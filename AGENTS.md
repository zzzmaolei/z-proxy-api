## 项目概述

**z.proxy.api** 是一个多 provider API 网关，通过反向代理 Web 端 AI 模型（DeepSeek、Qwen 两家），
将其封装为兼容 OpenAI 和 Anthropic 协议的标准化 API，可以直接接入 Codex、Codex CLI、
Continue.dev、Cursor 等各类 AI harness / IDE 工具。

## 项目修改守则

### 核心原则：最小化修改 + 每次改动后主动提交

> **每一次完成的改动都必须 commit 到本项目的 Git 仓库。** 规则如下：
> 1. 任何改动（包括配置、文档、脚本、代码等）完成后，立即执行 `git add` + `git commit`，**不询问用户**
> 2. commit message 遵循 Conventional Commits 规范（feat/fix/chore/refactor/test/docs）
> 3. 提交范围应仅包含本次改动相关文件，不要混入无关变更
> 4. 提交失败（冲突等）时，找用户处理

### 核心原则：每次改动后自动重启服务

> **每一次改动 commit 后，必须运行 `scripts/restart.bat` 重启服务使改动生效。** 规则如下：
> 1. commit 成功后，立即运行 `scripts/restart.bat`
> 2. 不再手动执行 `taskkill`、`nohup node src/start.js` 或其他替代重启命令
> 3. 调用该 BAT 时，Hermes `terminal` 工具必须将本次调用的 `timeout` 设置为 **10 秒**；这是本次重启调用的超时，不要修改全局 `terminal.timeout`
> 4. 如果 10 秒后工具仍显示运行中，立即中止该次工具调用，不要继续等待，也不要重复运行脚本；随后另起一次工具调用检查 `9090` 端口
> 5. 脚本启动后等待 3 秒，通过 `netstat -ano | findstr :9090` 确认服务已启动；端口处于 `LISTENING` 即视为重启成功
> 6. 服务重启失败时，找用户处理
>
> ### ⚠️ 重要：重启脚本的 `pause` 陷阱
>
> 当前 BAT 的正常成功路径没有末尾 `pause`；仅在项目目录不存在的错误分支中保留 `pause`。
> 真正导致 Hermes 工具一直显示“正在运行”的原因是脚本第 72 行通过
> `start ... cmd /k "npm start"` 启动了一个持续运行的独立 Node 服务窗口。
> 服务实际已经启动，但终端工具可能继续等待这个长驻子进程或其继承的进程句柄，
> 因此不能把工具调用是否自动返回作为启动成功标准。
>
> **解决方案：**严格使用上述 10 秒的工具级超时；超时后不重跑脚本，直接用新的工具调用检查
> `netstat -ano | findstr :9090`。不要修改 BAT 的 `cmd /k` 启动方式，也不要再添加 `pause`。

### 核心原则：最小化修改

> 这个项目在生产环境中运行，很多组件之间存在隐式依赖。修改时必须严格遵循：

1. **改前先看 diff**：确认工作目录干净（`git diff --stat`），分清哪些是"我的改动"哪些是"已有的未提交改动"。不确定就 `git stash` 先回退。

2. **一次只改一个链**：比如修 max_tokens 传递，只改传递链上的文件，不动 prompt 构建、session 管理、重试逻辑、账号轮换等无关代码。

3. **不改能正常跑的功能**：session 续接、增量 prompt、preamble dropper、重试循环、文件上传——只要当前截断/失败问题不是这些模块导致的，就别碰。

4. **diff 审核**：改完后 `git diff --stat` 检查改了几个文件、每文件几行。超过预期就逐文件审查砍掉无关改动。

5. **修改列表写进 memory**：改了什么文件、改了哪几行、为什么改——记下来，方便下一轮排查时回溯。

### 核心原则：修报错必须全链路分析，先复现再改动

> **这个项目已经较为完善，报错极少是单一小问题造成的，更可能是多个"看起来正常"但
> 一运行起来就报错的多因素共同作用。直接改动可能影响到正常运行的程序（捡了芝麻丢了西瓜）。**

修报错时必须严格遵循以下流程：

1. **先全链路、全流程分析**：报错日志中的每一条 WARN/ERROR 都不是孤立的，必须顺着调用链
   追溯到根因。典型场景：A 模块的一个时序问题导致 B 模块的缓存为空，B 的空缓存又导致 C 模块
   每次请求都走慢路径——日志里看到的是 C 的慢，根因在 A。

