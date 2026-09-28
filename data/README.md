# 数据持久化目录说明 (Data Directory Specification)

本目录（`data/`）用于存放 **z.proxy.api** 的运行时持久化配置、多平台账号池数据、设备反爬指纹及运行时锁。

---

## 🔒 隐私与安全隔离原则

项目已通过根目录 `.gitignore` 建立了**严格的物理白名单防线**：
- 规则：`data/*` 默认全部阻断入库，仅放行 `*.example.json` 模板与本 `README.md`。
- 本地生成的任何真实账号、Token、Cookie、设备指纹及锁文件均**绝对不会**被 Git 跟踪或意外提交。

---

## 📁 核心文件清单与作用

| 文件名 | 类型 | 说明 |
| :--- | :--- | :--- |
| **`config.example.json`** | 模板文件（已入库） | 运行时调度与重试策略模板，支持热更新。 |
| **`config.json`** | 业务文件（本地保留） | 实际运行时的动态配置持久化文件，由系统管理台自动落盘或手动配置。 |
| **`qwen-data.example.json`** | 模板文件（已入库） | 通义千问（Qwen）多账号池配置模板。 |
| **`qwen-data.json`** | 核心数据（本地保留） | 通义千问实际账号池文件，存储账号凭据、Token、Cookie 与调用统计。 |
| **`dpsk-data.example.json`** | 模板文件（已入库） | DeepSeek 网页端多账号池配置模板。 |
| **`dpsk-data.json`** | 核心数据（本地保留） | DeepSeek 实际账号池文件，存储账号凭据、User Token 与调用统计。 |
| `baxia-umid.json` | 运行时自动生成 | 通义千问反爬 UMID 令牌缓存，由服务自动维护。 |
| `dpsk-device.json` | 运行时自动生成 | DeepSeek 客户端设备反爬指纹缓存，由服务自动维护。 |
| `qwen-models-cache.json` | 运行时自动生成 | 千问平台动态模型列表缓存。 |
| `locks/` | 运行时目录 | 多进程/集群文件写锁目录，避免数据并发读写冲突。 |
| `response-state/` | 运行时目录 | 长响应断点续传与状态缓存目录。 |

---

## 🚀 快速初始化配置指南

首次克隆项目或在新环境部署时，请按照以下步骤初始化配置文件：

### 第一步：初始化运行时调度配置
```bash
# 复制配置文件模板
cp data/config.example.json data/config.json
```
- `dpskRoutingStrategy`: 账号调度算法（推荐 `round-robin` 轮询或 `idle-first` 空闲优先）。
- `minPacingIntervalMs`: 单账号最小平滑呼吸间隔（默认 `5000`ms，平滑流量防触发风控）。
- `chatRetryCount`: 遇到网络抖动或上游临时风控时的自动重试次数。

---

### 第二步：配置通义千问 (Qwen) 账号
```bash
# 复制千问账号模板
cp data/qwen-data.example.json data/qwen-data.json
```
打开 `data/qwen-data.json`，在 `accounts` 数组中填入真实账号：
- **Token 提取方式**：
  1. 登录 [chat.qwen.ai](https://chat.qwen.ai/) 网页版；
  2. 打开浏览器开发者工具（F12）-> 网络（Network）标签；
  3. 发送任意一条对话，在请求列表中找到 `completions` 请求；
  4. 查看该请求的请求头 `Authorization`，复制 `Bearer ` 后面的字符串，填入 `"token"` 字段。
- **Cookie 提取方式**（用于免密保活与长效鉴权）：
  在网络请求头中复制完整的 `Cookie` 字符串（重点包含 `login_aliyunid_ticket` 等项），填入 `"cookie"` 字段。
- **代理支持**：若某些账号需要独立出口 IP，可在 `"proxy"` 字段填入专属代理地址（如 `http://127.0.0.1:7890`），不填则使用系统全局配置。

---

### 第三步：配置 DeepSeek 网页端账号
```bash
# 复制 DeepSeek 账号模板
cp data/dpsk-data.example.json data/dpsk-data.json
```
打开 `data/dpsk-data.json`，在顶层数组中填入真实账号：
- **Token 提取方式**：
  1. 登录 [chat.deepseek.com](https://chat.deepseek.com/) 网页版；
  2. 打开浏览器开发者工具（F12）-> 网络（Network）标签；
  3. 刷新页面或发送对话，在任意 API 请求（如 `/api/v0/users/current` 或 `/api/v0/chat/completion`）中；
  4. 查看请求头中的 `Authorization: Bearer <your_token>`，将该 Token 填入 `"token"` 字段。
- **账号隔离**：DeepSeek 网页端风控机制较为敏感，建议配置多个账号并启用呼吸间隔，或为各账号配置不同的 `"proxy"` 代理打散出口。

---

## 💡 维护与注意事项

1. **自动热更新**：
   通过前端 Web 控制台（Dashboard）修改设置或增删账号时，系统会自动将最新数据安全回写至 `config.json`、`qwen-data.json` 与 `dpsk-data.json`，无需手动重启服务。
2. **多进程并发保护**：
   在 PM2 多 Worker 集群模式下，系统通过内置文件锁（`data/locks/`）自动串行化持久化写操作，保证高并发下账号数据的一致性与完整性。
3. **严禁破坏白名单**：
   请勿使用 `git add -f` 强制提交 `data/` 目录下的真实数据文件。
