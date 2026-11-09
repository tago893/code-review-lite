// Prints one JSON line about the tool-enabled model requests of a scenario: per-request bytes, how many tool results and
// pruned references each carried, totals, and the stamp/denial counters from the proxy log. Bytes are not tokens.
// Usage: node inspect-history.mjs <requests.jsonl> <proxy.log> [run.jsonl]
import { existsSync, readFileSync } from "node:fs";

const [requestsPath, proxyPath, runPath] = process.argv.slice(2);
const lines = (path) => (path && existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

const requests = lines(requestsPath)
  .filter((r) => String(r.path).includes("chat/completions") && r.has_tools)
  .map((r) => {
    const body = JSON.parse(r.body);
    const tool = body.messages.filter((m) => m.role === "tool");
    const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
    return { bytes: Buffer.byteLength(r.body), messages: body.messages.length, toolResults: tool.length, prunedRefs: tool.filter((m) => text(m).startsWith("[cra:pruned")).length, toolResultBytes: tool.reduce((a, m) => a + Buffer.byteLength(text(m)), 0) };
  });

const proxy = lines(proxyPath);
const count = (name) => proxy.filter((e) => e.event === name).length;
const sizes = requests.map((r) => r.bytes);
const total = sizes.reduce((a, b) => a + b, 0);
const run = lines(runPath);
const pruning = run.filter((e) => e.event === "history_pruning").map((e) => ({ verdict: e.verdict, modelRequests: e.modelRequests, prunes: e.prunes, stamps: e.stamps, errors: e.errors, maxToolResults: e.maxToolResults, maxKeptBytes: e.maxKeptBytes, savedBytes: e.savedBytes }));
const calls = run.filter((e) => e.event === "tool_call");
const readsOf = (path) => calls.filter((c) => c.tool === "cra_read" && c.status === "completed" && c.input?.path === path).map((c) => c.outputSha256);
const last = (n) => sizes.slice(-n);
const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

console.log(JSON.stringify({
  toolRequests: requests.length,
  sizes: sizes.join(" "),
  first: sizes[0] ?? null,
  max: sizes.length ? Math.max(...sizes) : null,
  total,
  meanLast10: mean(last(10)),
  slopeBytesPerRequest: sizes.length > 10 ? Math.round((mean(last(5)) - mean(sizes.slice(0, 5))) / (sizes.length - 5)) : null,
  lastToolResults: requests.at(-1)?.toolResults ?? 0,
  lastPrunedRefs: requests.at(-1)?.prunedRefs ?? 0,
  maxToolResultBytesInOneRequest: requests.length ? Math.max(...requests.map((r) => r.toolResultBytes)) : 0,
  proxy: { forwarded: count("request"), historyDenied: count("history_denied"), budgetExhausted: count("budget_exhausted"), stamped: proxy.filter((e) => e.event === "request" && e.history_stamp === true).length },
  pruning,
  usersReadHashes: readsOf("/repo/src/users.ts").concat(readsOf("src/users.ts")),
}));
