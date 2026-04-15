import { ToolSet } from "ai";
import {
  searchKnowledge,
  searchKnowledgeInputSchema,
  type SearchKnowledgeInput,
  type SearchKnowledgeOutput,
} from "@/tools/definitions/search-knowledge";
import {
  createTask,
  createTaskInputSchema,
  type CreateTaskInput,
  type CreateTaskOutput,
} from "@/tools/definitions/create-task";

export type ChatToolInputMap = {
  searchKnowledge: SearchKnowledgeInput;
  createTask: CreateTaskInput;
};

export type ChatToolOutputMap = {
  searchKnowledge: SearchKnowledgeOutput;
  createTask: CreateTaskOutput;
};

export function createChatTools(userId: string): ToolSet {
  return {
    searchKnowledge: {
      description:
        "Search relevant project knowledge from long-term memories and built-in project docs.",
      inputSchema: searchKnowledgeInputSchema,
      execute: async (input) => searchKnowledge(userId, input as SearchKnowledgeInput),
    },
    createTask: {
      description:
        "Create a task for the current user with title, optional details, due date, and priority.",
      inputSchema: createTaskInputSchema,
      execute: async (input) => createTask(userId, input as CreateTaskInput),
    },
  };
}
