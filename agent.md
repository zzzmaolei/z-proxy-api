# z.proxy.api Agent 自动化部署与运维指南 (agent.md)

> **目标受众**：AI Coding Agent / DevOps Agent（Claude Code, Codex, Pi, Hermes, Cursor, Continue 等自动化编程与运维助理）。  
> **文档宗旨**：提供无歧义、机器可直接解析并执行的系统架构图谱、部署流程、数据结构契约、健康探针以及故障自愈排查规范。

---

## 1. 系统架构全景图谱

`z.proxy.api` 是面向 Web 端 AI 模型（DeepSeek、千问 Qwen）的多 Provider 反向代理网关，将上游网页端协议降级中转，并向上暴露标准兼容的 OpenAI（`/v1/chat/completions`）、Anthropic（`/v1/messages`）及 OpenAI Responses（`/v1/responses`）协议端点。

### 1.1 进程与流转链路

```
[客户端请求: Claude Code / Codex / Cursor / SDK]
                           │ (HTTP / SSE)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 启动入口: src/start.js (智能识别单进程 / PM2 / 集群模式)    │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Web 服务器核心: src/server.js                               │
│ - 中间件挂载:                                                │
│   • middlewares/authorization.js (API_KEY / ADMIN_KEY 校验) │
│   • middlewares/chat-middleware.js (客户端 Profile 动态识别)│
│ - SPA 静态资源托管: public/dist/                            │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 路由层 (src/routes/)                                        │
│ • routes/models.js          -> GET /v1/models               │
│ • routes/chat.js            -> POST /v1/chat/completions    │
│ • routes/anthropic.js       -> POST /v1/messages            │
│ • routes/responses-compat.js-> POST /v1/responses (Codex)   │
│ • routes/settings.js        -> GET /api/scheduler-status    │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 路由分发器: src/providers/registry.js (按 model 名前缀分流) │
└──────────────┬───────────────────────────────┬──────────────┘
               │ (含 "dpsk" / "deepseek")      │ (其余默认走 Qwen)
               ▼                               ▼
┌──────────────────────────────┐┌──────────────────────────────┐
│ DeepSeek 路线                ││ Qwen (通义千问) 路线         │
│ • 控制器:                     ││ • 控制器:                     │
│   controllers/dpsk-chat.js   ││   controllers/chat.js        │
│   controllers/anthropic-     ││   controllers/anthropic.js   │
│     deepseek.js              ││ • 调度器:                     │
│ • 调度器:                     ││   backends/qwen/scheduler-   │
│   backends/deepseek/         ││     singleton.js             │
│     scheduler-singleton.js   ││ • 反爬与会话管理:             │
│ • 核心交互:                   ││   backends/qwen/baxia-umid.js│
│   backends/deepseek/dpsk-pow ││   backends/qwen/chat-id-pool │
│     (WASM PoW 挑战计算)      ││   backends/qwen/upstream-    │
│   backends/deepseek/dpsk-    ││     client.js                │
│     client.js                ││ • 核心交互:                   │
│ • 无状态独立 Session 隔离    ││   无状态 take 即用即丢 chat_id│
└──────────────────────────────┘└──────────────────────────────┘
```

---

## 2. 自动化部署标准 SOP (Standard Operating Procedure)

自动化 Agent 在初始化或迁移部署本网关时，必须严格执行以下标准步骤：

### 步骤 1：环境版本检查
必须确保宿主环境 Node.js 版本满足 `>= 18.0.0`（推荐 LTS 20.x 或 22.x）：
```bash
node -v
# 期望输出类似: v18.18.0 或更高版本
```

### 步骤 2：后端主依赖安装
在项目根目录下安装服务端依赖：
```bash
npm install
```

### 步骤 3：前端控制台构建
管理控制台（Dashboard）位于 `public/` 目录，基于 Vite + Vue 3 构建。生产部署必须编译输出静态产物至 `public/dist`，否则管理后台将返回 404 或未编译页面：
```bash
cd public
npm install
npm run build
cd ..
```
*检查点*：确认 `public/dist/index.html` 文件已生成。

### 步骤 4：配置初始化
从模板文件复制运行时配置文件，确保持久化目录就绪：
```bash
# 1. 确保核心目录存在
mkdir -p data logs

# 2. 从模板复制环境变量
[ ! -f .env ] && cp .env.example .env

# 3. 从模板复制运行时调度配置
[ ! -f data/config.json ] && cp data/config.example.json data/config.json

# 4. 从模板复制账号数据结构（若已有真实数据则跳过）
[ ! -f data/qwen-data.json ] && cp data/qwen-data.example.json data/qwen-data.json
[ ! -f data/dpsk-data.json ] && cp data/dpsk-data.example.json data/dpsk-data.json
```

