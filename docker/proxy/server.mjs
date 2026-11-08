// Credential-injecting, allow-listing proxy for the model provider. It holds the only copy of the key.
// - The key comes from the environment by name; it is never written to a file or a log.
// - Inbound Authorization headers are discarded; the real one is added on the way out.
// - Only the listed method/path pairs are forwarded, and only to the one configured upstream host.
// - Logs are metadata only (method, path, status, sizes, whether the body had tools / a response_format).
//   With PROXY_LOG_BODIES=1 (tests only) request bodies are also appended to /logs/requests.jsonl so a test can
//   check exactly what reached the model. Never enable that for real repositories.
import http from "node:http";
import https from "node:https";
import { appendFileSync } from "node:fs";

const KEY = process.env.GROQ_API_KEY;
if (!KEY) {
  process.stderr.write("FATAL: GROQ_API_KEY is missing\n");
  process.exit(1);
}

const upstream = new URL(process.env.UPSTREAM_URL ?? "https://api.groq.com");
const transport = upstream.protocol === "http:" ? http : https;
const LOG_BODIES = process.env.PROXY_LOG_BODIES === "1";
const BODY_LOG = "/logs/requests.jsonl";
const MAX_BODY = 1_000_000;
const ALLOW = [
  ["POST", "/openai/v1/chat/completions"],
  ["GET", "/openai/v1/models"],
];

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
    const path = (req.url ?? "").split("?")[0];
    const allowed = ALLOW.some(([m, p]) => m === req.method && p === path);
    if (!allowed) {
      log({ event: "denied", method: req.method, path });
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
        log({ event: "denied", method: req.method, path, reason: "body_too_large" });
        res.writeHead(413);
        res.end("request too large");
        return;
      }
      const body = Buffer.concat(chunks);
      const summary = req.method === "POST" ? describeBody(body) : {};
      log({ event: "request", method: req.method, path, bytes: body.length, inbound_auth_discarded: Boolean(req.headers.authorization), ...summary });
      if (LOG_BODIES && req.method === "POST") {
        try { appendFileSync(BODY_LOG, `${JSON.stringify({ t: Date.now(), path, ...summary, body: body.toString("utf8") })}\n`); } catch { /* test aid only */ }
      }

      const headers = { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${KEY}`, host: upstream.host, "content-length": String(body.length) };
      const out = transport.request({ hostname: upstream.hostname, port: upstream.port || undefined, path: req.url, method: req.method, headers }, (ur) => {
        log({ event: "upstream", path, status: ur.statusCode });
        const passHeaders = {};
        for (const name of ["content-type", "retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) if (ur.headers[name]) passHeaders[name] = ur.headers[name];
        res.writeHead(ur.statusCode ?? 502, passHeaders);
        ur.pipe(res);
      });
      out.on("error", (error) => {
        log({ event: "upstream_error", path, code: error.code ?? "unknown" });
        res.writeHead(502);
        res.end("upstream error");
      });
      out.end(body);
    });
  })
  .listen(8080, "0.0.0.0", () => log({ event: "listening", port: 8080, upstream_host: upstream.host, log_bodies: LOG_BODIES }));
