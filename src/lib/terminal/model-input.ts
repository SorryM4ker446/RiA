import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

function withoutApprovalState(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (!Object.hasOwn(input, "binding") && !Object.hasOwn(input, "autoReview")) return input;
  const { binding: _binding, autoReview: _autoReview, ...command } = input as Record<string, unknown>;
  return command;
}

export function projectTerminalInputs(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  return prompt.map(message => message.role === "assistant" ? {
    ...message,
    content: message.content.map(part => {
      if (part.type !== "tool-call" || part.toolName !== "runTerminalCommand") return part;
      const input = withoutApprovalState(part.input);
      return input === part.input ? part : { ...part, input };
    }),
  } : message);
}

export function sanitizeTerminalToolCall<T extends { toolName: string; input: string }>(call: T): T {
  if (call.toolName !== "runTerminalCommand") return call;
  try {
    const input: unknown = JSON.parse(call.input);
    const command = withoutApprovalState(input);
    return command === input ? call : { ...call, input: JSON.stringify(command) };
  } catch {
    // Let the SDK report malformed tool input as usual.
    return call;
  }
}
