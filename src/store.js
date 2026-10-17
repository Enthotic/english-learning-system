/* =============================================================
 * store.js —— 数据层（localStorage 持久化）
 * 对应后端数据库 Schema，所有实体在此统一 CRUD
 * ============================================================= */
(function (global) {
  'use strict';

  var KEY = 'els.db.v1';

  var DEFAULT_CATEGORIES = [
    '科技', '商业', '文化', 'AI', '城市生活', '教育', '职场', '旅行', '健康', '环境'
  ];

  var LEVELS = ['A2', 'B1', 'B2', 'C1', 'C2'];

  /* ---------------- 工具 ---------------- */
  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function dateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function nowISO() { return new Date().toISOString(); }

  /** 兼容各引擎的日期解析（优先手写解析 YYYY-MM-DD） */
  function parseDate(s) {
    if (s instanceof Date) return s;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    var d = new Date(s);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  function addDays(dateStrOrDate, n) {
    var d = parseDate(dateStrOrDate);
    d.setDate(d.getDate() + n);
    return dateStr(d);
  }

  function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }

  /* ---------------- 默认库 ---------------- */
  function defaultDB() {
    return {
      version: 1,
      user: {
        user_id: uid('user'),
        level: 'B1-B2',
        daily_minutes: 20,
        preferences: {
          topics: DEFAULT_CATEGORIES.slice(),
          avoid: ['敏感政治争议', '暴力', '成人内容', '违法内容'],
          difficulty: 'B1-B2'
        },
        created_at: nowISO()
      },
      settings: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0.7,
        mock: true,          // 默认 Mock，保证开箱即跑
        story_length: [100, 150],
        feedback_every: 5,
        recent_topic_window: 3
      },
      topics: [],
      articles: [],
      vocabulary: [],
      expressions: [],
      speaking_sessions: [],
      story_sessions: [],
      daily_plans: [],
      stats: {
        days_active: [],
        articles_read: 0,
        speaking_rounds: 0,
        story_segments: 0,
        words_learned: 0,
        minutes_spent: 0
      }
    };
  }

  /* ---------------- 载入 / 保存 ---------------- */
  var db = null;

  function load() {
    if (db) return db;
    try {
      var raw = global.localStorage.getItem(KEY);
      db = raw ? JSON.parse(raw) : defaultDB();
    } catch (e) {
      db = defaultDB();
    }
    // 兼容旧版本缺字段
    var def = defaultDB();
    for (var k in def) {
      if (!db[k]) db[k] = def[k];
    }
    if (!db.user.preferences) db.user.preferences = def.user.preferences;
    if (!db.settings) db.settings = def.settings;
    for (var s in def.settings) {
      if (db.settings[s] === undefined) db.settings[s] = def.settings[s];
    }
    for (var st in def.stats) {
      if (db.stats[st] === undefined) db.stats[st] = def.stats[st];
    }
    return db;
  }

  var saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        global.localStorage.setItem(KEY, JSON.stringify(db));
      } catch (e) {
        console.warn('[store] 持久化失败', e);
        // localStorage 配额通常 5–10MB，超限时给出可操作的提示
        if (/quota|exceed/i.test((e && (e.name + ' ' + e.message)) || '')) {
          if (typeof Store.onQuotaError === 'function') Store.onQuotaError(e);
        }
      }
    }, 0);
  }

  function reset() {
    db = defaultDB();
    try { global.localStorage.removeItem(KEY); } catch (e) { }
    save();
    return db;
  }

  function exportJSON() { return JSON.stringify(load(), null, 2); }

  function importJSON(text) {
    var obj = JSON.parse(text);
    if (!obj || !obj.user) throw new Error('备份文件格式不正确');
    db = obj;
    save();
    return db;
  }

  /* ---------------- 通用集合操作 ---------------- */
  function coll(name) { return load()[name]; }

  function insert(name, obj) { coll(name).push(obj); save(); return obj; }

  function find(name, idKey, id) {
    var list = coll(name);
    for (var i = 0; i < list.length; i++) if (list[i][idKey] === id) return list[i];
    return null;
  }

  function update(name, idKey, id, patch) {
    var o = find(name, idKey, id);
    if (!o) return null;
    for (var k in patch) o[k] = patch[k];
    save();
    return o;
  }

  function where(name, fn) { return coll(name).filter(fn); }

  function latest(name) {
    var list = coll(name);
    return list.length ? list[list.length - 1] : null;
  }

  /* ---------------- 实体快捷方法 ---------------- */
  var Store = {
    // ---- User ----
    getUser: function () { return load().user; },
    updateUser: function (patch) {
      var u = load().user;
      for (var k in patch) u[k] = patch[k];
      save();
      return u;
    },
    // ---- Settings ----
    getSettings: function () { return load().settings; },
    updateSettings: function (patch) {
      var s = load().settings;
      for (var k in patch) s[k] = patch[k];
      save();
      return s;
    },
    // ---- Topic ----
    addTopic: function (t) {
      t.topic_id = t.topic_id || uid('topic');
      t.created_at = t.created_at || nowISO();
      return insert('topics', t);
    },
    getTopic: function (id) { return find('topics', 'topic_id', id); },
    listTopics: function () { return coll('topics'); },
    recentTopicNames: function (days) {
      days = days || load().settings.recent_topic_window || 3;
      var since = Date.now() - days * 86400000;
      return coll('topics')
        .filter(function (t) { return parseDate(t.created_at).getTime() >= since; })
        .map(function (t) { return t.name || t.topic_name; })
        .filter(Boolean);
    },
    // ---- Article ----
    addArticle: function (a) {
      a.article_id = a.article_id || uid('article');
      a.created_at = a.created_at || nowISO();
      return insert('articles', a);
    },
    getArticle: function (id) { return find('articles', 'article_id', id); },
    listArticles: function () { return coll('articles'); },
    latestArticle: function () { return latest('articles'); },
    // ---- Vocabulary ----
    addVocabulary: function (v) {
      var exist = coll('vocabulary').filter(function (x) {
        return String(x.word).toLowerCase() === String(v.word).toLowerCase();
      })[0];
      if (exist) {
        // 旧词复现：尚未掌握且排期在未来的词，提前到今天复习
        if (!exist.mastered && exist.next_review_at && exist.next_review_at > dateStr()) {
          exist.next_review_at = dateStr();
          exist.encounter_count = (exist.encounter_count || 0) + 1;
          save();
        }
        return exist; // 去重
      }
      v.word_id = v.word_id || uid('word');
      v.review_count = v.review_count || 0;
      v.ease = v.ease === undefined ? 0 : v.ease;
      v.mastered = !!v.mastered;
      v.last_reviewed_at = v.last_reviewed_at || null;
      v.next_review_at = v.next_review_at || dateStr();
      v.created_at = v.created_at || nowISO();
      return insert('vocabulary', v);
    },
    addVocabularyBulk: function (arr) {
      var out = [];
      for (var i = 0; i < arr.length; i++) out.push(this.addVocabulary(arr[i]));
      return out;
    },
    listVocabulary: function () { return coll('vocabulary'); },
    updateVocabulary: function (id, patch) { return update('vocabulary', 'word_id', id, patch); },
    // ---- Expression ----
    addExpression: function (e) {
      var exist = coll('expressions').filter(function (x) {
        return x.original_expression === e.original_expression;
      })[0];
      if (exist) return exist;
      e.expression_id = e.expression_id || uid('exp');
      e.created_at = e.created_at || nowISO();
      return insert('expressions', e);
    },
    addExpressionBulk: function (arr) {
      var out = [];
      for (var i = 0; i < arr.length; i++) out.push(this.addExpression(arr[i]));
      return out;
    },
    listExpressions: function () { return coll('expressions'); },
    // ---- SpeakingSession ----
    addSpeakingSession: function (s) {
      s.session_id = s.session_id || uid('speak');
      s.messages = s.messages || [];
      s.corrections = s.corrections || [];
      s.feedback = s.feedback || [];
      s.round = s.round || 0;
      s.created_at = s.created_at || nowISO();
      s.updated_at = nowISO();
      return insert('speaking_sessions', s);
    },
    getSpeakingSession: function (id) { return find('speaking_sessions', 'session_id', id); },
    updateSpeakingSession: function (id, patch) {
      patch.updated_at = nowISO();
      return update('speaking_sessions', 'session_id', id, patch);
    },
    listSpeakingSessions: function () { return coll('speaking_sessions'); },
    // ---- StorySession ----
    addStorySession: function (s) {
      s.story_session_id = s.story_session_id || uid('story');
      s.history = s.history || [];
      s.created_at = s.created_at || nowISO();
      s.updated_at = nowISO();
      return insert('story_sessions', s);
    },
    getStorySession: function (id) { return find('story_sessions', 'story_session_id', id); },
    updateStorySession: function (id, patch) {
      patch.updated_at = nowISO();
      return update('story_sessions', 'story_session_id', id, patch);
    },
    listStorySessions: function () { return coll('story_sessions'); },
    latestStorySession: function () { return latest('story_sessions'); },
    // ---- DailyPlan ----
    upsertDailyPlan: function (date, patch) {
      var p = where('daily_plans', function (x) { return x.date === date; })[0];
      if (!p) {
        p = {
          plan_id: uid('plan'),
          user_id: load().user.user_id,
          date: date,
          topics: [],
          steps: [],
          completed_steps: [],
          notes: '',
          created_at: nowISO()
        };
        insert('daily_plans', p);
      }
      for (var k in patch) p[k] = patch[k];
      save();
      return p;
    },
    getDailyPlan: function (date) {
      return where('daily_plans', function (x) { return x.date === date; })[0] || null;
    },
    listDailyPlans: function () { return coll('daily_plans'); },
    // ---- Stats ----
    bumpStat: function (key, n) {
      var s = load().stats;
      s[key] = (s[key] || 0) + (n === undefined ? 1 : n);
      save();
      return s;
    },
    markActiveDay: function (date) {
      var s = load().stats;
      date = date || dateStr();
      if (s.days_active.indexOf(date) === -1) { s.days_active.push(date); save(); }
      return s;
    },
    getStats: function () { return load().stats; },
    // ---- 全局 ----
    raw: load,
    save: save,
    reset: reset,
    exportJSON: exportJSON,
    importJSON: importJSON,
    // ---- 工具 ----
    uid: uid,
    dateStr: dateStr,
    nowISO: nowISO,
    parseDate: parseDate,
    addDays: addDays,
    daysBetween: daysBetween,
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    LEVELS: LEVELS
  };

  global.ELS = global.ELS || {};
  global.ELS.store = Store;
})(window);
