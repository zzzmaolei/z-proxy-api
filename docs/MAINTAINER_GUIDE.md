# Qwen2API 维护者接手指南

这份文档面向后来维护项目的人。它不是用户手册，而是代码地图和排障手册。读完后应当能知道：请求从哪里进入、如何转成 Qwen Web 请求、账号如何选择、流式响应如何消费、Claude Code 兼容为什么这么写，以及改动时该验证哪些测试。

## 1. 项目定位

本项目把 Qwen Web Chat 后端包装成 OpenAI/Anthropic 兼容 API。

当前这套部署的重点是 **chat 后端**：

- OpenAI 兼容入口：`POST /v1/chat/completions`
- Anthropic 兼容入口：`POST /v1/messages`
- 图片/视频资源入口：`/v1/images/*`、`/v1/videos`
- CLI 路线已下线，当前环境中不要把 Claude Code 长任务问题归因到 CLI 路线。Claude Code 在这里主要走 chat 后端桥接。

## 2. 启动方式

相关文件：

- `src/start.js`：智能启动入口，`npm start` 使用它。
- `src/server.js`：Express 应用和路由挂载。
- `ecosystem.config.js`：PM2 多进程配置。

启动规则：

- `npm start` 默认单进程运行，即使 `.env` 配了 `PM2_INSTANCES=5`。
- PM2 启动时由 `ecosystem.config.js` 决定进程数，所有 PM2 worker 共享同一端口。
- 如果确实要直接用 Node cluster，需要显式设置 `ENABLE_NODE_CLUSTER=true`。

为什么这样设计：

- 直接 `node src/start.js` + `PM2_INSTANCES>1` 会自己 fork worker。
- 如果 WSL 或 Windows 已经有旧 Qwen2API 占用 `SERVICE_PORT`，worker 会报 `EADDRINUSE` 后退出。
- master 如果无限重启 worker，会造成日志刷屏和 Redis/account 清理日志风暴。
- 因此 direct cluster 默认关闭，PM2 多进程保留。

端口冲突排查：

- Windows：`netstat -aon | findstr :8080`
- WSL：`wsl -d Ubuntu -- bash -lc "ss -ltnp | grep ':8080' || true"`
- 如果 Windows 看不到 LISTEN，但 Node 报 `EADDRINUSE :::8080`，优先检查 WSL 里是否有旧 `node src/start.js`。

## 3. 目录地图

```text
src/
  start.js                       启动模式选择，PM2/direct cluster 保护
  server.js                      Express 应用、路由挂载、listen 错误处理
  routes/
    chat.js                      Qwen OpenAI 兼容路由入口
    anthropic.js                 Anthropic Messages 路由入口
    accounts.js                  Qwen Web 管理端账号接口
    settings.js                  Web 管理端运行配置接口
    dpsk-chat.js                 DeepSeek 聊天路由（/v1/dpsk/*）
    dpsk-accounts.js             DeepSeek 账号管理路由（/api/dpsk/*）
  controllers/
    chat.js                      Qwen OpenAI chat/text 工具调用主控制器
    anthropic.js                 Anthropic/Claude Code chat 桥接主控制器
    chat.image.video.js          图片、视频、图生图/文生图/文生视频
    dpsk-chat.js                 DeepSeek 聊天控制器（工具调用、思考输出、账号轮换）
    dpsk-models.js               DeepSeek 模型列表控制器（实时探测）
  utils/
    request.js                   Qwen Web chat_id 获取、账号选择、上游请求、串行换号
    upstream-client.js           axios request config、agent、Connection 策略
    upstream-consumer.js         上游 SSE 消费器，统一处理 data/end/error/close
    sse-frame-parser.js          SSE 帧切分和 JSON 解析
    tool-prompt.js               OpenAI 风格 tool_call 解析和纠偏提示（Qwen + DeepSeek 共用）
    account.js                   Qwen 账号加载、token
    account-pool-redis.js        Redis 模式下 inFlight、sticky、daily stats
    account-scorer.js            多账号选择打分
    upload.js                    图片上传和账号一致性处理
    dpsk-account.js              DeepSeek 账号管理（自动登录、禁言追踪、轮换）
    dpsk-client.js               DeepSeek 上游 HTTP 客户端（SSE 流式、PoW、模型探测）
    dpsk-pow.js                  DeepSeek PoW WASM 求解器
  agents/
    *.js                         client profile 检测和 Claude Code 等行为策略
test/                            provider/SSE 基础单测和 fixtures
tests/                           集成式回归测试
public/dist/                     管理后台构建产物，运行时需要
public/src/                      管理后台源码
```

