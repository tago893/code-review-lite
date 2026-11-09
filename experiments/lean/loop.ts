import { planPruning, type HistoryMessageLike, type ToolPartLike } from "../../src/agents/history.js";
import type { Roots } from "../../src/mcp/paths.js";
import { ProviderError, type ChatFn } from "./client.js";
import { MalformedToolCall, runTool, toolDefinitions } from "./tools.js";

// The whole investigation: ask the model, run the tools it asks for, repeat. Every limit is checked here, in this loop:
// the number of turns, the size of each request (older tool results shrink to references until it fits) and the run
// deadline (carried by `signal`). Nothing is retried except what the client retries (HTTP 429).

const MAX_CALLS_PER_TURN = 16;

export type TraceEvent = Readonly<Record<string, string | number | boolean>>;

export interface LoopInput {
  readonly chat: ChatFn;
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly roots: Roots;
  readonly maxTurns: number;
  /** A request body larger than this is never sent. */
  readonly maxRequestBytes: number;
  /** Bytes of tool results kept in full per request; older ones become references. Halved until the request fits. */
  readonly historyBytes: number;
  /** Requests for tools that do not exist before the run is stopped as incomplete. */
  readonly maxForbiddenToolCalls: number;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: TraceEvent) => void;
}

export interface LoopResult {
  readonly status: "complete" | "incomplete";
  /** A fixed word when incomplete: step_limit, deadline, request_budget_exceeded, malformed_tool_call_*, provider_<status>_<code>, ... */
  readonly reason?: string;
  /** The model's investigation notes (complete only). */
  readonly notes: string;
  readonly turns: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

interface ToolResult { readonly callId: string; readonly tool: string; readonly output: string }
interface Turn {
  readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
  readonly results: readonly ToolResult[];
}

export async function investigate(input: LoopInput): Promise<LoopResult> {
  const turns: Turn[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let unknownCalls = 0;
  const done = (status: "complete" | "incomplete", reason: string | undefined, notes: string): LoopResult =>
    Object.freeze({ status, ...(reason ? { reason } : {}), notes, turns: turns.length, tokensIn, tokensOut });

  for (let n = 1; n <= input.maxTurns; n++) {
    if (input.signal?.aborted) return done("incomplete", "deadline", "");
    const sized = fitRequest(input, turns);
    input.onEvent({ event: "request", turn: n, bytes: sized.bytes, toolResults: sized.toolResults, prunedResults: sized.pruned, keptToolBytes: sized.keptBytes });
    if (sized.bytes > input.maxRequestBytes) return done("incomplete", "request_budget_exceeded", "");

    let message: AssistantMessage;
    try {
      const reply = await input.chat(sized.body);
      if (reply.retries > 0) input.onEvent({ event: "retried_429", turn: n, retries: reply.retries });
      const parsed = readReply(reply.json);
      tokensIn += parsed.tokensIn;
      tokensOut += parsed.tokensOut;
      message = parsed.message;
      input.onEvent({ event: "response", turn: n, toolCalls: message.tool_calls.length, finish: parsed.finish, tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut });
    } catch (error) {
      const reason = error instanceof ProviderError ? (error.code === "deadline" ? "deadline" : error.message) : error instanceof MalformedToolCall ? error.message : "malformed_response";
      if (error instanceof ProviderError) input.onEvent({ event: "provider_error", turn: n, status: error.status, code: error.code, type: error.errorType, retries: error.retries });
      return done("incomplete", reason, "");
    }

    if (message.tool_calls.length === 0) {
      return message.content.trim() === "" ? done("incomplete", "empty_response", "") : done("complete", undefined, message.content);
    }

    const results: ToolResult[] = [];
    for (const [index, call] of message.tool_calls.entries()) {
      if (index >= MAX_CALLS_PER_TURN) { results.push({ callId: call.id, tool: "cra_none", output: "error: too_many_calls. Make at most 16 calls per turn." }); continue; }
      try {
        const outcome = await runTool(input.roots, call.function.name, call.function.arguments);
        input.onEvent({ event: "tool", turn: n, tool: call.function.name, status: outcome.status, bytes: Buffer.byteLength(outcome.output) });
        if (outcome.status === "unknown_tool" && ++unknownCalls >= input.maxForbiddenToolCalls) return done("incomplete", "forbidden_tool_requests", "");
        results.push({ callId: call.id, tool: call.function.name, output: outcome.output });
      } catch (error) {
        const reason = error instanceof MalformedToolCall ? error.message : "tool_failed";
        input.onEvent({ event: "tool", turn: n, tool: "(malformed)", status: reason, bytes: 0 });
        return done("incomplete", reason, "");
      }
    }
    turns.push({ calls: message.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })), results });
  }
  return done("incomplete", "step_limit", "");
}

