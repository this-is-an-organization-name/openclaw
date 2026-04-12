// before_model_resolve hook
export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
};

export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "ollama" */
  providerOverride?: string;
};

// before_prompt_build hook
export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  /** Session messages prepared for this run. */
  messages: unknown[];
};

export type PrependContextItem = string | { content: string; transient?: true };
export type PrependContextValue = PrependContextItem | PrependContextItem[];

function normalizePrependContextToArray(val: PrependContextValue): PrependContextItem[] {
  if (typeof val === "string") {
    return [val];
  }
  if (Array.isArray(val)) {
    return val;
  }
  return [val];
}

function resolveItem(item: PrependContextItem): { content: string; transient: boolean } {
  if (typeof item === "string") {
    return { content: item, transient: false };
  }
  return { content: item.content, transient: item.transient === true };
}

export function resolvePrependContextItems(
  val: PrependContextValue | undefined,
): { content: string; transient: boolean }[] {
  if (val === undefined) {
    return [];
  }
  return normalizePrependContextToArray(val).map(resolveItem);
}

export function mergePrependContextValues(
  left: PrependContextValue | undefined,
  right: PrependContextValue | undefined,
): PrependContextValue | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (typeof left === "string" && typeof right === "string") {
    return `${left}\n\n${right}`;
  }
  return [...normalizePrependContextToArray(left), ...normalizePrependContextToArray(right)];
}

export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: PrependContextValue;
  appendContext?: PrependContextValue;
  /**
   * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  appendSystemContext?: string;
};

export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
  "systemPrompt",
  "prependContext",
  "appendContext",
  "prependSystemContext",
  "appendSystemContext",
] as const satisfies readonly (keyof PluginHookBeforePromptBuildResult)[];

type MissingPluginPromptMutationResultFields = Exclude<
  keyof PluginHookBeforePromptBuildResult,
  (typeof PLUGIN_PROMPT_MUTATION_RESULT_FIELDS)[number]
>;
type AssertAllPluginPromptMutationResultFieldsListed =
  MissingPluginPromptMutationResultFields extends never ? true : never;
const assertAllPluginPromptMutationResultFieldsListed: AssertAllPluginPromptMutationResultFieldsListed = true;
void assertAllPluginPromptMutationResultFieldsListed;

// before_agent_start hook (legacy compatibility: combines both phases)
export type PluginHookBeforeAgentStartEvent = {
  prompt: string;
  /** Optional because legacy hook can run in pre-session phase. */
  messages?: unknown[];
};

export type PluginHookBeforeAgentStartResult = PluginHookBeforePromptBuildResult &
  PluginHookBeforeModelResolveResult;

export type PluginHookBeforeAgentStartOverrideResult = Omit<
  PluginHookBeforeAgentStartResult,
  keyof PluginHookBeforePromptBuildResult
>;

export const stripPromptMutationFieldsFromLegacyHookResult = (
  result: PluginHookBeforeAgentStartResult | void,
): PluginHookBeforeAgentStartOverrideResult | void => {
  if (!result || typeof result !== "object") {
    return result;
  }
  const remaining: Partial<PluginHookBeforeAgentStartResult> = { ...result };
  for (const field of PLUGIN_PROMPT_MUTATION_RESULT_FIELDS) {
    delete remaining[field];
  }
  return Object.keys(remaining).length > 0
    ? (remaining as PluginHookBeforeAgentStartOverrideResult)
    : undefined;
};
