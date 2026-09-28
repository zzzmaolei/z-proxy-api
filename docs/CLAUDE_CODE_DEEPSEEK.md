# Claude Code 接入 DeepSeek 链路指南

> 本文档基于 **2026-06-18** 版本（dpsk-chat.js 全面优化版）。

## 1. 架构概览

```
Claude Code (Anthropic SDK)
    │
    │ 默认: POST /v1/messages (Anthropic protocol)
    │ → z.proxy.api → Qwen Web Chat 后端
    │
    │ 如果你要把请求转到 DeepSeek，有两种方式:
    │
    ├── 方式 A: 通过 OpenAI 兼容中转层
    │   Claude Code → LiteLLM / 自建 relay → POST /v1/chat/completions
    │   → z.proxy.api /v1/chat/completions → model 名含 "deepseek"
    │   → z.proxy.api 内部自动转发到 dpsk-chat.js
    │
    └── 方式 B: 直接 POST /v1/dpsk/chat/completions
        Claude Code 配置 base_url 指向 /v1/dpsk 前缀
        → z.proxy.api → dpsk-chat.js → DeepSeek Web Chat
```

### 常见错误配置

**❌ 错误**:
```json
// Claude Code settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000/v1/dpsk"
  }
}
```
**为什么错**: Claude Code 会发 `POST /v1/dpsk/v1/messages`（错误路径）。

**✅ 正确**: 使用 OpenAI 兼容中转层（推荐 LiteLLM），或自建 relay：
```python
# Simple relay: Claude Code (Anthropic SDK) → OpenAI → z.proxy.api
@app.route('/v1/chat/completions')
def proxy():
    # translate Claude Code's OpenAI-style request → z.proxy.api
    payload = request.json
    # Force model to deepseek-v4-pro
    payload['model'] = 'deepseek-v4-pro'
    resp = requests.post('http://localhost:3000/v1/chat/completions', json=payload)
    return resp.json()
```

**或者**直接在 Claude Code 配置里指定 OpenAI provider：
```bash
# Claude Code env settings
ANTHROPIC_AUTH_TOKEN=sk-your-api-key
ANTHROPIC_BASE_URL=http://localhost:3000/v1
OAI_API_KEY=sk-your-api-key
```

---

## 2. 优化内容（2026-06-18）

### 2.1 Claude Code Profile 自动识别

当请求走 `/v1/chat/completions`（OpenAI 协议）时，系统现可**自动识别** Claude Code：

| 识别方式 | 触发条件 |
|----------|---------|
| `system` 含 "Claude Code" | 常见于 Claude Code 官方 system prompt |
| `tools` 含 `Read` + `Bash` + `Edit` | Claude Code 标志性只读工具 |
| `tools` 含 ≥4 个 Claude Code 工具 | Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch |
| `model` 以 `claude-` 开头 | `claude-3-5-sonnet` 等 |

识别后，响应头 `x-qwen-client-profile: claude-code` 会标注，日志里 `claude_code=true`。

### 2.2 工具调用提示词全面增强

对所有 profile 追加 **Tool failure recovery** 段：
- Edit 的 `old_string` 必须文件**字节级一致**
- Edit 失败超过 1 次 → **必须改用 Write**
- Read 对同一文件**最多连续调 1 次**
- 工具返回错误 → **先想清楚再调**，不要盲目 retry

仅 Claude Code 追加 **Anti-confusion guard**：
- 忽略 system 消息里 `ToolSearch`/`WebSearch`/`WebFetch`/`mcp__` 工具的描述
- 那是 Claude Code 内部工具，对本系统不可见
- 本轮只能用 `<tool_call>` 注入的工具集

### 2.3 过程话术主动丢弃

Claude Code 下，deepseek 输出 "我来读取..." / "let me check..." 等进度话术但
还没真正调工具时，**这些文本不再发到客户端**，避免 Claude Code 认为工作流结束了。

- 只影响 Claude Code 路径 (`claude_code=true`)
- 不影响 thinking 块（思考过程始终可见）
- 一旦首次 `<tool_call>` 被解析，后续文本正常透传

### 2.4 上下文智能压缩（不粗暴截断）

当消息历史过大时，默认**不修改客户端提供的 tool result**。DeepSeek 的 Web 上限由字节预算保护：

- 超过 hard limit 时，在创建 Web session/PoW 之前返回 `dpsk_prompt_too_large`
- 达到 soft limit 时跳过无意义的 transport/empty retry
- 若产品明确接受内容摘要，可设置 `DPSK_ENABLE_TOOL_HISTORY_COMPRESSION=true`；这是显式的有损策略，不是默认行为

