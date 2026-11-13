import { beforeAll, describe, expect, it } from "vitest";
import type { TraceEvent } from "../../experiments/lean/loop.js";
import { reviewLean, type LeanOptions } from "../../experiments/lean/run.js";
import { toolLabel } from "../../experiments/lean/tools.js";
import { makeFixture, PROMPTS, scripted, textTurn, toolTurn, type Fixture } from "./fixture.js";

// Bad tool calls go back to the model as tool results, so one hallucinated call (gpt-oss is known to invent
// repo_browser.* tools) no longer ends the review. Groq is asked not to reject such calls itself
// (disable_tool_validation), so they reach this loop. A per-run limit still stops a model that keeps doing it.

let fx: Fixture;
beforeAll(async () => { fx = await makeFixture(); });

const SENTINEL = "MODEL_TEXT_SENTINEL_51c2";
function run(chat: LeanOptions["chat"], over: Partial<LeanOptions> = {}): Promise<Awaited<ReturnType<typeof reviewLean>>> & { events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const promise = reviewLean({ repo: fx.repo, ctx: fx.ctx, prompts: PROMPTS, category: "code_quality", model: "m", chat, maxTurns: 8, maxRequestBytes: 32_000, historyBytes: 8_000, maxForbiddenToolCalls: 3, onEvent: (e) => events.push(e), ...over });
  return Object.assign(promise, { events });
}
type Body = { messages: { role: string; content: unknown; tool_call_id?: string }[]; disable_tool_validation?: unknown; tools?: unknown };
const toolResults = (body: unknown): string[] => (body as Body).messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const toolEvents = (events: readonly TraceEvent[]): TraceEvent[] => events.filter((e) => e["event"] === "tool");

describe("bad tool calls go back to the model", () => {
  it("asks Groq to return unknown tool calls instead of rejecting the request", async () => {
    const model = scripted(textTurn("No findings."));
    await run(model.chat);
    expect((model.bodies()[0] as Body).disable_tool_validation).toBe(true);
  });

  it("answers a made-up tool with the real tool names, and the review goes on", async () => {
    const model = scripted(toolTurn([["repo_browser.read_file", { path: SENTINEL }]]), toolTurn([["cra_read", { path: "src/users.ts" }]]), textTurn("No findings."));
    const r = run(model.chat);
    expect(await r).toMatchObject({ status: "complete" });
    const answer = toolResults(model.bodies()[1])[0] ?? "";
    expect(answer).toMatch(/^error: unknown_tool\..*cra_read, cra_grep, cra_glob, cra_list/);
    expect(answer).not.toContain("repo_browser");
    expect(toolEvents(r.events).map((e) => [e["tool"], e["status"]])).toEqual([["unknown:repo_browser", "unknown_tool"], ["cra_read", "ok"]]);
  });

  it("answers a garbled name and arguments that are not a JSON object, and keeps going", async () => {
    const model = scripted(
      toolTurn([["cra_read<|channel|>commentary", { path: "src/users.ts" }]]),
      toolTurn([["cra_read", `{not json ${SENTINEL}`], ["cra_grep", "[1]"]]),
      textTurn("No findings."),
    );
    const r = run(model.chat, { maxForbiddenToolCalls: 5 }); // three rejected calls, under this limit
    expect(await r).toMatchObject({ status: "complete" });
    expect(toolResults(model.bodies()[2]).slice(1)).toEqual([expect.stringMatching(/^error: unparsable_arguments\./), expect.stringMatching(/^error: unparsable_arguments\./)]);
    expect(toolEvents(r.events).map((e) => [e["tool"], e["status"]])).toEqual([["unknown:garbled_cra", "unknown_tool"], ["cra_read", "unparsable_arguments"], ["cra_grep", "unparsable_arguments"]]);
  });

  it("stops the run as incomplete after the per-run limit of rejected calls", async () => {
    const model = scripted(toolTurn([["repo_browser.open_file", {}]]), toolTurn([["cra_read", "{bad"]]), toolTurn([["container.exec", {}]]), textTurn("No findings."));
    expect(await run(model.chat)).toMatchObject({ status: "incomplete", reason: "forbidden_tool_requests" });
    expect(model.bodies()).toHaveLength(3);
  });

  it("never copies the model's bad name or arguments into the answer or the trace", async () => {
    const model = scripted(toolTurn([[`x_${SENTINEL}`, {}], ["cra_read", `{"path": "${SENTINEL}"`]]), textTurn("No findings."));
    const r = run(model.chat);
    await r;
    expect(toolResults(model.bodies()[1]).join("\n")).not.toContain(SENTINEL);
    expect(JSON.stringify(r.events)).not.toContain(SENTINEL);
  });
});

describe("toolLabel: fixed words for the trace", () => {
  it("keeps real tool names and classifies everything else without copying it", () => {
    expect(toolLabel("cra_list")).toBe("cra_list");
    expect(toolLabel("repo_browser.print_tree")).toBe("unknown:repo_browser");
    expect(toolLabel("container.exec")).toBe("unknown:container");
    expect(toolLabel("functions.cra_read")).toBe("unknown:functions_prefix");
    expect(toolLabel("cra_glob_x")).toBe("unknown:garbled_cra");
    expect(toolLabel("bash")).toBe("unknown:plain");
    expect(toolLabel("some.other.tool")).toBe("unknown:dotted");
    expect(toolLabel("Ünï<x>")).toBe("unknown:garbled");
    expect(toolLabel("a".repeat(500))).toBe("unknown:garbled");
  });
});
