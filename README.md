# 全自动英语互动学习系统（MVP）

零依赖、纯前端、可离线运行。没有大模型 API Key 时用内置 **Mock 引擎**跑通全链路；配了 Key 就切换成真实 AI 生成。

> 自检状态：`tools/logic-test.js` 71 项断言全部通过（8 个接口 + 8 条指令 + SRS + 持久化）。
> 运行方式：`cscript //nologo tools\logic-test.js`（Windows 自带 JScript，无需 Node）。

- 运行方式：**双击 `index.html`**（Chrome / Edge / Firefox 直接打开即可）；手机端见 **第七节：手机端 / PWA**
- 技术栈：原生 HTML + CSS + JS（ES5/ES6 兼容写法，classic script 加载，无需构建、无需 Node/Python）
- 数据存储：浏览器 `localStorage`（键 `els.db.v1`），可一键导出 / 导入 JSON 备份

---

## 一、系统架构设计

### 1.1 模块划分

```
┌───────────────────────────────────────────────────────────────┐
│  UI Layer  (index.html / ui.js / styles.css)                  │
│  今日计划 · 阅读 · 口语 · 故事 · 词库 · 设置 · 指令输入框      │
└────────────────────────┬──────────────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────────────┐
│  Command Layer  (commands.js)                                 │
│  换题 / 更难 / 更简单 / 开始口语 / 开始故事 / 复习 /           │
│  查看今日计划 / 继续故事                                       │
└────────────────────────┬──────────────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────────────┐
│  Service Layer  (services.js) —— 等价于后端 8 个 REST 接口     │
│  topicGenerate  articleGenerate  speakingStart  speakingMessage│
│  storyStart     storyChoose      vocabularyToday  planToday    │
└───────┬──────────────────────────────────────────┬────────────┘
        │                                          │
┌───────▼────────────┐                   ┌─────────▼────────────┐
│  AI Layer (ai.js)  │                   │  Data Layer (store.js│
│  OpenAI 兼容协议   │                   │  + srs.js)           │
│  + Mock 引擎兜底   │                   │  localStorage 持久化 │
└───────┬────────────┘                   └──────────────────────┘
        │
┌───────▼────────────────────────────────────────────────────────┐
│  Prompt Layer (prompts.js) —— 5 大场景 Prompt 模板 + 变量注入   │
│  ai_editor / reading_coach / speaking_partner /                │
│  story_director / vocabulary_manager                           │
└────────────────────────────────────────────────────────────────┘
```

### 1.2 数据流

```
[每日启动]
   planToday() ──► 生成/读取 DailyPlan（选题→阅读→口语→故事→复习 五步）
        │
        ▼
   topicGenerate() ──► Topic 落库（去重：最近 3 天主题不重复）
        │
        ▼
   articleGenerate(topic_id, source_text?) ──► Article 落库
        │                                        ├─► VocabularyItem[] 自动入库（进入 SRS 队列）
        │                                        └─► ExpressionItem[] 自动入库
        ▼
   speakingStart(article_id) ──► SpeakingSession（第 1 个问题）
        │  ⇅ speakingMessage() 循环（每 5 轮产出一次四维反馈）
        ▼
   storyStart(article_id) ──► StorySession（状态机初始化）
        │  ⇅ storyChoose() 循环（选择 → 更新 state → 下一段）
        ▼
   vocabularyToday() ──► 今日待复习（今日新词 + 到期旧词 SRS）
        │
        ▼
   Learning Tracker 汇总：学习天数、时长、词量、口语轮次、故事进度
```

### 1.3 关键接口一览

| 接口 | 方法 | 输入 | 输出 |
|---|---|---|---|
| `/api/topic/generate` | POST | `user_level, preferences, history` | `topic` |
| `/api/article/generate` | POST | `topic_id, source_text?` | `article` |
| `/api/speaking/start` | POST | `article_id` | `session_id, first_question` |
| `/api/speaking/message` | POST | `session_id, user_message` | `ai_reply, correction?, feedback?` |
| `/api/story/start` | POST | `topic_id \| article_id` | `story_session_id, first_story_segment` |
| `/api/story/choose` | POST | `story_session_id, choice` | `next_story_segment` |
| `/api/vocabulary/today` | GET | `user_id, date` | `vocabulary_items, expressions` |
| `/api/plan/today` | GET | `user_id, date` | `daily_plan` |

> 前端实现中它们一一对应 `ELS.services.*` 的 8 个异步方法，签名与返回值与表中一致，后续换成真实后端时只需替换这一层。

---

## 二、数据模型（Schema）

