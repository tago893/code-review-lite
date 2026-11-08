import { describe, expect, it } from "vitest";
import { scrubProviderError } from "../../src/agents/scrub.js";
import { loadConfig } from "../../src/config.js";

describe("scrubProviderError", () => {
  it("keeps an allow-listed OpenCode error name but never its message or data", () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const scrubbed = scrubProviderError({ name: "MessageAbortedError", message: `aborted ${secret}`, data: { message: secret } });
    expect(scrubbed).toMatchObject({ sdkName: "MessageAbortedError" });
    expect(JSON.stringify({ ...scrubbed, text: scrubbed.message })).not.toContain(secret);
  });

  it("drops an unknown error name", () => {
    expect(scrubProviderError({ name: "SomethingPrivateAboutAcmeCorp" })).not.toHaveProperty("sdkName");
  });
});

describe("REVIEW_TIMEOUT_SCALE", () => {
  const base = { GROQ_BASE_URL: "http://proxy:8080/openai/v1" };

  it("defaults to 1 and scales task and overall timeouts", () => {
    const one = loadConfig(base).timeouts;
    const three = loadConfig({ ...base, REVIEW_TIMEOUT_SCALE: "3" }).timeouts;
    expect(three.taskMs).toBe(one.taskMs * 3);
    expect(three.codeQualityTaskMs).toBe(one.codeQualityTaskMs * 3);
    expect(three.overallMs).toBe(one.overallMs * 3);
    expect(three.heartbeatMs).toBe(one.heartbeatMs);
  });

  it("rejects values outside 1 to 10", () => {
    for (const bad of ["0", "11", "-1", "abc", "1.5"]) expect(() => loadConfig({ ...base, REVIEW_TIMEOUT_SCALE: bad })).toThrow(/REVIEW_TIMEOUT_SCALE|Invalid/);
  });
});
