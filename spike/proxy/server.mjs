// THROWAWAY spike: credential-injecting allow-list proxy for Groq.
// Holds the only copy of the key. Never logs headers or the key.
import http from "node:http";
import https from "node:https";

const KEY = process.env.GROQ_API_KEY;
if (!KEY) {
  console.error("FATAL: GROQ_API_KEY is missing");
  process.exit(1);
}

const UPSTREAM = "api.groq.com";
const ALLOW = [
  ["POST", "/openai/v1/chat/completions"],
  ["GET", "/openai/v1/models"],
];

const log = (obj) => console.log(JSON.stringify({ t: Date.now(), ...obj }));

http
  .createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const allowed = ALLOW.some(([m, p]) => m === req.method && p === path);
    log({
      event: "request",
      method: req.method,
      path,
      allowed,
      inbound_auth_discarded: Boolean(req.headers.authorization),
    });
    if (!allowed) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden by proxy allow-list");
      return;
    }
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers.host;
    headers.authorization = `Bearer ${KEY}`;
    headers.host = UPSTREAM;
    const up = https.request(
      { host: UPSTREAM, path: req.url, method: req.method, headers },
      (ur) => {
        log({ event: "upstream", path, status: ur.statusCode });
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on("error", (e) => {
      log({ event: "upstream_error", path, message: String(e.message) });
      res.writeHead(502);
      res.end("upstream error");
    });
    req.pipe(up);
  })
  .listen(8080, "0.0.0.0", () => log({ event: "listening", port: 8080 }));
