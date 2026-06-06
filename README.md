# Tide 控制台

> 一个跑在本地的轻量 **Agent Harness**：把大模型、工具、权限、上下文、会话和一个浏览器控制台连成一套可运行的智能体。给它一个 API Key，它就能在你的电脑上读写文件、执行命令、调用 CLI 和 HTTP API，并在网页里和你对话。

当前内置模型：**DeepSeek**（OpenAI 兼容协议）。前后端是**同一个 Node 服务**，后端在后台**静默托管**（零黑窗口闪烁），双击一键启动只弹出一个浏览器控制台窗口。想彻底关闭时，点页面右上角的「**退出**」按钮即可结束后端。

---

## ✨ 特性

- 🖥️ **浏览器控制台**：聊天、模型配置、工具列表、实时事件流、思考过程可视化。
- 🧰 **本地工具**：读写/复制/移动/删除文件与文件夹、执行 shell 命令、调用可配置的 HTTP API。
- 🔐 **风险权限模型**：`read / write / network / execute` 四档，按需放开。
- 📂 **可选工作区范围**：在网页里选择工作目录，或放开到整台电脑。
- 💭 **思考可见**：发完消息有「思考中」实时进度，模型若返回推理内容会折叠展示。
- 💾 **会话持久化**：对话存到本地 `.sessions/`，可恢复。
- 🟢 **首次开箱即用**：一键安装自动配好环境，浏览器里填一次 API Key 即显示绿色「配置成功」。
- 🪟 **单窗口体验**：后端通过隐藏的 `wscript + supervisor` 在后台托管，启动时**只弹一个控制台窗口**，没有黑色命令行窗口闪烁。
- 🚪 **一键退出**：页面右上「退出」按钮调用 `POST /api/quit` 关闭后端；隐藏后端没有窗口可关，全靠这个开关。
- 🔁 **自动重连**：前端内置看门狗（每 2.5s 探活），后端重启时自动盖上重连遮罩并恢复，无需手动刷新。

---

## 🚀 新手使用教程

### 第 1 步：一键安装

双击项目文件夹里的 **`安装 Tide.cmd`**。它会自动完成：

1. 检测 Node.js（≥20）；没有就免管理员下载便携版到 `tools\node`。
2. `npm install` 安装依赖。
3. 生成 `.env` 配置（API Key 留空，稍后在网页里填）。
4. 在**项目文件夹内**创建一键启动快捷方式 `一键启动 Tide`。
5. 自动打开控制台网页。

> 需要 Windows + 联网。Node 已安装也可手动 `npm install`。

### 第 2 步：在网页里配置 API Key

1. 打开后，左侧「**模型 API 设置**」里供应商选 **DeepSeek**。
2. 粘贴你的 DeepSeek API Key（在 https://platform.deepseek.com 获取）。
3. 点「保存并切换」。状态变成绿色 **✓ 配置成功** 即可开始使用。

API Key 只保存在本地 `.env`，**不会上传**。

### 第 3 步：开始对话

在底部输入框提问，例如：

- `读取 README.md，总结这个项目怎么用`
- `在桌面新建一个叫 demo 的文件夹`
- `运行 git --version`

以后启动：进项目文件夹双击 **`一键启动 Tide`**（后端在后台静默托管，自动打开浏览器；若已在运行则直接打开页面，不会重复启动，全程无黑窗口）。

### 退出 Tide

点页面右上角的「**退出**」按钮即可关闭后端服务，随后关掉浏览器标签即可。直接关浏览器只会关掉页面，后台后端仍在运行——这是隐藏托管模式的代价，用「退出」按钮才能彻底停掉。

---

## 🔐 权限与工作区

在 `.env` 里配置（也可在网页「工作区范围」面板里改）：