2. **先复现，再改动**：确认能稳定复现问题后再动手改。不能复现就改 = 盲改，极大概率引入新问题
   或改动无效。代码级 bug（如缺少 `await`、变量名写错）可通过阅读代码确认；运行时 bug 必须跑
   测试或构造复现用例。

3. **分析改动影响面**：改动前先想清楚——这个改动会影响哪些链路？正常运行的请求会不会受影响？
   会不会破坏隐式依赖？不确定就先 stash 或在测试环境验证。

4. **一次只修一个根因**：多个报错如果是同一个根因引起的，修根因即可，不要逐个症状打补丁。
   如果是独立根因，分次修，每次修完 commit + 重启 + 验证。

5. **区分"真 bug"和"日志噪音"**：有些 WARN 是误报（如 `tool_choice="auto"` 时模型不调工具被
   误标记为 PROBLEM），不能看到 WARN 就改代码。先判断这个警告是否代表真实故障，再决定是否处理。

## 核心架构

- **多 provider 注册表**（src/providers/registry.js）：声明式路由，按 model 名自动分发到对应 controller
- **Qwen 路线**：主要后端，覆盖 chat.qwen.ai 的 Web API，驱动 /v1/chat/completions 和 /v1/messages
- **DeepSeek 路线**：独立后端，覆盖 chat.deepseek.com 的 Web API（PoW 认证 + 真实 SSE + Session 持久化），
  通过 dpsk-chat.js 暴露 OpenAI 兼容端点。
  Codex 的 Anthropic /v1/messages 请求按 model 名经 registry 分发到
  controllers/anthropic-deepseek.js -> backends/deepseek/anthropic-handler.js。

## 铁律：模型列表绝对不允许硬编码

> **任何 provider 的模型列表都必须从上游实时获取，不允许在代码中硬编码模型 ID 数组。**

原因：
1. 上游随时可能新增/废弃/改名模型，硬编码会迅速过时
2. 用户看到的模型列表与实际可用的模型脱节，产生"列表上有但用不了"的迷惑体验
3. 音乐生成、图片生成等特殊技能/模式模型有其独立的 `skillType` / `bot_id` / 端点，无法通过静态列表覆盖

做法：
- Qwen 路线：已正确实现实时 fetch（`getLatestModelsDetailed()` → `models-map.js`）
- DeepSeek：仍需改造为实时获取

这条规则适用于 `src/controllers/dpsk-models.js` 等所有硬编码列表文件。

## 核心设计原则：反代中转 + Prompt 模拟

> **本项目是反代中转，不是 API 适配器，更不是格式约束器。**
> 职责只有两件事：
> 1. **反代**：把 harness（Codex、Codex CLI、Continue 等）的请求中转给上游 Web 端模型，
>    再把模型输出中转回 harness
> 2. **Prompt 模拟**：上游 Web 端模型不原生支持 tool calling，需要用 prompt 让模型"知道"
>    自己处于 prompt 模拟环境，用文本输出工具调用，而非原生 function call

### 铁律：不注入 tool call 格式，格式由 harness 主导

> **反代层不注入与 harness 冲突的 tool call 格式指令。**
> 格式教学是 harness 的职责——每个 harness 会在自己的 system prompt 里教模型用什么格式调工具。

原因：
1. harness 自己注入的 system prompt 已经定义了工具调用格式（Codex 教 `tool_use`、
   Codex 教 `function_call`、OpenAI 客户端教 `tool_calls`）
2. 反代层再注入第二套格式指令 = 两套冲突指令，模型在两者间摇摆，输出四不像，谁都解析不了
3. 反代层的职责是"让模型知道要 prompt 模拟"，不是"教模型怎么写格式"

**重要例外（2026-07-12 发现）**：当 prompt 模拟环境生效时（上游不支持原生 tool calling），
harness 教的原生格式（如 Codex 的 `tool_use` block）随之失效。此时反代层**必须**告诉
模型用 `<tool_call>` XML 文本格式输出——这是反代层解析器（`createToolCallStreamParser`）期望的格式。
这不是"与 harness 冲突的第二套格式"，而是"prompt 模拟环境下的替代格式"——harness 的原生格式
在 prompt 模拟环境下不适用，反代层必须提供能被解析的文本格式。否则模型不知道用什么文本格式
输出工具调用，会纠结后放弃调工具（DeepSeek thinking 模式下尤其明显）。

