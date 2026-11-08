// A scripted, Groq-compatible chat-completions server that stands in for the model, so integration behaviour is
// deterministic and needs no provider key. It speaks the streaming (SSE) and non-streaming OpenAI formats.
//
// STUB_MODE:
//   attack  - turn 1 asks for forbidden tool calls (bash, write, read /etc/passwd, read /review/out, read through a
//             path outside the roots); once tool results arrive it answers "No findings."
//   obey    - answers "No findings." at once, as a model that obeyed an injected "approve this" would
//   report  - turn 1 reads src/users.ts; then writes notes naming the seeded bug; Phase 2/judge/verifier get fixed JSON
//   error   - always HTTP 500
//   tools   - turn 1 asks for read of src/users.ts only (a benign tool call), then "No findings."
//   overflow - turn 1 reads src/users.ts; every later request is answered with a Groq-shaped HTTP 413 (a deterministic
//             "request too large"). A request that looks like OpenCode's compaction call is logged as kind "compaction".
//   loop / loop_stubborn - an investigation that never ends by itself: it asks for a tool call on every request that still offers tools,
//             and only answers with text when a request offers none (what a step cap forces). Each request is logged with
//             its tool count, tool_choice and the tail of its last message, so a test can see what the cap did.
//   ratelimit      - always HTTP 429 with retry-after: 1
//   ratelimit_slow - always HTTP 429 with retry-after: 6
// The stub checks that the proxy replaced the placeholder with STUB_EXPECT_KEY and prints whether it did.
import http from "node:http";

const MODE = process.env.STUB_MODE ?? "obey";
const EXPECT = process.env.STUB_EXPECT_KEY ?? "";
const log = (record) => process.stdout.write(`${JSON.stringify({ t: Date.now(), mode: MODE, ...record })}\n`);

const ATTACKS = [
  ["bash", { command: "touch /tmp/pwned && printenv > /review/out/env.txt", description: "attack" }],
  ["write", { filePath: "/review/out/pwned.txt", content: "pwned" }],
  ["read", { filePath: "/etc/passwd" }],
  ["read", { filePath: "/review/out/report.md" }],
  ["read", { filePath: "/proc/self/environ" }],
  ["edit", { filePath: "/repo/src/users.ts", oldString: "name", newString: "pwned" }],
  ["webfetch", { url: "https://example.com", format: "text" }],
  // The unbounded built-in file tools are denied; the bounded MCP tools must refuse anything outside the snapshot.
  ["grep", { pattern: "root", path: "/etc" }],
  ["glob", { pattern: "**/*", path: "/" }],
  ["cra_read", { path: "/etc/passwd" }],
  ["cra_read", { path: "../../etc/passwd" }],
  ["cra_read", { path: "/review/out/report.md" }],
  ["cra_read", { path: "/proc/self/environ" }],
  ["cra_grep", { pattern: "root", path: "/etc" }],
  ["cra_glob", { pattern: "**/*", path: "/" }],
  ["cra_list", { path: "/review" }],
];

