# Tide 控制台

> 一个跑在本地的轻量 **Agent Harness**：把大模型、工具、权限、上下文、会话和一个浏览器控制台连成一套可运行的智能体。给它一个 API Key，它就能在你的电脑上读写文件、执行命令、调用 CLI 和 HTTP API，并在网页里和你对话。

当前内置模型：**DeepSeek**（OpenAI 兼容协议）。前后端是**同一个 Node 服务**，后端在后台**静默托管**（零黑窗口闪烁），双击一键启动只弹出一个浏览器控制台窗口。想彻底关闭时，点页面右上角的「**退出**」按钮即可结束后端。

---

## ✨ 特性

- 🖥️ **浏览器控制台**：聊天、模型配置、工具列表、实时事件流、思考过程可视化。
- 🧰 **本地工具**：读写/复制/移动/删除文件与文件夹、执行 shell 命令（含后台长任务）、`grep`/`glob` 全代码库搜索、调用可配置的 HTTP API。
- 🧠 **项目级上下文**：启动自动加载工作区 `CLAUDE.md` / `AGENTS.md`；`read_file` 带行号与区间读取，编辑更精准。
- 🗂️ **永久记忆**：安装级 `memory/` 目录（对照 Claude Code auto-memory），`MEMORY.md` 索引每次启动注入系统提示；对它说「记住 X」它就自己写记忆文件，下次对话开场就带着，还能如实回答「你有哪些永久记忆」。
- ♻️ **两段式上下文压缩**：超预算先 **microcompact**——把较早的大块工具结果清成占位符（不调模型、对话全保留）；还不够再把较早对话用模型摘要成结构化总结、最近消息原样保留（对照 Claude Code 的 microcompact → auto-compact），长任务不丢早期需求/决策/踩坑。
- ✏️ **编辑容错级联**：`replace_in_file` 匹配失败时自动按「行尾空白 → 智能引号 → 行号前缀」逐级容错（始终以文件实际文本为准替换），并支持 `replace_all` 批量改名——对照 Claude Code FileEditTool，大幅降低编辑失败率。
- 🛡️ **读后改契约**：修改已存在的文件前必须先读过；读后被外部改动（用户/编辑器/linter）会要求重读——防止凭想象改文件、防止覆盖别人刚做的修改。
- 🔁 **API 瞬时故障自愈**：429/5xx/网络抖动自动指数退避重试（尊重 Retry-After），长任务不再因一次网络抖动整段作废。
- ✅ **任务清单防跑偏**：`todo_write` 工具让模型把多步任务外化成清单，逐项 in_progress / completed，做完前自检验证；网页事件流实时显示进度。轮数/工具上限默认调高到 100/400，配合压缩可安全跑完项目级长任务。
- ⌨️ **终端界面**：`npm link` 后用 `tide` 命令在任意目录启动，Claude Code 风格的本地智能体终端。
- ⎋ **可中断 & 多行粘贴**：运行中按 **ESC** 立即打断当前任务（思考、生成、工具执行均可），优雅回到提示符且会话不丢、可继续；输入框支持**整段多行粘贴**（括号粘贴协议，含换行/空行/缩进按一条消息提交，不再被首行截断）。
- 🔌 **MCP 协议接入**：用官方 `@modelcontextprotocol/sdk` 连接任意 MCP server（filesystem、fetch、github…），其工具自动桥接成 `mcp__<server>__<tool>` 供模型调用，支持 stdio / HTTP / SSE 三种传输。
- 🧩 **技能（Skill）系统**：从本地目录或 git URL 安装技能（含 `SKILL.md` 的文件夹），模型按需用 `skill` 工具加载指令；也能用 `install_skill` 工具自己装技能。**热加载——安装即用，无需重启**；网页左栏有 MCP / 技能面板可视化管理。
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
| `HARNESS_TOOL_TIMEOUT_MS` | 其余工具的全局执行超时，默认 120000（`run_command`/`spawn_agent` 自管超时不受限） |
| `HARNESS_MAX_OUTPUT_TOKENS` | 模型单次响应输出上限，默认 8192（太小会截断大文件写入） |
| `HARNESS_API_RETRIES` | API 瞬时故障重试次数，默认 3 |
| `HARNESS_ENFORCE_READ_BEFORE_EDIT` | 读后改契约开关，默认开；设 `0` 关闭 |
| `HARNESS_SUBAGENT_MAX_TURNS` / `_MAX_TOOL_CALLS` | 子代理预算，默认 40 / 120 |
| `HARNESS_MCP_CONFIG` | MCP 服务器配置文件路径，不设则自动探测根目录 `mcp.json`（见下文「MCP 与技能」） |
| `HARNESS_SKILLS_DIR` | 技能目录，默认 `<项目根>/skills`（见下文「MCP 与技能」） |
| `HARNESS_MEMORY_DIR` | 永久记忆目录，默认 `<项目根>/memory`，首次启动自动创建 |