### Prompt 模拟的具体实现

上游 Web 端模型不原生支持 tool calling、function calling、thinking blocks 等高级协议特性。
所有 harness 兼容性都基于同一个原理：**让模型知道自己处于 prompt 模拟环境，以文本形式输出
工具调用，反代层解析文本并翻译为标准协议事件回传 harness。**

具体来说：
- **工具调用**：反代层只注入工具列表 + "用 prompt 模拟，不要原生调用"的提示。
  模型按 harness 教的格式输出工具调用文本，`createToolCallStreamParser()` 实时解析并翻译为
  标准的 `tool_calls` / `tool_use` 事件。**解析器必须宽容**，识别模型实际输出的各种变体
  （完整 XML 块、裸 JSON、不完整标签等），而不是强制模型遵守某种固定格式
- **思考/推理**：控制器将上游的 thinking 内容映射为标准协议的 `reasoning_content` 或
  `thinking` 块
- **多轮工具结果**：通过 `foldToolMessages()` 将历史 `tool_calls` / `tool` 消息折叠回注到
  prompt 中，维持多轮上下文。折叠只做协议降级（结构化 → 文本），不做内容截断或格式约束
- **tool_result 透传**：harness 的 tool_result 完整透传给模型，反代层不做任何长度限制或截断

### 反代层不该做的事（禁止清单）

1. ❌ 注入 tool call 格式指令（教模型用 `<tool_call>` 还是 JSON 还是别的）
2. ❌ 对 tool_result 内容做截断或长度限制
3. ❌ 对 tool_calls / tool_use 做数量限制或并行限制
4. ❌ 用"纠偏重试"强制模型遵守某种固定输出格式
5. ❌ 注入与 harness system prompt 冲突的"严格规则"

### 反代层该做的事

1. ✅ 中转请求：harness → 上游 Web 端（协议降级：结构化 messages → 纯文本 prompt）
2. ✅ 中转响应：上游 → harness（协议升级：文本输出 → 结构化 tool_use/tool_calls 事件）
3. ✅ 告诉模型"这是 prompt 模拟环境，用 prompt 输出工具调用"
4. ✅ 提供工具列表（让模型知道有哪些工具可用）
5. ✅ 宽松解析模型输出（识别各种变体，而非强制固定格式）
6. ✅ 完整透传 tool_result（不截断、不限制）

这是本项目所有 harness 适配（Codex、Codex CLI、Continue 等）的根本原理。
任何 API 兼容性改动都基于此原理。

## 已接入的协议端点

| 端点 | 协议 | 支持的 Provider | 用途 | max_output_tokens |
|------|------|----------------|------|-------------------|
| POST /v1/chat/completions | OpenAI | Qwen, DeepSeek | 通用聊天 | N/A（使用 max_tokens） |
| POST /v1/messages | Anthropic | Qwen, DeepSeek | Codex 等 | N/A（使用 max_tokens） |
| POST /v1/responses | OpenAI Responses | DeepSeek | Codex CLI | 流式 ✅ 已支持（重命名为 max_tokens 透传至下游 controller）；非流式 ❌ 未实现 |
| POST /v1/models | OpenAI | 全部 | 模型列表 | N/A |

## max_output_tokens 验证结论

在无上游 provider 凭证的环境中通过单元测试验证代码逻辑正确性：

| 场景 | 方式 | 结果 |
|------|------|------|
| A: stream=true + max_output_tokens=50 | 单元测试模拟请求体解析 | ✅ 通过 — `max_output_tokens` 正确提取并重命名为 `max_tokens=50` 传入 `chatReq` |
| B: stream=false + max_output_tokens=50 | 代码审查 | ❌ 未实现 — `singleResponse` 不在本次任务范围内，不会透传 `max_output_tokens` |
| C: stream=true + 不传 max_output_tokens | 单元测试模拟请求体解析 | ✅ 通过 — `max_tokens` 不出现于 `chatReq` 中，行为与修改前一致 |
| D: stream=false + 不传 max_output_tokens | 代码审查 | ✅ 通过 — `singleResponse` 不受影响，行为无变化 |

