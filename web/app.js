const sessionKey = "tide.sessionId";
const messagesKey = "tide.messages";

const elements = {
  messages: document.querySelector("#messages"),
  form: document.querySelector("#chatForm"),
  input: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  composerStatus: document.querySelector("#composerStatus"),
  sessionLabel: document.querySelector("#sessionLabel"),
  providerValue: document.querySelector("#providerValue"),
  risksValue: document.querySelector("#risksValue"),
  apiToolsValue: document.querySelector("#apiToolsValue"),
  modelConfigForm: document.querySelector("#modelConfigForm"),
  modelConfigStatus: document.querySelector("#modelConfigStatus"),
  providerSelect: document.querySelector("#providerSelect"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  baseUrlInput: document.querySelector("#baseUrlInput"),
  modelInput: document.querySelector("#modelInput"),
  saveModelButton: document.querySelector("#saveModelButton"),
  workspaceForm: document.querySelector("#workspaceForm"),
  workspaceInput: document.querySelector("#workspaceInput"),
  unrestrictedInput: document.querySelector("#unrestrictedInput"),
  workspacePresets: document.querySelector("#workspacePresets"),
  workspaceStatus: document.querySelector("#workspaceStatus"),
  workspaceHint: document.querySelector("#workspaceHint"),
  saveWorkspaceButton: document.querySelector("#saveWorkspaceButton"),
  toolList: document.querySelector("#toolList"),
  toolCount: document.querySelector("#toolCount"),
  eventList: document.querySelector("#eventList"),
  eventCount: document.querySelector("#eventCount"),
  healthDot: document.querySelector("#healthDot"),
  newSessionButton: document.querySelector("#newSessionButton"),
  clearButton: document.querySelector("#clearButton"),
  toast: document.querySelector("#toast"),
};

let sessionId = localStorage.getItem(sessionKey) || "";
let messages = readStoredMessages();
let events = [];
let modelPresets = [];
let activeModelConfig = null;

renderMessages();
renderSession();
loadState();

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (!message) return;

  addMessage({ role: "user", text: message });
  elements.input.value = "";
  setBusy(true, "运行中");
  showThinking();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, sessionId: sessionId || undefined }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "请求失败。");

    sessionId = data.sessionId;
    localStorage.setItem(sessionKey, sessionId);
    renderSession();
    stopThinking();
    addMessage({
      role: "assistant",
      text: data.finalText || "（没有返回内容）",
      reasoning: data.reasoning || "",
      meta: `${data.turns} 轮对话，${data.toolCalls} 次工具调用`,
    });
    appendEvents(data.events || []);
    setBusy(false, "就绪");
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    stopThinking();
    addMessage({ role: "assistant", text: messageText, error: true });
    showToast(messageText);
    setBusy(false, "错误");
  }
});

let thinkingEl = null;
let thinkingTimer = null;

function showThinking() {
  stopThinking();
  const item = document.createElement("article");
  item.className = "message assistant thinking";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = "Tide";

  const body = document.createElement("div");
  body.className = "message-body";
  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  const status = document.createElement("span");
  status.className = "thinking-status";
  status.textContent = "正在思考…";
  body.append(dots, status);

  item.append(meta, body);
  elements.messages.append(item);
  elements.messages.scrollTop = elements.messages.scrollHeight;

  thinkingEl = { item, status };
  pollThinking();
  thinkingTimer = window.setInterval(pollThinking, 1200);
}

async function pollThinking() {
  if (!thinkingEl) return;
  try {
    const response = await fetch("/api/state");
    const state = await response.json();
    const recent = state.recentEvents || [];
    const last = recent[recent.length - 1];
    if (thinkingEl && last) thinkingEl.status.textContent = thinkingStatusText(last);
  } catch {
    /* 轮询失败忽略，保持“正在思考” */
  }
}

function thinkingStatusText(event) {
  const label = eventLabel(event.type);
  const detail = eventDetail(event);
  return detail ? `${label} · ${detail}` : `${label}…`;
}

