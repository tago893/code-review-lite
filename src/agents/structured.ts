import { scrubProviderError } from "./scrub.js";

/** JSON schema for Phase 2. Strict mode needs every property required and no extras. */
export const FINDINGS_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["code_quality", "security", "performance"] },
          severity: { type: "string", enum: ["critical", "warning", "suggestion"] },
          file: { type: "string" },
          line: { type: "integer" },
          evidence: { type: "string" },
          claim: { type: "string" },
          path: { type: "string" },
        },
        required: ["category", "severity", "file", "line", "evidence", "claim", "path"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
});

export interface StructuredRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly signal?: AbortSignal;
}

export interface StructuredResult {
  readonly content: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** False when the response carried no usage block. */
  readonly tokensKnown?: boolean;
}

/** A no-tools, schema-constrained model call. Tools cannot be combined with structured output, so this is separate. */
export type StructuredCall = (req: StructuredRequest) => Promise<StructuredResult>;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Calls the credential proxy's chat-completions endpoint with a strict json_schema and no tools. The Authorization
 * value is a placeholder: the proxy discards it and injects the real key, which this process never holds.
 * Non-2xx responses and malformed bodies become scrubbed errors; the response body is never put in an error.
 */
export function createStructuredCall(
  baseUrl: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
  schema: object = FINDINGS_SCHEMA,
  schemaName = "findings",
): StructuredCall {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async (req) => {
    try {
      const body = JSON.stringify({
        model: req.model,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      });
      const init = { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer proxy-placeholder" }, body };
      const response = await fetchFn(url, req.signal ? { ...init, signal: req.signal } : init);
      const text = await response.text();
      if (!response.ok) {
        throw Object.assign(new Error("provider returned an error status"), { status: response.status, headers: response.headers, message: text.slice(0, 500) });
      }
      return extract(text);
    } catch (error) {
      throw scrubProviderError(error);
    }
  };
}

function extract(text: string): StructuredResult {
  const parsed = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("malformed provider response");
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const reported = typeof parsed.usage?.prompt_tokens === "number" || typeof parsed.usage?.completion_tokens === "number";
  return { content, tokensIn: count(parsed.usage?.prompt_tokens), tokensOut: count(parsed.usage?.completion_tokens), tokensKnown: reported };
}
