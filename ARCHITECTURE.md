# z.proxy.api 架构说明

> 本文档面向接手维护的开发者，系统性地介绍项目的分层架构、请求流转、核心设计模式
> 以及如何扩展新的 provider / 协议端点。阅读本文档后，应能快速定位到具体功能模块。

## 1. 项目定位

**z.proxy.api** 是一个多 provider API 网关，通过反向代理 Web 端 AI 模型（DeepSeek、Qwen 两家），
将其封装为兼容 OpenAI 和 Anthropic 协议的标准化 API，可以直接接入 Claude Code、Codex CLI、
Continue.dev、Cursor 等各类 AI harness / IDE 工具。

**核心原理：Prompt 模拟**
本项目反向代理的是 Web 端模型（非原生 API），Web 端模型不原生支持 tool calling、function calling、
thinking blocks 等高级协议特性。所有 harness 兼容性优化都基于同一个原理：在 prompt 中注入指令文本，
让模型在输出流中以约定的 XML 格式（如 `<tool_call>`）"模拟"出原生 API 的行为，再由控制器实时解析
并翻译为 OpenAI / Anthropic 协议事件。

## 2. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1 — 协议入口                                          │
│ routes/ + controllers/                                      │
│ 接收 Anthropic/OpenAI/Responses 协议请求，统一转换为内部格式 │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 2 — 共享抽象                                          │
│ shared/                                                     │
│ retry、tool-injection、SSE writing、client-detection、      │
│ anthropic-helpers（纯函数）、anthropic-base（流式基础设施） │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 3 — Provider 后端                                     │
│ backends/deepseek/                                          │
│ stream/sync handler → 调用 upstream client → 解析响应       │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ Layer 4 — 基础设施                                          │
│ utils/ + providers/                                         │
│ 账号管理、tokenizer、SSE 解析、上游通信、header 构建        │
└─────────────────────────────────────────────────────────────┘
```

## 3. 目录结构

```
src/
├── agents/                  # 客户端 profile 定义
│   ├── index.js             #   profile 注册表 + 检测入口
│   ├── profile-detector.js  #   基于 User-Agent / 请求特征检测客户端类型
│   ├── claude-code-profile.js    # Claude Code 严格模式 profile
│   ├── openai-compatible-profile.js  # 通用 OpenAI 兼容客户端 profile
│   ├── generic-anthropic-profile.js  # 通用 Anthropic 兼容客户端 profile
│   └── hermes-agent-profile.js  # Hermes agent profile
│
├── backends/                # Provider 后端逻辑（stream/sync handler + provider 专用工具）
│   ├── stream-utils.js      #   DeepSeek 共享的 OpenAI SSE 写入工具
│   ├── deepseek/            #   DeepSeek: stream-handler, sync-handler, anthropic-{stream,sync}-handler,
│   │                        #     dpsk-client, dpsk-account, dpsk-fingerprint, dpsk-pow
│   └── qwen/                #   Qwen: stream-handler, sync-handler, anthropic-{stream,sync}-handler,
│                            #     anthropic-utils, stream-utils, request, upload, upstream-{client,consumer},
│                            #     chat-id, chat-id-pool, cookie-generator, fingerprint, baxia-umid,
│                            #     ssxmod-manager, qwen-homepage-warmup
│
├── config/                  # 环境变量配置
│   └── index.js             #   统一配置入口
│
├── controllers/             # 控制器（协议入口 + 编排）
│   ├── anthropic.js         #   Anthropic /v1/messages 主控制器（Qwen 路线）
│   ├── anthropic-deepseek.js#   Anthropic /v1/messages DeepSeek 路线
│   ├── anthropic.compatibility.js  # Anthropic 兼容性头处理
│   ├── chat.js              #   OpenAI /v1/chat/completions 主控制器（Qwen 路线）
│   ├── chat.image.video.js  #   Qwen 图片/视频生成专用控制器
│   ├── dpsk-chat.js         #   DeepSeek chat 入口（编排层，handler 在 backends/）
│   ├── models.js            #   OpenAI /v1/models 模型列表
│   └── dpsk-models.js       #   DeepSeek 模型列表
│
├── middlewares/             # Express 中间件
│   ├── authorization.js     #   API Key 认证
│   └── chat-middleware.js   #   请求预处理（client profile 注入等）
│
├── models/                  # 模型列表管理
│   └── models-map.js        #   Qwen 模型实时获取与缓存
│
├── providers/               # Provider 注册表 + 上游通信封装
│   ├── registry.js          #   声明式路由注册表（按 model 名分发到 controller）
│   └── qwen-web/            #   Qwen Web API 封装（client, headers, normalizer, endpoints）
│
├── routes/                  # Express 路由定义
│   ├── chat.js              #   /v1/chat/completions
│   ├── anthropic.js         #   /v1/messages
│   ├── models.js            #   /v1/models
│   ├── dpsk-chat.js         #   /v1/dpsk/chat/completions（测试用直连端点）
│   ├── responses-compat.js  #   /v1/responses（Codex CLI 适配，翻译为 chat/completions）
│   ├── accounts.js          #   账号管理 API
│   └── ...
│
├── shared/                  # 跨 provider 共享逻辑
│   ├── anthropic-helpers.js #   Anthropic 协议纯函数（profile / normalize / flatten）
│   ├── anthropic-base.js    #   Anthropic 流式控制器共享基础设施（heartbeat / parser / retry / fallback）
│   ├── client-detection.js  #   客户端 profile 安全检测包装器
│   ├── retry.js             #   通用异步重试包装器（withRetry）
│   └── tool-injection.js    #   工具提示注入 + 重试提示构建
│
├── utils/                   # 工具函数（账号管理、SSE 解析、token 统计等）
│   ├── logger.js            #   统一日志器
│   ├── tools.js             #   通用工具函数（UUID、JSON 检测等）
│   ├── account.js           #   Qwen 账号管理器
│   ├── dpsk-account.js      #   DeepSeek 账号管理器
│   ├── dpsk-client.js       #   DeepSeek 上游通信客户端
│   ├── dpsk-pow.js          #   DeepSeek PoW 求解器（WASM）
│   ├── dpsk-fingerprint.js  #   DeepSeek 浏览器指纹
│   ├── request.js           #   Qwen 上游请求发送
│   ├── upstream-consumer.js #   上游流消费器
│   ├── upstream-http.js     #   上游 HTTP 通信基础
│   ├── anthropic-sse-state.js    # Anthropic SSE 写入器 + 状态机
│   ├── sse-frame-parser.js  #   SSE 帧解析器
│   ├── tool-prompt.js       #   工具调用提示词 + 流式解析器（核心模块）
│   ├── strict-tool-mode.js  #   严格工具模式（fallback tool use）
│   ├── precise-tokenizer.js #   token 计数器
│   ├── usage-tracker.js     #   用量统计与归因
│   ├── context-compressor.js#   上下文压缩（超长 prompt 渐进降级）
│   ├── chat-id-pool.js      #   chat_id 预生成池
│   ├── chat-latency-monitor.js  # 聊天延迟监控
│   ├── chat-interruption-monitor.js  # 聊天中断监控
│   ├── redis.js             #   Redis 客户端
│   ├── data-persistence.js  #   数据持久化（file / redis 模式）
│   ├── account-pool-redis.js#   账号池 Redis 实现
│   └── ...
│
├── server.js                # Express 应用入口
└── start.js                 # 启动脚本（自动选择 PM2 / 直接启动）
```

## 4. 请求流转

### 4.1 OpenAI /v1/chat/completions 请求流转

```
客户端请求
  ↓
