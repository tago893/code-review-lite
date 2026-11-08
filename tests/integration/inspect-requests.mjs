// Reads the proxy's request-body log (requests.jsonl, written under PROXY_LOG_BODIES=1) and prints one JSON line about the
// model requests: the first tool-enabled request (the investigator's) and the structured ones (Phase 2, judge, verifier).
// Usage: node inspect-requests.mjs <requests.jsonl>
import { readFileSync } from "node:fs";

const bytes = (x) => Buffer.byteLength(typeof x === "string" ? x : JSON.stringify(x ?? ""));
const text = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
const requests = readFileSync(process.argv[2], "utf8").trim().split("\n")
  .map((line) => JSON.parse(line))
  .filter((r) => String(r.path).includes("chat/completions"))
  .map((r) => ({ raw: r.body, body: JSON.parse(r.body) }));

const investigator = requests.find((r) => Array.isArray(r.body.tools) && r.body.tools.length > 0);
const structured = requests.filter((r) => r.body.response_format !== undefined);
const system = (r) => r.body.messages.filter((m) => m.role === "system").map(text).join("\n");
const user = (r) => r.body.messages.filter((m) => m.role === "user").map(text).join("\n");

console.log(JSON.stringify({
  investigator: investigator && {
    totalBytes: bytes(investigator.raw),
    messages: investigator.body.messages.length,
    systemBytes: investigator.body.messages.filter((m) => m.role === "system").reduce((a, m) => a + bytes(m), 0),
    toolsBytes: bytes(investigator.body.tools),
    toolNames: investigator.body.tools.map((t) => t.function?.name),
    systemIsOpenCodeBuiltin: /You are OpenCode|apply_patch|Editing constraints/.test(system(investigator)),
    systemIsInvestigatorPrompt: system(investigator).includes("read-only code-review investigator"),
    userHasReviewerRules: user(investigator).includes("# Shared reviewer rules") && user(investigator).includes("# Code quality reviewer"),
    userHasPrContext: user(investigator).includes("<shared_context>") && user(investigator).includes("diff --git"),
  },
  structured: { count: structured.length, anyHasInvestigatorPrompt: structured.some((r) => system(r).includes("read-only code-review investigator")), anyHasTools: structured.some((r) => Array.isArray(r.body.tools) && r.body.tools.length > 0) },
}));
