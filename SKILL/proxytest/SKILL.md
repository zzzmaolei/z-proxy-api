---
name: "proxytest"
description: "Runs full-chain smoke tests against the z.proxy.api gateway (Qwen + DeepSeek routes, OpenAI + Anthropic protocols, plain + tools + stream + long-context multi-turn modes). Invoke when user asks to verify service health, test both routes, run proxy tests, or after code changes that may affect request handling."
---

# proxytest

对 z.proxy.api 网关执行全链路烟雾测试，覆盖 Qwen 和 DeepSeek 两条路线 × OpenAI/Anthropic 两种协议 × 普通/tools/流式/超长上下文多轮 四种模式。

## 何时调用

- 用户要求"测试两条路线是否通"、"检查服务是否正常"、"跑一下代理测试"
- 代码改动后需要验证请求处理链路（提示词注入、工具调用解析、流式输出、协议转换、上下文续接）
- 用户报告"完全用不了"、"某个模型用不了"等可用性问题
- 用户明确提到 proxytest / proxy test / 代理测试

## 前置条件

- 服务运行在 `http://localhost:9090`（端口由 `.env` 中 `SERVICE_PORT=9090` 决定）
- `.env` 中至少配置了一个有效的 API_KEY（测试请求用 `Authorization: Bearer <key>`）
- 至少有一个 Qwen 账号和一个 DeepSeek 账号可用

## 测试矩阵

共 18 个测试场景，必须全部覆盖：

### A. 基础测试（10 个）

#### Qwen 路线（model: qwen3-max，上游 chat.qwen.ai）

| # | 协议端点 | 模式 | 请求特征 |
|---|---------|------|---------|
| 1 | POST /v1/chat/completions | 普通非流式 | `stream:false`, 无 tools |
| 2 | POST /v1/chat/completions | 普通流式 | `stream:true`, 无 tools |
| 3 | POST /v1/chat/completions | tools 非流式 | `stream:false`, 带 calc tool |
| 4 | POST /v1/chat/completions | tools 流式 | `stream:true`, 带 calc tool |
| 5 | POST /v1/messages | Anthropic tools 非流式 | `stream:false`, 带 calc tool, `max_tokens:1024` |

#### DeepSeek 路线（model: deepseek，上游 chat.deepseek.com）

| # | 协议端点 | 模式 | 请求特征 |
|---|---------|------|---------|
| 6 | POST /v1/chat/completions | 普通非流式 | `stream:false`, 无 tools |
| 7 | POST /v1/chat/completions | 普通流式 | `stream:true`, 无 tools |
| 8 | POST /v1/chat/completions | tools 非流式 | `stream:false`, 带 calc tool |
| 9 | POST /v1/chat/completions | tools 流式 | `stream:true`, 带 calc tool |
| 10 | POST /v1/messages | Anthropic tools 非流式 | `stream:false`, 带 calc tool, `max_tokens:1024` |

### B. Anthropic tools 流式测试（2 个）

| # | 路线 | 协议端点 | 模式 | 请求特征 |
|---|------|---------|------|---------|
| 11 | Qwen | POST /v1/messages | Anthropic tools 流式 | `stream:true`, 带 calc tool, `max_tokens:1024` |
| 12 | DeepSeek | POST /v1/messages | Anthropic tools 流式 | `stream:true`, 带 calc tool, `max_tokens:1024` |

### C. 超长上下文 + tools 多轮测试（4 个）

每轮发送约 30K tokens 的上下文（填充文本），共 3 轮对话。验证大上下文下 tools 调用是否正常、输出是否泄漏 XML 标签。

| # | 路线 | 协议端点 | 模式 | 请求特征 |
|---|------|---------|------|---------|
| 13 | Qwen | POST /v1/chat/completions | OpenAI 超长上下文 + tools 多轮 | 3 轮, 每轮 ~30K tokens, 带 calc tool |
| 14 | DeepSeek | POST /v1/chat/completions | OpenAI 超长上下文 + tools 多轮 | 3 轮, 每轮 ~30K tokens, 带 calc tool |
| 15 | Qwen | POST /v1/messages | Anthropic 超长上下文 + tools 多轮 | 3 轮, 每轮 ~30K tokens, 带 calc tool |
| 16 | DeepSeek | POST /v1/messages | Anthropic 超长上下文 + tools 多轮 | 3 轮, 每轮 ~30K tokens, 带 calc tool |