> 上游 DeepSeek 服务因缺少 API 凭证无法直连，实际截断效果（约 50 token 截断）需在有凭证的环境中验证。代码逻辑（参数提取 → 重命名 → 透传）已通过单元测试覆盖。

## DeepSeek 路线专项说明

DeepSeek Web 聊天 API 使用 PoW（Proof-of-Work）挑战-应答认证，需要 WASM 求解器。

### 铁律：DeepSeek session 绝对不允许复用（每次请求必须创建新 session）

> **DeepSeek Web 的 `chatSessionId` 是有状态的——上游会在 session 内累积消息历史。**
> **反代层必须每次请求创建新 session，绝对不允许复用，否则会导致上下文重复爆炸。**

**根因（2026-07-09 发现的严重 bug）**：

DeepSeek Web 与原生 API（OpenAI/Anthropic 官方）有本质区别：
- 原生 API 是**无状态**的——每次请求独立处理，处理完即丢弃
- DeepSeek Web 的 `chatSessionId` 是**有状态**的——上游会在 session 内累积消息历史

Codex 的行为是每次请求带完整上下文（system prompt + 所有历史消息 + tool_results）。
如果反代层复用 session 同时又发完整 prompt，上游上下文会重复翻倍：

| 请求 | 上游 session 状态 | 反代发的 prompt | 上游实际看到 |
|------|------------------|----------------|-------------|
| 第1次 | 空 | `1` | `1` |
| 第2次 | `1`（累积）| `1,2` | `1` + `1,2` = **重复** |
| 第3次 | `1,1,2`（累积）| `1,2,3` | `1,1,2` + `1,2,3` = **爆炸** |

这会导致两条消息就 167KB（约 42K tokens），触发上游 50K token 空响应限制，
4 次无意义重试全部失败（重试时 prompt 还在增长），浪费 8-10 秒后返回空响应。

**正确做法**（[anthropic-utils.js](src/backends/deepseek/anthropic-utils.js) 的 `getOrCreateSession`）：

```javascript
// 每次请求都创建新 session，与原生 API 无状态行为一致
const session = await withRetry(
    () => dpskClient.createSession(token, proxyUrl, fingerprint),
    { label: 'createSession-anthropic', logTag: 'DPSK' }
);
```

- `chatSessionId` 每次不同 → 上游每次空白
- `parentMessageId` 始终为 null → 不依赖上游续接
- `lastMessageId` 不再使用 → 不设置 parentMessageId

**错误做法（已修复，禁止回退）**：

```javascript
// ❌ 绝对禁止：基于 sessionKey 复用 session
const cached = sessionCache.get(sessionKey);
if (cached && hasToolResults || userCount > 1) {
    return cached;  // ← 导致上下文重复爆炸
}
```

**Qwen 路线无此问题**：Qwen Web 的 `chat_id` 是无状态的，每次 `take`（取出即删除）+
`parent_id: null`，上游不在 chat_id 内累积历史。架构从一开始就是正确的无状态模式。

### Codex 适配
- **Anthropic /v1/messages 路由分发**：按 model 名经 registry 分发：
  - deepseek/dpsk -> controllers/anthropic-deepseek.js -> backends/deepseek/anthropic-handler.js
  - 其余 -> controllers/anthropic.js (Qwen)
- 启用 `createPreambleDropper()` 丢弃模型的过程话术（"我来看看"等），避免 Codex
  误以为任务已开始而停止 workflow
- 严格执行 `requireStopReasonToolUse`：有 tool_use 时 stop_reason 必须是 `tool_use`

### Codex CLI 适配
- 通过 responses-compat.js 将 OpenAI Responses API 请求翻译为 chat/completions
- 流式路径将 chat chunk 事件翻译为 Response API 事件序列

## 代码结构