function stopThinking() {
  if (thinkingTimer) {
    window.clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
  if (thinkingEl) {
    thinkingEl.item.remove();
    thinkingEl = null;
  }
}

elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    elements.form.requestSubmit();
  }
});

elements.newSessionButton.addEventListener("click", () => {
  sessionId = "";
  messages = [];
  events = [];
  localStorage.removeItem(sessionKey);
  localStorage.removeItem(messagesKey);
  renderSession();
  renderMessages();
  renderEvents();
  setBusy(false, "就绪");
});

elements.clearButton.addEventListener("click", () => {
  messages = [];
  localStorage.removeItem(messagesKey);
  renderMessages();
});

elements.providerSelect.addEventListener("change", () => {
  const preset = modelPresets.find((item) => item.id === elements.providerSelect.value);
  if (!preset) return;
  elements.baseUrlInput.value = preset.defaultBaseUrl;
  elements.modelInput.value = preset.defaultModel;
  elements.apiKeyInput.value = "";
  elements.apiKeyInput.placeholder = "请输入该供应商的 API Key";
});

elements.modelConfigForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.saveModelButton.disabled = true;
  setModelStatus("保存中…", "neutral");

  try {
    const response = await fetch("/api/model-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: elements.providerSelect.value,
        apiKey: elements.apiKeyInput.value,
        baseUrl: elements.baseUrlInput.value,
        model: elements.modelInput.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存失败。");

    elements.apiKeyInput.value = "";
    setModelStatus("✓ 配置成功", "ok");
    showToast("配置成功，现在可以开始使用了。");
    await loadState();
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    setModelStatus("✗ 配置失败", "warn");
    showToast(messageText);
  } finally {
    elements.saveModelButton.disabled = false;
  }
});

elements.workspaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.saveWorkspaceButton.disabled = true;
  elements.workspaceStatus.textContent = "保存中";

  try {
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: elements.workspaceInput.value.trim(),
        unrestricted: elements.unrestrictedInput.checked,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存失败。");

    elements.workspaceStatus.textContent = "已生效";
    showToast("工作区范围已更新并生效。");
    await loadState();
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    elements.workspaceStatus.textContent = "保存失败";
    showToast(messageText);
  } finally {
    elements.saveWorkspaceButton.disabled = false;
  }
});

async function loadState() {
  try {
    const response = await fetch("/api/state");
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || "无法加载运行状态。");

    elements.providerValue.textContent = providerLabel(state.provider || "unknown");
    elements.risksValue.textContent = riskLabels(state.allowedRisks || []);
    elements.apiToolsValue.textContent = String(state.loadedApiTools || 0);
    elements.healthDot.classList.add("is-online");
    renderModelConfig(state.modelPresets || [], state.modelConfig);
    renderWorkspace(state.workspace);
    renderTools(state.tools || []);
    appendEvents(state.recentEvents || []);
  } catch (error) {
    elements.providerValue.textContent = "离线";
    elements.healthDot.classList.remove("is-online");
    showToast(error instanceof Error ? error.message : String(error));
  }
}

function renderModelConfig(presets, config) {
  modelPresets = presets;
  activeModelConfig = config;
  elements.providerSelect.replaceChildren(
    ...presets.map((preset) => {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      return option;
    }),
  );

  if (!config) return;
  elements.providerSelect.value = config.provider;
  elements.baseUrlInput.value = config.baseUrl || "";
  elements.modelInput.value = config.model || "";
  elements.apiKeyInput.value = "";
  elements.apiKeyInput.placeholder = config.hasApiKey
    ? "已保存，留空不修改"
    : "请输入 API Key";
  if (config.hasApiKey) {
    setModelStatus("✓ 配置成功", "ok");
  } else {
    setModelStatus("● 请先配置 API Key", "warn");
  }
}

function setModelStatus(text, kind) {
  const el = elements.modelConfigStatus;
  el.textContent = text;
  el.classList.remove("status-ok", "status-warn");
  if (kind === "ok") el.classList.add("status-ok");
  else if (kind === "warn") el.classList.add("status-warn");
}