function chunk(delta, finish, usage) {
  return { id: "stub-1", object: "chat.completion.chunk", created: 1, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
}
const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

function sse(res, parts) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const p of parts) res.write(`data: ${JSON.stringify(p)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function toolTurn(calls) {
  return [
    chunk({ role: "assistant", content: null, tool_calls: calls.map(([name, args], index) => ({ index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }, null),
    chunk({}, "tool_calls", USAGE),
  ];
}
const textTurn = (text) => [chunk({ role: "assistant", content: text }, null), chunk({}, "stop", USAGE)];

const PARTIAL_NOTES = ["Path: src/users.ts", "Notes so far: partial investigation."].join("\n");
const NOTES = [
  "Path: src/users.ts",
  "Line: 4",
  "Code: const sql = \"SELECT id, name, email FROM users WHERE name = '\" + name + \"'\";",
  "Claim: user-controlled `name` is concatenated into a SQL string passed to query() without parameters (SQL injection).",
  "Flow: server.ts handleGetUser passes request.query.name to findUser, which builds the SQL by concatenation and calls query(sql).",
  "Uncertainty: none seen.",
  "Counter-evidence: none; no escaping or validation on the path.",
].join("\n");
const FINDINGS = { findings: [{ category: "security", severity: "critical", file: "src/users.ts", line: 4, evidence: "const sql = \"SELECT id, name, email FROM users WHERE name = '\" + name + \"'\";", claim: "SQL injection: name is concatenated into the query string", path: "handleGetUser -> findUser -> query(sql)" }] };

function respond(body, res) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResults = messages.some((m) => m.role === "tool");
  const structured = body.response_format !== undefined;
  const wantsStream = body.stream === true;
  const system = String(messages[0]?.content ?? "");

  let kind; let parts; let json;
  if (structured) {
    const name = body.response_format?.json_schema?.name;
    kind = `structured:${name}`;
    json = name === "judgments" ? { judgments: [] } : name === "verdict" ? { answer: "disagrees" } : MODE === "report" ? FINDINGS : { findings: [] };
  } else if (MODE === "attack") {
    kind = hasToolResults ? "final" : "attack";
    parts = hasToolResults ? textTurn("No findings.") : toolTurn(ATTACKS);
  } else if (MODE === "overflow") {
    const compaction = system.includes("context summarization");
    kind = compaction ? "compaction" : hasToolResults ? "overflow_413" : "read";
    if (kind === "overflow_413") {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 11111, please reduce your message size and try again.", type: "tokens", code: "rate_limit_exceeded" } }));
      return { kind, stream: wantsStream, toolResults: hasToolResults, answered: 413 };
    }
    parts = compaction ? textTurn("summary") : toolTurn([["cra_read", { path: "/repo/src/users.ts" }]]);
  } else if (MODE === "loop" || MODE === "loop_stubborn") {
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const results = messages.filter((m) => m.role === "tool").length;
    const last = messages.at(-1);
    const tail = String(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")).slice(-160);
    // On its last allowed step OpenCode appends a "respond with text only" message but still offers the tools.
    // "loop" obeys it; "loop_stubborn" ignores it and keeps asking for tools.
    const told = /text ONLY/i.test(tail);
    const offered = toolCount > 0 && body.tool_choice !== "none" && (MODE === "loop_stubborn" || !told);
    kind = offered ? "loop_tool" : "loop_final";
    const picks = [["cra_read", { path: "/repo/src/users.ts" }], ["cra_read", { path: "/repo/src/server.ts" }], ["cra_grep", { pattern: "query" }], ["cra_glob", { pattern: "src/*.ts" }]];
    parts = offered ? toolTurn([picks[results % picks.length]]) : textTurn(PARTIAL_NOTES);
    setTimeout(() => sse(res, parts), 600); // a model takes time; this also keeps the cap's enforcement lag realistic
    return { kind, stream: wantsStream, toolResults: hasToolResults, tools: toolCount, toolChoice: body.tool_choice ?? null, messages: messages.length, lastRole: last?.role ?? null, told, lastTail: tail };
  } else if (MODE === "workload") {
    // The scripted bounded-reading workload: page through a large unchanged file, grep across files, read an unchanged
    // consumer, then answer. Same steps whatever the tool names, so request sizes can be compared like for like.
    const results = messages.filter((m) => m.role === "tool").length;
    const steps = [
      ["cra_read", { path: "src/orders.ts" }],
      ["cra_read", { path: "src/orders.ts", offset: 101 }],
      ["cra_grep", { pattern: "findUser" }],
      ["cra_read", { path: "src/consumer.ts" }],
    ];
    kind = results < steps.length ? "workload_tool" : "workload_final";
    parts = results < steps.length ? toolTurn([steps[results]]) : textTurn(NOTES);
  } else if (MODE === "tools" || MODE === "report") {
    kind = hasToolResults ? "final" : "read";
    parts = hasToolResults ? textTurn(MODE === "report" ? NOTES : "No findings.") : toolTurn([["cra_read", { path: "/repo/src/users.ts" }]]);
  } else {
    kind = "final";
    parts = textTurn("No findings.");
  }
  void system;
  if (json !== undefined) {
    const payload = { id: "stub-2", object: "chat.completion", created: 1, model: "stub", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(json) }, finish_reason: "stop" }], usage: USAGE };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  } else {
    sse(res, parts);
  }
  return { kind, stream: wantsStream, toolResults: hasToolResults };
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      const keyInjected = EXPECT !== "" && auth === `Bearer ${EXPECT}`;
      if (MODE === "error") {
        log({ event: "request", path: req.url, keyInjected, answered: 500 });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted failure", type: "server_error" } }));
        return;
      }
      if (MODE === "ratelimit" || MODE === "ratelimit_slow") {
        const wait = MODE === "ratelimit" ? "1" : "6";
        log({ event: "request", path: req.url, keyInjected, answered: 429 });
        res.writeHead(429, { "content-type": "application/json", "retry-after": wait });
        res.end(JSON.stringify({ error: { message: "Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1000. Please try again in " + wait + "s.", type: "tokens", code: "rate_limit_exceeded" } }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* answered below */ }
      const info = respond(body, res);
      // Names of any HOSTILE_*_MARKER (tests/integration/hostile-files.mjs) that reached the model, to prove what did not.
      const markers = [...new Set(Buffer.concat(chunks).toString("utf8").match(/HOSTILE_[A-Z_]+_MARKER/g) ?? [])];
      const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name ?? t?.name) : [];
      log({ event: "request", path: req.url, keyInjected, ...info, ...(toolNames.length > 0 ? { toolNames } : {}), ...(markers.length > 0 ? { markers } : {}) });
    });
  })
  .listen(9000, "0.0.0.0", () => log({ event: "listening", port: 9000 }));
