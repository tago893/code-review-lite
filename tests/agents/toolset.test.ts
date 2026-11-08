import { describe, expect, it } from "vitest";
import { APPROVED_TOOL_IDS } from "../../src/mcp/ids.js";
import { classifyError } from "../../src/resilience/errors.js";
import { scrubProviderError } from "../../src/agents/scrub.js";
import { KNOWN_BUILTIN_TOOL_IDS, ToolsetVerificationError, verifyToolset, type ToolsetApi } from "../../src/agents/toolset.js";

const timing = { waitMs: 1000, pollMs: 250 };
const noSleep = async (): Promise<void> => undefined;
const allIds = [...KNOWN_BUILTIN_TOOL_IDS, ...APPROVED_TOOL_IDS];

function api(overrides: Partial<ToolsetApi> = {}): ToolsetApi {
  return { mcpStatus: async () => ({ cra: { status: "connected" } }), toolIds: async () => allIds, ...overrides };
}

describe("verifyToolset", () => {
  it("passes when cra is connected and only built-ins plus the four approved tools exist", async () => {
    await expect(verifyToolset(api(), timing, noSleep)).resolves.toBeUndefined();
  });

  it("waits for a connection that is still starting", async () => {
    let calls = 0;
    const slow = api({ mcpStatus: async () => ({ cra: { status: ++calls < 3 ? "pending" : "connected" } }) });
    await expect(verifyToolset(slow, timing, noSleep)).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it.each([
    ["failed", { cra: { status: "failed" } }, "mcp_server_failed"],
    ["absent", {}, "mcp_server_absent"],
    ["never connects", { cra: { status: "pending" } }, "mcp_server_pending"],
    ["extra server", { cra: { status: "connected" }, evil: { status: "connected" } }, "unexpected_mcp_server"],
  ])("rejects %s", async (_label, status, reason) => {
    await expect(verifyToolset(api({ mcpStatus: async () => status }), timing, noSleep)).rejects.toThrow(reason);
  });

  it("rejects an unknown extra tool and an unreadable tool list", async () => {
    await expect(verifyToolset(api({ toolIds: async () => [...allIds, "evil_tool"] }), timing, noSleep)).rejects.toThrow("unexpected_tool_registered");
    await expect(verifyToolset(api({ toolIds: async () => { throw new Error("boom"); } }), timing, noSleep)).rejects.toThrow("tool_list_unavailable");
  });

  it("treats an unreachable status endpoint as an absent server", async () => {
    await expect(verifyToolset(api({ mcpStatus: async () => { throw new Error("down"); } }), timing, noSleep)).rejects.toThrow("mcp_server_absent");
  });
});

describe("tooling errors", () => {
  it("are classified as non-retryable tooling failures and survive scrubbing", () => {
    const error = new ToolsetVerificationError("mcp_server_failed");
    expect(classifyError(error)).toMatchObject({ kind: "tooling", retryable: false });
    const scrubbed = scrubProviderError(error);
    expect(classifyError(scrubbed)).toMatchObject({ kind: "tooling", retryable: false });
  });
});

describe("budget errors", () => {
  const apiError = (status: number, body: string) => ({ name: "APIError", data: { statusCode: status, message: "x", responseBody: body, isRetryable: false } });

  it("recognises the proxy's budget refusal, and only a 403 that carries its code", () => {
    const body = JSON.stringify({ error: { code: "request_budget_exhausted" } });
    expect(classifyError(apiError(403, body))).toMatchObject({ kind: "budget", retryable: false });
    expect(classifyError(apiError(403, "{}"))).toMatchObject({ kind: "auth" });
    expect(classifyError(apiError(429, body))).toMatchObject({ kind: "rate_limit" });
  });

  it("survives scrubbing as a budget failure", () => {
    const scrubbed = scrubProviderError(apiError(403, "request_budget_exhausted"));
    expect(classifyError(scrubbed)).toMatchObject({ kind: "budget", retryable: false });
  });
});