### 步骤 5：服务启动与就绪检查
根据执行环境选择对应的启动方式：
- **开发与 CLI 环境**：
  ```bash
  node src/start.js
  ```
- **自动化运维脚本**：
  - Windows 环境：运行 `start.bat`；热重启请运行 `scripts/restart.bat`。
  - Linux / macOS 环境：运行 `./start.sh`。
- **PM2 守护进程模式（生产推荐）**：
  ```bash
  npm run pm2:start
  ```

---

## 3. 账号持久化 Schema 规范

数据文件存放在 `data/` 目录中。**特别注意：Qwen 与 DeepSeek 的根 JSON 结构存在根本性差异，Agent 严禁构造混淆！**

### 3.1 通义千问账号 Schema (`data/qwen-data.json`)
- **根结构**：**JSON 对象 (Object)**，账号列表置于 `"accounts"` 数组中。
```json
{
  "defaultHeaders": null,
  "defaultCookie": null,
  "accounts": [
    {
      "id": "qwen-account-01",
      "email": "user1@example.com",
      "password": "your_password_here",
      "token": "eyJhbGciOi...",
      "cookie": "login_aliyunid_ticket=...; login_aliyunid_csrf=...",
      "status": "active",
      "created_at": "2025-01-01T00:00:00.000Z",
      "expires": null,
      "proxy": null,
      "stats": {
        "chat": {
          "input": 0,
          "output": 0,
          "requests": 0,
          "byProvider": {},
          "byModel": {}
        }
      }
    }
  ]
}
```
*字段关键说明*：
- `token`: 千问网页端 Bearer 鉴权凭证（必须）。
- `cookie`: 包含 `login_aliyunid_ticket` 等免密保活 Cookie。
- `proxy`: 可选账号独立出口代理，如 `"http://127.0.0.1:7890"`。

### 3.2 DeepSeek 账号 Schema (`data/dpsk-data.json`)
- **根结构**：**JSON 数组 (Array)**，顶层直接是账号对象列表。
```json
[
  {
    "id": "dpsk-account-01",
    "email": "user1@example.com",
    "password": "your_password_here",
    "token": "userToken_eyJhbG...",
    "status": "active",
    "enabled": true,
    "created_at": "2025-01-01T00:00:00.000Z",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "userId": "10000001",
    "mutedUntil": null,
    "proxy": null,
    "lastUsed": 0,
    "stats": {
      "chat": {
        "input": 0,
        "output": 0,
        "requests": 0,
        "byProvider": {},
        "byModel": {}
      }
    }
  }
]
```
*字段关键说明*：
- `token`: DeepSeek Web 端 `Authorization: Bearer <token>` 用户令牌。
- `enabled`: 布尔值，设为 `false` 可主动屏蔽此账号而不删除凭证。
- `mutedUntil`: 毫秒级时间戳，用于限流或故障冷却隔离，调度器自动维护。

---

## 4. 接口契约与健康探针 (Probes)

在 CI/CD、容器探活及 Agent 调度健康监控中，必须严格遵循下述端点契约。

### 4.1 存活与就绪探针 (Liveness / Readiness Probe)
- **推荐端点**：`GET /v1/models`
- **鉴权要求**：必须携带有效的 API Key：
  - Header: `Authorization: Bearer <API_KEY>` 或 `x-api-key: <API_KEY>`
- **验证命令**：
  ```bash
  curl -s -f -H "Authorization: Bearer sk-admin-yourkey" http://127.0.0.1:8080/v1/models
  ```
- **预期响应**：HTTP 200，包含 JSON 格式的 `{"object": "list", "data": [...]}`。
- ⚠️ **绝对禁忌：严禁使用 `GET /health`**：
  - 本项目网关未注册 `/health` 路径；
  - 任何针对未定义路径的请求均会被 Express 的 SPA 静态通配路由捕获，返回 `public/dist/index.html` 纯文本，HTTP 状态码甚至可能被误判为 200 或 404，导致自动化探针产生致命逻辑漂移！

### 4.2 调度大盘探针 (Scheduler Telemetry Probe)
- **推荐端点**：`GET /api/scheduler-status`
- **参数说明**：`provider=all`（默认聚合 DeepSeek 与 Qwen），亦可指定 `provider=deepseek` 或 `provider=qwen`。
- **鉴权要求**：必须携带管理员密钥：
  - Header: `x-admin-key: <ADMIN_KEY>` 或 `Authorization: Bearer <ADMIN_KEY>`
- **验证命令**：
  ```bash
  curl -s -f -H "x-admin-key: sk-admin-yourkey" "http://127.0.0.1:8080/api/scheduler-status?provider=all"
  ```
- **返回指标（JSON）**：
  - `totalAccounts`: 账号池总数
  - `totalInFlight`: 当前并发请求总数
  - `totalQueue`: 调度队列排队深度
  - `aggregateByStatus`: 账号健康分布（`idle` 空闲、`partial` 部分负载、`busy` 满载、`cooldown` 冷却）
  - 各账号实时打分 `score`、成功率 `successRate` 与冷却剩余毫秒 `cooldownRemainingMs`。