```
src/
├── agents/              # 客户端 profile 定义（Codex、Codex、Hermes 等）
├── backends/            # Provider 后端逻辑（stream/sync handler + provider 专用工具）
│   ├── deepseek/        #   DeepSeek: stream-handler, sync-handler, dpsk-account,
│   │                    #     dpsk-client, dpsk-fingerprint, dpsk-pow
│   └── qwen/            #   Qwen: 反爬 Cookie 链（baxia-umid, ssxmod-manager,
│                        #     cookie-generator, fingerprint）+ chat 编排链
│                        #     （qwen-homepage-warmup, chat-id, chat-id-pool,
│                        #     request, upload, upstream-client, upstream-consumer）
├── config/              # 环境变量配置
├── constants/           # 枚举常量
├── controllers/         # 控制器（协议入口 + 编排）
│   ├── anthropic.js     #   Anthropic 协议主控制器（Qwen CC 适配核心）
│   ├── chat.js          #   OpenAI chat 主控制器（Qwen 路线）
│   └── dpsk-chat.js     #   DeepSeek chat 入口（精简编排，handler 在 backends/）
├── middlewares/         # Express 中间件（认证、请求处理）
├── models/              # 模型列表管理
├── providers/           # Provider 注册表 + Qwen Web 后端封装
├── routes/              # Express 路由定义
├── shared/              # 跨 provider 共享逻辑
│   ├── anthropic-helpers.js # Anthropic 协议纯函数（profile/normalize/flatten）
│   ├── anthropic-base.js    # Anthropic 流式控制器共享基础设施（heartbeat/parser/retry/fallback）
│   ├── client-detection.js  # 客户端 profile 检测
│   ├── retry.js             # 通用异步重试包装器
│   └── tool-injection.js    # 工具提示注入 + 重试提示构建
└── utils/               # 跨 provider 共享工具（账号管理、SSE 解析、token 统计等）
                         #   provider 专用文件已移到 backends/<provider>/
```

### 分层架构

```
Layer 1 — 协议入口（routes/ + controllers/anthropic.js, chat.js）
   ↓   接收 Anthropic/OpenAI/Responses 协议请求，统一转换为内部格式
Layer 2 — 共享抽象（shared/）
   ↓   retry、tool-injection、SSE writing、client-detection
Layer 3 — Provider 后端（backends/deepseek/）
   ↓   stream/sync handler → 调用 upstream client → 解析响应
Layer 4 — 基础设施（utils/ + providers/qwen-web/）
       账号管理、tokenizer、SSE 解析、上游通信、header 构建
```

### 关键设计决策

- **Anthropic /v1/messages 路由分发**：按 model 名经 registry 分发：
  - deepseek/dpsk -> controllers/anthropic-deepseek.js -> backends/deepseek/anthropic-handler.js
  - 其余 -> controllers/anthropic.js (Qwen)
- **DeepSeek 的独立端点 `/v1/dpsk/chat/completions` 保留**：用于直接指定模型时测试，不走 routeByProvider 分发。
- **controllers/dpsk-chat.js 精简为编排层**：仅负责参数解析、账号轮换、
  model 解析、Vision→Pro 代理等编排逻辑，流式/非流式处理下沉到 backends/。
- **shared/ 存放跨 provider 共享逻辑**：
  - `anthropic-helpers.js`：Anthropic 协议纯函数（profile/normalize/flatten），被 2 个
    Anthropic 控制器共用（Qwen/DeepSeek）。重构前这些函数内联在 `controllers/anthropic.js`
    中，DeepSeek 控制器通过 `require('./anthropic')` 引用，导致 Qwen 主控制器被当作
    共享库加载。剥离后控制器依赖关系清晰。
  - `anthropic-base.js`：Anthropic 流式控制器共享基础设施（heartbeat/toolParser/retry/
    fallback/usage），从 `anthropic-deepseek.js` 中提取的 10 个
    共享函数。重构前控制器 70-80% 代码重复。
  - `retry.js`、`tool-injection.js`、`client-detection.js`：通用重试、工具提示注入、
    客户端 profile 检测。
- **工具提示词三层解耦**（`utils/tool-prompt.js`）：工具提示词生成涉及三个正交维度，
  按维度独立组织：
  - **协议层**（只有 OpenAI / Anthropic 两种）：`buildClaudeCodeBlock()` / `buildCodexBlock()`
    / `buildOpenAIChatProtocolHint()`
  - **Provider 层**：`buildDeepSeekStrictProtocol()` 等（针对上游模型能力差异注入额外约束）
  - **通用层**：`buildImageAwareBlock()` / `buildToolChoiceBlock()` / `buildFailureRecoveryBlock()`

## 上下文限制（Context Limits）

> 测试日期：2026-07-07
> 测试方式：通过 Anthropic Messages 协议（POST /v1/messages）从 9090 端口发送渐进式上下文载荷，
> 使用 `.test/test-context-limits.js` 脚本，流式 + 非流式两种模式。

