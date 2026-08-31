import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { assertRequestSecurity } from "@/lib/server/request-security";
import type { NextRequest } from "next/server";

type Context = { requestId: string; userId?: string };
const state = globalThis as typeof globalThis & { dataOperations?: { active: number; exclusive: boolean; context: AsyncLocalStorage<Context> } };
const operations = state.dataOperations ??= { active: 0, exclusive: false, context: new AsyncLocalStorage<Context>() };
export const dataRequestContext = () => operations.context.getStore();
export function identifyDataUser(userId: string) { const context = dataRequestContext(); if (context) context.userId = userId; }
export function retainDataOperation() {
  if (operations.exclusive) throw new ApiError({ code: "SERVICE_UNAVAILABLE", message: "正在备份或恢复数据，请稍后重试。" });
  operations.active++;
  let released = false;
  return () => { if (!released) { released = true; operations.active--; } };
}

// The local service has one database and one media store. Never restore while a
// request can still persist an answer, execute a tool, or migrate old media.
export function protectDataOperation<Args extends [NextRequest, ...unknown[]]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      assertRequestSecurity(args[0]);
      if (operations.exclusive) throw new ApiError({ code: "SERVICE_UNAVAILABLE", message: "正在备份或恢复数据，请稍后重试。" });
      operations.active++;
      let released = false;
      const release = () => { if (!released) { released = true; operations.active--; } };
      try {
        return await operations.context.run({ requestId: randomUUID() }, async () => {
          const response = await handler(...args);
          if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) { release(); return response; }
          const reader = response.body.getReader();
          return new Response(new ReadableStream({
            async pull(controller) {
              try { const item = await reader.read(); if (item.done) { release(); controller.close(); } else controller.enqueue(item.value); }
              catch (error) { release(); controller.error(error); }
            },
            async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
          }), { status: response.status, headers: response.headers });
        });
      } catch (error) { release(); throw error; }
    } catch (error) { return createApiErrorResponse(error, "本地数据操作失败。"); }
  };
}

export async function exclusiveDataOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (operations.exclusive || operations.active) throw new ApiError({ code: "CONFLICT", message: "仍有请求正在执行，请停止生成并等待其他操作完成后重试。" });
  operations.exclusive = true;
  try { return await operation(); } finally { operations.exclusive = false; }
}
