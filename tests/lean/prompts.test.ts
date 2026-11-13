import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { reviewLean } from "../../experiments/lean/run.js";
import { makeFixture, PROMPTS, scripted, textTurn, type Fixture } from "./fixture.js";

// What the model is told. The tool names in the prompt must be the names the model can actually call, and the default
// assistant must be the bug-finding one (uReview's "Standard" assistant), not the security one.

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const shared = readFileSync(join(PROMPTS, "REVIEWER_SHARED.md"), "utf8");

let fx: Fixture;
beforeAll(async () => { fx = await makeFixture(); });

describe("reviewer prompts", () => {
  it("names the four tools exactly as the model must call them", () => {
    for (const tool of ["cra_read", "cra_grep", "cra_glob", "cra_list"]) expect(shared).toContain(`\`${tool}\``);
    expect(shared).not.toMatch(/`(?:read|grep|glob|list)`/); // the old, uncallable short names
  });

  it("sends the tool names in the system prompt without a separate patch-up note", async () => {
    const model = scripted(textTurn("No findings."));
    await reviewLean({ repo: fx.repo, ctx: fx.ctx, prompts: PROMPTS, category: "code_quality", model: "m", chat: model.chat, maxTurns: 2, maxRequestBytes: 32_000, historyBytes: 8_000, maxForbiddenToolCalls: 3, onEvent: () => undefined });
    const system = (model.bodies()[0] as { messages: { role: string; content: string }[] }).messages[0]?.content ?? "";
    expect(system).toContain("`cra_read`");
    expect(system).not.toContain("(the read, grep, glob and list described above)");
  });

  it("runs the bug-finding assistant by default in the container and on the command line", () => {
    const compose = readFileSync(join(ROOT, "experiments/lean/compose.lean.yml"), "utf8");
    expect(compose).toMatch(/- --category\s*\n(?:\s*#[^\n]*\n)*\s*- \$\{LEAN_CATEGORY:-code_quality\}/); // [^\n]: also CRLF
    const run = readFileSync(join(ROOT, "experiments/lean/run.ts"), "utf8");
    expect(run).toContain('args.get("--category") ?? "code_quality"');
  });
});