```jsonc
User            { user_id, level, daily_minutes, preferences:{topics:[],avoid:[]}, created_at }
Topic           { topic_id, topic_name, topic_category, difficulty, why_this_topic, source_url?, created_at }
Article         { article_id, topic_id, title, original_text, summary[], key_vocabulary[],
                  useful_expressions[], comprehension_questions[], speaking_task,
                  difficulty_level, source_type, created_at }
VocabularyItem  { word_id, word, phonetic, en_definition, cn_definition, example_sentence,
                  source_article_id, source_type, review_count, last_reviewed_at,
                  next_review_at, ease, mastered }
ExpressionItem  { expression_id, original_expression, pattern, user_example, source_article_id }
SpeakingSession { session_id, user_id, topic_id, article_id, messages[], corrections[],
                  feedback[], round, created_at, updated_at }
StorySession    { story_session_id, user_id, topic_id, article_id, state, history[],
                  current_segment, created_at, updated_at }
DailyPlan       { plan_id, user_id, date, topics[], steps[], completed_steps[], notes, created_at }
Settings        { provider, baseUrl, apiKey, model, temperature, mock, story_length, speaking_rounds }
```

`StorySession.state` 状态机：

```jsonc
{
  "current_scene": "string",
  "character_relationships": { "name": "relation" },
  "player_decisions": ["A", "B", ...],
  "unlocked_clues": ["clue"],
  "ending_candidates": ["ending_id"],
  "segment_index": 0
}
```

---

## 三、AI Prompt 管理服务

`prompts.js` 提供注册表式管理，支持**场景切换 + 变量注入 + 难度调制 + JSON 约束自动追加**：

```js
ELS.prompts.render('reading_coach', {
  level: 'B1-B2', topic: '...', source_text: '...'
});
// => { system: '...', user: '...', schema: {...} }
```

| key | 角色 | 产出 |
|---|---|---|
| `ai_editor` | 英语内容主编 | 1 个选题（去敏、去重、可延展） |
| `reading_coach` | 英语阅读教练 | 180–250 词资讯 + 词汇 + 句型 + 问题 + 口语任务 |
| `speaking_partner` | 英语交流伙伴 | 单问对话 + Better version 纠正 + 每 5 轮反馈 |
| `story_director` | 互动故事引擎 | 100–150 词片段 + A/B/C + 新词 + 口语句 + 状态更新 |
| `vocabulary_manager` | 词汇助手 | 从文本抽取生词/好句生成复习卡 |

新增场景只需在 `PROMPTS` 注册表加一项，无需改调用方。

---

## 四、最小可行版本（MVP）范围

已实现：
1. 自动选题（含最近 3 天去重 + 主题偏好）
2. 阅读材料生成（自动生成 / 粘贴原文改写，两模式）
3. 口语对话（单问 + Better version + 每 5 轮四维反馈）
4. 互动故事（状态机 + A/B/C 分支 + 连续性约束）
5. 生词记录与复习（间隔重复 SRS）
6. 每日计划与进度打卡
7. 全部 8 条交互指令
8. 全量配置可改（水平、主题偏好、时长、模型、难度）

---

## 五、复习算法（SRS）

简易 SM-0：间隔阶梯 `0 / 1 / 2 / 4 / 7 / 15 / 30 / 60` 天。
- 认识 → `review_count + 1`，`next_review_at = today + ladder[min(count, len-1)]`
- 忘记 → `review_count = max(0, count - 1)`，`next_review_at = today`（当天重来）
- 连续 5 次正确且间隔 ≥ 30 天 → 标记 `mastered`

---

## 六、后续可扩展（预留接口，未实现）

| 功能 | 接入点 |
|---|---|
| 语音朗读（TTS） | `ui.js` 文章区「朗读」按钮 → `SpeechSynthesis` / Azure TTS |
| 语音识别（ASR） | 口语输入框 → `MediaRecorder` + Whisper |
| 发音评分 | `speakingMessage` 扩展 `audio_url` 字段，返回 `pronunciation_score` |
| 每周计划 | `DailyPlan` 升级为 `WeeklyPlan`，`planToday` 扩展 `planWeek` |
| 学习数据看板 | `store.getStats()` 已有埋点，接入图表即可 |
| 真实后端 | 用 Express/FastAPI 复刻 `services.js` 的 8 个方法，前端仅改 `services.js` |

---

## 七、手机端 / PWA（已实现）

本系统已按「PWA + 响应式 UI」完成手机端适配，可直接安装到手机桌面当 App 用。

### 7.1 新增文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | PWA 应用清单（名称 / 图标 / 主题色 / standalone） |
| `sw.js`（根目录） | Service Worker：离线缓存 + 版本清理 + 请求分流 |
| `assets/icons/icon-192.png` | 192×192 应用图标 |
| `assets/icons/icon-512.png` | 512×512 应用图标 |
| `assets/icons/icon-180.png` | iOS apple-touch-icon |
| `assets/icons/favicon-32.png` | 浏览器标签图标 |
| `tools/gen-icons.ps1` | 图标生成脚本（.NET 绘制，可重新生成） |
| `tools/serve.ps1` | 零依赖局域网静态服务器（手机联调用） |

### 7.2 与原指南的差异（有意为之）

