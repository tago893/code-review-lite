// Credential-injecting, allow-listing proxy for the model provider. It holds the only copy of the key.
// - The key comes from the environment by name; it is never written to a file or a log.
// - Inbound Authorization headers are discarded; the real one is added on the way out.
// - Only the listed method/path pairs are forwarded, and only to the one configured upstream host.
// - Logs are metadata only (method, path, status, sizes, timings, whether the body had tools / a response_format).
//   Every request gets an opaque id (rid) shared by its request, upstream and response_end events. Provider rate-limit
//   headers and the numbers in a 4xx error (limit window, limit, used, requested) are logged after strict validation;
//   provider error text, request bodies and the key never are.
// - A hard budget on outbound provider requests per proxy lifetime (one review run): PROXY_MAX_REQUESTS. Every request
//   forwarded upstream counts, including each retry OpenCode makes on its own. When the budget is spent the proxy
//   answers 403 with the error code "request_budget_exhausted" and forwards nothing. 403 is not retried by OpenCode and
//   does not look like a context overflow, so it can neither loop nor trigger compaction.
//   PROXY_REQUIRE_HISTORY=1 (set when the review is configured to prune tool-result history): a tool-enabled request must
//   carry the header x-cra-history, which CRA's history plugin adds only after pruning succeeded for that very request.
//   Without it the proxy answers 403 "history_pruning_inactive" and forwards nothing, so a missing, unloaded, crashed or
//   bypassed plugin cannot send an unpruned conversation. PROXY_MAX_REQUEST_BYTES is an independent backstop: a
//   tool-enabled request body above it gets the same refusal. Neither refusal counts against the request budget.
//   With PROXY_LOG_BODIES=1 (tests only) request bodies are also appended to /logs/requests.jsonl so a test can
//   check exactly what reached the model. Never enable that for real repositories.
import http from "node:http";
import https from "node:https";
import { appendFileSync } from "node:fs";

const fatal = (message) => {
  process.stderr.write(`FATAL: ${message}\n`);
  process.exit(1);
};

const KEY = process.env.GROQ_API_KEY;
if (!KEY) fatal("GROQ_API_KEY is missing");

// Fail closed: the proxy never picks an upstream or a mode for itself.
//   PROXY_MODE=stub  a scripted test provider: the key must be the recognisable dummy and the upstream must not be Groq.
//   PROXY_MODE=live  the real provider: needs PROXY_ALLOW_LIVE=1, the real host over https, and a non-dummy key.
const STUB_KEY_PREFIX = "gsk_STUBKEY";
const LIVE_HOST = "api.groq.com";
if (!process.env.UPSTREAM_URL) fatal("UPSTREAM_URL is required (there is no default upstream)");
let upstream;
try { upstream = new URL(process.env.UPSTREAM_URL); } catch { fatal("UPSTREAM_URL is not a valid URL"); }
const MODE = process.env.PROXY_MODE;
if (MODE === "stub") {
  if (!KEY.startsWith(STUB_KEY_PREFIX)) fatal("stub mode accepts only the dummy test key; a real credential was refused");
  if (upstream.hostname === LIVE_HOST || upstream.hostname.endsWith(".groq.com")) fatal("stub mode must not point at the real provider");
} else if (MODE === "live") {
  if (process.env.PROXY_ALLOW_LIVE !== "1") fatal("live mode needs explicit authorization (PROXY_ALLOW_LIVE=1)");
  if (KEY.startsWith(STUB_KEY_PREFIX)) fatal("live mode refuses the dummy test key");
  if (upstream.protocol !== "https:" || upstream.hostname !== LIVE_HOST) fatal(`live mode only talks to https://${LIVE_HOST}`);
} else {
  fatal("PROXY_MODE must be stub or live");
}
const transport = upstream.protocol === "http:" ? http : https;
const LOG_BODIES = process.env.PROXY_LOG_BODIES === "1";
const BODY_LOG = "/logs/requests.jsonl";
const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 8080);
const DEFAULT_MAX_REQUESTS = 200;
const MAX_REQUESTS = parseBudget(process.env.PROXY_MAX_REQUESTS);
const budget = { used: 0, denied: 0 };
const REQUIRE_HISTORY = process.env.PROXY_REQUIRE_HISTORY === "1";
const MAX_REQUEST_BYTES = parseCeiling(process.env.PROXY_MAX_REQUEST_BYTES);
const HISTORY_HEADER = "x-cra-history";
const HISTORY_STAMP = /^[1-9]\d{0,6}$/;
const MAX_ERROR_CAPTURE = 8192;
const MAX_BODY = 1_000_000;
const ALLOW = [
  ["POST", "/openai/v1/chat/completions"],
  ["GET", "/openai/v1/models"],
];

