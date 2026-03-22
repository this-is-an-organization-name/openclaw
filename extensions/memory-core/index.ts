import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  if (!availableTools.has("memory_search") && !availableTools.has("memory_get")) {
    return [];
  }
  const lines = [
    "## 记忆检索",
    "处理关于先前工作、决策、日期、人物、偏好或待办事项的事务前：先对 MEMORY.md + memory/*.md 运行 memory_search；然后使用 memory_get 拉取所需的行。",
  ];
  if (citationsMode === "off") {
    lines.push("引用已禁用：除非被明确要求，否则不要在输出内容中提及文件路径或行号。");
  } else {
    lines.push("引用：当有助于来源核查记忆片段时，包含 Source: <path#line>。");
  }
  lines.push("");
  return lines;
};

export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  register(api) {
    api.registerMemoryPromptSection(buildPromptSection);

    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
});