### D. Claude Code 兼容性测试（2 个）

验证 Claude Code 某些版本的非标准请求行为：
- 把 `system` 消息放到 `messages` 数组里（而非顶级 `system` 字段）
- 多轮 tools 对话中 assistant 消息 `content: null`（只有 `tool_calls`）

反代层应通过 `extractSystemFromMessages` 把 system 提取到顶级 system 字段，
`flattenAnthropicMessages` 应能处理 null content。Joi schema 应宽松放行。

| # | 路线 | 协议端点 | 模式 | 请求特征 |
|---|------|---------|------|---------|
| 17 | Qwen | POST /v1/messages | Anthropic + system-in-messages + null-content assistant | `messages:[user, system, assistant(content=null,tool_calls), user]`, 带 calc tool, `stream:true`, `max_tokens:1024` |
| 18 | DeepSeek | POST /v1/messages | Anthropic + system-in-messages + null-content assistant | 同上 |

## 执行流程

### 步骤 1：确认服务状态

```powershell
netstat -ano | findstr :9090
```

- 若无 LISTENING 行，服务未启动 → 告知用户并停止
- 记录 PID 供后续参考

### 步骤 2：读取 API key

从 `.env` 文件读取一个有效的 `API_KEY` 值。如果 `.env` 不存在或没有 API_KEY，告知用户。

### 步骤 3：执行基础测试（#1-#10）

**关键规则**：
- 使用 `curl.exe`（不是 `curl`，PowerShell 的 `curl` 是 `Invoke-WebRequest` 别名，无法正确处理 JSON body）
- 每个测试用 `--max-time 120`（DeepSeek PoW + 思考模型可能较慢）
- 流式请求用 `-N` 禁用缓冲
- 测量每个请求的耗时（`$start = Get-Date` ... `$elapsed = ((Get-Date) - $start).TotalSeconds`）
- 请求体直接内联在命令中（用 `-d` + JSON 字符串），避免创建临时文件

**请求体模板**：

普通请求（Qwen）：
```json
{"model":"qwen3-max","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":false}
```

普通请求（DeepSeek）：
```json
{"model":"deepseek","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":false}
```

OpenAI tools 请求（calc 工具）：
```json
{"model":"<qwen3-max|deepseek>","messages":[{"role":"user","content":"what is 1+1? use the calc tool"}],"tools":[{"type":"function","function":{"name":"calc","description":"calculate a math expression","parameters":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}}],"stream":<true|false>}
```

Anthropic 请求（/v1/messages）：
```json
{"model":"<qwen3-max|deepseek>","messages":[{"role":"user","content":"what is 1+1? use the calc tool"}],"tools":[{"name":"calc","description":"calculate a math expression","input_schema":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}],"stream":<true|false>,"max_tokens":1024}
```

Anthropic 请求需要额外 header：
```
-H "anthropic-version: 2023-06-01"
```

### 步骤 4：执行 Anthropic tools 流式测试（#11-#12）

与 #5/#10 相同的请求体，但 `stream:true`。验证 SSE 事件序列：

预期的 Anthropic 流式事件序列：
```
event: message_start
event: content_block_start (type: tool_use, name: calc)
event: content_block_delta (type: input_json_delta, partial_json: "{\"expr\":")
event: content_block_delta (type: input_json_delta, partial_json: "\"1+1\"}")
event: content_block_stop
event: message_delta (stop_reason: tool_use)
event: message_stop
```

DeepSeek 可能前面还有 thinking 块的流式事件（content_block_start type: thinking + thinking_delta）。

### 步骤 5：执行超长上下文 + tools 多轮测试（#13-#16）