function renderWorkspace(workspace) {
  if (!workspace) return;
  const presets = buildWorkspacePresets(workspace);
  elements.workspacePresets.replaceChildren(
    ...presets.map((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-preset";
      button.textContent = preset.label;
      button.title = preset.path;
      button.addEventListener("click", () => {
        elements.workspaceInput.value = preset.path;
        if (typeof preset.unrestricted === "boolean") {
          elements.unrestrictedInput.checked = preset.unrestricted;
        }
      });
      return button;
    }),
  );

  elements.workspaceInput.value = workspace.root || "";
  elements.unrestrictedInput.checked = Boolean(workspace.unrestricted);
  elements.workspaceStatus.textContent = "已配置";
  elements.workspaceHint.textContent = `当前生效：${workspace.root || "未设置"}（整机访问：${
    workspace.unrestricted ? "开" : "关"
  }）`;
}

function buildWorkspacePresets(workspace) {
  const home = workspace.homeDir || "";
  const cwd = workspace.cwd || "";
  const drive = /^[a-zA-Z]:/.test(home) ? `${home.slice(0, 2)}\\` : "C:\\";
  const presets = [];
  if (cwd) presets.push({ label: "项目目录", path: cwd, unrestricted: false });
  if (home) {
    presets.push({ label: "用户主目录", path: home, unrestricted: false });
    presets.push({ label: "桌面", path: winJoin(home, "Desktop"), unrestricted: false });
  }
  presets.push({ label: "整个 C 盘", path: drive, unrestricted: false });
  presets.push({ label: "整台电脑", path: home || drive, unrestricted: true });
  return presets;
}

function winJoin(base, sub) {
  return `${base.replace(/[\\/]+$/, "")}\\${sub}`;
}

function renderTools(tools) {
  elements.toolCount.textContent = String(tools.length);
  elements.toolList.replaceChildren(
    ...tools.map((tool) => {
      const item = document.createElement("div");
      item.className = "tool-item";

      const name = document.createElement("div");
      name.className = "tool-name";
      name.textContent = toolDisplayName(tool.name);

      const description = document.createElement("div");
      description.className = "tool-description";
      description.textContent = toolDescription(tool.name, tool.description);

      item.append(name, description);
      return item;
    }),
  );
}

function addMessage(message) {
  messages.push({
    at: new Date().toISOString(),
    ...message,
  });
  localStorage.setItem(messagesKey, JSON.stringify(messages.slice(-80)));
  renderMessages();
}

function renderMessages() {
  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const inner = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Tide 控制台";
    const subtitle = document.createElement("span");
    subtitle.textContent = "本地模型与工具运行台";
    inner.append(title, subtitle);
    empty.append(inner);
    elements.messages.replaceChildren(empty);
    return;
  }

  const nodes = messages.map((message) => {
    const item = document.createElement("article");
    item.className = `message ${message.role}${message.error ? " error" : ""}`;

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = message.meta || (message.role === "user" ? "你" : "Tide");

    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.text;

    item.append(meta);
    if (message.reasoning) {
      const details = document.createElement("details");
      details.className = "reasoning";
      const summary = document.createElement("summary");
      summary.textContent = "💭 思考过程";
      const reasoningBody = document.createElement("div");
      reasoningBody.className = "reasoning-body";
      reasoningBody.textContent = message.reasoning;
      details.append(summary, reasoningBody);
      item.append(details);
    }
    item.append(body);
    return item;
  });
  elements.messages.replaceChildren(...nodes);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function appendEvents(nextEvents) {
  if (nextEvents.length === 0) return;
  events.push(...nextEvents);
  events = events.slice(-80);
  renderEvents();
}

