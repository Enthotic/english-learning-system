/* =============================================================
 * prompts.js —— AI Prompt 管理服务
 * 注册表式：场景 key -> { role, template, schema, vars }
 * 支持：变量注入 / 难度调制 / JSON 约束自动追加
 * ============================================================= */
(function (global) {
  'use strict';

  /* ---------- JSON Schema（用于约束输出，同时作为解析兜底） ---------- */
  var SCHEMAS = {
    topic: {
      topic_name: 'string',
      topic_category: 'string',
      difficulty: 'A2|B1|B2|C1|C2',
      why_this_topic: 'string',
      source_url: 'string (optional)',
      discussion_angles: 'string[] (2-3 items, English)'
    },
    article: {
      title: 'string',
      original_text: 'string (180-250 words)',
      summary: 'string[] (3-5 English bullets)',
      key_vocabulary: [{
        word: 'string', phonetic: 'string', en_definition: 'string',
        cn_definition: 'string', example_sentence: 'string'
      }],
      useful_expressions: 'string[] (3-5 items)',
      comprehension_questions: 'string[] (3 items, English)',
      speaking_task: 'string (60s task)',
      difficulty_level: 'A2|B1|B2|C1|C2'
    },
    speaking_turn: {
      ai_reply: 'string (natural English, one question only)',
      correction: 'string (empty if no error; start with "Better version: ")',
      feedback: 'null | {vocabulary:string, grammar:string, fluency:string, logic:string}'
    },
    story_segment: {
      story_segment_id: 'string',
      story_text: 'string (100-150 words)',
      choices: { A: 'string', B: 'string', C: 'string' },
      new_words: [{ word: 'string', cn_definition: 'string' }],
      speaking_prompt: 'string',
      story_state: {
        current_scene: 'string',
        character_relationships: 'object',
        player_decisions: 'string[]',
        unlocked_clues: 'string[]',
        ending_candidates: 'string[]'
      },
      next_segment_hint: 'string'
    },
    vocabulary_pack: {
      vocabulary: [{
        word: 'string', phonetic: 'string', en_definition: 'string',
        cn_definition: 'string', example_sentence: 'string'
      }],
      expressions: [{ original_expression: 'string', pattern: 'string' }]
    }
  };

  /* ---------- Prompt 注册表 ---------- */
  var PROMPTS = {
    /* 1. AI Editor：自动选题 */
    ai_editor: {
      name: 'AI Editor',
      role: '你是一名英语内容主编。',
      build: function (v) {
        return [
          '请根据用户水平、兴趣和最近学习记录，自动选择 1 个适合学习的英文资讯主题。',
          '',
          '【用户水平】' + v.level,
          '【主题偏好】' + v.preferences.join('、'),
          '【最近已学主题（必须避开，不得重复）】' + (v.recent.length ? v.recent.join('、') : '无'),
          '【今日日期】' + v.date,
          '【学习历史摘要】' + (v.history || '暂无'),
          '',
          '选题标准：',
          '1. 适合 ' + v.level + ' 阅读；',
          '2. 有明确观点，便于讨论，能自然延伸成口语对话和互动故事；',
          '3. 贴近真实英文媒体（BBC / The Guardian / Reuters 等）风格；',
          '4. 覆盖一个具体、可讲清楚的切入点，不要空泛；',
          '5. 严格避免敏感政治争议、暴力、成人内容、违法内容。',
          '',
          '输出 topic_name、topic_category、difficulty、why_this_topic、discussion_angles。',
          'topic_name 用英文（媒体标题式），why_this_topic 用中文，2-3 句说明学习价值。',
          'topic_category 必须从主题偏好中选择。'
        ].join('\n');
      },
      schema: SCHEMAS.topic
    },

    /* 2. Reading Coach：阅读材料 */
    reading_coach: {
      name: 'Reading Coach',
      role: '你是一名英语学习教练。',
      build: function (v) {
        var src = v.source_text
          ? ['【用户提供的原文/链接内容】', v.source_text, '',
            '要求：基于以上原文生成学习材料。如果原文更难，请简化到 ' + v.level + '，但必须保留核心观点与关键事实，不改变原意。'].join('\n')
          : ['【主题】' + v.topic_name + '（类别：' + v.topic_category + '）', '',
            '要求：请自行构思一篇 180–250 词的英文短资讯，难度 ' + v.level + '，风格贴近真实英文媒体，有明确观点。'].join('\n');
        return [
          src, '',
          '请输出以下内容：',
          '1. title：英文标题；',
          '2. original_text：正文，严格 180–250 词，' + v.level + ' 难度；',
          '3. summary：3–5 条英文要点（每条约 15–25 词）；',
          '4. key_vocabulary：5–8 个关键词汇，每项含 word / phonetic / en_definition / cn_definition / example_sentence；',
          '   - en_definition 用简单英文（B1 可读），cn_definition 用中文；',
          '   - example_sentence 必须来自或贴近原文语境；',
          '5. useful_expressions：3–5 个可模仿句型（地道、可复用）；',
          '6. comprehension_questions：3 个英文理解问题（含至少一个 inferential 问题）；',
          '7. speaking_task：1 个 60 秒口语任务（给出具体情境和要求）；',
          '8. difficulty_level：从 A2/B1/B2/C1/C2 中选择。',
          '',
          '约束：避免敏感政治争议、暴力、成人、违法内容。'
        ].join('\n');
      },
      schema: SCHEMAS.article
    },

    /* 3. Speaking Partner：口语对话 */
    speaking_partner: {
      name: 'Speaking Partner',
      role: '你是一名英语交流伙伴。',
      build: function (v) {
        var lines = [
          '围绕当前文章主题与用户进行自然英文对话。',
          '',
          '【文章标题】' + v.title,
          '【文章要点】' + (v.summary || []).join(' / '),
          '【用户水平】' + v.level,
          '【当前轮次】第 ' + v.round + ' 轮',
          '',
          '对话记录：'
        ];
        for (var i = 0; i < (v.messages || []).length; i++) {
          var m = v.messages[i];
          lines.push((m.role === 'user' ? 'User: ' : 'You: ') + m.content);
        }
        lines.push('User: ' + v.user_message);
        lines.push('');
        lines.push('严格规则：');
        lines.push('1. 每次只问 **一个** 问题，语气自然，像朋友聊天，不要像考试；');
        lines.push('2. **绝不替用户回答**，不要复述用户刚说过的话；');
        lines.push('3. 如果用户回答有语言错误，用 "Better version: …" 开头轻轻纠正 1 处（错误不明显则 correction 为空字符串）；');
        lines.push('4. 可以自然地追问，但追问要顺着用户的话往下接；');
        lines.push('5. 用户英文水平 ' + v.level + '，你的用词难度不要超过该水平；');
        lines.push('6. ai_reply 中除了问题，可以有一句非常简短的回应（1 句）。');
        if (v.need_feedback) {
          lines.push('');
          lines.push('【本次需要反馈】这是第 ' + v.round + ' 轮（每 ' + v.feedback_every + ' 轮一次），请额外给出简短反馈，');
          lines.push('feedback 对象包含 vocabulary / grammar / fluency / logic 四条，每条一句话，具体、可操作、鼓励式。');
        } else {
          lines.push('');
          lines.push('【本次不需要反馈】feedback 请返回 null。');
        }
        return lines.join('\n');
      },
      schema: SCHEMAS.speaking_turn
    },

    /* 4. Story Director：互动故事 */
    story_director: {
      name: 'Story Director',
      role: '你是一名互动故事引擎。',
      build: function (v) {
        var lines = [
          '请根据当前主题生成一个英文互动故事片段。',
          '',
          '【主题】' + v.topic_name + '（' + v.topic_category + '）',
          '【难度】' + v.level + '，片段长度 ' + v.story_length[0] + '–' + v.story_length[1] + ' 词',
          '【当前故事状态】' + JSON.stringify(v.state),
          '【已发生剧情摘要】' + (v.history_summary || '（这是第一段，请开篇并介绍主角与场景）'),
          v.choice ? '【用户刚刚的选择】' + v.choice + '. ' + (v.choice_text || '') : '',
          '',
          '要求：',
          '1. story_text：100–150 词英文正文，剧情必须严格承接上文，不得前后矛盾；',
          '2. choices：A / B / C 三个选项，每个 10–18 词，必须 genuinely 影响后续情节走向；',
          '3. new_words：不超过 5 个本段新词，附中文释义；',
          '4. speaking_prompt：1 个可开口练习的英文句子（用户可朗读或回答）；',
          '5. story_state：输出**更新后的完整状态**（current_scene / character_relationships / player_decisions / unlocked_clues / ending_candidates），',
          '   必须包含历史信息，player_decisions 要追加本次选择；',
          '6. next_segment_hint：一句话提示下一段可能的走向（不剧透具体结果）；',
          '7. 如剧情已可收束，ending_candidates 中给出候选结局，并让选项之一指向结局。',
          '',
          '约束：避免暴力、成人、违法内容；人物关系与线索前后一致。'
        ];
        return lines.filter(Boolean).join('\n');
      },
      schema: SCHEMAS.story_segment
    },

    /* 5. Vocabulary Manager：生词抽取 */
    vocabulary_manager: {
      name: 'Vocabulary Manager',
      role: '你是一名词汇学习助手。',
      build: function (v) {
        return [
          '请从以下材料中提取值得学习的词汇和表达，生成复习卡片。',
          '',
          '【材料来源】' + v.source_type,
          '【材料内容】',
          v.text,
          '',
          '【需要优先复现的旧词】' + (v.old_words.length ? v.old_words.join('、') : '无'),
          '',
          '要求：',
          '1. vocabulary：5–8 个词，每项含 word / phonetic / en_definition / cn_definition / example_sentence；',
          '   - 优先选 B1–B2 高频、可迁移的词；',
          '   - en_definition 用简单英文，cn_definition 用中文；',
          '2. expressions：3–5 个可模仿句型，含 original_expression 与 pattern（抽象出的可替换模式）；',
          '3. 如果"需要优先复现的旧词"在材料中自然出现，优先收录它们。'
        ].join('\n');
      },
      schema: SCHEMAS.vocabulary_pack
    }
  };

  /* ---------- 难度调制 ---------- */
  var LEVEL_ORDER = ['A2', 'B1', 'B2', 'C1', 'C2'];

  function shiftLevel(level, delta) {
    var base = String(level || 'B1-B2');
    if (base.indexOf('-') > -1) base = base.split('-')[1];
    var i = LEVEL_ORDER.indexOf(base);
    if (i === -1) i = 1;
    i = Math.min(LEVEL_ORDER.length - 1, Math.max(0, i + delta));
    return LEVEL_ORDER[i];
  }

  function bandOf(level) {
    var l = String(level || 'B1');
    var i = LEVEL_ORDER.indexOf(l);
    if (i === -1) return 'B1-B2';
    return i === 0 ? 'A2-B1' : (i === LEVEL_ORDER.length - 1 ? 'C1-C2' : LEVEL_ORDER[i] + '-' + LEVEL_ORDER[i + 1]);
  }

  var DIFFICULTY_HINT = {
    'A2': 'Use very simple sentence structures, common everyday words (top 1500), short sentences.',
    'B1': 'Use clear, mostly simple sentences; allow common B1 connectors.',
    'B2': 'Allow compound-complex sentences, some topic-specific vocabulary, and opinion language.',
    'C1': 'Allow sophisticated structures, nuanced vocabulary, and abstract argumentation.',
    'C2': 'Allow near-native complexity, idiomatic and precise expression.'
  };

  function difficultyHint(level) {
    var l = String(level || 'B1-B2').split('-')[0];
    return DIFFICULTY_HINT[l] || DIFFICULTY_HINT['B1'];
  }

  /* ---------- 渲染 ---------- */
  function render(key, vars) {
    var p = PROMPTS[key];
    if (!p) throw new Error('未知 Prompt 场景: ' + key);
    vars = vars || {};
    var level = vars.level || global.ELS.store.getUser().preferences.difficulty || 'B1-B2';
    vars.level = level;
    var user = p.build(vars);
    var system = p.role + '\n' + difficultyHint(level) +
      '\n你必须只输出一个 JSON 对象，不要输出 markdown 代码块、不要输出任何解释文字。' +
      '\nJSON 结构必须严格符合：' + JSON.stringify(p.schema);
    return {
      key: key,
      name: p.name,
      system: system,
      user: user,
      schema: p.schema
    };
  }

  function list() {
    var out = [];
    for (var k in PROMPTS) out.push({ key: k, name: PROMPTS[k].name });
    return out;
  }

  /** 自定义覆盖：允许用户在设置里改写某个场景的 role 前缀 */
  var overrides = {};
  function setOverride(key, text) {
    overrides[key] = text;
    if (PROMPTS[key] && text) PROMPTS[key].role = text;
  }
  function getOverride(key) { return overrides[key] || ''; }

  global.ELS = global.ELS || {};
  global.ELS.prompts = {
    render: render,
    list: list,
    schemas: SCHEMAS,
    registry: PROMPTS,
    shiftLevel: shiftLevel,
    bandOf: bandOf,
    difficultyHint: difficultyHint,
    LEVEL_ORDER: LEVEL_ORDER,
    setOverride: setOverride,
    getOverride: getOverride
  };
})(window);
