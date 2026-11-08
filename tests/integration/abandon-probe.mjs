// Runs INSIDE the agent container, against the real launchOpenCode and a provider that always answers 429
// (STUB_MODE=ratelimit_slow). It checks, by OpenCode's own session ids and state (never by request sizes), that:
//   - an attempt abandoned by its abort signal leaves no OpenCode session behind (not listed, not active),
//   - a replacement attempt never runs alongside the abandoned one,
//   - cleanup is reported in the trace,
//   - nothing is resurrected afterwards.
// Prints one JSON line per check and exits non-zero if any fails.
import { launchOpenCode } from "/opt/crl/dist/agents/opencode-sdk.js";
import { buildAgentPermissions } from "/opt/crl/dist/agents/permissions.js";
import { loadConfig } from "/opt/crl/dist/config.js";

const sdk = await import("file:///opt/crl/node_modules/@opencode-ai/sdk/dist/v2/index.js");
const config = loadConfig({ GROQ_BASE_URL: "http://proxy:8080/openai/v1", REVIEW_SESSION_RETRIES: "20" });
const t0 = Date.now();
const traces = [];
const say = (o) => console.log(JSON.stringify({ tSec: +((Date.now() - t0) / 1000).toFixed(1), ...o }));
let failures = 0;
const check = (name, ok, detail = {}) => { if (!ok) failures++; say({ check: name, ok, ...detail }); };

const explorer = await launchOpenCode({
  repoRoot: "/tmp", baseUrl: "http://proxy:8080/openai/v1", env: {}, permissions: buildAgentPermissions("/tmp"), lifecycle: config.session,
  onTrace: (e) => { traces.push(e); if (["attempt_session", "session_cleanup", "session_retry"].includes(e.name)) say({ trace: e.name, ...e.data }); },
});
const probe = sdk.createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" });
const sessions = async () => ((await probe.session.list({}, { throwOnError: true })).data ?? []).map((s) => s.id);
const active = async () => Object.keys((await probe.session.status({}, { throwOnError: true })).data ?? {});
const sessionOf = (attemptId) => traces.find((e) => e.name === "attempt_session" && e.data.attemptId === attemptId)?.data.sessionId;

const attempt = (no) =>
  explorer.explore({ model: "openai/gpt-oss-20b", prompt: "Say hi.", attemptId: `probe#${no}`, signal: AbortSignal.timeout(20_000) })
    .then(() => ({ ok: true }), (error) => ({ ok: false, name: error?.name }));

// --- attempt 1: runs into 429s, then is abandoned by its deadline ---
const first = await attempt(1);
const s1 = sessionOf("probe#1");
check("attempt 1 ended by its deadline (TimeoutError)", first.ok === false && first.name === "TimeoutError", { name: first.name });
check("attempt 1 had been retrying before the deadline (session_retry traced)", traces.some((e) => e.name === "session_retry" && e.data.attemptId === "probe#1"));
check("attempt 1's session is not listed immediately after the failure", !(await sessions()).includes(s1), { sessionId: s1 });
check("attempt 1's session is not active immediately after the failure", !(await active()).includes(s1));
const cleanup1 = traces.find((e) => e.name === "session_cleanup" && e.data.attemptId === "probe#1")?.data;
check("cleanup of attempt 1 is reported as abort ok, idle, delete ok", cleanup1?.abort === "ok" && cleanup1?.idle === true && cleanup1?.delete === "ok", cleanup1 ?? {});

// --- attempt 2: the replacement. It must never overlap the abandoned session. ---
let maxActive = 0; let sawOld = false;
const watcher = setInterval(async () => {
  try { const a = await active(); maxActive = Math.max(maxActive, a.length); if (a.includes(s1)) sawOld = true; } catch { /* sampling only */ }
}, 1000);
const second = await attempt(2);
clearInterval(watcher);
const s2 = sessionOf("probe#2");
check("attempt 2 used a different session", s2 !== undefined && s2 !== s1, { s1, s2 });
check("never more than one active session while the replacement ran", maxActive <= 1, { maxActive });
check("the abandoned session never reappeared while the replacement ran", !sawOld);
check("attempt 2 ended by its deadline and was cleaned up too", second.name === "TimeoutError" && !(await sessions()).includes(s2));

// --- afterwards: nothing is left running and nothing comes back ---
await new Promise((r) => setTimeout(r, 15_000));
check("no sessions exist 15 s after both attempts ended", (await sessions()).length === 0, { sessions: await sessions() });
check("no session is active 15 s after both attempts ended", (await active()).length === 0);

say({ summary: "ABANDON PROBE", failures });
await explorer.close();
process.exit(failures === 0 ? 0 : 1);