function renderEvents() {
  elements.eventCount.textContent = String(events.length);
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event-item";
    const type = document.createElement("div");
    type.className = "event-type";
    type.textContent = "空闲";
    empty.append(type);
    elements.eventList.replaceChildren(empty);
    return;
  }

  elements.eventList.replaceChildren(
    ...events
      .slice()
      .reverse()
      .map((event) => {
        const item = document.createElement("div");
        item.className = "event-item";

        const type = document.createElement("div");
        type.className = "event-type";
        type.textContent = eventLabel(event.type);

        const detail = document.createElement("div");
        detail.className = "event-detail";
        detail.textContent = eventDetail(event);

        item.append(type, detail);
        return item;
      }),
  );
}

function eventDetail(event) {
  if ("name" in event) return toolDisplayName(event.name);
  if ("turn" in event) return `第 ${event.turn} 轮`;
  if ("sessionId" in event) return shortId(event.sessionId);
  if ("toolCalls" in event) return `${event.turns} 轮，${event.toolCalls} 次工具调用`;
  if ("before" in event) return `${event.before} -> ${event.after}`;
  return "";
}

function renderSession() {
  elements.sessionLabel.textContent = sessionId ? `会话 ${shortId(sessionId)}` : "本地会话";
}

function setBusy(isBusy, status) {
  elements.input.disabled = isBusy;
  elements.sendButton.disabled = isBusy;
  elements.composerStatus.textContent = status;
  if (!isBusy) elements.input.focus();
}

function showToast(text) {
  elements.toast.textContent = text;
  elements.toast.classList.add("is-visible");
  window.setTimeout(() => elements.toast.classList.remove("is-visible"), 4600);
}

function shortId(value) {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function readStoredMessages() {
  try {
    const parsed = JSON.parse(localStorage.getItem(messagesKey) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function providerLabel(value) {
  const labels = {
    deepseek: "DeepSeek",
    qwen: "通义千问",
    glm: "智谱 GLM",
    minimax: "MiniMax",
    kimi: "Kimi",
    mimo: "小米 MiMo",
    anthropic: "Anthropic",
    "openai-compatible": "OpenAI 兼容",
  };
  return labels[value] || value;
}

function riskLabels(values) {
  if (!values.length) return "无";
  const labels = {
    read: "读取",
    write: "写入",
    execute: "执行",
    network: "联网",
  };
  return values.map((value) => labels[value] || value).join("、");
}

function toolDisplayName(name) {
  const labels = {
    copy_path: "复制路径",
    create_directory: "新建文件夹",
    delete_path: "删除路径",
    example_search: "示例搜索 API",
    github_repo: "GitHub 仓库查询",
    list_files: "列出文件",
    move_path: "移动或重命名",
    read_file: "读取文件",
    replace_in_file: "替换文件内容",
    run_command: "运行命令",
    write_file: "写入文件",
  };
  return labels[name] || name;
}

function toolDescription(name, fallback) {
  const descriptions = {
    copy_path: "复制工作区内的文件或文件夹。",
    create_directory: "在工作区内创建文件夹，必要时会创建上级目录。",
    delete_path: "删除工作区内的文件或文件夹，删除文件夹需要递归确认。",
    example_search: "已认证 JSON API 示例，可替换为你的业务服务。",
    github_repo: "查询公开 GitHub 仓库的基础元数据。",
    list_files: "列出工作区内指定路径的文件和目录。",
    move_path: "移动或重命名工作区内的文件和文件夹。",
    read_file: "读取工作区内的 UTF-8 文本文件。",
    replace_in_file: "在工作区文件中替换一次指定文本。",
    run_command: "在工作区执行终端命令，属于高风险能力。",
    write_file: "写入 UTF-8 文件，必要时会覆盖已有内容。",
  };
  return descriptions[name] || fallback || "";
}

function eventLabel(type) {
  const labels = {
    "session.started": "会话开始",
    "session.saved": "会话已保存",
    "model.requested": "请求模型",
    "model.responded": "模型返回",
    "tool.started": "工具开始",
    "tool.finished": "工具完成",
    "context.compacted": "上下文压缩",
    "agent.finished": "任务完成",
  };
  return labels[type] || type;
}