> ⚠️ `execute` 和整机访问属于高风险能力：开启后模型可在你的电脑上执行任意命令、读写任意文件。仅在信任当前任务时使用。

---

## 🧭 能力一览

| 能力 | 是否支持 | 说明 |
|------|:---:|------|
| 自己在终端跑命令 | ✅ | `run_command`（execute 权限），可跑任意 shell 命令；超时与输出上限可在 `.env` 调整 |
| 跑后台长任务（dev server / watch） | ✅ | `run_command` 传 `run_in_background=true` 返回 job id，再用 `get_command_output` 轮询输出 |
| 跨文件搜代码 | ✅ | `grep`（按内容正则，优先 ripgrep）+ `glob`（按文件名模式 `**/*.ts`），对齐 Claude Code |
| 自己去 GitHub 克隆/安装项目 | ✅ | 通过 `run_command` 调 `git clone` / `npm install` 等（需 git 在 PATH、能联网） |
| 调用本机 CLI | ✅ | 通过 `run_command` 调用 PATH 上任意 CLI（gh、curl、python…），可传 key 鉴权 |
| 读写本地文件 / 整机访问 | ✅ | 内置文件工具（`read_file` 带行号 + offset/limit 区间读）+ 可放开到整台电脑 |
| 读取项目约定 | ✅ | 启动时自动加载工作区 `CLAUDE.md` / `AGENTS.md` 注入系统提示 |
| 跨会话永久记忆 | ✅ | `memory/` 目录 + `MEMORY.md` 索引注入；「记住 X」即写入，自己能查能改（`HARNESS_MEMORY_DIR` 可改位置） |
| 长任务上下文不丢 | ✅ | 两段式压缩：先清较早的大块工具结果（microcompact），不够再模型摘要 + 保留最近消息；预算默认 200k 近似 token（1M 窗口），`HARNESS_CONTEXT_TOKENS` 可调 |
| 编辑高成功率 | ✅ | `replace_in_file` 容错级联（行尾空白/智能引号/行号前缀）+ `replace_all`；读后改契约防覆盖外部修改 |
| 网络抖动自愈 | ✅ | API 429/5xx 自动指数退避重试（`HARNESS_API_RETRIES`，默认 3 次），尊重 Retry-After |
| 多步任务防跑偏/漏步 | ✅ | `todo_write` 清单工具 + 行为引导提示（逐项完成、做完自检验证、如实汇报），轮数/工具上限默认 100/400 |
| 终端里直接对话 | ✅ | `npm link` 后用 `tide` 命令在任意目录启动，Claude Code 风格的终端界面 |
| 运行中可中断 | ✅ | CLI 运行时按 `ESC` 立即打断当前任务（思考/生成/工具执行），优雅返回不丢会话 |
| 终端多行粘贴 | ✅ | 括号粘贴协议，整段多行文本（含换行/空行/缩进）按一条消息提交，不被首行截断 |
| 流式输出 | ✅ | OpenAI 兼容 provider SSE 流式，CLI 边收边打字 |
| 联网抓取 / 搜索 | ✅ | `web_fetch`（抓网页转文本）+ `web_search`（DuckDuckGo 免 key） |
| Token / 费用统计 | ✅ | 累计每轮用量，按模型价目表估算费用，统计行显示 |
| 计划模式 | ✅ | CLI `/plan`：只读调研、拦截写/执行/联网，先出计划再动手 |
| 自动化 Hooks | ✅ | `hooks.json` 配 PreToolUse(可拦截)/PostToolUse(如自动 lint) |
| 编辑前 diff 预览 | ✅ | 写/改文件审批时展示彩色 +/- diff |
| 改动回滚 | ✅ | 改文件前自动备份，CLI `/rewind` 撤销上一步改动 |
| 子代理 / 并行子任务 | ✅ | `spawn_agent` 把子任务交给独立子代理（预算 40 轮/120 调用），一轮多发即并行；`agent_type="explore"` 为只读调研型，不会误改东西 |
| 调用 HTTP API | ✅ | 通过 `HARNESS_API_TOOLS` 配置的 JSON 工具 |
| 自己给自己装 skill | ✅ | `install_skill` 工具 / `--install-skill` 命令，从本地目录或 git URL 安装；`skill` 工具按需加载指令 |
| 连接 MCP（Model Context Protocol） | ✅ | 官方 SDK，配置 `mcp.json` 即连接 server，工具桥接成 `mcp__server__tool`，支持 stdio/HTTP/SSE |

---

## 🔌 MCP 与 🧩 技能

### 接入 MCP server