function parseBudget(raw) {
  if (raw === undefined || raw === "") return DEFAULT_MAX_REQUESTS;
  if (!/^[1-9]\d{0,6}$/.test(raw)) {
    process.stderr.write("FATAL: PROXY_MAX_REQUESTS must be a positive integer\n");
    process.exit(1);
  }
  return Number(raw);
}

function parseCeiling(raw) {
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9]\d{3,8}$/.test(raw)) {
    process.stderr.write("FATAL: PROXY_MAX_REQUEST_BYTES must be an integer of at least 1000\n");
    process.exit(1);
  }
  return Number(raw);
}

/** Why a tool-enabled request must not be forwarded, or undefined. Pure: only the summary, the stamp header and the size. */
function historyRefusal(summary, stamp, bytes) {
  if (!summary.has_tools) return undefined;
  if (REQUIRE_HISTORY && !(typeof stamp === "string" && HISTORY_STAMP.test(stamp))) return "unstamped";
  if (MAX_REQUEST_BYTES !== undefined && bytes > MAX_REQUEST_BYTES) return "over_ceiling";
  return undefined;
}

let counter = 0;
const nextRid = () => `r${(++counter).toString(16)}`;

// Only values that look like plain durations or counts are logged; anything else is dropped, never echoed.
const DURATION_OR_COUNT = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h)?)+$/;
const RATE_HEADERS = {
  "x-ratelimit-limit-requests": "limitRequests", "x-ratelimit-limit-tokens": "limitTokens",
  "x-ratelimit-remaining-requests": "remainingRequests", "x-ratelimit-remaining-tokens": "remainingTokens",
  "x-ratelimit-reset-requests": "resetRequests", "x-ratelimit-reset-tokens": "resetTokens",
};
function safeValue(value) {
  return typeof value === "string" && value.length <= 24 && DURATION_OR_COUNT.test(value.trim()) ? value.trim() : undefined;
}
function rateLimitOf(headers) {
  const out = {};
  for (const [header, key] of Object.entries(RATE_HEADERS)) {
    const value = safeValue(headers[header]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Fixed-vocabulary facts from a 4xx error body: the error type/code and the limit window and numbers. Never the text. */
function providerErrorFacts(buffer) {
  const facts = {};
  try {
    const error = JSON.parse(buffer.toString("utf8")).error ?? {};
    const word = /^[a-z_]{1,40}$/;
    if (typeof error.type === "string" && word.test(error.type)) facts.errorType = error.type;
    if (typeof error.code === "string" && word.test(error.code)) facts.errorCode = error.code;
    const message = typeof error.message === "string" ? error.message : "";
    const window = /\((TPM|TPD|RPM|RPD)\)/.exec(message);
    if (window) facts.window = window[1];
    for (const [key, label] of [["limit", "Limit"], ["used", "Used"], ["requested", "Requested"]]) {
      const match = new RegExp(label + " (\\d{1,9})\\b").exec(message);
      if (match) facts[key] = Number(match[1]);
    }
  } catch { /* an unparsable body simply yields no facts */ }
  return facts;
}

const log = (record) => process.stdout.write(`${JSON.stringify({ t: Date.now(), ...record })}\n`);

function describeBody(buffer) {
  try {
    const body = JSON.parse(buffer.toString("utf8"));
    return {
      model: typeof body.model === "string" ? body.model : null,
      has_tools: Array.isArray(body.tools) && body.tools.length > 0,
      tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
      has_response_format: body.response_format !== undefined,
      messages: Array.isArray(body.messages) ? body.messages.length : 0,
    };
  } catch {
    return { unparsable: true };
  }
}

http
  .createServer((req, res) => {
    const rid = nextRid();
    const t0 = Date.now();
    const path = (req.url ?? "").split("?")[0];
    const allowed = ALLOW.some(([m, p]) => m === req.method && p === path);
    if (!allowed) {
      log({ event: "denied", rid, method: req.method, path });
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden by proxy allow-list");
      return;
    }

    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY) {
        log({ event: "denied", rid, method: req.method, path, reason: "body_too_large" });
        res.writeHead(413);
        res.end("request too large");
        return;
      }
      const body = Buffer.concat(chunks);
      const summary = req.method === "POST" ? describeBody(body) : {};
      const refusal = req.method === "POST" ? historyRefusal(summary, req.headers[HISTORY_HEADER], body.length) : undefined;
      if (refusal) {
        log({ event: "history_denied", rid, method: req.method, path, reason: refusal, bytes: body.length, ceiling: MAX_REQUEST_BYTES ?? null, ...summary });
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "cra_history", code: "history_pruning_inactive", message: "CRA requires pruned tool-result history for this request" } }));
        return;
      }
      // The check and the increment run in one synchronous step, so concurrent requests cannot overshoot the budget.
      if (budget.used >= MAX_REQUESTS) {
        budget.denied += 1;
        log({ event: "budget_exhausted", rid, method: req.method, path, used: budget.used, max: MAX_REQUESTS, denied: budget.denied });
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "cra_budget", code: "request_budget_exhausted", message: "CRA provider request budget exhausted" } }));
        return;
      }
      budget.used += 1;
      log({ event: "request", rid, method: req.method, path, budgetUsed: budget.used, budgetMax: MAX_REQUESTS, bytes: body.length, inbound_auth_discarded: Boolean(req.headers.authorization), history_stamp: typeof req.headers[HISTORY_HEADER] === "string", ...summary });
      if (LOG_BODIES && req.method === "POST") {
        try { appendFileSync(BODY_LOG, `${JSON.stringify({ t: Date.now(), path, ...summary, body: body.toString("utf8") })}\n`); } catch { /* test aid only */ }
      }

      const headers = { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${KEY}`, host: upstream.host, "content-length": String(body.length) };
      const out = transport.request({ hostname: upstream.hostname, port: upstream.port || undefined, path: req.url, method: req.method, headers }, (ur) => {
        const status = ur.statusCode ?? 502;
        const retryAfter = safeValue(ur.headers["retry-after"]);
        const rateLimit = rateLimitOf(ur.headers);
        log({ event: "upstream", rid, path, status, ttfbMs: Date.now() - t0, ...(retryAfter ? { retryAfter } : {}), ...(rateLimit ? { rateLimit } : {}) });
        let bytes = 0;
        const kept = [];
        let keptBytes = 0;
        ur.on("data", (chunk) => {
          bytes += chunk.length;
          if (status >= 400 && keptBytes < MAX_ERROR_CAPTURE) { kept.push(chunk); keptBytes += chunk.length; }
        });
        ur.on("end", () => {
          if (status >= 400) log({ event: "provider_error", rid, status, ...providerErrorFacts(Buffer.concat(kept)) });
          log({ event: "response_end", rid, status, bytes, totalMs: Date.now() - t0 });
        });
        const passHeaders = {};
        for (const name of ["content-type", "retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) if (ur.headers[name]) passHeaders[name] = ur.headers[name];
        res.writeHead(ur.statusCode ?? 502, passHeaders);
        ur.pipe(res);
      });
      out.on("error", (error) => {
        log({ event: "upstream_error", rid, path, code: error.code ?? "unknown", totalMs: Date.now() - t0 });
        res.writeHead(502);
        res.end("upstream error");
      });
      out.end(body);
    });
  })
  .listen(LISTEN_PORT, "0.0.0.0", () => log({ event: "listening", port: LISTEN_PORT, upstream_host: upstream.host, log_bodies: LOG_BODIES, budget_max: MAX_REQUESTS, require_history: REQUIRE_HISTORY, max_request_bytes: MAX_REQUEST_BYTES ?? null }));