| 项 | 说明 |
|----|------|
| `HARNESS_ALLOW_RISKS` | `read,write,network,execute` 四档风险，逗号分隔，按需放开 |
| `HARNESS_WORKSPACE` | 文件工具的工作区根目录（默认用户主目录） |
| `HARNESS_FS_UNRESTRICTED=1` | 放开整机访问，允许绝对路径在任意位置读写（高风险） |
| `HARNESS_COMMAND_TIMEOUT_MS` | `run_command` 单条命令超时，默认 600000（10 分钟），`0`=不限时 |
| `HARNESS_COMMAND_MAX_BUFFER` | 命令输出字节上限，默认 10MB |

> ⚠️ `execute` 和整机访问属于高风险能力：开启后模型可在你的电脑上执行任意命令、读写任意文件。仅在信任当前任务时使用。

---

## 🧭 能力一览

| 能力 | 是否支持 | 说明 |
|------|:---:|------|
| 自己在终端跑命令 | ✅ | `run_command`（execute 权限），可跑任意 shell 命令；超时与输出上限可在 `.env` 调整 |
| 自己去 GitHub 克隆/安装项目 | ✅ | 通过 `run_command` 调 `git clone` / `npm install` 等（需 git 在 PATH、能联网） |
| 调用本机 CLI | ✅ | 通过 `run_command` 调用 PATH 上任意 CLI（gh、curl、python…），可传 key 鉴权 |
| 读写本地文件 / 整机访问 | ✅ | 内置文件工具 + 可放开到整台电脑 |
| 调用 HTTP API | ✅ | 通过 `HARNESS_API_TOOLS` 配置的 JSON 工具 |
| 自己给自己装 skill | 🚧 待更新 | 目前没有 skill/插件系统，无法在运行时给自己加能力 |
| 连接 MCP（Model Context Protocol） | 🚧 待更新 | 目前没有 MCP 客户端，给 key 也无法连接 MCP server |

---

## 🛠️ 待更新（Roadmap）

以下能力**当前尚未实现**，计划后续补上：

- **MCP 客户端接入** 🚧 —— 让 Tide 能像主流 Agent 一样连接 MCP server（filesystem、github、puppeteer 等），通过 key/配置自动接入。
- **Skill / 工具热加载** 🚧 —— 支持运行时从指定目录读取并自注册工具，实现“自己给自己装能力”。
- **更多大模型接入** 🚧 —— 当前仅启用 DeepSeek。计划恢复并完善对 **通义千问 Qwen、智谱 GLM、MiniMax、Kimi、小米 MiMo、Anthropic Claude，以及任意 OpenAI 兼容**模型的接入与在网页里一键切换。
- 流式输出（边生成边显示）、命令执行的交互式审批等。

> 这些都是已知缺口，欢迎在 Issue 区反馈优先级。

---

## ⚙️ 配置

模型供应商通过 `HARNESS_MODEL_PROVIDER` 指定，当前为 `deepseek`：

```env
HARNESS_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的key        # 建议在网页里填，别提交到仓库
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

`.env` 已被 `.gitignore` 排除，真实 Key 不会进仓库。

---

## 📁 项目结构

```
src/
  app/        运行时、模型配置、工作区配置
  core/       Agent 主循环
  model/      模型 Provider 适配（OpenAI 兼容 / Anthropic）
  tools/      内置工具（文件/命令）+ HTTP API 工具
  policy/     工具风险策略
  context/    上下文管理
  session/    会话存储
  config/     .env 加载
web/          浏览器控制台（静态页 + 前端逻辑）
tools/        install.ps1 一键安装脚本
  Tide.vbs       隐藏启动器（wscript 无窗口拉起 supervisor）
  supervisor.ps1 后台托管后端（隐藏、探活、开浏览器）
examples/     api-tools.example.json 示例
tests/        测试
安装 Tide.cmd   一键安装入口
Start Tide.cmd  启动器（转交隐藏 supervisor，后端后台托管 + 自动开浏览器）
```

---

## 🧑‍💻 开发

```powershell
npm install        # 安装依赖
npm run web:open   # 启动控制台并打开浏览器
npm start          # 命令行聊天
npm run check      # 类型检查 + 测试
```

要求 Node.js ≥ 20。

---

## 📄 许可

个人项目，按现状提供。使用 `execute` / 整机访问能力的风险由使用者自行承担。