#### 5.1 生成填充文本

使用 PowerShell 生成约 30K tokens 的填充文本（约 120KB 英文文本）：

```powershell
# 生成约 30K tokens 的填充文本（英文 ~4 字符/token，所以约 120000 字符）
$para = "The quick brown fox jumps over the lazy dog near the riverbank at sunset while birds sing in the trees and the wind gently rustles the leaves creating a peaceful atmosphere that calms the mind and soothes the soul. "
$filler = $para * 250   # 约 125KB ≈ 31K tokens
```

#### 5.2 多轮对话流程（以 OpenAI 协议为例）

**第 1 轮**：用户发送填充文本 + 工具调用请求
```json
{
  "model": "<qwen3-max|deepseek>",
  "messages": [
    {"role":"user","content":"<filler>\n\nBased on the above context, calculate 1+1 using the calc tool."}
  ],
  "tools":[{"type":"function","function":{"name":"calc","description":"calculate a math expression","parameters":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}}],
  "stream": false
}
```

验证第 1 轮响应：
- `tool_calls[0].function.name === "calc"`
- `tool_calls[0].function.arguments` 包含 `"expr":"1+1"`
- `finish_reason === "tool_calls"`
- `content` 不包含任何 XML 标签（`<tool_invoke>`、`<tool_call`、`</tool_call` 等）

**第 2 轮**：把第 1 轮的 assistant tool_calls + tool 结果加到 messages，再加新的填充文本 + 新的工具请求
```json
{
  "model": "<qwen3-max|deepseek>",
  "messages": [
    {"role":"user","content":"<filler_round1>\n\nCalculate 1+1 using the calc tool."},
    {"role":"assistant","content":null,"tool_calls":[{"id":"call_r1","type":"function","function":{"name":"calc","arguments":"{\"expr\":\"1+1\"}"}}]},
    {"role":"tool","tool_call_id":"call_r1","name":"calc","content":"2"},
    {"role":"user","content":"<filler_round2>\n\nThe previous result was 2. Now calculate 2+2 using the calc tool."}
  ],
  "tools":[{"type":"function","function":{"name":"calc","description":"calculate a math expression","parameters":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}}],
  "stream": false
}
```

验证第 2 轮响应：
- `tool_calls[0].function.arguments` 包含 `"expr":"2+2"`
- `content` 不包含任何 XML 标签

**第 3 轮**：继续累加上下文
```json
{
  "model": "<qwen3-max|deepseek>",
  "messages": [
    {"role":"user","content":"<filler_r1>\n\nCalculate 1+1 using the calc tool."},
    {"role":"assistant","content":null,"tool_calls":[{"id":"call_r1","type":"function","function":{"name":"calc","arguments":"{\"expr\":\"1+1\"}"}}]},
    {"role":"tool","tool_call_id":"call_r1","name":"calc","content":"2"},
    {"role":"user","content":"<filler_r2>\n\nCalculate 2+2 using the calc tool."},
    {"role":"assistant","content":null,"tool_calls":[{"id":"call_r2","type":"function","function":{"name":"calc","arguments":"{\"expr\":\"2+2\"}"}}]},
    {"role":"tool","tool_call_id":"call_r2","name":"calc","content":"4"},
    {"role":"user","content":"<filler_r3>\n\nThe previous results were 2 and 4. Now calculate 4+4 using the calc tool."}
  ],
  "tools":[{"type":"function","function":{"name":"calc","description":"calculate a math expression","parameters":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}}],
  "stream": false
}
```

验证第 3 轮响应：
- `tool_calls[0].function.arguments` 包含 `"expr":"4+4"`
- `content` 不包含任何 XML 标签
- 3 轮总上下文约 90K tokens

#### 5.3 Anthropic 协议的多轮对话