| 指南建议 | 实际实现 | 原因 |
|---|---|---|
| `src/sw.js` | **`sw.js` 放在项目根目录** | SW 作用域由文件位置决定，放 `src/` 下 scope 只有 `/src/`，无法接管页面、离线不生效 |
| `theme_color #16213e` | `#4f6ef7`（品牌蓝） | 与现有浅色 UI 一致，避免状态栏与页面割裂 |
| `user-scalable=no` | 保留缩放 + `viewport-fit=cover` | 禁用缩放有可访问性问题；`viewport-fit=cover` 解决 iPhone 刘海安全区 |
| 输入条纵向堆叠 | 输入框 + 发送按钮保持同行 | 竖向占两行会进一步压缩内容区，横排更省高度 |
| 表格 `white-space: nowrap` | 仅横向滚动，保留单元格换行 | nowrap 会让释义列变成极长单行，可读性差 |
| — | 新增深色模式自适应 | `prefers-color-scheme`，跟随系统切换，手机夜间不刺眼 |

### 7.3 缓存策略（sw.js）

- 页面导航（HTML）：**network-first** —— 有网时始终拿最新版，离线回退 `index.html`
- CSS / JS / 图标等静态资源：**cache-first**
- 跨域 AI 请求：**透传不缓存**（不会把模型回复缓存住）

升级版本时只需改 `sw.js` 顶部的 `CACHE_NAME`（例如 `v1.0.1`），旧缓存会在 activate 阶段自动清除。

### 7.4 怎么在手机上用

**方式 A：本地局域网（快速联调，功能完整但无离线）**

```powershell
cd D:\All in AI\System\english-learning-system
.\tools\serve.ps1          # 默认 8080
```

控制台会输出 `Phone: http://192.168.x.x:8080/`，手机连同一 WiFi 用浏览器打开即可。
（HTTP + 局域网 IP 不属于安全上下文，Service Worker 不注册，属浏览器限制。）

**方式 B：部署到 HTTPS（完整 PWA，可离线、可安装）**

| 托管 | 操作 |
|---|---|
| Netlify（最简单） | 打开 netlify.com → 把 `english-learning-system` 整个文件夹拖进控制台 → 得到 `https://xxx.netlify.app` |
| Vercel | `npm i -g vercel` → 项目根目录执行 `vercel` |
| GitHub Pages | 推送到仓库 → Settings → Pages → 选择分支；或直接用 `tools\deploy-github.ps1` 一键部署（见 7.4） |

**安装步骤**

- Android Chrome：地址栏右侧「安装」/ 菜单 →「安装应用」，或使用页面内的安装提示条
- iOS Safari：底部「分享」→「添加到主屏幕」（iOS 无自动弹窗，需手动操作）

#**方式 C：一键脚本部署到 GitHub Pages（推荐，无需安装 git）**

创建令牌：https://github.com/settings/tokens → Generate new token (classic) → 勾选 `repo` → 生成后复制 `ghp_xxx`。

然后在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy-github.ps1 -Token ghp_你的令牌
```

脚本会通过 GitHub REST API 自动完成：创建仓库 → 上传全部文件（已自动排除 `tools/`）→ 开启 Pages → 轮询等待构建 → 打印网址。

## 7.5 移动端 UI 变化

- 侧栏改为**底部导航栏**（6 个 Tab 横排，图标 + 文字）
- 指令输入条固定在底部导航上方，键盘弹出时 `100dvh` 保证不被遮挡
- 所有可点控件触摸目标 ≥ 44px（导航项 52px）
- 词汇表 / 词库表格横向滑动
- 设置抽屉改为全屏底部弹层
- 顶部状态栏 / 桌面图标使用品牌蓝，深色模式自动适配


---

## 八、配置说明

设置页支持：
- `provider`：`openai`（OpenAI 兼容协议，兼容 DeepSeek / 通义 /  moonshot / 本地 Ollama 等）
- `baseUrl`：默认 `https://api.openai.com/v1`
- `model`：默认 `gpt-4o-mini`
- `apiKey`：**保存在浏览器 localStorage，仅本机可见，不会上传任何第三方**
- `mock`：**开启后完全离线**，用内置引擎生成内容，用于先跑通流程

> 建议在浏览器里用 `http://` 方式访问（如 VS Code Live Server）以避免 `file://` 的跨域限制；本系统已做 classic-script 兼容，双击打开亦可运行。

---

## 九、验收标准（Smoke Test）

1. 打开页面 → 自动出现「今日计划」五个步骤
2. 点「自动选题」→ 返回主题 + 选题理由
3. 点「生成阅读材料」→ 出现 180–250 词英文文章、词汇表、句型、问题、口语任务
4. 点「开始口语」→ AI 提出第 1 个问题；回答后得到 `Better version:` 纠正；第 5 轮出现四维反馈
5. 点「开始故事」→ 100–150 词片段 + A/B/C；选择后剧情延续且状态更新
6. 点「复习」→ 出现今日生词卡，点「认识/忘记」后 `next_review_at` 变化
7. 输入指令「换题 / 更难 / 更简单 / 开始口语 / 开始故事 / 复习 / 查看今日计划 / 继续故事」均被正确识别
8. 刷新页面 → 所有数据保留