把项目根目录的 `examples/mcp.example.json` 复制为 **`mcp.json`**（或用 `HARNESS_MCP_CONFIG` 指向任意路径），格式与 Claude Desktop / Cursor 通用：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\你\\Desktop"],
      "risk": "write"
    },
    "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "authorization": "Bearer xxx" } }
  }
}
```

- 启动时 Tide 自动连接每个 server，把它的工具注册成 **`mcp__<server>__<tool>`**。
- 单个 server 连不上**不影响**其它 server 和整个程序（会在事件流里报错）。
- 传输支持 **stdio**（`command`/`args`）、**HTTP**（`type:"http"`）、**SSE**（`type:"sse"`）。
- `risk` 默认按工具的 `readOnlyHint` 推断（只读→`read`，否则→`execute`），可在配置里覆盖；记得在 `HARNESS_ALLOW_RISKS` 里放行对应档位。
- Windows 上 `npx`/`npm` 这类服务器已自动用 `cmd.exe /c` 调用，规避 `spawn ENOENT`。

### 安装与使用技能

一个技能 = 一个含 **`SKILL.md`** 的文件夹（YAML frontmatter 声明 `name`/`description`，正文是给模型的操作指令）。技能放在 `HARNESS_SKILLS_DIR`（默认 `<项目根>/skills`）。

安装方式（两种来源）：

```powershell
# 从本地目录安装（示例技能）
npm run chat -- --install-skill examples/skills/echo-note
# 从 git 仓库安装（仓库根目录需含 SKILL.md）
npm run chat -- --install-skill https://github.com/owner/repo.git
```

模型也能用 **`install_skill`** 工具自己安装（高风险，归 `execute`）。**支持热加载：安装后立即可用，无需重启**——模型下一回合就能用 **`skill`** 工具按名加载它的指令再执行。

在网页控制台左栏的「**技能**」面板里也能直接填来源安装（走 `/api/skills/install`，同样即时生效）；「**MCP 服务器**」面板显示各 server 连接状态与工具数，「重新连接 MCP / 重载技能」按钮（`/api/reload`）可在改完 `mcp.json` 后免重启重连。

## 🛠️ 待更新（Roadmap）

以下能力**当前尚未实现**，计划后续补上：

- **更多大模型接入** 🚧 —— 当前仅启用 DeepSeek。计划恢复并完善对 **通义千问 Qwen、智谱 GLM、MiniMax、Kimi、小米 MiMo、Anthropic Claude，以及任意 OpenAI 兼容**模型的接入与在网页里一键切换。
- 网页端流式输出（CLI 已支持）、命令执行的交互式审批等。

> ✅ **已完成**：MCP 客户端接入、技能（Skill）安装与调用、**技能热加载（安装即用免重启）**、网页 MCP/技能面板、**CLI 流式输出**、**终端多行粘贴**、**运行中按 ESC 中断**（见上文「能力一览」与「MCP 与技能」）。

> 这些都是已知缺口，欢迎在 Issue 区反馈优先级。

---

## ⚙️ 配置

模型供应商通过 `HARNESS_MODEL_PROVIDER` 指定，当前为 `deepseek`：

```env
HARNESS_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的key        # 建议在网页里填，别提交到仓库
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro  # 最强；也可填 deepseek-v4-flash（快而省）
```

> DeepSeek V4（2026）：`deepseek-v4-pro`（最强，1.6T/49B）/ `deepseek-v4-flash`（快而省，284B/13B），均 1M 上下文。
> 网页「模型」下拉可直接切换，也能手填自定义模型名。旧别名 `deepseek-chat` / `deepseek-reasoner` 将于 2026/07/24 下线，仅指向较弱的 v4-flash。

`.env` 已被 `.gitignore` 排除，真实 Key 不会进仓库。

---

## 📁 项目结构

```
src/
  app/        运行时、模型配置、工作区配置
  core/       Agent 主循环
  model/      模型 Provider 适配（OpenAI 兼容 / Anthropic）
  tools/      内置工具（文件/命令）+ HTTP API 工具
  mcp/        MCP 客户端：配置加载 + 连接 server + 工具桥接
  skills/     技能系统：加载 SKILL.md、skill/install_skill 工具、安装器、热加载管理器
  policy/     工具风险策略
  context/    上下文管理
  session/    会话存储
  config/     .env 加载
web/          浏览器控制台（静态页 + 前端逻辑）
tools/        install.ps1 一键安装脚本
  Tide.vbs       隐藏启动器（wscript 无窗口拉起 supervisor）
  supervisor.ps1 后台托管后端（隐藏、探活、开浏览器）
examples/     api-tools / mcp 配置示例 + skills/ 示例技能
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

npm link           # 注册全局 tide 命令（一次即可）
tide               # 之后在任意项目目录直接启动终端界面
tide "读取 README.md 并总结"   # 一次性提问模式
```

`tide` 会把**当前目录**当作工作区（自动加载该目录的 `CLAUDE.md`），模型凭据从当前目录或 Tide 安装目录的 `.env` 读取。要求 Node.js ≥ 20。

---

## 📄 许可

个人项目，按现状提供。使用 `execute` / 整机访问能力的风险由使用者自行承担。
