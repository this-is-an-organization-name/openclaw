import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { logVerbose } from "../../globals.js";
import { resolveMemoryFlushPlan } from "../../plugins/memory-state.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { emitResetCommandHooks, type ResetCommandAction } from "./commands-reset-hooks.js";
import { runPreResetMemoryFlush } from "./commands-save.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  const mutableCtx = ctx as Record<string, unknown>;
  mutableCtx.Body = resetTail;
  mutableCtx.RawBody = resetTail;
  mutableCtx.CommandBody = resetTail;
  mutableCtx.BodyForCommands = resetTail;
  mutableCtx.BodyForAgent = resetTail;
  mutableCtx.BodyStripped = resetTail;
  mutableCtx.AcpDispatchTailAfterReset = true;
}
export async function maybeHandleResetCommand(
  params: HandleCommandsParams,
): Promise<CommandHandlerResult | null> {
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
  if (!resetMatch) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // tmpfix: pre-reset memory flush — save durable memories before the session is wiped
  if (params.sessionEntry?.sessionId) {
    const plan = resolveMemoryFlushPlan({ cfg: params.cfg });
    if (plan) {
      const flushResult = await runPreResetMemoryFlush({
        cfg: params.cfg,
        sessionEntry: params.previousSessionEntry ?? params.sessionEntry,
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
      if (flushResult.ok) {
        logVerbose(`Pre-reset memory flush completed for session ${params.sessionKey}`);
      } else {
        logVerbose(`Pre-reset memory flush failed: ${flushResult.error}`);
      }
    }
  }

  const commandAction: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
  const resetTail = params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart();
  const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
  const boundAcpKey =
    boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
      ? boundAcpSessionKey.trim()
      : undefined;
  if (boundAcpKey) {
    const resetResult = await resetConfiguredBindingTargetInPlace({
      cfg: params.cfg,
      sessionKey: boundAcpKey,
      reason: commandAction,
      commandSource: `${params.command.surface}:${params.ctx.CommandSource ?? "text"}`,
    });
    if (!resetResult.ok) {
      logVerbose(`acp reset failed for ${boundAcpKey}: ${resetResult.error ?? "unknown error"}`);
    }
    if (resetResult.ok) {
      params.command.resetHookTriggered = true;
      if (resetTail) {
        applyAcpResetTailContext(params.ctx, resetTail);
        if (params.rootCtx && params.rootCtx !== params.ctx) {
          applyAcpResetTailContext(params.rootCtx, resetTail);
        }
        return { shouldContinue: false };
      }
      return {
        shouldContinue: false,
        reply: { text: "✅ ACP session reset in place." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "⚠️ ACP session reset failed. Check /acp status and try again." },
    };
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  await emitResetCommandHooks({
    action: commandAction,
    ctx: params.ctx,
    cfg: params.cfg,
    command: params.command,
    sessionKey: params.sessionKey,
    sessionEntry: targetSessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    workspaceDir: params.workspaceDir,
  });
  return null;
}