routes/chat.js               # 路由入口
  ↓
middlewares/authorization.js # API Key 认证
  ↓
middlewares/chat-middleware.js # 注入 clientProfile
  ↓
providers/registry.js        # 按 model 名分发
  ↓
┌─────────────────────────────────────────┐
│ model 含 "dpsk" / "deepseek"            │
│   → controllers/dpsk-chat.js            │
│   → backends/deepseek/stream-handler.js │
│   → utils/dpsk-client.js                │
└─────────────────────────────────────────┘
┌─────────────────────────────────────────┐
│ 其他（Qwen）                            │
│   → controllers/chat.js                 │
│   → utils/request.js                    │
│   → providers/qwen-web/client.js        │
└─────────────────────────────────────────┘
```

### 4.2 Anthropic /v1/messages 请求流转

```
客户端请求（Claude Code 等）
  ↓
routes/anthropic.js          # 路由入口
  ↓
middlewares/authorization.js # API Key 认证
  ↓
providers/registry.js        # 按 model 名分发
  ↓
┌─────────────────────────────────────────────────────┐
│ model 含 "dpsk" / "deepseek"                        │
│   → controllers/anthropic-deepseek.js               │
│   → shared/anthropic-helpers.js（纯函数）           │
│   → shared/anthropic-base.js（heartbeat/parser 等） │
│   → utils/dpsk-client.js（上游通信）                │
│   → utils/anthropic-sse-state.js（SSE 写入）        │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│ 其他（Qwen）                                        │
│   → controllers/anthropic.js                        │
│   → utils/request.js + providers/qwen-web/          │
└─────────────────────────────────────────────────────┘
```

### 4.3 OpenAI /v1/responses 请求流转（Codex CLI）

```
Codex CLI 请求
  ↓
