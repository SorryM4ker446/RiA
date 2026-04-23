import { type ToolSet } from "ai";
import { createChatToolSet } from "@/tools/catalog";

export function createChatTools(userId: string): ToolSet {
  return createChatToolSet(userId);
}

