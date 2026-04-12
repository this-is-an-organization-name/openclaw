// tmpfix: pre-reset memory flush & /save command (ref: PR#18883)
import crypto from "node:crypto";
import { resolveAgentDir, resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { appendCronStyleCurrentTimeLine, resolveCronStyleNow } from "../../agents/current-time.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isEmbeddedPiRunActive, runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { resolveMemoryFlushPlan } from "../../plugins/memory-state.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const SAVE_PROMPT = [
  "Manual memory save requested by user.",
  "Store important context, decisions, and learnings to memory files (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.",
  `If nothing worth saving, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

const SAVE_SYSTEM_PROMPT = [
  "Manual memory save turn.",
  "The user explicitly requested a memory save. Capture durable memories to disk.",
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

const RESET_FLUSH_PROMPT = [
  "Session is being reset. Save any important context to memory files now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.",
  `Reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

const RESET_FLUSH_SYSTEM_PROMPT = [
  "Pre-reset memory flush turn.",
  "The user triggered /new or /reset. Write durable notes before the session is cleared.",
  `You must reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

export async function runMemorySave(params: {
  cfg: HandleCommandsParams["cfg"];
  sessionEntry: HandleCommandsParams["sessionEntry"];
  sessionKey: HandleCommandsParams["sessionKey"];
  storePath: HandleCommandsParams["storePath"];
  agentId: HandleCommandsParams["agentId"];
  workspaceDir: HandleCommandsParams["workspaceDir"];
  provider: HandleCommandsParams["provider"];
  model: HandleCommandsParams["model"];
  resolvedThinkLevel: HandleCommandsParams["resolvedThinkLevel"];
  resolvedVerboseLevel: HandleCommandsParams["resolvedVerboseLevel"];
  resolvedReasoningLevel: HandleCommandsParams["resolvedReasoningLevel"];
  ownerNumbers?: string[];
  prompt?: string;
  systemPrompt?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const sessionId = params.sessionEntry?.sessionId;
  if (!sessionId) {
    return { ok: false, error: "missing session id" };
  }
  if (isEmbeddedPiRunActive(sessionId)) {
    return { ok: false, error: "agent is currently running" };
  }

  const plan = resolveMemoryFlushPlan({ cfg: params.cfg });
  const rawPrompt = params.prompt ?? SAVE_PROMPT;
  let prompt: string;
  if (!params.prompt && plan) {
    prompt = plan.prompt;
  } else {
    const dateStamp = plan
      ? plan.relativePath.replace(/^memory\//, "").replace(/\.md$/, "")
      : formatFallbackDateStamp(params.cfg);
    prompt = appendCronStyleCurrentTimeLine(
      rawPrompt.replaceAll("YYYY-MM-DD", dateStamp),
      params.cfg ?? {},
      Date.now(),
    );
  }
  const systemPrompt =
    params.systemPrompt ?? plan?.systemPrompt ?? SAVE_SYSTEM_PROMPT;

  const runId = crypto.randomUUID();
  registerAgentRunContext(runId, {
    sessionKey: params.sessionKey,
    verboseLevel: params.resolvedVerboseLevel,
  });

  try {
    const sessionFile = resolveSessionFilePath(
      sessionId,
      params.sessionEntry,
      resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
      }),
    );

    const agentDir = resolveAgentDir(params.cfg, params.agentId ?? "main");

    await runWithModelFallback({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(params.cfg, params.agentId ?? "main"),
      run: async (provider, model) => {
        return runEmbeddedPiAgent({
          sessionId,
          sessionKey: params.sessionKey,
          sessionFile,
          workspaceDir: params.workspaceDir,
          agentDir,
          config: params.cfg,
          skillsSnapshot: params.sessionEntry?.skillsSnapshot,
          prompt,
          extraSystemPrompt: systemPrompt,
          ownerNumbers: params.ownerNumbers,
          enforceFinalTag: false,
          provider,
          model,
          thinkLevel: params.resolvedThinkLevel,
          verboseLevel: params.resolvedVerboseLevel,
          reasoningLevel: params.resolvedReasoningLevel,
          execOverrides: undefined,
          bashElevated: {
            enabled: false,
            allowed: false,
            defaultLevel: "off",
          },
          timeoutMs: 60_000,
          runId,
        });
      },
    });

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logVerbose(`memory save failed: ${message}`);
    return { ok: false, error: message };
  }
}

export async function runPreResetMemoryFlush(
  params: Parameters<typeof runMemorySave>[0],
): Promise<{ ok: boolean; error?: string }> {
  return runMemorySave({
    ...params,
    prompt: RESET_FLUSH_PROMPT,
    systemPrompt: RESET_FLUSH_SYSTEM_PROMPT,
  });
}

export const handleSaveCommand: CommandHandler = async (params) => {
  const saveRequested =
    params.command.commandBodyNormalized === "/save" ||
    params.command.commandBodyNormalized.startsWith("/save ");
  if (!saveRequested) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /save from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const result = await runMemorySave({
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    model: params.model,
    resolvedThinkLevel: params.resolvedThinkLevel,
    resolvedVerboseLevel: params.resolvedVerboseLevel,
    resolvedReasoningLevel: params.resolvedReasoningLevel,
    ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
  });

  if (!result.ok) {
    return {
      shouldContinue: false,
      reply: { text: `💾 Save unavailable (${result.error}).` },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: "💾 Memory saved." },
  };
};

function formatFallbackDateStamp(cfg?: HandleCommandsParams["cfg"]): string {
  const nowMs = Date.now();
  const { userTimezone } = resolveCronStyleNow(cfg ?? {}, nowMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: userTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find(p => p.type === "year")?.value;
  const month = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;
  if (year && month && day) { return `${year}-${month}-${day}`; }
  return new Date(nowMs).toISOString().slice(0, 10);
}