Anthropic 协议多轮工具消息格式：
```json
{
  "model": "<qwen3-max|deepseek>",
  "messages": [
    {"role":"user","content":"<filler_r1>\n\nCalculate 1+1 using the calc tool."},
    {"role":"assistant","content":[{"type":"tool_use","id":"call_r1","name":"calc","input":{"expr":"1+1"}}]},
    {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_r1","content":"2"}]},
    {"role":"user","content":"<filler_r2>\n\nCalculate 2+2 using the calc tool."}
  ],
  "tools":[{"name":"calc","description":"calculate a math expression","input_schema":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}],
  "stream": false,
  "max_tokens": 1024
}
```

注意：Anthropic 协议中 `tool_result` 必须在 user 消息的 content 数组中，不能单独作为 role:tool。

#### 5.4 XML 泄漏检测

每一轮的响应都必须检查 `content` 字段（或 Anthropic 的 text 块）是否包含内部 XML 标签：

需要检测的标签（出现任何一个即判定 XML 泄漏）：
- `<tool_invoke>` 或 `</tool_invoke>`
- `<tool_call` 或 `</tool_call`
- `<tool_calls>` 或 `</tool_calls>`
- `$tool_call$` 或 `$/tool_call$`
- `<tool_response`

用 PowerShell 检测：
```powershell
$content = $response.choices[0].message.content
$xmlLeaked = $content -match '<tool_invoke>|</tool_invoke>|<tool_call|</tool_call|\$tool_call\$|<tool_response'
if ($xmlLeaked) { Write-Host "XML LEAKED: $content" }
```

### 步骤 6：执行 Claude Code 兼容性测试（#17-#18）

验证 Claude Code 某些版本的非标准请求（system role in messages + assistant content=null）能通过校验并正确处理。

请求体模板（Anthropic 协议，messages 中混合 system + null-content assistant）：
```json
{
  "model": "<qwen3-max|deepseek>",
  "messages": [
    {"role":"user","content":"Calculate 1+1 using the calc tool."},
    {"role":"system","content":"You are a helpful assistant that always uses tools when asked to calculate."},
    {"role":"assistant","content":null,"tool_calls":[{"id":"call_prev","type":"function","function":{"name":"calc","arguments":"{\"expr\":\"0+0\"}"}}]},
    {"role":"user","content":"Now calculate 1+1 using the calc tool."}
  ],
  "tools":[{"name":"calc","description":"calculate a math expression","input_schema":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}],
  "stream": true,
  "max_tokens": 1024
}
```

注意：Anthropic 协议中 `tool_calls` 字段非原生（原生用 `content:[{type:"tool_use",...}]`），
但 Claude Code 兼容性测试要验证反代层对这种混合形态的容忍度。

验证规则：
- HTTP 200（不应返回 400 `messages[N].role must be one of [user, assistant]`）
- 流式响应正常，出现 `event: message_start`
- 出现 `event: content_block_start` 且 `content_block.type == "tool_use"`（system 指令生效，模型调用了工具）
- `event: message_delta` 中 `delta.stop_reason == "tool_use"`
- 无 XML 标签泄漏

### 步骤 7：验证规则汇总

**普通请求**（非流式）：
- HTTP 200
- `choices[0].message.content` 非空字符串
- `finish_reason: "stop"`

**普通请求**（流式）：
- 多个 `data: {...}` SSE 事件
- 至少有一个 `delta.content` 非空
- 最后有 `data: [DONE]`

**tools 请求**（非流式 OpenAI）：
- `choices[0].message.tool_calls` 数组非空
- `tool_calls[0].function.name === "calc"`
- `tool_calls[0].function.arguments` 包含 `"expr"`
- `finish_reason: "tool_calls"`
- `content` 为 null 或空字符串（模型只调用工具不说话）
- **`content` 不包含任何 XML 标签**（XML 泄漏检测）

**tools 请求**（流式 OpenAI）：
- 出现 `delta.tool_calls` 事件（先 name 后 arguments 增量）
- `finish_reason: "tool_calls"`
- `data: [DONE]`
- **所有 `delta.content` 拼接后不包含 XML 标签**

