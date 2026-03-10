import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
};
const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
}

export function isOpenRouterAnthropicModel(provider: string, modelId: string): boolean {
  return provider.toLowerCase() === "openrouter" && modelId.toLowerCase().startsWith("anthropic/");
}

function mapThinkingLevelToOpenRouterReasoningEffort(
  thinkingLevel: ThinkLevel,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (thinkingLevel === "off") {
    return "none";
  }
  if (thinkingLevel === "adaptive") {
    return "medium";
  }
  return thinkingLevel;
}

function normalizeProxyReasoningPayload(payload: unknown, thinkingLevel?: ThinkLevel): void {
  if (!payload || typeof payload !== "object") {
    return;
  }

  const payloadObj = payload as Record<string, unknown>;
  delete payloadObj.reasoning_effort;
  if (!thinkingLevel || thinkingLevel === "off") {
    return;
  }

  const existingReasoning = payloadObj.reasoning;
  if (
    existingReasoning &&
    typeof existingReasoning === "object" &&
    !Array.isArray(existingReasoning)
  ) {
    const reasoningObj = existingReasoning as Record<string, unknown>;
    if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) {
      reasoningObj.effort = mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel);
    }
  } else if (!existingReasoning) {
    payloadObj.reasoning = {
      effort: mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel),
    };
  }
}

type PayloadMessage = {
  role?: string;
  content?: unknown;
};

function injectCacheControlOnMessage(msg: PayloadMessage, requireTextType: boolean) {
  if (typeof msg.content === "string") {
    msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(msg.content) && msg.content.length > 0) {
    const last = msg.content[msg.content.length - 1];
    if (
      last &&
      typeof last === "object" &&
      (!requireTextType || (last as Record<string, unknown>).type === "text")
    ) {
      (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }
  }
}

export function createSystemCacheControlWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        const messages = (payload as Record<string, unknown>)?.messages;
        if (Array.isArray(messages)) {
          for (const msg of messages as PayloadMessage[]) {
            if (msg.role === "system" || msg.role === "developer") {
              injectCacheControlOnMessage(msg, false);
            }
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function createConversationCacheControlWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        const messages = (payload as Record<string, unknown>)?.messages;
        if (Array.isArray(messages)) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i] as PayloadMessage;
            if (msg.role !== "user" && msg.role !== "assistant") {
              continue;
            }
            injectCacheControlOnMessage(msg, true);
            break;
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...options?.headers,
      },
      onPayload: (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
        return onPayload?.(payload, model);
      },
    });
  };
}

export function isProxyReasoningUnsupported(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("x-ai/");
}

export function createKilocodeWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        ...resolveKilocodeAppHeaders(),
      },
      onPayload: (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
        return onPayload?.(payload, model);
      },
    });
  };
}
