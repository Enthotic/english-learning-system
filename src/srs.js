/* =============================================================
 * srs.js —— 简易间隔重复（SM-0 变体）
 * ============================================================= */
(function (global) {
  'use strict';

  var Store = global.ELS.store;

  // 复习间隔阶梯（天）
  var LADDER = [0, 1, 2, 4, 7, 15, 30, 60];

  function intervalFor(count) {
    var i = Math.min(Math.max(count, 0), LADDER.length - 1);
    return LADDER[i];
  }

  var SRS = {
    LADDER: LADDER,

    /** 今日到期 + 今日新词 */
    todayQueue: function (date) {
      date = date || Store.dateStr();
      var list = Store.listVocabulary();
      var due = [], fresh = [];
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        if (w.mastered) continue;
        if (!w.last_reviewed_at && w.next_review_at && w.next_review_at <= date) fresh.push(w);
        else if (w.last_reviewed_at && w.next_review_at && w.next_review_at <= date) due.push(w);
      }
      return { due: due, fresh: fresh, all: fresh.concat(due) };
    },

    /** 认识：推进一个阶梯 */
    reviewKnown: function (word_id) {
      var w = Store.updateVocabulary(word_id, {});
      if (!w) return null;
      var count = (w.review_count || 0) + 1;
      var next = Store.addDays(Store.dateStr(), intervalFor(count));
      return Store.updateVocabulary(word_id, {
        review_count: count,
        ease: (w.ease || 0) + 1,
        last_reviewed_at: Store.dateStr(),
        next_review_at: next,
        mastered: count >= 5 && intervalFor(count) >= 30
      });
    },

    /** 忘记：回退一级，当天重来 */
    reviewForgot: function (word_id) {
      var w = Store.updateVocabulary(word_id, {});
      if (!w) return null;
      var count = Math.max(0, (w.review_count || 0) - 1);
      return Store.updateVocabulary(word_id, {
        review_count: count,
        ease: Math.max(0, (w.ease || 0) - 1),
        last_reviewed_at: Store.dateStr(),
        next_review_at: Store.dateStr(),
        mastered: false
      });
    },

    /** 未来 7 天复习负荷预测 */
    forecast: function (days) {
      days = days || 7;
      var out = [], today = Store.dateStr();
      for (var i = 0; i < days; i++) {
        var d = Store.addDays(today, i);
        var n = Store.listVocabulary().filter(function (w) {
          return !w.mastered && w.next_review_at === d;
        }).length;
        out.push({ date: d, count: n });
      }
      return out;
    },

    stats: function () {
      var list = Store.listVocabulary();
      var q = SRS.todayQueue();
      return {
        total: list.length,
        mastered: list.filter(function (w) { return w.mastered; }).length,
        due_today: q.all.length,
        new_today: q.fresh.length
      };
    }
  };

  global.ELS.srs = SRS;
})(window);
