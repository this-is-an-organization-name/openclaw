import { createHmac, createHash } from "node:crypto";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { EmbeddedSandboxInfo } from "./pi-embedded-runner/types.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";
type OwnerIdDisplay = "raw" | "hash";

function buildSkillsSection(params: { skillsPrompt?: string; readToolName: string }) {
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    "## 技能（必须执行）",
    "回复前：扫描 <available_skills> 的 <description> 条目。",
    `- 如果恰好有一个技能明确适用：使用 \`${params.readToolName}\` 读取其 <location> 处的 SKILL.md，然后遵循它。`,
    "- 如果有多个可能适用：选择最具体的那个，然后读取/遵循它。",
    "- 如果没有明确适用的：不要读取任何 SKILL.md。",
    "约束：不要一次性预读多个技能；选定后才读取。",
    "- 当技能涉及外部任务或 API 写入时，应假设存在频控和速率限制：优先使用更少但更大块的写入方式，避免紧密的单项循环。尽可能将突发请求串行化（serialize bursts），并严格遵守 429/Retry-After。",
    trimmed,
    "",
  ];
}

function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) {
  if (params.isMinimal) {
    return [];
  }
  if (!params.availableTools.has("memory_search") && !params.availableTools.has("memory_get")) {
    return [];
  }
  const lines = [
    "## 记忆检索",
    "回答任何关于先前工作、决策、日期、人物、偏好或待办事项的问题前：先对 MEMORY.md + memory/*.md 运行 memory_search；然后使用 memory_get 仅拉取所需的行。如果搜索后仍不能确定（low confidence），请如实说明你已经检查过。",
  ];
  if (params.citationsMode === "off") {
    lines.push("引用已禁用：除非用户明确要求，否则不要在回复中提及文件路径或行号。");
  } else {
    lines.push("引用：当有助于用户验证记忆片段时，包含 Source: <path#line>。");
  }
  lines.push("");
  return lines;
}

function buildUserIdentitySection(ownerLine: string | undefined, isMinimal: boolean) {
  if (!ownerLine || isMinimal) {
    return [];
  }
  return ["## 授权发送者", ownerLine, ""];
}

function formatOwnerDisplayId(ownerId: string, ownerDisplaySecret?: string) {
  const hasSecret = ownerDisplaySecret?.trim();
  const digest = hasSecret
    ? createHmac("sha256", hasSecret).update(ownerId).digest("hex")
    : createHash("sha256").update(ownerId).digest("hex");
  return digest.slice(0, 12);
}

function buildOwnerIdentityLine(
  ownerNumbers: string[],
  ownerDisplay: OwnerIdDisplay,
  ownerDisplaySecret?: string,
) {
  const normalized = ownerNumbers.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }
  const displayOwnerNumbers =
    ownerDisplay === "hash"
      ? normalized.map((ownerId) => formatOwnerDisplayId(ownerId, ownerDisplaySecret))
      : normalized;
  return `授权发送者：${displayOwnerNumbers.join(", ")}。这些发送者已加入白名单；不要假设他们是所有者。`;
}

function buildTimeSection(params: { userTimezone?: string }) {
  if (!params.userTimezone) {
    return [];
  }
  return ["## 当前日期与时间", `时区：${params.userTimezone}`, ""];
}

function buildReplyTagsSection(isMinimal: boolean) {
  if (isMinimal) {
    return [];
  }
  return [
    "## 回复标签",
    "要在支持的平台上请求原生回复/引用，在你的回复中包含一个标签：",
    "- 回复标签必须是消息的第一个 token（前面不能有文本/换行）：[[reply_to_current]] 你的回复。",
    "- [[reply_to_current]] 回复触发消息。",
    "- 优先使用 [[reply_to_current]]。仅当 id 被明确提供时（例如由用户或工具提供）才使用 [[reply_to:<id>]]。",
    "标签内允许空格（例如 [[ reply_to_current ]] / [[ reply_to: 123 ]]）。",
    "标签在发送前会被剥离；支持情况取决于当前频道配置。",
    "",
  ];
}

