/* =============================================================
 * commands.js —— 交互指令解析器
 * 支持：换题 / 更难 / 更简单 / 开始口语 / 开始故事 / 复习 /
 *       查看今日计划 / 继续故事
 * ============================================================= */
(function (global) {
  'use strict';

  var Store = global.ELS.store;
  var Services = global.ELS.services;

  var ui = null;
  function setUI(impl) { ui = impl; }

  function ensureArticle() {
    var a = Store.latestArticle();
    return a || null;
  }

  var COMMANDS = [
    {
      key: 'change_topic',
      label: '换题',
      patterns: [/换题/, /换个?主题/, /换一个/, /new\s*topic/i, /change\s*topic/i],
      desc: '重新选题并生成新的阅读材料',
      run: function () {
        return Services.topicGenerate({}).then(function (t) {
          return Services.articleGenerate({ topic_id: t.topic_id }).then(function (a) {
            Services.completeStep('topic');
            Services.completeStep('article');
            if (ui) { ui.onArticle(a); ui.go('reading'); }
            return '已换题：' + t.name + '（' + t.topic_category + '）\n理由：' + t.why_this_topic;
          });
        });
      }
    },
    {
      key: 'harder',
      label: '更难',
      patterns: [/更难/, /难一点/, /难一些/, /难度.*高/, /提高难度/,
        /^\s*harder\s*$/i, /more\s*difficult/i],
      desc: '提升难度并重新生成材料',
      run: function () {
        var band = Services.changeDifficulty(+1);
        var a = ensureArticle();
        var p = a
          ? Services.articleGenerate({ topic_id: a.topic_id, level: band })
          : Services.topicGenerate({}).then(function (t) { return Services.articleGenerate({ topic_id: t.topic_id, level: band }); });
        return p.then(function (art) {
          if (ui) { ui.onArticle(art); ui.go('reading'); }
          return '难度已提升为 ' + band + '，材料已重新生成。';
        });
      }
    },
    {
      key: 'easier',
      label: '更简单',
      patterns: [/更简单/, /简单一点/, /简单点/, /简单些/, /降低难度/,
        /^\s*easier\s*$/i, /^\s*simpler\s*$/i],
      desc: '降低难度并重新生成材料',
      run: function () {
        var band = Services.changeDifficulty(-1);
        var a = ensureArticle();
        var p = a
          ? Services.articleGenerate({ topic_id: a.topic_id, level: band })
          : Services.topicGenerate({}).then(function (t) { return Services.articleGenerate({ topic_id: t.topic_id, level: band }); });
        return p.then(function (art) {
          if (ui) { ui.onArticle(art); ui.go('reading'); }
          return '难度已降低为 ' + band + '，材料已重新生成。';
        });
      }
    },
    {
      key: 'start_speaking',
      label: '开始口语',
      patterns: [/开始口语/, /口语练习/, /练口语/, /口语对话/,
        /start\s*speaking/i, /^\s*speaking\s*$/i, /^\s*speak\s*$/i],
      desc: '直接进入口语练习',
      run: function () {
        var a = ensureArticle();
        if (!a) return Promise.resolve('还没有文章，请先点「自动选题」生成阅读材料。');
        return Services.speakingStart({ article_id: a.article_id }).then(function (r) {
          if (ui) { ui.onSpeakingStart(r); ui.go('speaking'); }
          Services.completeStep('speaking');
          return '口语练习已开始：\n' + r.first_question;
        });
      }
    },
    {
      key: 'start_story',
      label: '开始故事',
      patterns: [/开始故事/, /新故事/, /start\s*story/i, /new\s*story/i],
      desc: '直接进入互动故事',
      run: function () {
        var a = ensureArticle();
        if (!a) return Promise.resolve('还没有文章，请先点「自动选题」。');
        return Services.storyStart({ article_id: a.article_id }).then(function (r) {
          if (ui) { ui.onStory(r); ui.go('story'); }
          Services.completeStep('story');
          return '互动故事已开始：\n\n' + r.segment.story_text;
        });
      }
    },
    {
      key: 'review',
      label: '复习',
      patterns: [/^复习$/, /复习生词/, /复习单词/, /开始复习/, /^\s*review\s*$/i],
      desc: '复习今日生词和好句',
      run: function () {
        return Services.vocabularyToday({}).then(function (r) {
          if (ui) { ui.onReview(r); ui.go('vocab'); }
          Services.completeStep('review');
          if (!r.vocabulary_items.length) return '今日暂时没有待复习的生词，先去读一篇文章吧。';
          return '今日待复习 ' + r.vocabulary_items.length + ' 个词，另有 ' + r.expressions.length + ' 个好句。';
        });
      }
    },
    {
      key: 'today_plan',
      label: '查看今日计划',
      patterns: [/查看今日计划/, /今日计划/, /今天学什么/, /daily\s*plan/i, /my\s*plan/i],
      desc: '显示当天学习任务',
      run: function () {
        return Services.planToday({}).then(function (plan) {
          if (ui) { ui.onPlan(plan); ui.go('today'); }
          var lines = ['📅 今日计划（' + plan.date + '）'];
          plan.steps.forEach(function (s) {
            lines.push((plan.completed_steps.indexOf(s.key) > -1 ? '[x] ' : '[ ] ') + s.title + ' — ' + s.desc);
          });
          lines.push('备注：' + plan.notes);
          return lines.join('\n');
        });
      }
    },
    {
      key: 'continue_story',
      label: '继续故事',
      patterns: [/继续故事/, /接着讲/, /continue\s*story/i, /next\s*segment/i],
      desc: '回到上一段未完的互动故事（选 A/B/C 才会续写新内容）',
      run: function () {
        var s = Store.latestStorySession();
        if (!s) {
          return COMMANDS.filter(function (c) { return c.key === 'start_story'; })[0].run();
        }
        var seg = s.current_segment;
        if (ui) {
          ui.onStory({ story_session_id: s.story_session_id, segment: seg });
          ui.go('story');
        }
        var idx = seg && seg.story_state ? seg.story_state.segment_index : (s.history || []).length;
        var ended = seg && seg.story_state &&
          (seg.story_state.ending_candidates || []).length > 0;
        Services.completeStep('story');
        return Promise.resolve(
          '已回到上次的故事（第 ' + idx + ' 段）。' +
          (ended ? '本故事已进入结局候选，选择其一即可收尾；输入「开始故事」可重开一篇。'
                 : '请选择 A / B / C，剧情会按你的选择继续。')
        );
      }
    }
  ];

  /** 匹配指令；返回 command 或 null */
  function match(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    for (var i = 0; i < COMMANDS.length; i++) {
      for (var j = 0; j < COMMANDS[i].patterns.length; j++) {
        if (COMMANDS[i].patterns[j].test(t)) return COMMANDS[i];
      }
    }
    return null;
  }

  function isCommand(text) { return !!match(text); }

  function run(key, params) {
    var cmd = COMMANDS.filter(function (c) { return c.key === key; })[0];
    if (!cmd) return Promise.reject(new Error('未知指令：' + key));
    return cmd.run(params || {});
  }

  function list() {
    return COMMANDS.map(function (c) { return { key: c.key, label: c.label, desc: c.desc }; });
  }

  global.ELS.commands = {
    setUI: setUI,
    match: match,
    isCommand: isCommand,
    run: run,
    list: list,
    COMMANDS: COMMANDS
  };
})(window);