如果上游 DeepSeek 返回 `context too long` 或空 SSE，优先缩短客户端历史或拆分任务；不得复用 Web session 来绕过限制。

### 2.5 流式 tool_call 补救 reparse

DeepSeek Web SSE 跨帧边界时可能把 `<tool_call>` 拆成两个 chunk。
如果整个流没有 emit 任何 tool_call 但最终响应里包含 `<tool_call>`，
自动用 `parseToolCallsFromText` 全量 reparse 一次。

### 2.6 客户端断开时 session 清理

Claude Code 流式响应中断或客户端断开 → 主动删除 session 缓存，
避免下一个请求复用"半挂" session 导致上下文错乱。

### 2.7 实时模型探测 & 变体展开

不再硬编码 deepseek-v4-pro / deepseek-v4-flash 两个模型。
每次调用 `getModels()` 时通过 `GET /api/v0/client/settings?scope=model` 实时拉取上游模型配置，
然后自动展开为对应变体：

| 上游 model_type | 生成模型 ID | 说明 |
|----------------|------------|------|
| `default` | `deepseek-default`, `deepseek-default-flash` | 快速模式（默认） |
| `expert` | `deepseek-expert`, `deepseek-expert-flash` | 专家模式 |
| `vision` | `deepseek-vision`, `deepseek-vision-flash` | 识图模式 |

每个模型 ID 都携带 `model_type`、`thinking_enabled`、`file_feature`、`search_feature` 元数据，
供下游 routing 使用。

Vision 模型的图片处理：
- `uploadFilesFromMessages` 不再跳过 `image_url` / `image` 类型的消息内容
- 图片通过 DeepSeek 文件上传接口转为 `ref_file_ids`，在 chat completion 时引用
- prompt 中图片内容以 `[Image attached]` 占位

失败时返回空数组（与 Qwen 路线一致），绝不返回硬编码假列表。

### 2.8 DeepSeek 上游 context too long 错误处理

当 DeepSeek Web Chat 的 `parseDeepSeekSSE` 检测到 `biz_code` 包含
"context"/"too long"/"length" 关键字时，错误带 `err.contextTooLong = true`，
上层 controller 自动触发压缩重试。

---

## 3. 使用验证

### 3.1 确认 Claude Code 被识别

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [
      {"role":"system","content":"You are Claude Code"},
      {"role":"user","content":"Read file test.txt"}
    ],
    "tools": [{"type":"function","function":{"name":"Read","description":"Read a file","parameters":{}}},
              {"type":"function","function":{"name":"Bash","description":"Run a command","parameters":{}}},
              {"type":"function","function":{"name":"Edit","description":"Edit a file","parameters":{}}}],
    "stream": false
  }'
```

**期望**:
- 响应头 `x-qwen-client-profile: claude-code`
- 日志显示 `claude_code=true`（不是 `false`）
- 响应内容正常

### 3.2 测试上下文压缩

构造一条 > 100k 字符的 user 消息，带 N 条历史：
```bash
# 用 Python 构造长消息 (略)
# curl ... 发送 150k 字符的 messages
```
**期望**: 请求不因为 context too long 而 500/503，返回正常响应。

### 3.3 测试过程话术丢弃

Claude Code 中执行："帮我修改 dpsk-account.js，添加 count api"。
**期望**:
- 不会看到 "我来读取..." / "let me read..." 出现在响应里
- 首个响应直接是 Read 工具调用
- 如果 Edit 失败 1 次，立即切换 Write

---

## 4. 常见问题排查

### Q: 日志里 `claude_code=false`

A: 确认你的 system 消息含 "Claude Code"，或 tools 列表含 Read + Bash + Edit。
检查 profile-detector 的 `detectClaudeCodeFromOpenAIBody` 启发式是否命中。

### Q: Read 工具调用 card死

A: 这是 DeepSeek 在长文本场景下的已知问题。检查上下文压缩是否触发（日志 `[DPSK] 上下文过长`），
尝试手动缩短消息历史或开启更多账号以分散负载。

### Q: Edit 工具 old_string 反复匹配失败

A: 新增的 Tool failure recovery 段告诉模型失败 1 次后改用 Write。
如果你仍然遇到此问题，检查 prompt 是否真的被注入（日志里搜索 `Tool failure recovery`）。

### Q: 上下文太长，DeepSeek 直接返回错误

A: 系统会在上游请求前按 UTF-8 字节预算拒绝明显超限的 prompt，并把空 SSE 标记为协议错误。默认不会静默截断 tool result；请在客户端缩短历史，或在明确接受有损摘要时设置 `DPSK_ENABLE_TOOL_HISTORY_COMPRESSION=true`。