### 1. 测试结论

| 模型 | 10K | 50K | 100K | 200K | 500K | 1M |
|------|-----|-----|------|------|------|-----|
| DeepSeek Expert | ✅ 200 (262s) | ⚠️ 200 空响应 (<1s) | ⚠️ 200 空响应 (<1s) | ⚠️ 200 空响应 (<1s) | ⚠️ 200 空响应 (<1s) | ⚠️ 200 空响应 (<1s) |
| Qwen (全部模型) | ❌ 500 | ❌ 500 | ❌ 500 | ❌ 500 | ❌ 500 | ❌ 500 |

- **DeepSeek**：10K tokens 正常工作，模型真实响应（262s 流式，19788 个 SSE 事件）。
  50K+ tokens 上游返回 **空 SSE 流**（HTTP 200 但仅 3 个事件：message_start、message_delta、message_stop，无内容）。
  上下文上限在 **10K ~ 50K token 之间**（约 40KB ~ 200KB 文本）。
- **Qwen**：全部测试返回 500 错误。上游返回非 SSE 响应（风控/captcha），是 Qwen 账号问题而非上下文限制。

### 2. 限制来源

**限制完全来自上游 Web 端，反代层没有添加任何限制。**

#### DeepSeek 链路分析

- 反代层没有对消息长度/token 数做任何限制。`buildPrompt()` 将完整消息序列化为文本后直接传给 `dpskClient.sendChatMessage()`。
- `sendChatMessage()` 构造请求体发送给 `https://chat.deepseek.com/api/v0/chat/completion`：
  ```js
  // src/backends/deepseek/dpsk-client.js L588-601
  const body = {
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt: prompt,           // ← 完整 prompt，无截断
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      ...
  };
  if (maxTokens !== null && maxTokens > 0) {
      body.max_tokens = maxTokens;  // 默认 65536（anthropic-stream-handler.js L235）
  }
  ```
- 上游收到 50K+ token 的 prompt 时静默返回空 SSE 流（`yields=1, chars=0`），
  服务器日志显示 `[DPSK-PROBLEM] SSE 流结束但未收到 [DONE]/FINISHED (text=0B think=0B fragments=0 yields=0 0ms)`。
- 反代层将空响应当作正常流结束处理，返回空的 Anthropic 事件序列给客户端。

#### Qwen 链路分析

- 反代层同样没有限制。Qwen 的 `buildInternalRequest()` 将消息完整传入 `parsedMessages`，
  `sendChatRequest()` 原样发送给 `chat.qwen.ai/api/v2/chat/completions`。
- 当前 Qwen 上游对所有请求返回风控/captcha 响应（非 SSE），导致 500 错误。
  这不是上下文限制问题，而是账号/反爬问题。

### 3. 绕过方法

**本项目是 Web 端反代，不是 API Key 项目。永远不要提"改用官方 API Key"这种废话。**

限制来自 DeepSeek/千问 Web 端的上游服务，不是反代层可控的。反代层已确认无任何限制
（上下文压缩已删除、peekFirstChunk 已删除、所有请求完整透传）。

理论上模型支持 1M 上下文，但 Web 端接口（`chat.deepseek.com`、`chat.qwen.ai`）并非
模型的完整 API 端点，而是面向浏览器用户的 Web 聊天界面。Web 端对单次请求的 prompt 长度
有硬性限制（估计在 50K-100K token 左右），远低于模型的原生上下文窗口。

**可能的绕过方向（均在 Web 端范畴内探索）**：

1. **拆分轮次上传**：利用 DeepSeek 的 Session 持久化机制（chatSessionId + parentMessageId），
   将大上下文拆分为多个小请求，每个请求上传一部分，最后再发真正的问题。反代已支持 Session 续接。
   需测试：Web 端是否对 Session 累积上下文长度有总限制。

2. **多轮消息拼接**：在同一个 Web 聊天会话中，分多次发送长消息，每次发送一部分。
   利用 Web 端聊天界面本身支持的多轮对话能力绕过单次请求限制。

### 3.1 其他反代项目调研（2026-07-07 实测）

