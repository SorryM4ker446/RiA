-- A task sub-agent's own tool calls are steps of the turn that started it, recorded
-- under the call that started the sub-agent, so the execution record can show them
-- nested inside it.
ALTER TABLE "agent_steps" ADD COLUMN "parentToolCallId" TEXT;
