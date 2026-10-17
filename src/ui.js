/* =============================================================
 * ui.js —— 视图层：渲染 + 事件
 * ============================================================= */
(function (global) {
  'use strict';

  var Store = global.ELS.store;
  var SRS = global.ELS.srs;
  var Services = global.ELS.services;
  var Commands = global.ELS.commands;
  var AI = global.ELS.ai;

  /* ---------------- 运行时状态 ---------------- */
  var S = {
    tab: 'today',
    article: null,
    speaking: null,   // { session_id, messages, corrections, feedback }
    story: null,      // { story_session_id, segment }
    review: { items: [], index: 0 },
    plan: null
  };

  /* ---------------- 基础工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, type) {
    var wrap = $('#toast-wrap');
    var d = document.createElement('div');
    d.className = 'toast' + (type ? ' ' + type : '');
    d.textContent = msg;
    wrap.appendChild(d);
    setTimeout(function () { d.remove(); }, 3200);
  }

  var loadingDepth = 0;
  function loading(on, text) {
    var m = $('#loading-mask');
    loadingDepth = Math.max(0, loadingDepth + (on ? 1 : -1));
    if (text) $('#loading-text').textContent = text;
    m.classList.toggle('hidden', loadingDepth === 0);
  }

  function go(tab) {
    S.tab = tab;
    $$('#nav li').forEach(function (li) { li.classList.toggle('active', li.dataset.tab === tab); });
    $$('.tab-pane').forEach(function (p) { p.classList.toggle('hidden', p.dataset.pane !== tab); });
    render();
    if (tab === 'speaking') scrollChat();
  }

  function scrollChat() {
    var c = $('.chat');
    if (c) c.scrollTop = c.scrollHeight;
  }

  /** 全局忙锁：防止连续点击/回车触发并发 AI 请求 */
  var busy = false;
  function isBusy() { return busy; }
  function setBusy(v) { busy = !!v; }

  /** 统一异步包装：忙碌保护 + loading + 错误 toast */
  function run(promise, text) {
    if (busy) {
      toast('上一个请求还在处理中，请稍候…');
      return Promise.reject(new Error('系统繁忙，请稍后重试'));
    }
    busy = true;
    loading(true, text || '处理中…');
    return promise.then(function (r) {
      busy = false; loading(false);
      return r;
    }, function (e) {
      busy = false; loading(false);
      if (e && e.message !== '系统繁忙，请稍后重试') toast((e && e.message) || '出错了', 'err');
      throw e;
    });
  }

  /* =============================================================
   * 各 Tab 渲染
   * ============================================================= */

  function renderToday() {
    var pane = $('[data-pane="today"]');
    var plan = S.plan;
    var done = (plan && plan.completed_steps) || [];
    var steps = (plan && plan.steps) || [];
    var pct = steps.length ? Math.round(done.length / steps.length * 100) : 0;
    var stats = Store.getStats();

    pane.innerHTML = [
      '<div class="card">',
      '  <div class="row-between">',
      '    <div><h2>今日学习计划</h2><p class="muted">' + (plan ? plan.date : Store.dateStr()) + ' · 目标 ' + Store.getUser().daily_minutes + ' 分钟</p></div>',
      '    <div class="actions">',
      '      <button class="btn btn-primary" data-act="topic">自动选题</button>',
      '      <button class="btn" data-act="article">生成阅读材料</button>',
      '    </div>',
      '  </div>',
      '  <div style="margin-top:14px" class="bar"><i style="width:' + pct + '%"></i></div>',
      '  <p class="muted" style="margin-top:6px">完成 ' + done.length + ' / ' + steps.length + ' 步</p>',
      '</div>',

      '<div class="card">',
      '  <h2>学习流程</h2>',
      '  <div style="margin-top:8px">' + steps.map(function (s, i) {
        var isDone = done.indexOf(s.key) > -1;
        return '<div class="step' + (isDone ? ' done' : '') + '">' +
          '<div class="dot">' + (isDone ? '✓' : (i + 1)) + '</div>' +
          '<div class="txt"><div class="t">' + esc(s.title) + '</div><div class="d">' + esc(s.desc) + '</div></div>' +
          '<button class="btn btn-sm" data-act="goto" data-key="' + s.key + '">' + (isDone ? '继续' : '开始') + '</button>' +
          '</div>';
      }).join('') + '</div>',
      '</div>',

      '<div class="card">',
      '  <h2>累计数据</h2>',
      '  <div class="stat-grid" style="margin-top:12px">' +
      stat(stats.articles_read, '阅读文章') +
      stat(stats.speaking_rounds, '口语轮次') +
      stat(stats.story_segments, '故事片段') +
      stat(Store.listVocabulary().length, '生词总量') +
      stat((stats.days_active || []).length, '学习天数') +
      '</div>',
      '</div>'
    ].join('');
  }

  function stat(n, l) {
    return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
  }

  function renderReading() {
    var pane = $('[data-pane="reading"]');
    var a = S.article || Store.latestArticle();
    if (!a) {
      pane.innerHTML = [
        '<div class="card"><div class="empty">',
        '<span class="big">📰</span>',
        '还没有阅读材料。<br/>点击「自动选题」让系统为你选一个 B1–B2 英文资讯主题，再生成文章。',
        '<div class="actions" style="margin-top:16px;justify-content:center">',
        '<button class="btn btn-primary" data-act="topic">自动选题</button>',
        '</div></div></div>'
      ].join('');
      return;
    }
    var topic = a.topic_id ? Store.getTopic(a.topic_id) : null;

    pane.innerHTML = [
      '<div class="card">',
      '  <div class="row-between">',
      '    <div>',
      '      <h2>' + (topic ? esc(topic.topic_category) + ' · 今日主题' : '今日主题') + '</h2>',
      '      <p class="muted">' + esc(topic ? topic.name : a.title) + '</p>',
      topic ? '      <p style="margin:8px 0 0;font-size:13px;color:var(--ink-2)">' + esc(topic.why_this_topic) + '</p>' : '',
      '    </div>',
      '    <div class="actions">',
      '      <button class="btn btn-sm" data-act="cmd" data-cmd="change_topic">换题</button>',
      '      <button class="btn btn-sm" data-act="cmd" data-cmd="easier">更简单</button>',
      '      <button class="btn btn-sm" data-act="cmd" data-cmd="harder">更难</button>',
      '    </div>',
      '  </div>',
      '  <div style="margin-top:14px" class="actions">',
      '    <button class="btn btn-primary" data-act="speak">开始口语</button>',
      '    <button class="btn" data-act="story">开始故事</button>',
      '    <button class="btn btn-ghost btn-sm" data-act="toggle-source">用我自己的原文生成</button>',
      '  </div>',
      '  <div id="source-box" class="hidden" style="margin-top:12px">',
      '    <textarea id="source-text" rows="6" placeholder="粘贴英文原文（或文章链接的内容），系统会简化到你的难度并保留核心观点…"></textarea>',
      '    <div style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="article-from-source">基于原文生成</button></div>',
      '  </div>',
      '</div>',

      '<div class="card">',
      '  <div class="article-title">' + esc(a.title) + '</div>',
      '  <div class="article-meta">难度 ' + esc(a.difficulty_level) + ' · 来源 ' + (a.source_type === 'user_source' ? '用户原文改写' : 'AI 生成') + ' · ' + wordCount(a.original_text) + ' 词</div>',
      '  <div class="article-text">' + esc(a.original_text) + '</div>',
      '  <h3>Summary</h3>',
      '  <ul class="summary-list">' + (a.summary || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>',
      '  <h3>Key Vocabulary</h3>',
      vocabTable(a.vocabulary || []),
      '  <h3>Useful Expressions</h3>',
      '  <div class="pill-list">' + (a.expressions || []).map(function (e) {
        var t = typeof e === 'string' ? e : (e.original_expression || '');
        return '<span class="pill">' + esc(t) + '</span>';
      }).join('') + '</div>',
      '  <h3>Comprehension Questions</h3>',
      '  <ul class="summary-list">' + (a.questions || []).map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>',
      '  <h3>Speaking Task（60s）</h3>',
      '  <p style="margin:0">' + esc(a.speaking_task) + '</p>',
      '</div>'
    ].join('');
  }

  function wordCount(t) {
    return String(t || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function vocabTable(list) {
    if (!list.length) return '<p class="muted">暂无</p>';
    return '<table class="grid"><thead><tr><th>Word</th><th>EN Definition</th><th>中文</th><th>Example</th></tr></thead><tbody>' +
      list.map(function (v) {
        return '<tr><td><span class="word-en">' + esc(v.word) + '</span><br/><span class="phonetic">' + esc(v.phonetic || '') + '</span></td>' +
          '<td>' + esc(v.en_definition) + '</td>' +
          '<td>' + esc(v.cn_definition) + '</td>' +
          '<td>' + esc(v.example_sentence) + '</td></tr>';
      }).join('') +
      '</tbody></table>';
  }

  function renderSpeaking() {
    var pane = $('[data-pane="speaking"]');
    var s = S.speaking;
    var a = S.article || Store.latestArticle();

    if (!s) {
      pane.innerHTML = [
        '<div class="card"><div class="empty">',
        '<span class="big">🎙️</span>',
        a ? '准备好围绕《' + esc(a.title) + '》开口了吗？' : '还没有文章，请先生成阅读材料。',
        '<div style="margin-top:16px"><button class="btn btn-primary" data-act="speak">开始口语练习</button></div>',
        '</div></div>'
      ].join('');
      return;
    }

    var html = ['<div class="card">',
      '<div class="row-between">',
      '<div><h2>口语陪练</h2><p class="muted">第 ' + (s.round || 0) + ' 轮 · 每 ' + Store.getSettings().feedback_every + ' 轮给出一次反馈</p></div>',
      '<div class="actions"><button class="btn btn-sm" data-act="extract">抽取本轮生词</button><button class="btn btn-sm btn-ghost" data-act="speak-end">结束会话</button></div>',
      '</div>',
      '<div class="chat" id="chat-box" style="margin-top:14px">'];

    s.messages.forEach(function (m) {
      html.push('<div class="msg ' + (m.role === 'user' ? 'user' : 'ai') + '"><span class="who">' +
        (m.role === 'user' ? 'You' : 'Partner') + '</span>' + esc(m.content) + '</div>');
      var cor = (s.corrections || []).filter(function (c) { return c.round === m.round && m.role === 'user'; })[0];
      if (cor) html.push('<div class="correction">' + esc(cor.better) + '</div>');
      var fb = (s.feedback || []).filter(function (f) { return f.round === m.round && m.role === 'assistant'; })[0];
      if (fb) {
        var it = fb.items || {};
        html.push('<div class="feedback-card"><h4>第 ' + fb.round + ' 轮反馈</h4><ul>' +
          '<li><b>Vocabulary：</b>' + esc(it.vocabulary) + '</li>' +
          '<li><b>Grammar：</b>' + esc(it.grammar) + '</li>' +
          '<li><b>Fluency：</b>' + esc(it.fluency) + '</li>' +
          '<li><b>Logic：</b>' + esc(it.logic) + '</li>' +
          '</ul></div>');
      }
    });

    html.push('</div>',
      '<p class="muted" style="margin-top:12px">在页面底部输入框直接用英文回答；输入「结束口语」可结束。</p>',
      '</div>');
    pane.innerHTML = html.join('');
  }

  function renderStory() {
    var pane = $('[data-pane="story"]');
    var st = S.story;
    if (!st || !st.segment) {
      pane.innerHTML = ['<div class="card"><div class="empty">',
        '<span class="big">🎬</span>',
        '还没有故事。开始后你会拿到 100–150 词的英文片段和 A / B / C 三个选择，你的选择会改变剧情。',
        '<div style="margin-top:16px"><button class="btn btn-primary" data-act="story">开始互动故事</button></div>',
        '</div></div>'].join('');
      return;
    }
    var seg = st.segment;
    var state = seg.story_state || {};

    pane.innerHTML = [
      '<div class="card">',
      '<div class="row-between">',
      '<div><h2>互动故事</h2><p class="muted">第 ' + (state.segment_index || 1) + ' 段</p></div>',
      '<button class="btn btn-sm" data-act="cmd" data-cmd="continue_story">继续故事</button>',
      '</div>',
      '<div class="story-text" style="margin-top:12px">' + esc(seg.story_text) + '</div>',
      '<div class="choices">' + ['A', 'B', 'C'].map(function (k) {
        return '<button class="choice" data-act="choose" data-choice="' + k + '"><span class="k">' + k + '</span>' + esc((seg.choices || {})[k] || '') + '</button>';
      }).join('') + '</div>',
      '<h3>New Words</h3>',
      '<div class="pill-list">' + (seg.new_words || []).map(function (w) {
        return '<span class="pill"><b>' + esc(w.word) + '</b> · ' + esc(w.cn_definition || '') + '</span>';
      }).join('') + '</div>',
      '<h3>Speaking Prompt</h3>',
      '<p style="margin:0">' + esc(seg.speaking_prompt) + '</p>',
      '<h3>Story State</h3>',
      '<div class="state-grid">' +
      cell('current_scene', state.current_scene) +
      cell('player_decisions', (state.player_decisions || []).join(', ') || '—') +
      cell('unlocked_clues', (state.unlocked_clues || []).join(' / ') || '—') +
      cell('ending_candidates', (state.ending_candidates || []).join(', ') || '—') +
      cell('relationships', JSON.stringify(state.character_relationships || {})) +
      '</div>',
      '<p class="muted" style="margin-top:12px">下一段提示：' + esc(seg.next_segment_hint) + '</p>',
      '</div>'
    ].join('');
  }

  function cell(k, v) {
    return '<div class="state-cell"><div class="k">' + k + '</div><div class="v">' + esc(v || '—') + '</div></div>';
  }

  function renderVocab() {
    var pane = $('[data-pane="vocab"]');
    var items = S.review.items || [];
    var idx = Math.min(S.review.index || 0, Math.max(0, items.length - 1));
    var cur = items[idx];

    var html = ['<div class="card">',
      '<div class="row-between">',
      '<div><h2>今日复习</h2><p class="muted">间隔重复：认识 → 拉长间隔；忘记 → 当天重来</p></div>',
      '<button class="btn btn-sm" data-act="refresh-review">刷新队列</button>',
      '</div>'];

    if (!items.length) {
      html.push('<div class="empty" style="padding:28px"><span class="big">📚</span>今日没有待复习的词。去读一篇文章就会自动收词。</div>');
    } else {
      html.push('<div class="review-meta" style="margin-top:14px"><span>' + (idx + 1) + ' / ' + items.length + '</span><span>已复习 ' + (cur.review_count || 0) + ' 次 · 下次 ' + esc(cur.next_review_at) + '</span></div>');
      html.push('<div class="flash">',
        '<div><span class="word">' + esc(cur.word) + '</span><span class="ph">' + esc(cur.phonetic || '') + '</span></div>',
        '<div class="def"><div class="en">' + esc(cur.en_definition) + '</div>',
        '<div class="cn">' + esc(cur.cn_definition) + '</div></div>',
        cur.example_sentence ? '<div class="ex">' + esc(cur.example_sentence) + '</div>' : '',
        '<div class="flash-actions">',
        '<button class="btn btn-ok" data-act="know" data-id="' + cur.word_id + '">认识</button>',
        '<button class="btn btn-danger" data-act="forgot" data-id="' + cur.word_id + '">忘记</button>',
        '</div></div>');
    }
    html.push('</div>');

    var exprs = Store.listExpressions().slice(-20).reverse();
    html.push('<div class="card"><h2>好句本</h2>');
    if (!exprs.length) html.push('<p class="muted">暂无</p>');
    else html.push('<div class="pill-list" style="margin-top:10px">' + exprs.map(function (e) {
      return '<span class="pill">' + esc(e.original_expression) + (e.pattern ? ' <span style="color:var(--ink-3)">→ ' + esc(e.pattern) + '</span>' : '') + '</span>';
    }).join('') + '</div>');
    html.push('</div>');

    var all = Store.listVocabulary().slice().reverse();
    html.push('<div class="card"><h2>我的词库（' + all.length + '）</h2>',
      '<table class="grid" style="margin-top:10px"><thead><tr><th>Word</th><th>中文</th><th>来源</th><th>复习</th><th>下次</th><th></th></tr></thead><tbody>',
      all.slice(0, 60).map(function (w) {
        return '<tr><td><span class="word-en">' + esc(w.word) + '</span>' + (w.mastered ? ' <span class="badge badge-ok">已掌握</span>' : '') + '</td>' +
          '<td>' + esc(w.cn_definition) + '</td>' +
          '<td>' + esc(w.source_type || 'article') + '</td>' +
          '<td>' + (w.review_count || 0) + '</td>' +
          '<td>' + esc(w.next_review_at) + '</td>' +
          '<td><button class="btn btn-sm btn-ghost" data-act="del-word" data-id="' + w.word_id + '">删</button></td></tr>';
      }).join(''),
      '</tbody></table></div>');

    pane.innerHTML = html.join('');
  }

  function renderDash() {
    var pane = $('[data-pane="dash"]');
    var d = Services.dashboard();
    var max = d.forecast.reduce(function (m, f) { return Math.max(m, f.count); }, 1);
    pane.innerHTML = [
      '<div class="card"><h2>学习总览</h2><div class="stat-grid" style="margin-top:12px">' +
      stat(d.stats.articles_read || 0, '阅读文章') +
      stat(d.stats.speaking_rounds || 0, '口语轮次') +
      stat(d.stats.story_segments || 0, '故事片段') +
      stat(d.srs.total, '生词总量') +
      stat(d.srs.mastered, '已掌握') +
      stat(d.srs.due_today, '今日待复习') +
      '</div></div>',

      '<div class="card"><h2>未来 7 天复习负荷</h2><div class="fc">' +
      d.forecast.map(function (f) {
        return '<div class="col"><i style="height:' + Math.round(f.count / max * 90) + 'px"></i><span>' + f.date.slice(5) + '</span><span>' + f.count + '</span></div>';
      }).join('') +
      '</div></div>',

      '<div class="card"><h2>需要重点攻克的词</h2>' +
      (d.weakest.length
        ? '<div class="pill-list" style="margin-top:10px">' + d.weakest.map(function (w) {
          return '<span class="pill"><b>' + esc(w.word) + '</b> · ' + esc(w.cn_definition) + '</span>';
        }).join('') + '</div>'
        : '<p class="muted">暂无</p>') +
      '</div>',

      '<div class="card"><h2>历史会话</h2><p class="muted">口语 ' + d.speaking_sessions + ' 场 · 故事 ' + d.story_sessions + ' 场 · 文章 ' + d.articles + ' 篇</p></div>'
    ].join('');
  }

  function render() {
    if (S.tab === 'today') renderToday();
    else if (S.tab === 'reading') renderReading();
    else if (S.tab === 'speaking') renderSpeaking();
    else if (S.tab === 'story') renderStory();
    else if (S.tab === 'vocab') renderVocab();
    else if (S.tab === 'dash') renderDash();
    renderSidebar();
  }

  function renderSidebar() {
    var plan = S.plan;
    var steps = (plan && plan.steps) || [];
    var done = (plan && plan.completed_steps) || [];
    var pct = steps.length ? Math.round(done.length / steps.length * 100) : 0;
    $('#progress-mini').innerHTML =
      '<div class="row"><span>今日完成</span><span>' + done.length + '/' + steps.length + '</span></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="row"><span>待复习</span><span>' + SRS.stats().due_today + '</span></div>';
  }

  /* =============================================================
   * 设置抽屉
   * ============================================================= */
  var PROVIDERS = {
    openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    moonshot: { name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    dashscope: { name: '通义千问（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    ollama: { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
    custom: { name: '自定义（OpenAI 兼容）', baseUrl: '', model: '' }
  };

  function renderSettings() {
    var st = Store.getSettings();
    var u = Store.getUser();
    var cats = Store.DEFAULT_CATEGORIES;

    $('#drawer-body').innerHTML = [
      '<div class="field"><label>当前难度</label><select id="set-level">',
      ['A2-B1', 'B1-B2', 'B2-C1', 'C1-C2'].map(function (l) {
        return '<option value="' + l + '"' + (u.preferences.difficulty === l ? ' selected' : '') + '>' + l + '</option>';
      }).join(''),
      '</select><div class="hint">影响阅读、口语、故事三处的生成难度</div></div>',

      '<div class="field"><label>每日学习时长（分钟）</label><input type="number" id="set-minutes" min="5" max="180" value="' + u.daily_minutes + '" /></div>',

      '<div class="field"><label>主题偏好</label><div class="topic-tags" id="set-topics">',
      cats.map(function (c) {
        var on = u.preferences.topics.indexOf(c) > -1;
        return '<span class="topic-tag' + (on ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</span>';
      }).join(''),
      '</div><div class="hint">自动屏蔽：敏感政治争议、暴力、成人内容、违法内容</div></div>',

      '<hr style="border:none;border-top:1px solid var(--line);margin:20px 0" />',

      '<div class="field"><label>模型服务商</label><select id="set-provider">',
      Object.keys(PROVIDERS).map(function (k) {
        return '<option value="' + k + '"' + (st.provider === k ? ' selected' : '') + '>' + PROVIDERS[k].name + '</option>';
      }).join(''),
      '</select></div>',

      '<div class="field"><label>Base URL</label><input type="text" id="set-baseurl" value="' + esc(st.baseUrl) + '" /></div>',
      '<div class="field"><label>Model</label><input type="text" id="set-model" value="' + esc(st.model) + '" /></div>',
      '<div class="field"><label>API Key</label><input type="password" id="set-apikey" value="' + esc(st.apiKey) + '" placeholder="sk-…" /><div class="hint">仅保存在本机浏览器 localStorage，不会上传到任何第三方</div></div>',
      '<div class="field"><label>Temperature</label><input type="number" id="set-temp" step="0.1" min="0" max="1.5" value="' + st.temperature + '" /></div>',
      '<div class="field"><label>每 N 轮口语反馈</label><input type="number" id="set-fb" min="2" max="10" value="' + st.feedback_every + '" /></div>',
      '<div class="field"><label>选题去重天数</label><input type="number" id="set-window" min="1" max="30" value="' + st.recent_topic_window + '" /></div>',
      '<div class="field"><label class="switch"><input type="checkbox" id="set-mock"' + (st.mock ? ' checked' : '') + ' /> 使用离线 Mock 引擎（无需 API Key）</label></div>',

      '<hr style="border:none;border-top:1px solid var(--line);margin:20px 0" />',
      '<div class="actions">',
      '<button class="btn btn-primary" data-act="save-settings">保存设置</button>',
      '<button class="btn" data-act="export">导出备份</button>',
      '<button class="btn" data-act="import">导入备份</button>',
      '<button class="btn btn-danger" data-act="reset">清空数据</button>',
      '</div>',
      '<textarea id="io-box" rows="4" style="margin-top:12px;width:100%;border:1px solid var(--line);border-radius:10px;padding:8px;font-family:inherit;font-size:12px" placeholder="导出/粘贴备份 JSON 在这里"></textarea>'
    ].join('');

    $$('#set-topics .topic-tag').forEach(function (t) {
      t.onclick = function () { t.classList.toggle('on'); };
    });
    $('#set-provider').onchange = function () {
      var p = PROVIDERS[this.value];
      if (p && p.baseUrl) {
        $('#set-baseurl').value = p.baseUrl;
        if (p.model) $('#set-model').value = p.model;
      }
    };
  }

  function saveSettings() {
    var u = Store.getUser();
    var topics = $$('#set-topics .topic-tag.on').map(function (t) { return t.dataset.cat; });
    Store.updateUser({
      daily_minutes: parseInt($('#set-minutes').value, 10) || 20,
      preferences: Object.assign({}, u.preferences, {
        difficulty: $('#set-level').value,
        topics: topics.length ? topics : Store.DEFAULT_CATEGORIES.slice()
      })
    });
    Store.updateSettings({
      provider: $('#set-provider').value,
      baseUrl: $('#set-baseurl').value.trim(),
      model: $('#set-model').value.trim(),
      apiKey: $('#set-apikey').value.trim(),
      temperature: parseFloat($('#set-temp').value),
      feedback_every: parseInt($('#set-fb').value, 10) || 5,
      recent_topic_window: parseInt($('#set-window').value, 10) || 3,
      mock: $('#set-mock').checked
    });
    refreshBadges();
    toast('设置已保存', 'ok');
    render();
  }

  function refreshBadges() {
    var u = Store.getUser();
    $('#badge-level').textContent = u.preferences.difficulty || u.level;
    var mock = AI.isMock();
    var b = $('#badge-mode');
    b.textContent = mock ? 'Mock 模式' : 'AI 模式';
    b.className = 'badge ' + (mock ? 'badge-warn' : 'badge-ok');
  }

  /* =============================================================
   * 业务动作
   * ============================================================= */

  function doTopic() {
    return run(Services.topicGenerate({}), 'AI Editor 正在选题…').then(function (t) {
      Services.completeStep('topic');
      toast('已选题：' + t.name, 'ok');
      return doArticle(t.topic_id);
    });
  }

  function doArticle(topicId, sourceText) {
    topicId = topicId || (S.article && S.article.topic_id) || (Store.listTopics().slice(-1)[0] || {}).topic_id;
    if (!topicId) return doTopic();
    return run(Services.articleGenerate({ topic_id: topicId, source_text: sourceText || '' }), 'Reading Coach 正在生成材料…')
      .then(function (a) {
        S.article = a;
        Services.completeStep('article');
        loadPlan();
        go('reading');
        toast('阅读材料已生成', 'ok');
        return a;
      });
  }

  function doSpeaking() {
    var a = S.article || Store.latestArticle();
    if (!a) { toast('请先生成阅读材料', 'err'); return Promise.resolve(); }
    return run(Services.speakingStart({ article_id: a.article_id }), 'Speaking Partner 正在准备…')
      .then(function (r) {
        var sess = Store.getSpeakingSession(r.session_id);
        S.speaking = {
          session_id: r.session_id,
          messages: sess.messages,
          corrections: sess.corrections,
          feedback: sess.feedback,
          round: r.round
        };
        Services.completeStep('speaking');
        loadPlan();
        go('speaking');
        return r;
      });
  }

  function doSendSpeaking(text) {
    if (!S.speaking) return Promise.resolve();
    return run(Services.speakingMessage({ session_id: S.speaking.session_id, user_message: text }), 'Partner 正在回应…')
      .then(function (r) {
        var sess = Store.getSpeakingSession(r.session_id);
        S.speaking = {
          session_id: r.session_id,
          messages: sess.messages,
          corrections: sess.corrections,
          feedback: sess.feedback,
          round: r.round
        };
        renderSpeaking();
        scrollChat();
        if (r.feedback) toast('已生成第 ' + r.round + ' 轮反馈', 'ok');
        return r;
      });
  }

  function doStoryStart() {
    var a = S.article || Store.latestArticle();
    if (!a) { toast('请先生成阅读材料', 'err'); return Promise.resolve(); }
    return run(Services.storyStart({ article_id: a.article_id }), 'Story Director 正在构思…')
      .then(function (r) {
        S.story = r;
        Services.completeStep('story');
        loadPlan();
        go('story');
        return r;
      });
  }

  function doStoryChoose(choice) {
    return run(Services.storyChoose({ story_session_id: S.story.story_session_id, choice: choice }), 'Story Director 正在续写…')
      .then(function (r) {
        S.story = r;
        renderStory();
        return r;
      });
  }

  function loadReview() {
    return Services.vocabularyToday({}).then(function (r) {
      S.review = { items: r.vocabulary_items, index: 0 };
    });
  }

  function loadPlan() {
    return Services.planToday({}).then(function (p) { S.plan = p; });
  }

  /* =============================================================
   * 事件绑定
   * ============================================================= */
  function bind() {
    // 侧栏导航
    $$('#nav li').forEach(function (li) {
      li.onclick = function () { go(li.dataset.tab); };
    });

    // 内容区事件委托
    $('#content').addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      var act = t.dataset.act;

      if (act === 'topic') doTopic();
      else if (act === 'article') doArticle();
      else if (act === 'article-from-source') {
        var txt = $('#source-text').value.trim();
        if (!txt) { toast('请先粘贴英文原文', 'err'); return; }
        doArticle(null, txt);
      }
      else if (act === 'toggle-source') $('#source-box').classList.toggle('hidden');
      else if (act === 'speak') doSpeaking();
      else if (act === 'speak-end') { S.speaking = null; renderSpeaking(); }
      else if (act === 'story') doStoryStart();
      else if (act === 'choose') doStoryChoose(t.dataset.choice);
      else if (act === 'goto') {
        var map = { topic: 'today', article: 'reading', speaking: 'speaking', story: 'story', review: 'vocab' };
        go(map[t.dataset.key] || 'today');
      }
      else if (act === 'cmd') runCmd(t.dataset.cmd);
      else if (act === 'know') { SRS.reviewKnown(t.dataset.id); nextCard(); }
      else if (act === 'forgot') { SRS.reviewForgot(t.dataset.id); nextCard(); }
      else if (act === 'refresh-review') loadReview().then(function () { renderVocab(); renderSidebar(); });
      else if (act === 'del-word') {
        var list = Store.listVocabulary().filter(function (w) { return w.word_id !== t.dataset.id; });
        Store.raw().vocabulary = list; Store.save(); renderVocab();
      }
      else if (act === 'extract') {
        var last = (S.speaking && S.speaking.messages || []).slice(-6).map(function (m) { return m.content; }).join('\n');
        run(Services.extractVocabulary({ text: last, source_type: 'speaking', source_article_id: (S.article || {}).article_id }), '正在抽取生词…')
          .then(function (r) { toast('已收录 ' + r.vocabulary.length + ' 个词', 'ok'); loadReview(); });
      }
    });

    // 指令输入
    function submit() {
      var input = $('#cmd-input');
      var v = input.value.trim();
      if (!v) return;
      input.value = '';

      var cmd = Commands.match(v);
      if (cmd) { runCmd(cmd.key); return; }

      // 非指令：口语会话中当作英文回答
      if (S.tab === 'speaking' && S.speaking) { doSendSpeaking(v); return; }
      if (S.tab === 'story' && /^[ABC]$/i.test(v)) { doStoryChoose(v.toUpperCase()); return; }
      toast('未识别的指令。可用：换题 / 更难 / 更简单 / 开始口语 / 开始故事 / 复习 / 查看今日计划 / 继续故事');
    }
    $('#cmd-send').onclick = submit;
    $('#cmd-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    // 设置抽屉
    $('#btn-settings').onclick = function () {
      renderSettings();
      $('#drawer').classList.remove('hidden');
      $('#drawer-mask').classList.remove('hidden');
    };
    $('#drawer-close').onclick = closeDrawer;
    $('#drawer-mask').onclick = closeDrawer;
    $('#drawer-body').addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      var act = t.dataset.act;
      if (act === 'save-settings') saveSettings();
      else if (act === 'export') $('#io-box').value = Store.exportJSON();
      else if (act === 'import') {
        try { Store.importJSON($('#io-box').value); refreshBadges(); render(); toast('导入成功', 'ok'); }
        catch (err) { toast('导入失败：' + err.message, 'err'); }
      }
      else if (act === 'reset') {
        if (confirm('确定清空所有学习数据？此操作不可恢复。')) {
          Store.reset(); S.article = null; S.speaking = null; S.story = null;
          refreshBadges(); loadPlan().then(render); toast('已清空');
        }
      }
    });

    // 快捷指令 chips
    var chipWrap = $('#cmd-chips');
    chipWrap.innerHTML = Commands.list().map(function (c) {
      return '<span class="chip" data-cmd="' + c.key + '" title="' + esc(c.desc) + '">' + esc(c.label) + '</span>';
    }).join('');
    chipWrap.addEventListener('click', function (e) {
      var t = e.target.closest('[data-cmd]');
      if (t) runCmd(t.dataset.cmd);
    });
  }

  function closeDrawer() {
    $('#drawer').classList.add('hidden');
    $('#drawer-mask').classList.add('hidden');
  }

  function nextCard() {
    S.review.index = (S.review.index || 0) + 1;
    if (S.review.index >= S.review.items.length) {
      loadReview().then(function () {
        renderVocab();
        toast('本轮复习完成 🎉', 'ok');
      });
      return;
    }
    renderVocab();
  }

  function runCmd(key) {
    var c = Commands.COMMANDS.filter(function (x) { return x.key === key; })[0];
    if (!c) return;
    if (busy) { toast('上一个请求还在处理中，请稍候…'); return; }
    busy = true;
    loading(true, '执行「' + c.label + '」…');
    Commands.run(key).then(function (msg) {
      busy = false; loading(false);
      loadPlan().then(render);
      if (msg) toast(String(msg).split('\n')[0], 'ok');
    }, function (e) {
      busy = false; loading(false);
      toast((e && e.message) || '指令执行失败', 'err');
    });
  }

  /** localStorage 配额不足时的用户提示 */
  Store.onQuotaError = function () {
    toast('浏览器本地存储空间已满，请在设置里导出备份并清理旧数据', 'err');
  };

  /* =============================================================
   * 供 commands.js 使用的 UI 适配
   * ============================================================= */
  Commands.setUI({
    onArticle: function (a) { S.article = a; },
    onSpeakingStart: function (r) {
      var sess = Store.getSpeakingSession(r.session_id);
      S.speaking = { session_id: r.session_id, messages: sess.messages, corrections: sess.corrections, feedback: sess.feedback, round: r.round };
    },
    onStory: function (r) { S.story = r; },
    onReview: function (r) { S.review = { items: r.vocabulary_items, index: 0 }; },
    onPlan: function (p) { S.plan = p; },
    go: go
  });

  global.ELS.ui = {
    S: S,
    go: go,
    render: render,
    toast: toast,
    loading: loading,
    bind: bind,
    loadPlan: loadPlan,
    loadReview: loadReview,
    refreshBadges: refreshBadges,
    doTopic: doTopic
  };
})(window);