routes/responses-compat.js   # Responses API → chat/completions 翻译层
  ↓
controllers/dpsk-chat.js
  ↓
（后续与 /v1/chat/completions 相同）
```

## 5. 核心设计模式

### 5.1 Provider 注册表（声明式路由）

`src/providers/registry.js` 是一个声明式路由表，按 model 名前缀分发到对应 controller：

```javascript
// 简化示例
const registry = [
  { match: /^(dpsk|deepseek)/i, controller: 'anthropic-deepseek.js' },
  // 其余走默认 Qwen 路线
];
```

新增 provider 只需在 registry 注册，无需修改路由代码。

### 5.2 Profile 驱动决策

不同客户端（Claude Code / Codex / Continue / Hermes）对协议严格性要求不同。
通过 `agents/` 目录下的 profile 定义，将客户端特定的严格性配置与通用协议逻辑解耦：

```javascript
// agents/claude-code-profile.js
module.exports = {
  name: 'claude-code',
  profile: {
    strictToolUse: true,           // 严格工具调用（工具名必须匹配）
    dropToolPreamble: true,        // 丢弃"我来看看"等过程话术
    requireStopReasonToolUse: true,// tool_use 时 stop_reason 必须为 tool_use
    maxCorrectionRetry: 1,         // 纠偏重试次数
  },
  looksLikeIntendsToCallTool: (text) => { /* ... */ },
  looksLikeFinalReport: (text) => { /* ... */ },
};
```

控制器通过 `getAnthropicProfile(req)` 获取当前 profile，用 `shouldRequireStopReasonToolUse(profile)`
等 helper 做 profile 驱动决策，避免在代码中硬编码客户端判断。

### 5.3 工具提示词三层解耦

`src/utils/tool-prompt.js` 中的 `buildToolSystemPrompt()` 是工具调用提示词的核心模块，
被所有 2 个 provider 路线共用。提示词生成涉及三个正交维度，按维度独立组织：

```
┌─────────────────────────────────────────────────────────┐
│ 协议层（只有 OpenAI / Anthropic 两种）                  │
│   buildClaudeCodeBlock()      # Anthropic /v1/messages  │
│   buildCodexBlock()           # OpenAI /v1/responses    │
│   buildOpenAIChatProtocolHint()# OpenAI /v1/chat        │
├─────────────────────────────────────────────────────────┤
│ Provider 层（针对上游模型能力差异注入额外约束）         │
│   buildDeepSeekStrictProtocol()  # DeepSeek 专用严格块  │
│   （Qwen 当前无特化块）                                 │
├─────────────────────────────────────────────────────────┤
│ 通用层（与协议/provider 无关）                          │
│   buildImageAwareBlock()      # 图片感知模式            │
│   buildToolChoiceBlock()      # tool_choice 语义        │
│   buildFailureRecoveryBlock() # 工具失败恢复策略        │
└─────────────────────────────────────────────────────────┘
```

### 5.4 Anthropic 控制器共享基础设施

两个 Anthropic 控制器（Qwen / DeepSeek）共用两个 shared 模块：

```
shared/anthropic-helpers.js（纯函数，无副作用）
  ├── getAnthropicProfile()           # 获取 profile
  ├── shouldRequireStopReasonToolUse()# profile 驱动决策
  ├── normalizeAnthropicSystem()      # system 字段规范化
  ├── normalizeAnthropicTools()       # tools → OpenAI 风格
  ├── normalizeAnthropicToolChoice()  # tool_choice → OpenAI 风格
  ├── normalizeAnthropicImageSource() # image.source 规整
  ├── flattenAnthropicMessages()      # Anthropic messages → OpenAI messages
  └── hasAnthropicRequestImage()      # 是否含图片

