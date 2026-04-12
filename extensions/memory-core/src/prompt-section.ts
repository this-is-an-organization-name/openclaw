import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      // tmpfix: Chinese prompt
      "回答任何关于过往工作、决策、日期、人物、偏好或待办事项的问题之前：先对 MEMORY.md + memory/*.md + 已索引的会话记录运行 memory_search；然后使用 memory_get 仅提取所需行。如果搜索后信心不足，说明你已查过。";
  } else if (hasMemorySearch) {
    toolGuidance =
      // tmpfix: Chinese prompt
      "回答任何关于过往工作、决策、日期、人物、偏好或待办事项的问题之前：先对 MEMORY.md + memory/*.md + 已索引的会话记录运行 memory_search，并从匹配结果中作答。如果搜索后信心不足，说明你已查过。";
  } else {
    toolGuidance =
      // tmpfix: Chinese prompt
      "回答任何涉及已知特定记忆文件或笔记的过往工作、决策、日期、人物、偏好或待办事项的问题之前：运行 memory_get 仅提取所需行。如果阅读后信心不足，说明你已查过。";
  }

  // tmpfix: Chinese prompt
  const lines = ["## 记忆检索", toolGuidance];
  if (citationsMode === "off") {
    lines.push(
      "引用已禁用：除非被明确要求，否则不要在输出内容中提及文件路径或行号。",
    );
  } else {
    lines.push(
      "引用：当有助于来源核查记忆片段时，包含 Source: <path#line>。",
    );
  }
  lines.push("");
  return lines;
};
