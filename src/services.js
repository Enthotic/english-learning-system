/* =============================================================
 * services.js —— 服务层（等价于后端 8 个 REST 接口）
 * 前端 UI 只依赖本层；换成真实后端时只需替换实现，签名保持不变。
 * ============================================================= */
(function (global) {
  'use strict';

  var Store = global.ELS.store;
  var AI = global.ELS.ai;
  var Prompts = global.ELS.prompts;

  function historySummary(limit) {
    limit = limit || 6;
    var arts = Store.listArticles().slice(-limit).map(function (a) { return a.title; });
    var stats = Store.getStats();
    return '已学文章：' + (arts.length ? arts.join(' / ') : '暂无') +
      '；累计阅读 ' + stats.articles_read + ' 篇，口语 ' + stats.speaking_rounds + ' 轮，生词 ' + stats.words_learned + ' 个。';
  }

  function normalizeTopic(raw) {
    return {
      topic_id: Store.uid('topic'),
      name: raw.topic_name || raw.name || 'Untitled topic',
      topic_name: raw.topic_name || raw.name || 'Untitled topic',
      topic_category: raw.topic_category || raw.category || '文化',
      difficulty: raw.difficulty || 'B1',
      why_this_topic: raw.why_this_topic || '',
      discussion_angles: raw.discussion_angles || [],
      source_url: raw.source_url || '',
      created_at: Store.nowISO()
    };
  }

  var Services = {

    /* =========== POST /api/topic/generate =========== */
    topicGenerate: function (params) {
      params = params || {};
      var user = Store.getUser();
      var level = params.user_level || user.preferences.difficulty || user.level || 'B1-B2';
      var preferences = params.preferences || user.preferences.topics;
      var avoid = (user.preferences.avoid || []).join('、');

      return AI.complete('ai_editor', {
        level: level,
        preferences: preferences,
        recent: Store.recentTopicNames(Store.getSettings().recent_topic_window),
        date: Store.dateStr(),
        history: historySummary(),
        avoid: avoid
      }).then(function (raw) {
        var t = normalizeTopic(raw);
        Store.addTopic(t);
        var today = Store.dateStr();
        var plan = Store.getDailyPlan(today);
        if (plan) {
          var topics = plan.topics.slice();
          topics.push(t.topic_id);
          Store.upsertDailyPlan(today, { topics: topics });
        }
        return t;
      });
    },

    /* =========== POST /api/article/generate =========== */
    articleGenerate: function (params) {
      params = params || {};
      var topic = params.topic_id ? Store.getTopic(params.topic_id) : null;
      if (params.topic_id && !topic) return Promise.reject(new Error('topic_id 不存在：' + params.topic_id));

      var level = params.level || Store.getUser().preferences.difficulty || 'B1-B2';

      return AI.complete('reading_coach', {
        level: level,
        topic_name: topic ? topic.name : (params.topic_name || 'A change in everyday life'),
        topic_category: topic ? topic.topic_category : '文化',
        source_text: params.source_text || ''
      }).then(function (raw) {
        var article = {
          article_id: Store.uid('article'),
          topic_id: topic ? topic.topic_id : null,
          title: raw.title || (topic ? topic.name : 'Untitled'),
          original_text: raw.original_text || '',
          summary: raw.summary || [],
          vocabulary: raw.key_vocabulary || [],
          expressions: raw.useful_expressions || [],
          questions: raw.comprehension_questions || [],
          speaking_task: raw.speaking_task || '',
          difficulty_level: raw.difficulty_level || String(level).split('-').pop(),
          source_type: params.source_text ? 'user_source' : 'ai_generated',
          created_at: Store.nowISO()
        };
        Store.addArticle(article);

        // 生词自动入库（进入 SRS 队列）
        var today = Store.dateStr();
        (article.vocabulary || []).forEach(function (v) {
          if (!v || !v.word) return;
          Store.addVocabulary({
            word: v.word,
            phonetic: v.phonetic || '',
            en_definition: v.en_definition || '',
            cn_definition: v.cn_definition || '',
            example_sentence: v.example_sentence || '',
            source_article_id: article.article_id,
            source_type: 'article',
            next_review_at: today
          });
        });
        (article.expressions || []).forEach(function (e) {
          Store.addExpression({
            original_expression: typeof e === 'string' ? e : (e.original_expression || ''),
            pattern: typeof e === 'string' ? '' : (e.pattern || ''),
            user_example: '',
            source_article_id: article.article_id
          });
        });

        Store.bumpStat('articles_read');
        Store.bumpStat('words_learned', (article.vocabulary || []).length);
        Store.markActiveDay();
        return article;
      });
    },

    /* =========== POST /api/speaking/start =========== */
    speakingStart: function (params) {
      params = params || {};
      var article = Store.getArticle(params.article_id);
      if (!article) return Promise.reject(new Error('请先生成或选择一篇文章'));

      var user = Store.getUser();
      var session = Store.addSpeakingSession({
        user_id: user.user_id,
        topic_id: article.topic_id,
        article_id: article.article_id,
        messages: [],
        round: 0
      });

      return AI.complete('speaking_partner', {
        level: user.preferences.difficulty || user.level,
        title: article.title,
        summary: article.summary,
        messages: [],
        user_message: '(用户刚刚开始口语练习，请提出第一个自然、开放的问题)',
        round: 1,
        need_feedback: false,
        feedback_every: Store.getSettings().feedback_every
      }).then(function (raw) {
        var reply = raw.ai_reply || 'Hi! What did you think of the article we just read?';
        session.messages.push({ role: 'assistant', content: reply, round: 1 });
        session.round = 1;
        Store.updateSpeakingSession(session.session_id, {
          messages: session.messages, round: session.round
        });
        return {
          session_id: session.session_id,
          first_question: reply,
          round: 1
        };
      });
    },

    /* =========== POST /api/speaking/message =========== */
    speakingMessage: function (params) {
      params = params || {};
      var session = Store.getSpeakingSession(params.session_id);
      if (!session) return Promise.reject(new Error('会话不存在，请先开始口语练习'));

      var userMsg = String(params.user_message || '').trim();
      if (!userMsg) return Promise.reject(new Error('请输入你的回答'));

      var settings = Store.getSettings();
      var article = Store.getArticle(session.article_id) || { title: '', summary: [] };
      var round = (session.round || 0) + 1;
      var needFeedback = round > 0 && round % (settings.feedback_every || 5) === 0;

      session.messages.push({ role: 'user', content: userMsg, round: round });

      return AI.complete('speaking_partner', {
        level: Store.getUser().preferences.difficulty || Store.getUser().level,
        title: article.title,
        summary: article.summary,
        messages: session.messages.slice(0, -1),
        user_message: userMsg,
        round: round,
        need_feedback: needFeedback,
        feedback_every: settings.feedback_every || 5
      }).then(function (raw) {
        var correction = raw.correction || '';
        var feedback = raw.feedback || null;

        session.messages.push({ role: 'assistant', content: raw.ai_reply || '', round: round });
        if (correction) session.corrections.push({ round: round, original: userMsg, better: correction });
        if (feedback) session.feedback.push({ round: round, items: feedback });

        Store.updateSpeakingSession(session.session_id, {
          messages: session.messages,
          corrections: session.corrections,
          feedback: session.feedback,
          round: round
        });
        Store.bumpStat('speaking_rounds');
        Store.markActiveDay();

        return {
          session_id: session.session_id,
          round: round,
          ai_reply: raw.ai_reply || '',
          correction: correction,
          feedback: feedback
        };
      });
    },

    /* =========== POST /api/story/start =========== */
    storyStart: function (params) {
      params = params || {};
      var topic = params.topic_id ? Store.getTopic(params.topic_id) : null;
      var article = params.article_id ? Store.getArticle(params.article_id) : null;
      if (!topic && !article) return Promise.reject(new Error('需要提供 topic_id 或 article_id'));
      if (article && !topic) topic = Store.getTopic(article.topic_id) || { name: article.title, topic_category: '文化' };

      var user = Store.getUser();
      var session = Store.addStorySession({
        user_id: user.user_id,
        topic_id: topic ? topic.topic_id : null,
        article_id: article ? article.article_id : null,
        state: {
          current_scene: '',
          character_relationships: {},
          player_decisions: [],
          unlocked_clues: [],
          ending_candidates: [],
          segment_index: 0
        },
        history: [],
        current_segment: null
      });

      return Services._storyNext(session, null, null);
    },

    /* =========== POST /api/story/choose =========== */
    storyChoose: function (params) {
      params = params || {};
      var session = Store.getStorySession(params.story_session_id);
      if (!session) return Promise.reject(new Error('故事会话不存在，请先开始故事'));
      var choice = String(params.choice || 'A').toUpperCase();
      if (['A', 'B', 'C'].indexOf(choice) === -1) return Promise.reject(new Error('choice 必须是 A / B / C'));
      var choiceText = (session.current_segment && session.current_segment.choices &&
        session.current_segment.choices[choice]) || '';
      return Services._storyNext(session, choice, choiceText);
    },

    _storyNext: function (session, choice, choiceText) {
      var topic = Store.getTopic(session.topic_id) || { name: 'an unexpected change', topic_category: '文化' };
      var user = Store.getUser();
      var state = session.state || {};

      return AI.complete('story_director', {
        level: user.preferences.difficulty || user.level,
        topic_name: topic.name || topic.topic_name,
        topic_category: topic.topic_category || '文化',
        story_length: Store.getSettings().story_length || [100, 150],
        state: state,
        history_summary: session.history.map(function (h) { return h.story_text; }).slice(-2).join(' '),
        choice: choice,
        choice_text: choiceText
      }).then(function (raw) {
        var seg = {
          story_segment_id: raw.story_segment_id || ('seg_' + ((state.segment_index || 0) + 1)),
          story_text: raw.story_text || '',
          choices: raw.choices || { A: '', B: '', C: '' },
          new_words: raw.new_words || [],
          speaking_prompt: raw.speaking_prompt || '',
          story_state: raw.story_state || state,
          next_segment_hint: raw.next_segment_hint || '',
          choice: choice
        };
        seg.story_state.segment_index = (state.segment_index || 0) + 1;

        var history = session.history.slice();
        history.push(seg);

        Store.updateStorySession(session.story_session_id, {
          state: seg.story_state,
          history: history,
          current_segment: seg
        });

        // 故事新词入库
        (seg.new_words || []).forEach(function (w) {
          if (!w || !w.word) return;
          Store.addVocabulary({
            word: w.word,
            phonetic: w.phonetic || '',
            en_definition: w.en_definition || '',
            cn_definition: w.cn_definition || '',
            example_sentence: '',
            source_article_id: session.article_id,
            source_type: 'story',
            next_review_at: Store.dateStr()
          });
        });

        Store.bumpStat('story_segments');
        Store.markActiveDay();

        return {
          story_session_id: session.story_session_id,
          segment: seg
        };
      });
    },

    /* =========== GET /api/vocabulary/today =========== */
    vocabularyToday: function (params) {
      params = params || {};
      var date = params.date || Store.dateStr();
      var q = global.ELS.srs.todayQueue(date);
      var expressions = Store.listExpressions().slice(-20);
      return Promise.resolve({
        date: date,
        vocabulary_items: q.all,
        expressions: expressions,
        stats: global.ELS.srs.stats()
      });
    },

    /** 从任意文本抽取生词（口语 / 故事 / 自由输入） */
    extractVocabulary: function (params) {
      params = params || {};
      var oldWords = Store.listVocabulary()
        .filter(function (w) { return !w.mastered; })
        .slice(0, 8).map(function (w) { return w.word; });
      return AI.complete('vocabulary_manager', {
        source_type: params.source_type || 'speaking',
        text: params.text || '',
        old_words: oldWords
      }).then(function (raw) {
        var saved = Store.addVocabularyBulk((raw.vocabulary || []).map(function (v) {
          return {
            word: v.word, phonetic: v.phonetic, en_definition: v.en_definition,
            cn_definition: v.cn_definition, example_sentence: v.example_sentence,
            source_article_id: params.source_article_id || null,
            source_type: params.source_type || 'speaking',
            next_review_at: Store.dateStr()
          };
        }));
        var exps = Store.addExpressionBulk((raw.expressions || []).map(function (e) {
          return {
            original_expression: e.original_expression,
            pattern: e.pattern,
            user_example: '',
            source_article_id: params.source_article_id || null
          };
        }));
        return { vocabulary: saved, expressions: exps };
      });
    },

    /* =========== GET /api/plan/today =========== */
    planToday: function (params) {
      params = params || {};
      var date = params.date || Store.dateStr();
      var user = Store.getUser();
      var existing = Store.getDailyPlan(date);

      if (existing) return Promise.resolve(existing);

      var steps = [
        { key: 'topic', title: '自动选题', desc: '系统根据兴趣与历史选一个 B1–B2 英文资讯主题', done: false },
        { key: 'article', title: '分级阅读', desc: '生成 180–250 词资讯 + 词汇 + 句型 + 问题', done: false },
        { key: 'speaking', title: '口语陪练', desc: '围绕文章做至少 5 轮对话，含纠正与反馈', done: false },
        { key: 'story', title: '互动故事', desc: '把主题转成互动故事，做 2 个以上选择', done: false },
        { key: 'review', title: '生词复习', desc: '复习今日新词与到期旧词（间隔重复）', done: false }
      ];

      var plan = Store.upsertDailyPlan(date, {
        user_id: user.user_id,
        date: date,
        topics: [],
        steps: steps,
        completed_steps: [],
        notes: '每日目标时长：' + user.daily_minutes + ' 分钟',
        created_at: Store.nowISO()
      });
      return Promise.resolve(plan);
    },

    /** 标记某一步完成 */
    completeStep: function (key, date) {
      date = date || Store.dateStr();
      var plan = Store.getDailyPlan(date);
      if (!plan) return null;
      var done = plan.completed_steps.slice();
      if (done.indexOf(key) === -1) done.push(key);
      plan.steps.forEach(function (s) { if (s.key === key) s.done = true; });
      Store.markActiveDay(date);
      return Store.upsertDailyPlan(date, { completed_steps: done, steps: plan.steps });
    },

    /* =========== 难度调整 =========== */
    changeDifficulty: function (delta) {
      var user = Store.getUser();
      var cur = user.preferences.difficulty || 'B1-B2';
      var next = Prompts.shiftLevel(cur, delta);
      var band = Prompts.bandOf(next);
      Store.updateUser({ preferences: Object.assign({}, user.preferences, { difficulty: band }) });
      return band;
    },

    /* =========== 学习看板汇总 =========== */
    dashboard: function () {
      var s = Store.getStats();
      var words = Store.listVocabulary();
      return {
        stats: s,
        srs: global.ELS.srs.stats(),
        articles: Store.listArticles().length,
        speaking_sessions: Store.listSpeakingSessions().length,
        story_sessions: Store.listStorySessions().length,
        forecast: global.ELS.srs.forecast(7),
        weakest: words.filter(function (w) { return !w.mastered; })
          .sort(function (a, b) { return (a.ease || 0) - (b.ease || 0); }).slice(0, 5)
      };
    }
  };

  global.ELS.services = Services;
})(window);