### 代码注释索引

这些文件里有面向维护者的关键注释，建议改相关逻辑前先读对应块：

**Qwen 路线：**
- `src/start.js`：direct cluster 默认关闭、worker 重启风暴保险丝。
- `src/server.js`：`EADDRINUSE` 端口冲突为什么要直接退出。
- `src/controllers/chat.js`：OpenAI 兼容转换、`tool_choice=required` 输出隔离、非流式 whitespace keepalive。
- `src/controllers/anthropic.js`：Anthropic SSE 状态机、延迟 `message_start`、bootstrap retry、retry buffer 隔离。
- `src/utils/request.js`：预选账号、会话粘滞、串行换号、stream inFlight 释放。
- `src/utils/upstream-client.js`：长流 agent 和 `Connection` 策略。
- `src/utils/upstream-consumer.js`：SSE data/end/error/close 的 settle 规则和 idle timeout。
- `src/utils/account-pool-redis.js`：session sticky key 的优先级和不能使用 request id 的原因。

**DeepSeek 路线：**
- `src/utils/dpsk-client.js`：SSE fragment 解析器（`o` 字段省略问题）、PoW 流程、模型探测逻辑。
- `src/controllers/dpsk-chat.js`：工具提示注入最后一条 user 消息、`<think>` 块单对包裹、账号轮换重试。
- `src/utils/dpsk-account.js`：禁言追踪（`biz_code=5`）、自动登录、token 刷新。
- `src/utils/dpsk-pow.js`：WASM SHA3 PoW 求解。

## 4. OpenAI 请求链路

入口：

1. `src/routes/chat.js`
2. `apiKeyVerify`
3. `detectOpenAIProfile`
4. `processRequestBody`
5. `handleChatCompletion` 或图片/视频 controller

普通文本请求：

1. `handleChatCompletion` 调用 `sendChatRequest`
2. `sendChatRequest` 选择账号并生成/复用 `chat_id`
3. 使用 `upstream-client` 发到 Qwen Web `/api/v2/chat/completions`
4. 上游永远按 stream 返回
5. controller 根据客户端要求输出 OpenAI stream 或聚合成 non-stream JSON

注意点：

- Qwen Web 上游不支持真正的 `stream=false`，非流式响应是在 controller 里消费完整上游流后组装出来的。
- OpenAI stream 的 `tool_choice=required` 不能在已经把自然语言发给客户端后再二次纠偏，否则会出现“第一轮输出 + 第二轮输出”混合。
- 当前逻辑会对 required 工具场景暂存部分输出，确认没有工具调用后再决定是否 flush。

## 5. Anthropic/Claude Code 请求链路

入口：

1. `src/routes/anthropic.js`
2. `apiKeyVerify`
3. `detectClientProfile(req, 'anthropic')`
4. 当前部署重点为 `chat` 后端，最终进入 `handleAnthropicMessages`