interface AssistantMessage {
  readonly content: string;
  readonly tool_calls: readonly { readonly id: string; readonly function: { readonly name: string; readonly arguments: string } }[];
}

function readReply(json: unknown): { message: AssistantMessage; finish: string; tokensIn: number; tokensOut: number } {
  const root = json as { choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  const choice = root.choices?.[0];
  if (choice?.message === undefined) throw new Error("malformed_response");
  const raw = Array.isArray(choice.message.tool_calls) ? (choice.message.tool_calls as unknown[]) : [];
  const calls = raw.map((c, i) => {
    const call = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof call.function?.name !== "string" || (call.function.arguments !== undefined && typeof call.function.arguments !== "string")) {
      throw new MalformedToolCall("bad_tool_name");
    }
    return { id: typeof call.id === "string" && call.id !== "" ? call.id : `call_${i}`, function: { name: call.function.name, arguments: call.function.arguments ?? "{}" } };
  });
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    message: { content: typeof choice.message.content === "string" ? choice.message.content : "", tool_calls: calls },
    finish: typeof choice.finish_reason === "string" ? choice.finish_reason.slice(0, 20) : "none",
    tokensIn: count(root.usage?.prompt_tokens),
    tokensOut: count(root.usage?.completion_tokens),
  };
}

interface Sized { readonly body: object; readonly bytes: number; readonly toolResults: number; readonly pruned: number; readonly keptBytes: number }

/** Builds the request, halving the full-result budget until it fits. The newest result is always kept in full. */
function fitRequest(input: LoopInput, turns: readonly Turn[]): Sized {
  let budget = input.historyBytes;
  for (;;) {
    const sized = assemble(input, turns, budget);
    if (sized.bytes <= input.maxRequestBytes || budget <= 1) return sized;
    budget = Math.floor(budget / 2);
  }
}

function assemble(input: LoopInput, turns: readonly Turn[], budget: number): Sized {
  const parts = new Map<ToolResult, ToolPartLike>();
  const views: HistoryMessageLike[] = [];
  for (const turn of turns) {
    const toolParts = turn.results.map((r) => {
      const part: ToolPartLike = { type: "tool", tool: r.tool, state: { status: "completed", output: r.output } };
      parts.set(r, part);
      return part;
    });
    views.push({ parts: toolParts });
  }
  const plan = planPruning(views, budget);
  const replaced = new Map(plan.replacements.map((r) => [r.part, r.output]));
  const messages: object[] = [{ role: "system", content: input.system }, { role: "user", content: input.user }];
  for (const turn of turns) {
    messages.push({ role: "assistant", content: null, tool_calls: turn.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });
    for (const r of turn.results) messages.push({ role: "tool", tool_call_id: r.callId, content: replaced.get(parts.get(r) as ToolPartLike) ?? r.output });
  }
  const body = { model: input.model, messages, tools: toolDefinitions, tool_choice: "auto", temperature: 0 };
  return { body, bytes: Buffer.byteLength(JSON.stringify(body)), toolResults: plan.stats.toolResults, pruned: plan.stats.pruned, keptBytes: plan.stats.keptBytes };
}
