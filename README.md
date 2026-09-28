<div align="center">

# z.proxy.api

**高并发、开箱即用的 AI Web 反代网关**

将 DeepSeek 网页端与千问 Studio 网页版逆向封装为标准 OpenAI 协议（`/v1/chat/completions` 与 `/v1/models`），即插即用接入主流第三方 AI 客户端与 Agent 工具。

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.18.0-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com)

</div>

---

## 💡 为什么选择 z.proxy.api

`z.proxy.api` 致力于打破大模型网页版与生态工具之间的协议壁垒。无需依赖昂贵或受限的商业 API 额度，通过将上游 Web 端服务转换为完全兼容 OpenAI 的标准化接口，让各类第三方客户端与 Coding Agent 零改造直接调用。

- ⚡ **即插即用**：对外暴露纯正的 OpenAI 规范接口，兼容任意第三方应用。
- 🧠 **深度思考原生透传**：支持 DeepSeek 深度思考模型，以 `reasoning_content` 原生流式输出完整思维链。
- 🌐 **Web 联网检索**：原生支持上游网页搜索，保留搜索摘要与网络来源。
- 🛡️ **多账号高并发池化**：内置租约调度算法，支持账号多活轮询、平滑呼吸间隔、故障自动降级与状态自愈。
- 🖥️ **内置可视化控制台**：附带现代化响应式 Web 控制面板，实时掌握账号状态与调用监控。

---

## ✨ 核心特性

| 特性 | 说明 |
| :--- | :--- |
| **100% OpenAI 兼容** | 完整实现 `/v1/chat/completions` 与 `/v1/models`，适配几乎所有支持自定义端点的 AI 客户端 |
| **深度思考 (Reasoning)** | 完美透传思考链内容（`reasoning_content`），长文本推理过程可视化 |
| **实时联网检索 (Online)** | 原生透传上游检索标记与参考信息，获取最新动态资讯 |
| **多账号智能调度** | $O(1)$ 游标轮询、平滑呼吸间隔与失效剔除，有效抵抗高并发压力 |
| **账号级独立代理** | 支持为每个账号独立绑定 HTTP / HTTPS / SOCKS5 代理，避免同一出口 IP 关联风控 |
| **现代 Web 控制面板** | 可视化管理账号池状态、Token 用量分析与动态配置修改 |
| **多客户端生态支持** | 经过严格适配，支持 NextChat、Chatbox、Cherry Studio、LibreChat、Dify、Claude Code、Codex 等 |

---

## 🚀 极速开始

### 1. 环境准备
- **Node.js**：版本需 `>= 18.18.0`
- **系统支持**：Windows / macOS / Linux

### 2. 获取代码与安装
```bash
# 克隆仓库
git clone https://github.com/your-username/z-proxy-api.git
cd z-proxy-api
```

### 3. 一键启动

项目已内置跨平台自动化脚本，自动检测环境依赖、创建必要目录并启动服务：

- **Windows 用户**：
  直接双击根目录下的 `start.bat`，或在命令行运行：
  ```cmd
  start.bat
  ```

- **Linux / macOS 用户**：
  运行冷启动脚本：
  ```bash
  chmod +x start.sh
  ./start.sh
  ```
  > 如需在 Linux 服务器后台静默守护运行，可添加 `--daemon` 参数：
  > ```bash
  > ./start.sh --daemon
  > ```

服务启动成功后，默认监听 `http://localhost:8080`。

### 4. 账号快速配置

1. **环境配置**：
   复制环境变量模板并设置主密钥：
   ```bash
   cp .env.example .env
   ```
   在 `.env` 中设置服务密钥 `ADMIN_KEY`（或 `API_KEY`），如：`sk-admin-888888`。

2. **添加上游账号**：
   参考 `data/` 目录下的示例模板创建真实账号文件：
   - **DeepSeek 账号**：复制 `data/dpsk-data.example.json` 为 `data/dpsk-data.json`，填入 DeepSeek 网页端登录 Token。
   - **通义千问账号**：复制 `data/qwen-data.example.json` 为 `data/qwen-data.json`，填入千问 Studio 网页端 Cookie 或登录凭据。

> 💡 **提示**：服务运行中亦可直接登录前端管理面板（`http://localhost:8080`），使用管理员密钥一键导入与管理账号。

---

## 🔌 客户端接入指南

### 核心接入参数

| 参数项 | 配置值 | 说明 |
| :--- | :--- | :--- |
| **Base URL (接口地址)** | `http://localhost:8080/v1` | 填入客户端的 API 代理地址/端点字段 |
| **API Key (服务密钥)** | `.env` 中配置的 `ADMIN_KEY` | 鉴权密钥（例如 `sk-admin-888888`） |

---

### 支持的模型清单

服务根据模型后缀智能路由至对应的执行模式：

