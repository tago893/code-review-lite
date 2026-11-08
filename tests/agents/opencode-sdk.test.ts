import { describe, expect, it } from "vitest";
import { INVESTIGATOR_PROMPT, TRUSTED_OPENCODE_ENV, boundedFetch } from "../../src/agents/opencode-sdk.js";
import { scrubProviderError } from "../../src/agents/scrub.js";
import { classifyError } from "../../src/resilience/errors.js";

// A fetch that never answers unless its signal fires, like a wedged local OpenCode server.
const hangs: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
  });

describe("boundedFetch (per-call transport timeout to the local OpenCode server)", () => {
  it("turns a hung call into a TransportTimeoutError that is retryable and is not a server error", async () => {
    const error = await boundedFetch(40, hangs)(new Request("http://127.0.0.1:1/x")).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "TransportTimeoutError" });
    expect(classifyError(error)).toMatchObject({ retryable: true, kind: "transport" });
    expect(classifyError(scrubProviderError(error))).toMatchObject({ retryable: true, kind: "transport" });
  });

  it("passes responses through untouched", async () => {
    const ok: typeof fetch = async () => new Response("hello", { status: 200 });
    const response = await boundedFetch(1000, ok)(new Request("http://127.0.0.1:1/x"));
    expect(await response.text()).toBe("hello");
  });

  it("does not relabel a caller's own abort as a timeout", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("attempt deadline"), { name: "TimeoutError" });
    const pending = boundedFetch(5000, hangs)(new Request("http://127.0.0.1:1/x", { signal: controller.signal })).catch((e: unknown) => e);
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });

  it("is set per call, so a slow attempt is never cut short by it", async () => {
    // Two sequential calls each shorter than the timeout succeed even though their total exceeds it.
    const slow: typeof fetch = async () => { await new Promise((r) => setTimeout(r, 30)); return new Response("ok"); };
    const f = boundedFetch(50, slow);
    await f(new Request("http://127.0.0.1:1/a"));
    await f(new Request("http://127.0.0.1:1/b"));
  });

  it("recognises the SDK's opaque 'network error (no response)' failure as transport once guarded", async () => {
    const opaque = new Error("opencode server GET http://x → : network error (no response)");
    expect(classifyError(opaque).retryable).toBe(false); // by itself it is unknown...
    // ...which is why the adapter marks it; the marker is what classifyError and scrubbing keep.
    expect(classifyError(Object.assign(opaque, { code: "CRA_TRANSPORT" }))).toMatchObject({ retryable: true, kind: "transport" });
  });
});

describe("TRUSTED_OPENCODE_ENV", () => {
  it("switches off project config and external skills, so a reviewed repository cannot configure the agent", () => {
    expect(TRUSTED_OPENCODE_ENV).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" });
    expect(Object.isFrozen(TRUSTED_OPENCODE_ENV)).toBe(true);
  });
});

describe("INVESTIGATOR_PROMPT", () => {
  it("is concise, static and states the read-only, untrusted-evidence and cra_* tool rules", () => {
    expect(Buffer.byteLength(INVESTIGATOR_PROMPT)).toBeLessThan(1200);
    expect(INVESTIGATOR_PROMPT).toMatch(/read-only/);
    expect(INVESTIGATOR_PROMPT).toMatch(/untrusted/);
    for (const tool of ["cra_glob", "cra_grep", "cra_list", "cra_read"]) expect(INVESTIGATOR_PROMPT).toContain(tool);
    expect(INVESTIGATOR_PROMPT).not.toContain("<shared_context>"); // the PR context stays in the user message
  });
});