### 4.3 核心协议服务端口
| 协议标准 | HTTP 路径 | 支持模型前缀 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **OpenAI** | `POST /v1/chat/completions` | `deepseek-chat`, `deepseek-reasoner`, `qwen-*` | 通用 Chat, IDE 插件, NextChat |
| **Anthropic** | `POST /v1/messages` | 全部映射模型 | Claude Code, Codex, Continue |
| **OpenAI Responses** | `POST /v1/responses` | `deepseek-*` | Codex CLI 专用流式会话 |
| **模型列表** | `GET /v1/models` | 全量上游实时列表 | 客户端拉取模型列表与探活 |

---

## 5. 自动化测试命令

本项目内置 Node.js 原生测试套件，无需额外安装 Jest 或 Mocha：

```bash
# 运行全量单元与集成自动化测试
node --test
```
*检查点*：输出中所有测试用例必须返回 `✔`，无失败项（`fail 0`）。

---

## 6. 故障排查与自愈机制 (Troubleshooting & Self-Healing)

### 6.1 429 WAF 与频率限制 (Rate Limit)
- **现象**：客户端收到 `status: 429`，或服务端日志出现 `[UPSTREAM-429]`。
- **自愈机制**：
  1. **账号级降级**：网关感知到上游 429 后，会调用 `markAccountFailed(email, 120000, '429/rate limit')`，自动将该账号置入 120 秒冷却队列（`cooldown`），立即自动轮换并选取池中下一个可用账号重试。
  2. **队列背压保护**：若并发激增超过系统设定的最大队列深度（`dpskMaxQueueSize`），网关返回携带 `Retry-After: 5` 响应头的 429，防止上游彻底封禁 IP。
- **Agent 排查动作**：
  - 检查 `data/qwen-data.json` 或 `data/dpsk-data.json` 中配置的有效可用账号数量，并发较高时建议配置 3 个以上账号；
  - 在 `data/config.json` 或 `.env` 中调大平滑呼吸间隔 `minPacingIntervalMs`（建议 `>= 5000`ms）；
  - 为账号配置不同的出口代理（`proxy` 字段）。

### 6.2 ECONNREFUSED / ETIMEDOUT 代理与网络故障
- **现象**：服务端报错 `connect ECONNREFUSED 127.0.0.1:7890` 或 `ETIMEDOUT`。
- **排查动作**：
  1. 检查 `.env` 中的 `PROXY_URL` 或账号数据中的 `"proxy"` 端口是否存在且正在监听（例如本地 Clash、v2ray 是否启动）；
  2. 若服务器部署在国内环境直连上游失败，必须在 `.env` 中设置有效的 `PROXY_URL=http://...`；
  3. 检查 DNS 解析状态：本项目内置 DNS 预热模块（`src/utils/dns-cache.js`），必要时可配置 `QWEN_CHAT_PROXY_URL` 指向可用的反向代理中继域名。

### 6.3 账号失效与风控状态判定
- **401 Unauthorized / Token Expired**：
  - Token 已过期失效。Agent 需提示或通过脚本更新对应账号的 `"token"` 字段。
- **500 风控拦截 (UMID / Captcha)**：
  - Qwen 路线触发风控时，系统会自动启动 Baxia-UMID 令牌刷新（`backends/qwen/baxia-umid.js`）；若持续失败，说明当前 Cookie 已被黑名单拦截，需重新提取浏览器 `login_aliyunid_ticket`。
- **DeepSeek PoW 挑战异常**：
  - 检查 WebAssembly 环境是否完好，`src/backends/deepseek/dpsk-pow.js` 依赖 Node.js WASM 运行时支持。

---

## 7. Agent 维护与协作铁律

任何正在接管或修改本项目的 AI Agent 必须恪守以下纪律：

1. **改动后立即执行标准重启验证**：
   - 每次代码修改、配置调整或 Git commit 后，必须通过 `scripts/restart.bat`（Windows）或服务管理命令重启服务；
   - 重启后必须调用 `GET /v1/models` 进行存活验证。
2. **严禁硬编码模型列表**：
   - 上游模型瞬息万变，所有模型必须通过 Provider 上游动态拉取（`models-map.js`），严禁在代码中写死静态数组。
3. **数据隔离防线**：
   - 绝不能将任何带有真实凭据的 `qwen-data.json`、`dpsk-data.json` 或 `.env` 提交到版本库，仅允许提交 `*.example.*` 模板文件。
4. **最小化修改原则**：
   - 仅针对目标链条进行精准外科手术式修改，不改动无关的上下文压缩、增量 prompt 或会话续接逻辑。