#### 🌟 DeepSeek 系列
| 模型名称 | 思考链 | 联网检索 | 适用场景 |
| :--- | :---: | :---: | :--- |
| `deepseek-v4.1-flash` | ❌ | ❌ | 极速日常对话与代码生成 |
| `deepseek-v4.1-flash-think` | ✅ | ❌ | 复杂数学推演、深层逻辑分析与架构设计 |
| `deepseek-v4.1-flash-search` | ❌ | ✅ | 事实性核查、突发新闻与在线资料检索 |
| `deepseek-v4.1-flash-think-search` | ✅ | ✅ | 顶配形态：兼备深度思考与实时网络检索 |
| `deepseek-v4.1` / `deepseek-chat` | 兼容 | - | 常用标准兼容别名 |

#### 🌟 通义千问系列
| 模型名称 | 说明 | 适用场景 |
| :--- | :--- | :--- |
| `qwen3-max` / `qwen-max` | 千问旗舰超大语言模型 | 综合复杂任务处理 |
| `qwen3-coder-plus` | 编程专项强化模型 | 代码补全、重构与 Agent 自动化工具链 |
| `qwen-plus` / `qwen-turbo` | 高速平衡型与轻量级模型 | 快速应答与大批量文本生成 |

---

### 常见客户端配置示例

#### 1. cURL 命令行极速验证
```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-admin-888888" \
  -d '{
    "model": "deepseek-v4.1-flash-think",
    "messages": [{"role": "user", "content": "请简述量子纠缠的基本原理"}],
    "stream": true
  }'
```

#### 2. NextChat / ChatGPT-Next-Web
- **接口地址 (Base URL)**: `http://localhost:8080` (客户端会自动补充 `/v1`)
- **API Key**: 填入你的服务密钥
- **自定义模型**: 填入 `deepseek-v4.1-flash-think,deepseek-v4.1-flash-search,qwen3-max`

#### 3. Cherry Studio / Chatbox / LibreChat
- **提供商**: 选择 `OpenAI` 或 `自定义 (Custom)`
- **API 地址 / Host**: `http://localhost:8080/v1`
- **API Key**: 填入你的服务密钥
- **模型**: 手动添加或点击“拉取模型列表”自动同步

#### 4. Coding Agent / AI 编程工具 (Claude Code / Codex / Continue / Pi / Hermes)
在环境配置或客户端选项中将 OpenAI 兼容端点指向网关：
```json
{
  "api_base": "http://localhost:8080/v1",
  "api_key": "sk-admin-888888",
  "model": "deepseek-v4.1-flash-think"
}
```

---

## ⚠️ 已知限制与使用说明 (Known Limitations)

1. **DeepSeek 网页端风控机制**：
   上游 DeepSeek 网页端配备严格的反爬与风控体系。若单账号在短时间内发起极端高频请求或行为偏离常规交互，对应账号绑定的邮箱可能被官方临时禁言数天。**强烈建议配置多账号池并合理调整并发间隔**，通过轮询分摊访问压力。
2. **上下文窗口上限**：
   - **DeepSeek 网页端**：有效输入上限通常约为 **256K ~ 300K 字符**。超大上下文单次输入可能导致上游响应超时或返回空流；
   - **千问 Studio 网页端**：受上游平台单次请求限制，有效上下文窗口约为 **64K**。
3. **上游网页接口协议依赖**：
   本项目服务依赖上游网页端公开交互协议。当平台官方前端发生重大架构重构或接口变更时，可能需要同步更新适配补丁。

---

## 🛠️ 常见问题排查 (FAQ)

<details>
<summary><b>Q: 启动时提示端口 8080 被占用？</b></summary>
可以在 <code>.env</code> 文件中修改 <code>SERVICE_PORT</code>（例如改为 <code>9090</code>），随后重新运行启动脚本即可。
</details>

<details>
<summary><b>Q: 请求返回 401 Unauthorized？</b></summary>
请核对客户端请求头中的 <code>Authorization: Bearer &lt;KEY&gt;</code> 是否与 <code>.env</code> 中的 <code>ADMIN_KEY</code>（或 <code>API_KEY</code>）一致。
</details>

<details>
<summary><b>Q: 如何配置出站代理以避免 IP 关联封禁？</b></summary>
可在 <code>.env</code> 中配置全局 <code>PROXY_URL=http://127.0.0.1:7890</code>，或在账号配置 JSON 中为特定账号绑定独立的 <code>proxy</code> 字段，账号级代理享有最高优先级。
</details>

---

## 📄 严格免责声明 (Disclaimer)

1. **用途限制**：本项目仅供个人学习、技术研究与学术测试使用，**严禁用于任何商业牟利、恶意攻击或商业生产环境**。
2. **技术性质**：本项目通过模拟浏览器标准请求行为访问公开可用功能，不包含任何暴力破解、逆向解密商业专有算法或破坏计算机信息系统安全的行为。
3. **责任自负**：使用者应充分了解并遵守各模型提供商的服务条款及所在地区的法律法规。任何人因使用本项目所产生的一切直接或间接后果与法律责任（包括但不限于账号受限、服务中断、财产损失等），均由使用者本人独立承担，与本项目原作者及任何贡献者无关。
4. **同意条款**：下载、克隆、使用或传播本项目即表示您已完整阅读、完全知悉并无保留地同意本声明的所有条款。
