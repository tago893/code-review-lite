import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pluginModule from "../../src/agents/history-plugin.js";
import { CraHistoryPlugin } from "../../src/agents/history-plugin.js";
import { parseHistoryState } from "../../src/agents/history-stats.js";

interface Msg { parts: { type: string; tool?: string; state?: { status: string; output: string } }[] }
const msgs = (...outputs: string[]): Msg[] => [{ parts: outputs.map((output) => ({ type: "tool", tool: "cra_read", state: { status: "completed", output } })) }];

function setup(budget: string | undefined): string {
  const file = join(mkdtempSync(join(tmpdir(), "cra-plugin-")), "state.jsonl");
  if (budget === undefined) delete process.env["CRA_HISTORY_BUDGET_BYTES"]; else process.env["CRA_HISTORY_BUDGET_BYTES"] = budget;
  process.env["CRA_HISTORY_STATE_FILE"] = file;
  return file;
}
afterEach(() => { delete process.env["CRA_HISTORY_BUDGET_BYTES"]; delete process.env["CRA_HISTORY_STATE_FILE"]; });
const state = (file: string) => parseHistoryState(readFileSync(file, "utf8"));

describe("CRA history plugin", () => {
  it("exports only the plugin function (OpenCode treats every export as a plugin)", () => {
    expect(Object.keys(pluginModule)).toEqual(["CraHistoryPlugin"]);
  });

  it("prunes older results in place before a request and records it", async () => {
    const file = setup("600");
    const hooks = await CraHistoryPlugin();
    const output = { messages: msgs("a".repeat(500), "b".repeat(500), "c".repeat(500)) };
    await hooks["experimental.chat.messages.transform"]({}, output);
    const bodies = output.messages[0]?.parts.map((p) => p.state?.output ?? "") ?? [];
    expect(bodies[2]).toBe("c".repeat(500));
    expect(bodies[0]).toMatch(/^\[cra:pruned tool=cra_read/);
    expect(bodies[1]).toMatch(/^\[cra:pruned/);
    expect(state(file)).toMatchObject({ loaded: true, prunes: 1, errors: 0, lastPruned: 2 });
  });

  it("stamps a request only after a prune, once per prune", async () => {
    const file = setup("600");
    const hooks = await CraHistoryPlugin();
    const stamp = async (): Promise<Record<string, string>> => {
      const out = { headers: {} as Record<string, string> };
      await hooks["chat.headers"]({}, out);
      return out.headers;
    };
    expect(await stamp()).toEqual({}); // no prune yet: unstamped, the proxy will refuse it
    await hooks["experimental.chat.messages.transform"]({}, { messages: msgs("x") });
    expect(await stamp()).toEqual({ "x-cra-history": "600" });
    expect(await stamp()).toEqual({}); // the prune authorised one request only
    expect(state(file).stamps).toBe(1);
  });

  it("records the error and rethrows when pruning fails, and does not authorise a stamp", async () => {
    const file = setup("600");
    const hooks = await CraHistoryPlugin();
    const hostile = { get messages(): never { throw new Error("boom"); } };
    await expect(hooks["experimental.chat.messages.transform"]({}, hostile)).rejects.toThrow("boom");
    const out = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]({}, out);
    expect(out.headers).toEqual({});
    expect(state(file)).toMatchObject({ errors: 1, prunes: 0, stamps: 0 });
  });

  it("refuses to load without a valid budget", async () => {
    for (const bad of [undefined, "0", "abc", "-5", "1.5"]) {
      const file = setup(bad);
      await expect(CraHistoryPlugin(), String(bad)).rejects.toThrow(/invalid budget/);
      expect(state(file).errors).toBe(1);
    }
  });
});