Anthropic stream 输出必须遵守 SSE 状态机：

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`

维护注意：

- `message_start` 现在尽量延迟到首个真实协议输出前。
- 如果上游在首个协议事件前断开，可以 bootstrap retry。
- 如果已经向客户端输出了 Anthropic 协议事件，不再做不可回滚的 retry。
- `tool_use` 输出必须成对 start/stop，不能出现 delta 没有 block 的情况。

## 5.5 DeepSeek 请求链路

DeepSeek 路线是独立于 Qwen 的反代实现，纯 HTTP，无 Playwright。

入口：

1. `src/routes/dpsk-chat.js` → `POST /v1/dpsk/chat/completions`
2. `apiKeyVerify`
3. `src/controllers/dpsk-chat.js` → `chatCompletions`

请求流程：

1. **消息预处理**：`foldToolMessagesForChatBackend` 把 `assistant.tool_calls` / `role=tool` 折叠成纯文本
2. **工具提示注入**：`injectToolSystemPrompt` 把 `buildToolSystemPrompt` 生成的内容作为前缀注入最后一条 user 消息
3. **账号选择**：`dpskAccount.getAvailableAccount()` 轮换选择可用账号（跳过禁言账号）
4. **模型解析**：`resolveModelOptions` 把模型名映射为 `{ modelType, thinkingEnabled }`
5. **上游调用**：`dpskClient.sendChatMessage()` 发起流式请求
   - `getPowChallenge()` → `dpskPow.solvePow()` → `createSession()` → SSE 流式
6. **SSE 解析**：`parseDeepSeekSSE()` 逐帧解析 fragment 系统
7. **工具调用解析**：`createToolCallStreamParser()` 实时解析 `<tool_call>` 块
8. **思考输出**：`thinkingBlockOpen` 状态跟踪，整段思考内容用单对 `<think></think>` 包裹

关键设计决策：

- **工具提示注入最后一条 user 消息**（而非独立 system 块）：与 Qwen 路线 `chat-middleware.js` 一致，避免模型混淆
- **`<think>` 块单对包裹**：每个 thinking chunk 不单独包裹，整段思考用一对 `<think></think>`，避免 `<think>c1</think><think>c2</think>`
- **SSE content append 不要求 `o` 字段**：DeepSeek SSE 的 `response/fragments/-1/content` 事件有时省略 `o:"APPEND"`，解析器不能强制要求，否则会丢失内容（典型表现：`<tool_call>` 被截成 `<_call>`）
- **禁言检测**：`biz_code=5` 表示 user is muted，自动标记账号并轮换重试
- **模型探测**：每次实时创建会话验证账号可用性，失败返回空数组，不硬编码兜底

账号管理（`src/utils/dpsk-account.js`）：

- 数据存储：`data/dpsk-data.json`（独立于 Qwen 的 `data/data.json`）
- 自动登录：添加账号时调用 `dpskClient.login(email, password)`
- 禁言追踪：`markMuted(email)` / `isMuted(email)` / `getAvailableAccount()` 自动跳过
- Token 刷新：`refreshToken(email)` 重新登录获取新 token

## 6. 账号池和粘性

核心文件：

- `src/utils/request.js`
- `src/utils/account.js`
- `src/utils/account-pool-redis.js`
- `src/utils/account-scorer.js`

选择账号大致流程：

1. controller 若传入 `{ account }`，优先使用该账号。
2. 否则根据 session sticky 尝试复用之前账号。
3. scorer 根据 inFlight、失败冷却、stickyEmail 选出账号。
4. chat_id 生成失败、网络错误、429、5xx 时，`sendChatRequest` 可以串行换号。
5. 成功拿到上游 stream 后，inFlight 绑定到 stream 的 end/close/error 释放。

粘性字段优先级：

- `metadata.user_id`
- `metadata.session_id`
- `X-Session-ID`
- `Session_id`
- `X-Amp-Thread-Id`
- `X-Codex-Session-Id`
- `sessionId`
- `session_id`
- `conversation_id`

不要把每次请求都变化的 request id 当 session key，否则长任务会被分散到多个账号。

## 7. 长任务和流式稳定性

相关配置：

- `QWEN_STREAM_TIMEOUT_MS`：axios 总超时，默认 2 小时，`0` 表示关闭。
- `QWEN_STREAM_IDLE_TIMEOUT_MS`：上游 SSE idle 超时，默认 2 小时，`0` 表示关闭。
- `QWEN_STREAM_KEEP_ALIVE`：流式请求是否复用 keepAlive agent，默认 false。
- `QWEN_STREAM_BOOTSTRAP_RETRIES`：Anthropic 首个协议事件前断线的 bootstrap retry 次数。
- `NONSTREAM_KEEPALIVE_INTERVAL_MS`：非流式响应等待期间写 JSON whitespace 保活，默认关闭。

关键设计：

- `upstream-client` 对 streaming 请求默认使用 non-keepAlive agent，并设置 `Connection: close`。
- `upstream-consumer` 负责把 `data/end/error/aborted/close` 统一分类，避免 close/end race。
- controller 负责决定是否还能 retry。已经向客户端输出的响应通常不可回滚。

## 8. Tool Call 兼容

OpenAI：

- 工具调用由 `src/utils/tool-prompt.js` 解析 `<tool_call>...</tool_call>`。
- stream 下工具参数按 OpenAI chunk 规范分片输出。
- required retry 使用独立 parser/buffer，避免二次输出污染第一轮。

Anthropic：

- 工具调用统一转成 `tool_use` content block。
- Claude Code profile 下通常丢弃工具前置自然语言，避免客户端把“说明文字 + tool_use”理解成重复动作。
- retry 只有解析出有效 tool call 时才替换第一轮工具结果；否则丢弃 retry 文本。

## 9. 图片和视频

相关文件：

- `src/controllers/chat.image.video.js`
- `src/utils/upload.js`
- `src/controllers/chat.js`
- `src/controllers/anthropic.js`

维护注意：

- 图片上传时使用的账号应尽量和 chat 请求账号一致。
- OSS/file_url 和账号 token 的关系要谨慎处理，避免换号后上游无法读取上传资源。
- 图片/视频历史复用逻辑在测试里有覆盖，改动时跑 `image-video-*` 测试。

## 10. Redis 和数据模式

数据模式：

- `DATA_SAVE_MODE=none`：主要依赖 env，适合简单运行。
- `DATA_SAVE_MODE=file`：使用 `data/data.json`。
- `DATA_SAVE_MODE=redis`：多进程共享账号、inFlight、sticky、stats。

Redis 注意：

- Redis 模式下，不要在短暂 idle 后主动断开连接，否则请求密集时会反复 disconnect/reconnect。
- 进程退出时会清理 Redis 连接，cluster 多 worker 下看到多条清理日志是正常的。
- 如果清理日志反复刷，通常不是 Redis 本身，而是 worker 正在崩溃重启。

## 11. 测试地图

推荐按改动范围跑测试：

```powershell
node --test tests\upstream-client.test.js
node --test tests\upstream-consumer.test.js
node --test tests\anthropic-tool-use-emit.test.js
node --test tests\anthropic-stream-retry.test.js
node --test tests\stage4-stream-stability.test.js
node --test tests\redis-pool.test.js
node --test tests\stage4-provider.test.js
```

按模块：

- SSE parser/provider：`test\*.test.js`、`tests\stage4-provider.test.js`
- Anthropic/Claude Code：`tests\anthropic-*`、`tests\claude-code-*`
- 工具调用：`tests\tool-call-parser.test.js`、`tests\anthropic-tool-use-emit.test.js`
- 账号池/Redis：`tests\redis-pool.test.js`
- 统计口径：`tests\chat-usage-breakdown.test.js`
- 图片/视频：`tests\image-video-*`、`tests\image-upload-account-consistency.test.js`
- DeepSeek：`tests\tool-call-parser.test.js`（共用工具解析器）、手动脚本 `test-dpsk-tools.js`、`test-multiturn-tools.js`

## 12. 常见故障

### 启动后一用就刷 Redis/account 清理日志

优先看是否有：

```text
bind EADDRINUSE null:8080
工作进程已退出 - 退出码: 1
正在重启工作进程
```

这表示端口被旧进程占用，worker 崩溃后被 master 重启，不是 Redis 根因。

### Windows 查不到 8080 LISTEN，但 Node 说端口占用

检查 WSL：

```powershell
wsl -d Ubuntu -- bash -lc "ss -ltnp | grep ':8080' || true"
```

如果看到 `/mnt/z/Qwen2API-main/src/start.js`，停掉 WSL 旧进程后再启动。

### Claude Code 长任务中途断

优先看 chat 后端：

- 上游 `QWEN_STREAM_TIMEOUT_MS`
- 上游 `QWEN_STREAM_IDLE_TIMEOUT_MS`
- streaming agent/Connection 策略
- Anthropic 首事件前 bootstrap retry
- 是否已经向客户端输出导致不能 retry
- strict tool mode 分类：`classification / retryUsed / fallbackUsed / blocked`

### 重复输出两段回答

重点检查 controller retry：

- OpenAI required retry 是否复用了同一响应 buffer。
- Anthropic retry 是否把 retry 文本直接追加到了第一轮文本。
- stream 场景是否已经输出可见内容后还做不可回滚 retry。

### DeepSeek 工具调用解析失败（`<_call>` / 丢字）

检查 `src/utils/dpsk-client.js` 的 SSE content append 分支：

- 不能强制要求 `data.o === 'APPEND'`。
- 必须仅根据 `data.p === 'response/fragments/-1/content' && typeof data.v === 'string'` 判断。
- 旧版本曾因这里漏掉无 `o` 字段的帧，导致 `<tool_call>` 被截成 `<_call>`。

### DeepSeek 模型列表为空

- 检查 `data/dpsk-data.json` 中账号 token 是否有效。
- 检查账号是否被标记 `mutedUntil`（`biz_code=5` 禁言）。
- `/v1/dpsk/models` 实时探测，账号全部失效时返回空数组。

### DeepSeek 思考内容被多对 `<think>` 包裹

检查 `src/controllers/dpsk-chat.js` 的 `thinkingBlockOpen` 状态：

- 第一个 thinking chunk 开 `<think>`。
- 后续 thinking chunk 不再重复开标签。
- 遇到正文或生成器结束时关闭 `</think>`。

## 13. 改动守则

- 不要在 `sendChatRequest` 里并发打多个账号。它的换号逻辑应保持串行。
- 不要在 controller retry 时把第一轮和第二轮文本直接拼接。
- 不要把单次 request id 当 session sticky key。
- 不要在已经输出 SSE 协议事件后重放另一轮上游完整响应。
- 不要在运行路径里依赖 `public/node_modules`，运行使用 `public/dist`。
- 改启动逻辑时同时考虑 Windows 和 WSL 残留进程。
- 改 Anthropic stream 时必须跑 SSE 状态机相关测试。

## 14. Strict Tool Mode

核心文件：

- `src/agents/claude-code-profile.js`
- `src/utils/strict-tool-mode.js`
- `src/controllers/anthropic.js`

触发条件：

- Anthropic `/v1/messages`
- 请求带 `tools`
- profile 启用 `strictToolUse`
- `tool_choice` 不是 `none`

输出规则：

- 合法工具调用：输出完整 Anthropic `tool_use` block，`stop_reason=tool_use`。
- 明确最终报告：输出 text，`stop_reason=end_turn`。
- 过程话术、无效 JSON、未知工具名、空回复：先 strict retry，最多 1 次。
- retry 仍失败：只允许构造 Read/LS/Glob/Grep/Search 等只读 fallback。
- 无 fallback：输出含 `strict_tool_mode_no_tool_call` 的 blocked 文本。

维护注意：

- retry 必须复用同一个 Qwen 账号。
- retry 的 answer buffer 不得混入首轮自然语言。
- 不能自动构造 Edit/Write/MultiEdit/Delete/Bash 类 fallback。
- strict retry 的 token 要计入总 chat usage，并单独计入 retry breakdown。

## 15. Usage Stats

兼容字段：

- `stats.chat.input`
- `stats.chat.output`

新增可选字段：

- `requests`
- `blockedRequests`
- `upstreamInput`
- `upstreamOutput`
- `estimatedInput`
- `estimatedOutput`
- `retryInput`
- `retryOutput`

规则：

- 上游返回 usage 时，写入 upstream breakdown。
- 本地估算 usage 时，写入 estimated breakdown。
- strict correction retry 的额外消耗写入 retry breakdown，同时计入总 input/output。
- 老数据没有 breakdown 时，前端按 unknown/estimated 口径展示，不能把估算伪装成真实账单。

## 16. 工作树与生成物整理

建议先分三类看 `git status --short`：

1. 业务源码改动：`src/`、`public/src/`、`tests/`、`docs/`
2. 运行生成物：`node_modules/`、`public/dist/`、`logs/`、`data/`
3. 临时测试输出：`test-out*.txt`、`test-results.txt`、`test_output.txt`

处理建议：

- `node_modules/` 不提交；需要构建时用 `npm install` 或 `npm --prefix public install` 重建。
- `public/dist/` 已在 `.gitignore`，本地 build 产物不提交。
- 根目录测试输出文本应删除或保持删除状态，不要继续追踪新的 `test-out*.txt`。
- `.serena/` 属于本地工具缓存，默认不提交。
- `docs/MAINTAINER_GUIDE.md` 是维护文档，建议纳入版本控制。
- 如果工作树已经很脏，先用 `git diff --stat` 和 `git diff -- <path>` 分批审查，不要用 `git reset --hard`。