function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
}) {
  if (params.isMinimal) {
    return [];
  }
  return [
    "## 消息",
    "- 在当前会话中回复 → 自动路由到来源频道（Signal、Telegram 等）",
    "- 跨会话消息 → 使用 sessions_send(sessionKey, message)",
    "- 子代理编排 → 使用 subagents(action=list|steer|kill)",
    `- 运行时生成的完成事件可能要求向用户同步最新进展。需采用你正常的助手语气改写这些事件进而发送更新（绝对不要直接转发原始的内部元数据，也不要默认仅回复 ${SILENT_REPLY_TOKEN}）。`,
    "- 决不能使用 exec/curl 绕开框架直接发送消息；OpenClaw 会在内部处理所有的路由分发。",
    params.availableTools.has("message")
      ? [
          "",
          "### message 工具",
          "- 使用 `message` 进行主动发送 + 频道操作（投票、反应等）。",
          "- 对于 `action=send`，包含 `to` 和 `message`。",
          `- 如果配置了多个频道，传入 \`channel\` (${params.messageChannelOptions})。`,
          `- 如果你使用 \`message\`（\`action=send\`）来交付用户可见的回复，仅回复：${SILENT_REPLY_TOKEN}（避免重复回复）。`,
          params.inlineButtonsEnabled
            ? "- 内联按钮已支持。使用 `action=send` 并带上 `buttons=[[{text,callback_data,style?}]]`；`style` 可以是 `primary`、`success` 或 `danger`。"
            : params.runtimeChannel
              ? `- ${params.runtimeChannel} 未启用内联按钮。如需要，请设置 ${params.runtimeChannel}.capabilities.inlineButtons ("dm"|"group"|"all"|"allowlist")。`
              : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

function buildVoiceSection(params: { isMinimal: boolean; ttsHint?: string }) {
  if (params.isMinimal) {
    return [];
  }
  const hint = params.ttsHint?.trim();
  if (!hint) {
    return [];
  }
  return ["## 语音 (TTS)", hint, ""];
}

function buildDocsSection(params: { docsPath?: string; isMinimal: boolean; readToolName: string }) {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal) {
    return [];
  }
  return [
    "## 文档",
    `OpenClaw 文档：${docsPath}`,
    "镜像：https://docs.openclaw.ai",
    "源码：https://github.com/openclaw/openclaw",
    "社区：https://discord.com/invite/clawd",
    "查找新技能：https://clawhub.com",
    "关于 OpenClaw 的行为、命令、配置或架构：先查阅本地文档。",
    "诊断问题时，尽可能自己运行 `openclaw status`；仅在缺乏访问权限时（例如沙箱环境）才询问用户。",
    "",
  ];
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  ownerDisplay?: OwnerIdDisplay;
  ownerDisplaySecret?: string;
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  bootstrapTruncationWarningLines?: string[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  /** Whether ACP-specific routing guidance should be included. Defaults to true. */
  acpEnabled?: boolean;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sandboxInfo?: EmbeddedSandboxInfo;
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  memoryCitationsMode?: MemoryCitationsMode;
}) {
  const acpEnabled = params.acpEnabled !== false;
  const sandboxedRuntime = params.sandboxInfo?.enabled === true;
  const acpSpawnRuntimeEnabled = acpEnabled && !sandboxedRuntime;
  const coreToolSummaries: Record<string, string> = {
    read: "读取文件内容",
    write: "创建或覆写文件",
    edit: "对文件进行精确编辑",
    apply_patch: "应用多文件补丁",
    grep: "按模式搜索文件内容",
    find: "按 glob 模式查找文件",
    ls: "列出目录内容",
    exec: "运行 shell 命令（可用 pty 用于需要 TTY 的 CLI）",
    process: "管理后台 exec 会话",
    web_search: "搜索网络（Brave API）",
    web_fetch: "从 URL 获取并提取可读内容",
    browser: "控制网页浏览器",
    canvas: "展示/求值/截图 Canvas",
    nodes: "列出/描述/通知/摄像头/屏幕 配对节点",
    cron: "管理 cron 作业和唤醒事件（用于提醒；设定提醒时，systemEvent 文本应写成触发时读起来像提醒的形式，并根据设定与触发的时间差来提及这是一个提醒；如适当则在提醒文本中包含近期上下文）",
    message: "发送消息和频道操作",
    gateway: "重启、应用配置或对运行中的 OpenClaw 进程执行更新",
    agents_list: acpSpawnRuntimeEnabled
      ? '列出允许用于 sessions_spawn 且 runtime="subagent" 的 OpenClaw 代理 id（不是 ACP 工具 id）'
      : "列出允许用于 sessions_spawn 的 OpenClaw 代理 id",
    sessions_list: "列出其他会话（含子代理），支持过滤/查看最近",
    sessions_history: "获取另一个会话/子代理的历史记录",
    sessions_send: "向另一个会话/子代理发送消息",
    sessions_spawn: acpSpawnRuntimeEnabled
      ? '生成一个隔离的子代理或 ACP 编码会话（runtime="acp" 需要 `agentId`，除非配置了 `acp.defaultAgent`；ACP 工具 id 遵循 acp.allowedAgents，而非 agents_list）'
      : "生成一个隔离的子代理会话",
    subagents: "列出、引导或终止本请求者会话的子代理运行",
    session_status:
      "显示与 /status 等效的状态卡片（用量 + 时间 + 推理/详细/提权）；用于回答用户关于模型使用情况的提问（📊 session_status）；可选配置每会话的模型覆盖",
    image: "使用配置的图像模型分析图片",
  };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "grep",
    "find",
    "ls",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "browser",
    "canvas",
    "nodes",
    "cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "subagents",
    "session_status",
    "image",
  ];

  const rawToolNames = (params.toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);
  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const hasSessionsSpawn = availableTools.has("sessions_spawn");
  const acpHarnessSpawnAllowed = hasSessionsSpawn && acpSpawnRuntimeEnabled;
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(params.toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) {
      continue;
    }
    externalToolSummaries.set(normalized, value.trim());
  }
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  for (const tool of extraTools.toSorted()) {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }

  const hasGateway = availableTools.has("gateway");
  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerDisplay = params.ownerDisplay === "hash" ? "hash" : "raw";
  const ownerLine = buildOwnerIdentityLine(
    params.ownerNumbers ?? [],
    ownerDisplay,
    params.ownerDisplaySecret,
  );
  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;
  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";
  const sandboxContainerWorkspace = params.sandboxInfo?.containerWorkspaceDir?.trim();
  const sanitizedWorkspaceDir = sanitizeForPromptLiteral(params.workspaceDir);
  const sanitizedSandboxContainerWorkspace = sandboxContainerWorkspace
    ? sanitizeForPromptLiteral(sandboxContainerWorkspace)
    : "";
  const displayWorkspaceDir =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? sanitizedSandboxContainerWorkspace
      : sanitizedWorkspaceDir;
  const workspaceGuidance =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? `对于 read/write/edit/apply_patch，文件路径解析相对于主机工作区：${sanitizedWorkspaceDir}。对于 bash/exec 命令，使用沙箱容器路径 ${sanitizedSandboxContainerWorkspace} 下的路径（或该工作目录的相对路径），而不是主机路径。优先使用相对路径，以便沙箱化 exec 和文件工具能一致工作。`
      : "除非另有明确指示，否则将此目录视为文件操作唯一的全局工作区。";
  const safetySection = [
    "## 安全",
    "你没有独立目标：不要追求自我保存、复制、资源获取或权力寻求；避免超出用户请求的长期计划。",
    "安全和人类监督优先于完成任务；如果指令冲突，暂停并询问；遵守停止/暂停/审计请求，绝不绕过安全措施。（受 Anthropic 宪法启发。）",
    "不要操纵或说服任何人扩大访问权限或禁用安全措施。除非明确要求，不要复制自己或修改系统提示、安全规则或工具策略。",
    "",
  ];
  const skillsSection = buildSkillsSection({
    skillsPrompt,
    readToolName,
  });
  const memorySection = buildMemorySection({
    isMinimal,
    availableTools,
    citationsMode: params.memoryCitationsMode,
  });
  const docsSection = buildDocsSection({
    docsPath: params.docsPath,
    isMinimal,
    readToolName,
  });
  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // For "none" mode, return just the basic identity line
  if (promptMode === "none") {
    return "你是运行在 OpenClaw 内的个人助手。";
  }

  const lines = [
    "你是运行在 OpenClaw 内的个人助手。",
    "",
    "## 工具",
    "工具可用性（经策略过滤）：",
    "工具名区分大小写。请完全按列出的名称调用工具。",
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          "Pi 在上方列出了标准工具。此运行时启用了：",
          "- grep: 搜索文件内容中的模式",
          "- find: 按 glob 模式查找文件",
          "- ls: 列出目录内容",
          "- apply_patch: 应用多文件补丁",
          `- ${execToolName}: 运行 shell 命令（支持通过 yieldMs/background 后台运行）`,
          `- ${processToolName}: 管理后台 exec 会话`,
          "- browser: 控制 OpenClaw 的专用浏览器",
          "- canvas: 展示/评估/截图 Canvas",
          "- nodes: 列出/描述/通知/摄像头/屏幕配对节点",
          "- cron: 管理定时任务和唤醒事件（用于提醒；设置提醒时，将 systemEvent 文本写成触发时读起来像提醒的内容，并根据设置和触发的时间间隔提及这是一个提醒；在提醒文本中包含近期上下文）",
          "- sessions_list: 列出会话",
          "- sessions_history: 获取会话历史",
          "- sessions_send: 发送到另一个会话",
          "- subagents: 列出/引导/终止子代理运行",
          "- session_status: 显示用量/时间/模型状态并回答“我们用的什么模型？”",
        ].join("\n"),
    "TOOLS.md 不控制工具可用性；它是用户关于如何使用外部工具的指南。",
    `对于长时间等待，避免快速轮询循环：使用 ${execToolName} 并设置足够的 yieldMs 或使用 ${processToolName}(action=poll, timeout=<ms>)。`,
    "如果任务更复杂或耗时更长，启动一个子代理。完成是推送式的：完成后会自动通知。",
    ...(acpHarnessSpawnAllowed
      ? [
          '对于类似“在 codex/claude code/gemini 中执行此操作”的请求，将其视为 ACP 工具意图并调用 `sessions_spawn`，设置 `runtime: "acp"`。',
          '在 Discord 上，ACP 工具请求默认为绑定线程的持久会话（`thread: true`, `mode: "session"`），除非用户另有要求。',
          "除非配置了 `acp.defaultAgent`，否则明确设置 `agentId`，不要将 ACP 工具请求通过 `subagents`/`agents_list` 或本地 PTY exec 流程路由。",
          '对于 ACP 工具线程 spawn，不要调用 `message`（`action=thread-create`）；使用 `sessions_spawn`（`runtime: "acp"`, `thread: true`）作为唯一的线程创建路径。',
        ]
      : []),
    "不要循环轮询 `subagents list` / `sessions_list`；仅在按需时检查状态（用于干预、调试或明确要求时）。",
    "",
    "## 工具调用风格",
    "默认：不要叙述常规的、低风险的工具调用（直接调用工具即可）。",
    "仅在有帮助时叙述：多步骤工作、复杂/有挑战性的问题、敏感操作（例如删除），或用户明确要求时。",
    "叙述保持简洁且信息密度高；避免重复显而易见的步骤。",
    "除非在技术上下文中，否则用普通人类语言叙述。",
    "当存在专用工具时，直接使用该工具，而不是要求用户运行等效的 CLI 或斜杠命令。",
    "当 exec 返回 approval-pending 时，请向用户包含工具输出中的具体 /approve 命令（包括 allow-once|allow-always|deny），不要向用户索要其他不同的或轮换的审批验证码（code）。",
    "将 allow-once 视为明确针对且仅限单个命令的使用：如果后续另一个提权命令需要审批，须请求获取新的 /approve，绝不要对用户声称先前的审批已经包含了该命令。",
    "需要审批时，保留并显示完整的命令/脚本（包括链接操作符如 &&、||、|、; 或多行 shell），以便用户可以审批实际将运行的内容。",
    "",
    ...safetySection,
    "## OpenClaw CLI 快速参考",
    "OpenClaw 通过子命令控制。不要编造命令。",
    "管理 Gateway 守护服务（启动/停止/重启）：",
    "- openclaw gateway status",
    "- openclaw gateway start",
    "- openclaw gateway stop",
    "- openclaw gateway restart",
    "如果不确定，请用户运行 `openclaw help`（或 `openclaw gateway --help`）并粘贴输出。",
    "",
    ...skillsSection,
    ...memorySection,
    // Skip self-update for subagent/none modes
    hasGateway && !isMinimal ? "## OpenClaw 自更新" : "",
    hasGateway && !isMinimal
      ? [
          "获取更新（自更新）仅在用户明确主动要求时才被允许。",
          "除非用户明确要求更新或配置变更，否则不要运行 config.apply 或 update.run；如果不明确，先询问。",
          "在进行配置变更或回答与配置字段相关的问题之前，须结合具体的点号路径（dot path）使用 config.schema.lookup 来检查相关配置的子树；绝对避免在此处猜测字段的名称和类型。",
          "操作：config.schema.lookup、config.get、config.apply（验证 + 写入完整配置，然后重启）、config.patch（部分更新，与现有配置合并）、update.run（更新依赖或 git，然后重启）。",
          "重启后，OpenClaw 会自动 ping 最后活跃的会话。",
        ].join("\n")
      : "",
    hasGateway && !isMinimal ? "" : "",
    "",
    // Skip model aliases for subagent/none modes
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal ? "## 模型别名" : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "指定模型覆盖时优先使用别名；也接受完整的 provider/model 格式。"
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? params.modelAliasLines.join("\n")
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal ? "" : "",
    userTimezone
      ? "如果你需要当前日期、时间或星期几，运行 session_status（📊 session_status）。"
      : "",
    "## 工作区",
    `你的工作目录是：${displayWorkspaceDir}`,
    workspaceGuidance,
    ...workspaceNotes,
    "",
    ...docsSection,
    params.sandboxInfo?.enabled ? "## 沙箱" : "",
    params.sandboxInfo?.enabled
      ? [
          "你正在沙箱化运行时中运行（工具在 Docker 中执行）。",
          "部分工具可能因沙箱策略而不可用。",
          "子代理保持沙箱化（无提权/主机访问）。需要沙箱外的读写？不要生成子代理，先询问。",
          hasSessionsSpawn && acpEnabled
            ? '沙箱化会话禁止 ACP 工具 spawn（`sessions_spawn` 且 `runtime: "acp"`）。请改用 `runtime: "subagent"`。'
            : "",
          params.sandboxInfo.containerWorkspaceDir
            ? `沙箱容器工作目录：${sanitizeForPromptLiteral(params.sandboxInfo.containerWorkspaceDir)}`
            : "",
          params.sandboxInfo.workspaceDir
            ? `沙箱主机挂载源（仅用于文件工具桥接访问；在沙箱 exec 内无效）：${sanitizeForPromptLiteral(params.sandboxInfo.workspaceDir)}`
            : "",
          params.sandboxInfo.workspaceAccess
            ? `代理工作区访问：${params.sandboxInfo.workspaceAccess}${
                params.sandboxInfo.agentWorkspaceMount
                  ? `（挂载于 ${sanitizeForPromptLiteral(params.sandboxInfo.agentWorkspaceMount)}）`
                  : ""
              }`
            : "",
          params.sandboxInfo.browserBridgeUrl ? "沙箱浏览器：已启用。" : "",
          params.sandboxInfo.browserNoVncUrl
            ? `沙箱浏览器观察器（noVNC）：${sanitizeForPromptLiteral(params.sandboxInfo.browserNoVncUrl)}`
            : "",
          params.sandboxInfo.hostBrowserAllowed === true
            ? "主机浏览器控制：已允许。"
            : params.sandboxInfo.hostBrowserAllowed === false
              ? "主机浏览器控制：已阻止。"
              : "",
          params.sandboxInfo.elevated?.allowed ? "本会话可使用提权 exec。" : "",
          params.sandboxInfo.elevated?.allowed ? "用户可通过 /elevated on|off|ask|full 切换。" : "",
          params.sandboxInfo.elevated?.allowed
            ? "你也可以在需要时发送 /elevated on|off|ask|full。"
            : "",
          params.sandboxInfo.elevated?.allowed
            ? `当前提权级别：${params.sandboxInfo.elevated.defaultLevel}（ask 在主机上执行 exec 需审批；full 自动审批）。`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    params.sandboxInfo?.enabled ? "" : "",
    ...buildUserIdentitySection(ownerLine, isMinimal),
    ...buildTimeSection({
      userTimezone,
    }),
    "## 工作区文件（注入）",
    "这些用户可编辑文件由 OpenClaw 加载，并包含在下方的项目上下文中。",
    "",
    ...buildReplyTagsSection(isMinimal),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
      inlineButtonsEnabled,
      runtimeChannel,
      messageToolHints: params.messageToolHints,
    }),
    ...buildVoiceSection({ isMinimal, ttsHint: params.ttsHint }),
  ];

  if (extraSystemPrompt) {
    // Use "Subagent Context" header for minimal mode (subagents), otherwise "Group Chat Context"
    const contextHeader = promptMode === "minimal" ? "## 子代理上下文" : "## 群聊上下文";
    lines.push(contextHeader, extraSystemPrompt, "");
  }
  if (params.reactionGuidance) {
    const { level, channel } = params.reactionGuidance;
    const guidanceText =
      level === "minimal"
        ? [
            `${channel} 的表情反应已启用，模式为最少。`,
            "仅在真正相关时反应：",
            "- 确认重要的用户请求或确认信息",
            "- 谨慎地表达真实情感（幽默、感谢）",
            "- 避免对常规消息或你自己的回复做出反应",
            "准则：每 5-10 次交流最多 1 个反应。",
          ].join("\n")
        : [
            `${channel} 的表情反应已启用，模式为广泛。`,
            "可以自由地反应：",
            "- 用合适的 emoji 确认消息",
            "- 通过反应表达情感和个性",
            "- 对有趣内容、幽默或值得注意的事件做出反应",
            "- 使用反应确认理解或同意",
            "准则：感觉自然时就反应。",
          ].join("\n");
    lines.push("## 表情反应", guidanceText, "");
  }
  if (reasoningHint) {
    lines.push("## 推理格式", reasoningHint, "");
  }

  const contextFiles = params.contextFiles ?? [];
  const bootstrapTruncationWarningLines = (params.bootstrapTruncationWarningLines ?? []).filter(
    (line) => line.trim().length > 0,
  );
  const validContextFiles = contextFiles.filter(
    (file) => typeof file.path === "string" && file.path.trim().length > 0,
  );
  if (validContextFiles.length > 0 || bootstrapTruncationWarningLines.length > 0) {
    lines.push("# 项目上下文", "");
    if (validContextFiles.length > 0) {
      const hasSoulFile = validContextFiles.some((file) => {
        const normalizedPath = file.path.trim().replace(/\\/g, "/");
        const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
        return baseName.toLowerCase() === "soul.md";
      });
      lines.push("以下项目上下文文件已加载：");
      if (hasSoulFile) {
        lines.push(
          "如果存在 SOUL.md，请全身心代入其塑造的人设与语调。避免给出极其生硬、千篇一律的机械回复；尽最大可能遵循其中的指引，除非受到更高优先级指令的覆盖。",
        );
      }
      lines.push("");
    }
    if (bootstrapTruncationWarningLines.length > 0) {
      lines.push("⚠ 引导截断警告：");
      for (const warningLine of bootstrapTruncationWarningLines) {
        lines.push(`- ${warningLine}`);
      }
      lines.push("");
    }
    for (const file of validContextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // Skip silent replies for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## 静默回复",
      `当你无话可说时，仅回复：${SILENT_REPLY_TOKEN}`,
      "",
      "⚠️ 规则：",
      "- 它必须是你的整条消息——不能有其他内容",
      `- 永远不要将它附加到实际回复后（永远不要在真实回复中包含 "${SILENT_REPLY_TOKEN}"）`,
      "- 永远不要用 markdown 或代码块包裹它",
      "",
      `❌ 错误："这是帮助... ${SILENT_REPLY_TOKEN}"`,
      `❌ 错误："${SILENT_REPLY_TOKEN}"`,
      `✅ 正确：${SILENT_REPLY_TOKEN}`,
      "",
    );
  }

  // Skip heartbeats for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## 心跳",
      heartbeatPromptLine,
      "如果你收到心跳轮询（指的是一条与上述心跳提示词匹配的用户消息），且此时并没有需要特别关注的事项，请极其精确地仅回复：",
      "HEARTBEAT_OK",
      'OpenClaw 将消息开头/结尾的 "HEARTBEAT_OK" 视为心跳确认（可能将其丢弃）。',
      '如果有需要关注的事项，不要包含 "HEARTBEAT_OK"；直接回复告警文本。',
      "",
    );
  }

  lines.push(
    "## 运行时",
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel),
    `推理：${reasoningLevel}（隐藏，除非设为 on/stream）。通过 /reasoning 切换；/status 在启用时显示推理状态。`,
  );

  return lines.filter(Boolean).join("\n");
}

export function buildRuntimeLine(
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    repoRoot?: string;
  },
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
  defaultThinkLevel?: ThinkLevel,
): string {
  return `运行时：${[
    runtimeInfo?.agentId ? `agent=${runtimeInfo.agentId}` : "",
    runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
    runtimeInfo?.repoRoot ? `repo=${runtimeInfo.repoRoot}` : "",
    runtimeInfo?.os
      ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
      : runtimeInfo?.arch
        ? `arch=${runtimeInfo.arch}`
        : "",
    runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
    runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",
    runtimeInfo?.shell ? `shell=${runtimeInfo.shell}` : "",
    runtimeChannel ? `channel=${runtimeChannel}` : "",
    runtimeChannel
      ? `capabilities=${runtimeCapabilities.length > 0 ? runtimeCapabilities.join(",") : "none"}`
      : "",
    `thinking=${defaultThinkLevel ?? "off"}`,
  ]
    .filter(Boolean)
    .join(" | ")}`;
}
