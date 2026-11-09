import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatFn } from "../../experiments/lean/client.js";
import type { ReviewPlan } from "../../src/plan.js";
import { writeReviewContext } from "../../src/workspace/review-context.js";

// The synthetic SQL-injection repository (same shape as tests/integration/make-fixture-repo.sh), a prepared review
// context for it, and helpers for scripting a fake model. No real code, no network.

export const PROMPTS = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../prompts");
export const VULNERABLE_LINE = `  return query("SELECT id, name, email FROM users WHERE name = '" + name + "'");`;

const FILES: Readonly<Record<string, string>> = {
  "src/db.ts": "export interface Row { [column: string]: unknown }\nexport function query(sql: string, params: readonly unknown[] = []): Row[] { return []; }\n",
  "src/server.ts": 'import { findUser } from "./users";\nexport function handleGetUser(request: { query: { name: string } }) {\n  return findUser(request.query.name);\n}\n',
  "src/users.ts": `import { query, type Row } from "./db";\n\nexport function findUser(name: string): Row[] {\n${VULNERABLE_LINE}\n}\n`,
  "src/big.ts": Array.from({ length: 300 }, (_, i) => `export const LINE_${i + 1} = ${i + 1}; // padding to make this file long enough to page through`).join("\n") + "\n",
};

export interface Fixture { readonly repo: string; readonly ctx: string }

export async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "lean-"));
  const repo = join(root, "repo");
  const ctx = join(root, "ctx");
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const patch = `--- a/src/users.ts\n+++ b/src/users.ts\n@@ -3,3 +3,3 @@\n export function findUser(name: string): Row[] {\n-  return query("SELECT id, name, email FROM users WHERE name = $1", [name]);\n+${VULNERABLE_LINE}\n }\n`;
  const plan: ReviewPlan = {
    tier: "lite", agents: ["security"], reasons: [], uncertainties: [], size: { changedLines: 2, files: 1 },
    entries: [{ oldPath: "src/users.ts", newPath: "src/users.ts", status: "modified", addedLines: [VULNERABLE_LINE], removedLines: [], addedLineNumbers: [4], removedLineNumbers: [], isBinary: false, isRename: false, patch }],
    excluded: [], withheld: [], disposition: "review", manualReasons: [], unreviewed: [],
  };
  await writeReviewContext(ctx, plan, { baseSha: "a".repeat(40), headSha: "b".repeat(40) });
  return { repo, ctx };
}

export type Call = readonly [name: string, args: unknown];
export const toolTurn = (calls: readonly Call[]): unknown => ({
  choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: calls.map(([name, args], i) => ({ id: `c${i}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } })) } }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});
export const textTurn = (text: string): unknown => ({ choices: [{ finish_reason: "stop", message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });

export const NOTES = `Path: src/users.ts\nLine: 4\nCode: ${VULNERABLE_LINE.trim()}\nClaim: name is concatenated into SQL.\nFlow: handleGetUser -> findUser -> query`;
export const finding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: "security", severity: "critical", file: "src/users.ts", line: 4, evidence: VULNERABLE_LINE.trim(), claim: "SQL injection via string concatenation", path: "handleGetUser -> findUser -> query", ...over,
});

export interface Scripted { readonly chat: ChatFn; readonly bodies: () => readonly Record<string, unknown>[] }

/** A fake model: each call returns the next scripted response (a function receives the request body). */
export function scripted(...steps: readonly (unknown | ((body: Record<string, unknown>) => unknown))[]): Scripted {
  const bodies: Record<string, unknown>[] = [];
  const chat: ChatFn = async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
    const step = steps[Math.min(bodies.length - 1, steps.length - 1)];
    const json = typeof step === "function" ? (step as (b: Record<string, unknown>) => unknown)(bodies[bodies.length - 1] as Record<string, unknown>) : step;
    return { json, retries: 0 };
  };
  return { chat, bodies: () => bodies };
}