**tools 请求**（Anthropic /v1/messages 非流式）：
- `content` 数组包含 `{"type":"tool_use","name":"calc","input":{"expr":"1+1"}}`
- `stop_reason: "tool_use"`
- DeepSeek 可能还有 `{"type":"thinking","thinking":"..."}` 块（正常）
- **所有 `type:text` 块的 text 字段不包含 XML 标签**

**tools 请求**（Anthropic /v1/messages 流式）：
- 出现 `event: content_block_start` 且 `content_block.type == "tool_use"`
- 出现 `event: content_block_delta` 且 `delta.type == "input_json_delta"`
- `event: message_delta` 中 `delta.stop_reason == "tool_use"`
- **所有 `text_delta` 事件拼接后不包含 XML 标签**

**超长上下文 + tools 多轮**：
- 3 轮全部返回正确的 tool_calls
- 每轮的 `content` 都不包含 XML 标签
- 第 2、3 轮能正确理解前序工具结果（计算结果递增：2→4→8）
- 无空响应、无 500 错误、无超时

**Claude Code 兼容性**（#17-#18）：
- HTTP 200（不应返回 400 `messages[N].role must be one of [user, assistant]`）
- 流式响应正常，出现 `event: message_start` / `event: message_stop`
- 出现 `content_block.type == "tool_use"`（system 指令生效）
- `delta.stop_reason == "tool_use"`
- 无 XML 标签泄漏

### 步骤 8：汇总报告

输出一个表格，包含：# | 路由 | 协议 | 模式 | 耗时 | 结果（✅/❌）| 备注

如果有失败：
- 记录 HTTP 状态码
- 记录响应体片段（前 500 字符）
- 记录失败现象（空响应/超时/错误码/无 tool_calls/XML 泄漏 等）
- 超长上下文测试需标注是第几轮失败
- 不要自动修复，只报告给用户

## 失败排查指引

| 现象 | 可能原因 |
|------|---------|
| Qwen tools 返回 `content:null, completion_tokens:0` | 上游 function_call 拦截（检查 `` → `<tool_invoke>` 替换是否生效） |
| DeepSeek 超时 | PoW 求解慢或账号被限流 |
| Qwen 返回 500 + RGV587_ERROR | Qwen 风控/captcha，账号问题 |
| 所有 Qwen 请求 500 | Qwen 账号全部失效 |
| 所有 DeepSeek 请求 500 | DeepSeek 账号或 PoW 问题 |
| 连接被拒绝（端口不通） | 服务未启动或崩溃 |
| 超长上下文 50K+ 空响应 | 上游 Web 端单次请求长度限制（DeepSeek 10K~50K 之间），非反代层问题 |
| 超长上下文第 2/3 轮失败 | Session 上下文累积超限，或反代层多轮消息折叠异常 |
| content 中出现 `<tool_invoke>` 等标签 | `stripInternalToolBlocks` / `stripToolCallBlocks` 未正确清除工具块文本 |
| Anthropic 流式无 `tool_use` 事件 | 流式 tool call 解析器未正确处理 `<tool_invoke>` 标签 |
| #17/#18 返回 400 `messages[N].role must be one of [user, assistant]` | Joi schema 未放行 `system` role；或 `extractSystemFromMessages` 未提取 system 消息 |
| #17/#18 返回 400 `content must be one of [string, array]` | Joi schema 未放行 `null` content（assistant 只有 tool_calls 时） |

## 注意事项

- **基础测试**（#1-#10）：请求体直接内联在 curl 命令中，不创建临时文件
- **超长上下文测试**（#13-#16）：因请求体过大（每轮 ~120KB），必须用 PowerShell 生成 JSON 临时文件再发送（`-d "@file.json"`），测试后删除临时文件
- **不要修改任何代码**：本 skill 只做测试，不做修复
- **不要重启服务**：除非用户明确要求
- **不要提交 git**：测试本身不产生代码变更
- 测试完成后清理所有临时文件（JSON 文件、日志文件等）
- 超长上下文测试较慢（每轮可能 30-120s），整体测试可能需要 10-20 分钟，提前告知用户