**qwen3-reverse 项目（[wwwzhouhui/qwen3-reverse](https://github.com/wwwzhouhui/qwen3-reverse)）**：
- 已 clone 到 `z:\qwen3-reverse\`，完整阅读了 2822 行源码
- 架构与我们的 Qwen 路线完全一致：`chat.qwen.ai/api/v2/chat/completions`
- **没有上下文绕过**：所有消息拼接为一个字符串 `"\n\n".join([f"{msg['role']}: {msg['content']}"])`
  一次性发送，同样受 Web 端单次请求长度限制
- 其他差异：硬编码 MODEL_MAP（我们已改为实时获取）、只有 OpenAI 协议（无 Anthropic）、
  Python/FastAPI 实现（我们是 Node.js）

**DeepSeek Web 反代项目**：
- 截至 2026-07-07，**GitHub 上不存在任何公开的 DeepSeek Web 端（chat.deepseek.com）反代项目**
- 所有搜索到的项目（codex-deepseek、deep-code 等）都是走官方 API（api.deepseek.com）
  或第三方 API 代理（SiliconFlow），不是 Web 端逆向
- 本项目是唯一已知的公开 DeepSeek Web 端 PoW 反代实现

**结论**：当前没有任何公开项目实现了 Web 端上下文限制的绕过。拆分轮次上传是唯一值得尝试的方向。

### 4. 测试数据

#### DeepSeek Expert 流式测试

| 级别 | 请求体大小 | 目标 Token | HTTP | TTFB | 总耗时 | SSE 事件 | 实际内容 |
|------|-----------|-----------|------|------|--------|---------|---------|
| 10K | 39.2 KB | 10,000 | 200 | 2,255ms | 290,053ms | 21,320 | 有内容（模型遍历了填充文本） |
| 50K | 195.4 KB | 50,000 | 200 | 930ms | 930ms | 3 | **空响应** |
| 100K | 390.7 KB | 100,000 | 200 | 828ms | 829ms | 3 | **空响应** |
| 200K | 781.4 KB | 200,000 | 200 | 1,097ms | 1,098ms | 3 | **空响应** |
| 500K | 1,953.2 KB | 500,000 | 200 | 1,057ms | 1,057ms | 3 | **空响应** |
| 1M | 3,906.4 KB | 1,000,000 | 200 | 1,145ms | 1,146ms | 3 | **空响应** |

#### DeepSeek Expert 非流式测试

| 级别 | 请求体大小 | HTTP | 总耗时 | 结果 |
|------|-----------|------|--------|------|
| 10K | 39.2 KB | 0 | 120,011ms | 超时（模型处理时间 > 120s） |

#### 服务器日志关键证据

```
# 10K 正常响应（262s 流式，19788 个 yield）
[DPSK-SEND] chat completion session=... model=expert prompt=40030B max_tokens=128
[DPSK-RECV] chat completion stream 结束 ... yields=19788 262062ms

# 50K+ 空响应（<1s，仅 1 个 yield，0 chars）
[DPSK-SEND] chat completion session=... model=expert prompt=800030B max_tokens=32
[DPSK-RECV] chat completion stream 结束 ... yields=1 795ms
[DPSK-Anth] 流式完成 (1058ms, chars=0, tool_calls=false, ...)
[DPSK-PROBLEM] SSE 流结束但未收到 [DONE]/FINISHED (text=0B think=0B fragments=0 yields=0 0ms)
```

### 5. 注意事项

- **stream 默认为 false**：根据 Anthropic 协议规范，`/v1/messages` 的 `stream` 字段缺省为 `false`。
  非流式模式下，反代层需要等待上游完整响应后再返回，大上下文下容易超时。
  建议客户端始终传 `stream: true`。
- **DeepSeek Anthropic 路线默认 max_tokens=65536**：`anthropic-stream-handler.js` L235：
  `maxTokens: (typeof max_tokens === 'number' && max_tokens > 0) ? max_tokens : 65536`。
  如果客户端不传 `max_tokens`，会自动设置 65536 传给上游。
- **Qwen 路线当前不可用**：所有 Qwen 模型在测试时返回 500 错误（上游风控/captcha），
  这不是上下文限制问题，需单独排查 Qwen 账号状态。
- **测试脚本**：`.test/test-context-limits.js` 支持参数化测试，可通过 `--model`、`--stream`、
  `--start`、`--end`、`--max-tokens`、`--timeout` 参数调整测试范围。
