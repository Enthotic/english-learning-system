/* =============================================================
 * ai.js —— 大模型客户端
 *  1) OpenAI 兼容协议（/chat/completions）
 *  2) 未配置 API Key 或开启 Mock 时，使用内置离线引擎生成内容
 * ============================================================= */
(function (global) {
  'use strict';

  /* ---------------- JSON 容错解析 ---------------- */
  function extractJSON(text) {
    if (!text) throw new Error('AI 返回为空');
    var s = String(text).trim();
    // 去掉 markdown 代码块
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    var start = s.search(/[\{\[]/);
    if (start === -1) throw new Error('AI 返回不是 JSON：' + s.slice(0, 200));
    var open = s[start], close = open === '{' ? '}' : ']';
    var end = s.lastIndexOf(close);
    if (end <= start) throw new Error('AI 返回的 JSON 不完整');
    var body = s.slice(start, end + 1);
    try {
      return JSON.parse(body);
    } catch (e) {
      // 去掉尾随逗号再试一次
      body = body.replace(/,\s*([\}\]])/g, '$1');
      return JSON.parse(body);
    }
  }

  /* ---------------- 真实 API ---------------- */
  function callAPI(system, user, opts) {
    var st = global.ELS.store.getSettings();
    var base = (st.baseUrl || '').replace(/\/+$/, '');
    var url = base + '/chat/completions';
    var payload = {
      model: st.model || 'gpt-4o-mini',
      temperature: opts && opts.temperature != null ? opts.temperature : (st.temperature || 0.7),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    };

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 120000);

    function post(withJsonMode) {
      var p = JSON.parse(JSON.stringify(payload));
      if (withJsonMode) p.response_format = { type: 'json_object' };
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (st.apiKey || '')
        },
        body: JSON.stringify(p),
        signal: ctrl.signal
      }).then(function (r) {
        return r.text().then(function (t) {
          if (!r.ok) return { ok: false, status: r.status, text: t };
          return { ok: true, text: t };
        });
      });
    }

    return post(true).then(function (res) {
      if (!res.ok && /response_format|unsupported|json_object/i.test(res.text || '')) {
        return post(false);
      }
      return res;
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('AI 接口错误 ' + res.status + '：' + String(res.text).slice(0, 300));
      var data = JSON.parse(res.text);
      var content = data &&
        data.choices && data.choices[0] &&
        (data.choices[0].message && data.choices[0].message.content || data.choices[0].text);
      if (!content) throw new Error('AI 返回缺少 content 字段');
      return extractJSON(content);
    }, function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('AI 请求超时');
      throw err;
    });
  }

  /* =============================================================
   * Mock 引擎（离线兜底）
   * ============================================================= */
  var TOPIC_POOL = [
    { n: 'Why More Cities Are Turning Empty Offices Into Homes', c: '城市生活', why: '该话题覆盖住房、城市规划与生活方式高频词汇，观点明确，天然适合讨论"你愿意住在办公室改造的公寓里吗"，也能延伸成一场关于社区改造的互动故事。', a: ['Is this a real solution to the housing crisis?', 'What kind of buildings should be converted first?'] },
    { n: 'The Rise of Four-Day Work Weeks in Small Companies', c: '职场', why: '职场类话题贴近真实工作场景，涉及 productivity、well-being 等 B2 高频词，容易展开"效率与健康哪个更重要"的口语辩论。', a: ['Does a shorter week really improve productivity?', 'Which industries could never adopt this?'] },
    { n: 'How AI Tutors Are Changing After-School Study', c: '教育', why: '教育与 AI 的交叉点，词汇实用、观点有争议，能自然引出"AI 会不会取代老师"的口语任务与校园题材故事。', a: ['Can an AI tutor replace a human teacher?', 'Should schools set limits on AI homework help?'] },
    { n: 'Why Young Travellers Are Choosing Slow Train Journeys', c: '旅行', why: '旅行话题轻松、画面感强，适合练描述性语言；"慢旅行 vs 效率"的对立观点便于口语表达训练。', a: ['Is slow travel worth the extra time and cost?', 'How does transport shape a trip?'] },
    { n: 'Can Walking Meetings Really Improve Team Thinking?', c: '健康', why: '健康与职场结合，篇幅小、观点新，包含大量可迁移动词搭配，60 秒口语任务容易组织。', a: ['Does movement help creative thinking?', 'Should offices redesign their meeting culture?'] },
    { n: 'Small Shops Are Using Data to Compete With Giants', c: '商业', why: '商业类话题含数据、竞争等常见表达，难度可控，能延伸到"小生意如何生存"的故事线。', a: ['Can data really level the playing field?', 'What do small shops lose when they go digital?'] },
    { n: 'Museums Are Experimenting With Phone-Free Hours', c: '文化', why: '文化类话题观点鲜明，涉及注意力与体验的词汇，适合讨论"科技是否破坏了文化体验"。', a: ['Should public spaces limit phone use?', 'How do phones change the way we look at art?'] },
    { n: 'Cities Are Planting Trees to Cool Down Summer Streets', c: '环境', why: '环境类热词密集（heat, shade, urban, sustainable），因果结构清晰，便于练习解释与论证。', a: ['Are green solutions enough to fight urban heat?', 'Who should pay for city greening?'] },
    { n: 'Why Some Workers Are Choosing to Learn a Trade Again', c: '职场', why: '职业选择话题贴近生活决策，表达实用，口语任务可以围绕"稳定 vs 兴趣"展开。', a: ['Is a university degree still the safest path?', 'What skills will stay valuable in ten years?'] },
    { n: 'The Quiet Return of Handwritten Letters', c: '文化', why: '反差感强、情绪色彩足，适合练习对比句式与描述感受，故事延展空间大。', a: ['Why do people still value slow communication?', 'Does the medium change the message?'] }
  ];

  var VOCAB_POOL = [
    { word: 'breakthrough', phonetic: '/ˈbreɪkθruː/', en_definition: 'an important development or discovery that makes progress possible', cn_definition: 'n. 突破；重大进展', example_sentence: 'The new battery design was described as a breakthrough for clean transport.' },
    { word: 'surge', phonetic: '/sɜːrdʒ/', en_definition: 'a sudden and large increase in something', cn_definition: 'n./v. 激增；猛增', example_sentence: 'There has been a surge in demand for flexible office space.' },
    { word: 'widespread', phonetic: '/ˈwaɪdspred/', en_definition: 'existing or happening in many places or among many people', cn_definition: 'adj. 普遍的；广泛的', example_sentence: 'Widespread support for the idea surprised even its organisers.' },
    { word: 'tackle', phonetic: '/ˈtækl/', en_definition: 'to make a determined effort to deal with a difficult problem', cn_definition: 'v. 应对；处理（难题）', example_sentence: 'The city plans to tackle rising rents by building more small flats.' },
    { word: 'incentive', phonetic: '/ɪnˈsentɪv/', en_definition: 'something that encourages a person to do something', cn_definition: 'n. 激励；动机', example_sentence: 'Tax incentives have encouraged companies to invest in training.' },
    { word: 'sustainable', phonetic: '/səˈsteɪnəbl/', en_definition: 'able to continue for a long time without causing damage', cn_definition: 'adj. 可持续的', example_sentence: 'Officials want growth that is sustainable rather than fast.' },
    { word: 'despite', phonetic: '/dɪˈspaɪt/', en_definition: 'without being affected or prevented by something', cn_definition: 'prep. 尽管；虽然', example_sentence: 'Despite the cost, many families moved closer to the city centre.' },
    { word: 'estimate', phonetic: '/ˈestɪmeɪt/', en_definition: 'to roughly calculate a value, size or cost', cn_definition: 'v./n. 估计；估算', example_sentence: 'Researchers estimate that the change will affect one in five workers.' },
    { word: 'adopt', phonetic: '/əˈdɑːpt/', en_definition: 'to start using a particular method, idea or behaviour', cn_definition: 'v. 采用；采纳', example_sentence: 'Several schools adopted the shorter timetable last September.' },
    { word: 'impact', phonetic: '/ˈɪmpækt/', en_definition: 'a strong effect or influence on someone or something', cn_definition: 'n./v. 影响；冲击', example_sentence: 'The policy had an immediate impact on small businesses.' }
  ];

  var EXPR_POOL = [
    'One of the biggest questions is whether …',
    'What makes this interesting is that …',
    'It is not just about X — it is about Y.',
    'Some people argue that …, while others believe …',
    'From my point of view, the real issue is …',
    'The numbers suggest that …',
    'On the surface it looks like …, but in practice …'
  ];

  var ARTICLE_TPL = [
    '{T} has moved from the edge of public debate to the centre of it over the past two years. What used to sound like a specialist concern is now part of everyday conversation — in offices, classrooms and family group chats. Supporters say the change is long overdue. Critics warn that the pace may be faster than most people can comfortably absorb.',
    'The numbers help explain why attention has grown so quickly. Recent surveys suggest that a clear majority of young people now expect {T_lower} to shape their working lives within five years. Companies and institutions have responded by investing heavily, and several large employers have already begun to rewrite their internal rules. "We cannot pretend this is a distant issue any more," one manager said last month.',
    'Yet the picture is not simple. Access remains uneven, and the benefits are not shared equally. Experts argue that the real test will not be the idea itself, but whether institutions can adapt fast enough to make it work in practice. For ordinary people, the practical question is unchanged: what does this mean for the way we live and work?'
  ];

  var QUESTION_TPL = [
    'What is the main reason {T_lower} has attracted so much attention recently?',
    'According to the article, why do critics warn about the speed of this change?',
    'What does the writer suggest is the "real test" for the future?'
  ];

  var SPEAKING_TASK_TPL = 'In 60 seconds, explain whether you think {T_lower} will genuinely change everyday life in the next five years. Give one clear reason, one concrete example, and end with what you would do about it.';

  var OPEN_QUESTIONS = [
    'Before we go deeper — what was your first reaction when you read this article?',
    'Interesting. Do you think this change would be welcomed where you live? Why?',
    'That is a fair point. What kind of person do you think benefits most from it?',
    'Let me ask you this: if you had to explain this issue to a friend in one sentence, what would you say?',
    'Good. Now imagine the opposite — what is the strongest argument against your view?',
    'You mentioned something important. How do you think older and younger people see this differently?',
    'Let us make it practical: what would you personally change about this situation?',
    'One more thing — do you think money or culture matters more in making this work?',
    'That is clear. If you could ask the writer one question, what would it be?',
    'Last one for now: five years from now, do you expect this to be normal or forgotten?'
  ];

  var FEEDBACK_POOL = {
    vocabulary: [
      'Try replacing general words like "good" or "bad" with more precise ones such as "effective", "risky" or "affordable".',
      'You repeated a few basic verbs; try "argue", "suggest" and "admit" to sound more natural.',
      'Good range overall. One gap: you rarely use linkers like "however" and "as a result".'
    ],
    grammar: [
      'Watch subject–verb agreement in longer sentences, especially after "the number of…".',
      'Your past tense is solid, but articles (a / the) slip when you speak quickly — slow down slightly.',
      'Try one more complex structure per answer, e.g. "Although X happened, Y still matters".'
    ],
    fluency: [
      'You pause before opinions. Begin with a fixed frame: "I would say that…" to buy thinking time.',
      'Good flow. Aim for 3–4 connected sentences instead of several short ones.',
      'Filler words ("you know", "like") appear often — a short silence is better than a filler.'
    ],
    logic: [
      'State your conclusion first, then give the reason — listeners follow you more easily.',
      'Your answers would be stronger with one concrete example to support each claim.',
      'Try to answer the actual question before adding extra background.'
    ]
  };

  var STORY_OPENINGS = {
    opening: 'Maya had worked in the same bright office for six years, but on Monday morning the building felt unfamiliar. Half the desks were gone, and a printed notice was taped to the glass door. It said the floor would become something else entirely by spring.\n\nShe had ten minutes before a meeting that would decide who stayed and who moved. Her phone buzzed with a message from her manager: "We need someone to lead the change. Interested?"\n\nMaya looked around the quiet room. Whatever she chose now would shape the next two years of her working life.'
  };

  var STORY_BRANCH = {
    'A': '{Name} chose the safest option available: to follow the plan exactly as written. It worked, but it felt strangely empty. Two days later, an unexpected email arrived — the numbers in the plan did not add up, and someone had already noticed.\n\nNow {Name} had to decide whether to report the problem and slow everything down, or quietly fix it alone before anyone else found out.',
    'B': '{Name} went against the obvious choice and asked for more time instead. The room went quiet. Then, to everyone\'s surprise, a colleague nodded and said the same question had been on their mind for weeks.\n\nThat small moment changed the atmosphere completely. But it also meant {Name} now carried a promise — and a deadline that was getting closer every day.',
    'C': '{Name} tried a third path: instead of choosing, {Name} asked everyone else what they actually wanted. The answers were messy, honest and far more useful than any report.\n\nBy Friday the team had a rough plan of its own. The only problem was that it depended on one person who had not spoken up yet — and that person was watching {Name} carefully.'
  };

  /** 由字符串派生稳定种子（不依赖 Date 解析，跨引擎安全） */
  function seedFrom(s) {
    var n = 0;
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 100000;
    return n;
  }

  function pick(arr, n, seed) {
    var out = [], src = arr.slice();
    seed = seed || 0;
    for (var i = 0; i < n && src.length; i++) {
      var idx = (seed * 7 + i * 3) % src.length;
      out.push(src.splice(idx, 1)[0]);
    }
    return out;
  }

  function tpl(s, topic) {
    return String(s)
      .replace(/\{T_lower\}/g, String(topic).toLowerCase())
      .replace(/\{T\}/g, topic);
  }

  function normalizeTopicName(name) {
    return String(name || 'this trend');
  }

  /* ---- Mock: 按场景生成 ---- */
  var MOCK = {
    ai_editor: function (v) {
      var recent = v.recent || [];
      var pool = TOPIC_POOL.filter(function (t) { return recent.indexOf(t.n) === -1; });
      if (!pool.length) pool = TOPIC_POOL;
      var pref = v.preferences || [];
      var matched = pool.filter(function (t) { return pref.indexOf(t.c) > -1; });
      if (matched.length) pool = matched;
      var seed = seedFrom(v.date);
      var t = pool[seed % pool.length];
      return {
        topic_name: t.n,
        topic_category: t.c,
        difficulty: String(v.level || 'B1-B2').split('-').pop(),
        why_this_topic: t.why,
        source_url: '',
        discussion_angles: t.a
      };
    },

    reading_coach: function (v) {
      var topic = normalizeTopicName(v.topic_name);
      var seed = topic.length;
      var words = pick(VOCAB_POOL, 6, seed).map(function (w) {
        return {
          word: w.word, phonetic: w.phonetic, en_definition: w.en_definition,
          cn_definition: w.cn_definition,
          example_sentence: w.example_sentence
        };
      });
      var text = ARTICLE_TPL.map(function (p) { return tpl(p, topic); }).join('\n\n');
      return {
        title: topic,
        original_text: text,
        summary: [
          'The topic has quickly moved from a specialist concern to mainstream public debate.',
          'Supporters see it as overdue progress, while critics worry the pace is too fast.',
          'Surveys suggest most young people expect it to affect their working lives within five years.',
          'Benefits are uneven, and access to them is still unequal.',
          'Experts say the real test is whether institutions can adapt quickly enough.'
        ],
        key_vocabulary: words,
        useful_expressions: pick(EXPR_POOL, 4, seed),
        comprehension_questions: QUESTION_TPL.map(function (q) { return tpl(q, topic); }),
        speaking_task: tpl(SPEAKING_TASK_TPL, topic),
        difficulty_level: String(v.level || 'B1-B2').split('-').pop()
      };
    },

    speaking_partner: function (v) {
      var round = v.round || 1;
      var q = OPEN_QUESTIONS[(round - 1) % OPEN_QUESTIONS.length];
      var msg = String(v.user_message || '');
      var correction = MOCK._correct(msg);
      var feedback = null;
      if (v.need_feedback) {
        var s = msg.length % 3;
        feedback = {
          vocabulary: FEEDBACK_POOL.vocabulary[s],
          grammar: FEEDBACK_POOL.grammar[s],
          fluency: FEEDBACK_POOL.fluency[s],
          logic: FEEDBACK_POOL.logic[s]
        };
      }
      return { ai_reply: q, correction: correction, feedback: feedback };
    },

    _correct: function (msg) {
      var m = String(msg || '').trim();
      if (!m) return '';
      // [匹配规则, 替换串]
      var rules = [
        [/\bmore\s+(\w+er)\b/i, '$1'],
        [/\bi\s+am\s+agree\b/i, 'I agree'],
        [/\bdespite\s+of\b/i, 'despite'],
        [/\bdiscuss\s+about\b/i, 'discuss'],
        [/\bcan\s+able\s+to\b/i, 'can'],
        [/\bvery\s+much\s+like\b/i, 'really like'],
        [/\bi\s+think\s+its\b/i, 'I think it\'s']
      ];
      var fixed = m;
      for (var i = 0; i < rules.length; i++) {
        if (rules[i][0].test(m)) { fixed = m.replace(rules[i][0], rules[i][1]); break; }
      }
      fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
      if (!/[.!?]$/.test(fixed)) fixed += '.';

      if (fixed === m) {
        if (m.split(/\s+/).length < 6) {
          return 'Better version: ' + m + ' Try adding one reason, e.g. "because …"';
        }
        return '';
      }
      return 'Better version: ' + fixed;
    },

    story_director: function (v) {
      var state = v.state || {};
      var idx = (state.segment_index || 0);
      var name = 'Maya';
      var text, choices;
      if (idx === 0) {
        text = STORY_OPENINGS.opening;
        choices = {
          A: 'Reply "yes" immediately and take charge of the whole project.',
          B: 'Ask for a day to think, and talk to the team first.',
          C: 'Decline politely and keep your current role unchanged.'
        };
      } else {
        var tplText = STORY_BRANCH[v.choice] || STORY_BRANCH.A;
        text = tplText.replace(/\{Name\}/g, name);
        choices = {
          A: 'Report the problem honestly, even if it slows everything down.',
          B: 'Fix it quietly yourself before anyone notices the mistake.',
          C: 'Bring the whole team together and decide what to do next.'
        };
      }
      var newWords = pick(VOCAB_POOL, 3, idx + 2).map(function (w) {
        return { word: w.word, cn_definition: w.cn_definition };
      });
      var nextState = {
        current_scene: idx === 0 ? 'The half-empty office, Monday morning' : 'Two days later, after the decision',
        character_relationships: state.character_relationships || { 'Maya': 'protagonist', 'Manager': 'offered her the lead role' },
        player_decisions: (state.player_decisions || []).concat(v.choice ? [v.choice] : []),
        unlocked_clues: (state.unlocked_clues || []).concat(idx === 0 ? ['The building will be converted by spring'] : ['The plan\'s numbers do not add up']),
        ending_candidates: idx >= 2 ? ['ending_rebuild', 'ending_quiet_fix', 'ending_team_plan'] : (state.ending_candidates || [])
      };
      return {
        story_segment_id: 'seg_' + (idx + 1),
        story_text: text,
        choices: choices,
        new_words: newWords,
        speaking_prompt: 'Say it aloud: "If I were ' + name + ', I would choose option ' + (v.choice || 'A') + ' because …"',
        story_state: nextState,
        next_segment_hint: 'The consequences of your choice begin to reach people beyond the office.'
      };
    },

    vocabulary_manager: function (v) {
      var seed = String(v.text || '').length;
      return {
        vocabulary: pick(VOCAB_POOL, 6, seed).map(function (w) {
          return {
            word: w.word, phonetic: w.phonetic, en_definition: w.en_definition,
            cn_definition: w.cn_definition, example_sentence: w.example_sentence
          };
        }),
        expressions: pick(EXPR_POOL, 4, seed).map(function (e) {
          return { original_expression: e, pattern: e.replace(/…/g, '[your idea]') };
        })
      };
    }
  };

  /* ---------------- 统一入口 ---------------- */
  /**
   * @param {string} scenario  Prompt 场景 key
   * @param {object} vars      Prompt 变量（同时供 Mock 使用）
   * @returns {Promise<object>} 解析后的 JSON 对象
   */
  function complete(scenario, vars) {
    var rendered = global.ELS.prompts.render(scenario, vars);
    var st = global.ELS.store.getSettings();
    var useMock = st.mock || !st.apiKey;
    if (useMock && MOCK[scenario]) {
      // 模拟一点网络延迟，UI 更真实
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(MOCK[scenario](vars)); }, 220);
      });
    }
    if (useMock) {
      return Promise.reject(new Error('Mock 引擎未覆盖场景：' + scenario + '，请配置 API Key'));
    }
    return callAPI(rendered.system, rendered.user);
  }

  global.ELS = global.ELS || {};
  global.ELS.ai = {
    complete: complete,
    callAPI: callAPI,
    extractJSON: extractJSON,
    mockTopics: TOPIC_POOL,
    isMock: function () {
      var st = global.ELS.store.getSettings();
      return !!(st.mock || !st.apiKey);
    }
  };
})(window);