shared/anthropic-base.js（流式处理工具，带状态/带 I/O）
  ├── HEARTBEAT_MS / startHeartbeat() # SSE 心跳
  ├── buildToolParser()               # tool call 流式解析器工厂
  ├── flushToolParser()               # parser 尾部缓冲 flush
  ├── consumeRetryAnswer()            # 消费重试 generator
  ├── tryReadonlyFallbackToolUse()    # 空响应只读工具 fallback
  ├── attributeAnthropicUsage()       # token 用量归因
  ├── filterReadonlyFallbackTools()   # 筛选只读工具
  └── isTextEssentiallyEmpty()        # 文本实质为空判断
```

### 5.5 SSE 状态机（Anthropic）

`src/utils/anthropic-sse-state.js` 实现了 Anthropic SSE 协议的状态机：

```
message_start
  ↓
content_block_start (type: thinking | text | tool_use)
  ↓
content_block_delta  (thinking_delta | text_delta | input_json_delta)
  ↓
content_block_stop
  ↓
... (更多 content block)
  ↓
message_delta (stop_reason, usage)
  ↓
message_stop
```

`createAnthropicStreamWriter(res, sseState, { messageId, model })` 封装了所有 SSE 事件写入，
控制器只需调用 `writer.emitTextDelta()` / `writer.emitThinkingDelta()` / `writer.writeToolCalls()`
等方法，无需关心 SSE 协议细节。

## 6. 如何扩展

### 6.1 新增 Provider

1. **创建上游客户端**：在 `utils/` 下新建 `<provider>-client.js`，封装上游 Web API 通信
2. **创建账号管理器**：在 `utils/` 下新建 `<provider>-account.js`，实现 `getAvailableAccount()` / `releaseAccount()`
3. **创建后端 handler**（可选）：在 `backends/<provider>/` 下新建 `stream-handler.js` 和 `sync-handler.js`
4. **创建控制器**：在 `controllers/` 下新建 `anthropic-<provider>.js` 和/或 `<provider>-chat.js`
5. **注册路由**：在 `providers/registry.js` 中按 model 名前缀注册
6. **复用共享模块**：
   - Anthropic 路线：`require('../shared/anthropic-helpers')` + `require('../shared/anthropic-base')`
   - OpenAI 路线：`require('../shared/retry')` + `require('../shared/tool-injection')`

### 6.2 新增协议端点

1. **创建路由**：在 `routes/` 下新建路由文件
2. **创建控制器**：在 `controllers/` 下新建控制器
3. **复用 shared/**：尽量复用 `shared/anthropic-helpers.js`、`shared/anthropic-base.js` 等共享模块
4. **在 server.js 注册路由**

### 6.3 新增客户端 Profile

1. **创建 profile 文件**：在 `agents/` 下新建 `<client>-profile.js`
2. **注册 profile**：在 `agents/index.js` 中注册
3. **更新检测器**：在 `agents/profile-detector.js` 中添加 User-Agent / 请求特征检测规则

## 7. 铁律

> 这些规则在 `CLAUDE.md` 中有详细说明，这里仅列出关键点：

1. **模型列表绝对不允许硬编码**：任何 provider 的模型列表都必须从上游实时获取
2. **每次改动必须 commit + 重启服务**：commit message 遵循 Conventional Commits；重启统一运行 `scripts/restart.bat`
3. **最小化修改**：一次只改一个链，不改能正常跑的功能
4. **改前先看 diff**：确认工作目录干净，分清"我的改动"和"已有的未提交改动"
5. **修改列表写进 memory**：方便下一轮排查时回溯

## 8. 已知问题与待办

- **DeepSeek 模型列表仍为硬编码**：需改造为实时获取（Qwen 已正确实现）

## 9. backends 统一接口（2026-07-04 阶段 C 完成）

所有 `backends/*/stream-handler.js` 和 `sync-handler.js` 入口统一为**单参 ctx 对象**：

| 文件 | 导出函数 |
|------|---------|
| backends/qwen/stream-handler.js | `handleStreamResponse(ctx)` |
| backends/qwen/sync-handler.js | `handleSyncResponse(ctx)` |
| backends/qwen/anthropic-stream-handler.js | `handleAnthropicStream(ctx)` |
| backends/qwen/anthropic-sync-handler.js | `handleAnthropicSync(ctx)` |
| backends/deepseek/stream-handler.js | `handleStreamResponse(ctx)` |
| backends/deepseek/sync-handler.js | `handleSyncResponse(ctx)` |
| backends/deepseek/anthropic-stream-handler.js | `handleAnthropicStream(ctx)` |
| backends/deepseek/anthropic-sync-handler.js | `handleAnthropicSync(ctx)` |

**ctx 通用字段**：`res, req, model, account, startTime, requestId, clientProfile`

**ctx 协议特化**：
- OpenAI: `response`（上游 axios 响应）+ `requestBody, enable_thinking, enable_web_search`
- Anthropic: `messages, system, tools, tool_choice, max_tokens, thinking`

**ctx provider 特化**：
- DeepSeek: `token, chatSessionId, prompt, chatOptions, cachedSession, sessionKey`
- Qwen Anthropic: `upstream, message_id, hasTools, toolChoice, rawTools, rawMessages, retryCount, latency`

## 10. Qwen thinking 模型特殊处理

Qwen Web API 的 thinking 模型返回两种 thinking phase：

- **`phase='think'`**：传统 thinking 输出，`delta.content` 字段直接包含 thinking 文本
- **`phase='thinking_summary'`**：summary 阶段，`delta.content` 为空，真实文本在
  `delta.extra.summary_thought.content[]` **累积数组**里（每次事件包含全部历史，只取
  最后一个元素作为本次增量，避免重复输出）

提取逻辑统一封装在 `backends/qwen/stream-utils.js` 的 `extractThinkingSummaryDelta(delta)`
和 `isThinkingPhase(phase)` 中，被 4 个 Qwen handler 共用。Thinking 内容通过：
- OpenAI 协议：`delta.reasoning_content` 字段输出
- Anthropic 协议：`thinking` content block 输出

不再向 `content` 注入 `</think>` 闭合标签（thinking 已通过独立字段/block 输出）。
