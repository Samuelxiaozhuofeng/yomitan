# AI 解释功能集成计划（Yomitan）

## 目标

在用户用 **Shift 扫描查词**（弹出查词面板）时：

1. 仍然正常展示字典含义；
2. 同时把 `{word}{context}` 发送到 **兼容 OpenAI 的 Chat Completions API** 获取解释；
3. 将 AI 返回结果展示在查词面板顶部（字典条目上方）；
4. Settings 增加 AI 设置：支持自定义 `API Key` / `API URL` / `AI Models` / `Prompt`。

默认 `API URL`：`http://127.0.0.1:8317/v1/chat/completions`。

## 需要你确认的问题（决定实现细节）

1. **触发范围**：是否仅对 `modifierKeys` 包含 `shift` 的扫描触发 AI？（默认按你的描述：仅 Shift）
2. **结果类型**：AI 是否需要同时支持 `terms` 和 `kanji` 两类结果？（默认：两者都可以，只要是 Shift 触发）
3. **无结果时行为**：如果字典 “No results found”，是否仍然请求 AI？（默认：仍请求，便于解释上下文/拼写/用法）
4. **Prompt 语义**：自定义提示词是作为 `messages[0].role=user` 的完整内容，还是希望拆成 `system + user` 两段？（默认：单条 user message，支持 `{word}` `{context}` 占位符）
5. **模型配置**：`AI Models` 你希望是「可选列表」还是「自由输入」？（默认：自由输入 model，同时提供可配置的下拉候选列表）
6. **开关/默认值**：AI 功能是否默认开启？（默认建议：关闭，需要用户显式开启，避免意外网络请求）
7. **设置作用域**：AI 设置按 **Profile** 存储还是全局存储？（默认建议：按 Profile，便于不同站点/语言使用不同配置）

## 设计方案（拟）

### 1) Options 结构（Profile 级别）

在 `ProfileOptions` 增加 `ai`：

- `ai.enabled: boolean`
- `ai.apiUrl: string`（可填完整 endpoint；若用户只填到 `/v1` 则内部自动补全 `/chat/completions`）
- `ai.apiKey: string`（可为空；为空则不发送 Authorization）
- `ai.model: string`
- `ai.models: string[]`（候选列表，可在设置里以换行/逗号输入）
- `ai.prompt: string`（支持 `{word}` `{context}`）

### 2) 后端 API（background 发起网络请求）

新增一个内部 API（例如 `aiExplain`）：

- 入参：`{word, context, optionsContext}`
- 后端读取对应 Profile 的 `options.ai`，拼装 openai-compatible `POST`：
  - URL：`ai.apiUrl`（默认 `http://127.0.0.1:8317/v1/chat/completions`）
  - body：`{ model, messages: [{role:'user', content: compiledPrompt}], stream:false }`
  - headers：`Content-Type: application/json`；若 `apiKey` 非空则 `Authorization: Bearer ...`
- 返回：`{text: string}`（从 `choices[0].message.content` 提取）
- 增加超时（如 20s）与错误封装（返回可展示的错误信息）。

这样前端/显示层不直接接触跨域与网络细节，也避免把 API Key 暴露给页面上下文。

### 3) Popup UI（查词面板顶部展示）

在 `ext/popup.html` 的顶部区域添加一个 AI 区块：

- 初始隐藏；
- 查词触发后立即显示 “AI 让它想一想…” 的 loading；
- 请求完成后展示结果文本（保留换行）；失败则展示错误提示并允许折叠。

### 4) 触发逻辑（仅 Shift 扫描）

在 Display 层监听内容更新：

- 从 `display.history.state.optionsContext.modifierKeys` 判断是否包含 `shift`；
- `word` 使用 `display.query`；
- `context` 使用 `display.history.state.sentence?.text`（如果存在）；
- 触发 `api.aiExplain(...)`，并做并发控制：
  - 新查词会取消/忽略旧请求（requestId/AbortController）。

### 5) Settings UI

在 `ext/settings.html` 增加 “AI” section，并用现有 `data-setting="..."` 绑定：

- Enable toggle
- API URL input（默认填入上述 URL）
- API Key input（password 类型，带显示/隐藏按钮可选）
- Model input（自由输入）
- Models list（textarea，解析成数组）
- Prompt textarea（支持占位符提示）

## 实施步骤

1. 代码勘察：确定 Shift 扫描的 `optionsContext.modifierKeys` 在 popup 中是否稳定可用（并确认 sentence 在 state 中是否总是存在）。
2. 扩展 Options schema + types：为 `ProfileOptions.ai` 添加 schema/defaults，并同步 `types/ext/settings.d.ts`。
3. 增加 background API：实现 `aiExplain`，接入后端 API map、types、以及 `ext/js/comm/api.js` 客户端方法。
4. 增加 Display 模块：实现 `DisplayAi`（监听 contentUpdateStart/contentClear/optionsUpdated；管理 loading/abort/渲染）。
5. 增加 popup UI + CSS：在 `ext/popup.html` 放置 AI 容器，必要时在 `ext/css/display.css` 增加样式。
6. 增加 Settings UI：在 `ext/settings.html` 添加 AI 设置区块，并确保保存/加载生效。
7. 验证：运行 `npm test:unit` + `npm run test:ts`（必要时全量 `npm test`），并手动在浏览器里验证 Shift 查词时 AI 结果展示与取消逻辑。

## 验收标准

- Shift 查词时，AI 区块在字典条目上方显示，并能在 1 次查词内稳定更新。
- 非 Shift 触发的查词不出现 AI 区块（或保持隐藏）。
- Settings 能配置 `API URL/API Key/Model/Prompt/Models`，并立即在查词中生效。
- 请求失败时不会影响字典查词；AI 区块显示可理解的错误提示。
