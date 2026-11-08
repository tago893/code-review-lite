import { z } from "zod";

// Model IDs were exercised in the Task 0 spike (spike/NOTES.md). The final reviewer/coordinator split is
// still open, so every one of them is overridable by env.
const DEFAULT_REVIEWER_MODEL = "openai/gpt-oss-20b";
const DEFAULT_COORDINATOR_MODEL = "openai/gpt-oss-120b";
const DEFAULT_VERIFIER_MODEL = "openai/gpt-oss-120b";
const DEFAULT_FALLBACK_MODEL = "openai/gpt-oss-120b";
const DEFAULT_PROXY_PORT = 8080;
// Groq's base plan allows ~8,000 tokens/minute, so retries are bounded and reviewers run one at a time.
const MAX_RETRIES = 2;
const REVIEWER_CONCURRENCY = 1;
const MINUTE_MS = 60_000;

export type Env = Readonly<Record<string, string | undefined>>;

export interface Timeouts {
  readonly taskMs: number;
  readonly codeQualityTaskMs: number;
  readonly overallMs: number;
  readonly inactivityMs: number;
  readonly heartbeatMs: number;
  /** How long an aborted attempt may take to cancel and delete its OpenCode session before the run stops waiting. */
  readonly abortGraceMs: number;
}

/** How one OpenCode session is driven. None of these scale with REVIEW_TIMEOUT_SCALE: they are not attempt deadlines. */
export interface SessionLifecycle {
  /** Interval between status polls. */
  readonly pollMs: number;
  /** Timeout of each individual HTTP call to the local OpenCode server (not of the attempt). */
  readonly requestTimeoutMs: number;
  readonly startGraceMs: number;
  readonly cleanupWaitMs: number;
  /** OpenCode retries a failing provider call by itself; past this many retries the attempt is ended. */
  readonly maxProviderRetries: number;
  readonly maxPollFailures: number;
  /** Most agent steps (model calls) one reviewer investigation may take. See REVIEW_INVESTIGATION_STEPS. */
  readonly maxInvestigationSteps: number;
}

/** Agent-side config. It never holds the real Groq key: `groqBaseUrl` points at the credential proxy. */
export interface Config {
  readonly groqBaseUrl: string;
  readonly reviewerModel: string;
  readonly coordinatorModel: string;
  readonly verifierModel: string;
  readonly fallbackModel: string;
  readonly maxRetries: number;
  readonly reviewerConcurrency: number;
  readonly timeouts: Timeouts;
  readonly session: SessionLifecycle;
}

/** Proxy-side config. Holds the real key, so log or serialise only `toSafeView(...)` of it. */
export interface ProxyConfig {
  readonly groqApiKey: string;
  readonly port: number;
}

export interface SafeProxyConfig {
  readonly groqApiKey: "[redacted]";
  readonly port: number;
}

const nonEmpty = (name: string) =>
  z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);

const baseUrlSchema = nonEmpty("GROQ_BASE_URL").refine(isHttpUrl, "GROQ_BASE_URL must be an http(s) URL");

const portSchema = z
  .string()
  .regex(/^\d+$/, "PORT must be an integer from 1 to 65535")
  .transform(Number)
  .refine((port) => port >= 1 && port <= 65535, "PORT must be an integer from 1 to 65535");

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}

function modelFromEnv(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

/** Multiplies the task and overall timeouts, for a provider tier with a low tokens-per-minute limit. 1 to 10; anything else is an error. */
function timeoutScale(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  return parseOrThrow(z.string().regex(/^\d+$/).transform(Number).refine((n) => n >= 1 && n <= 10, "REVIEW_TIMEOUT_SCALE must be an integer from 1 to 10"), value.trim());
}

/** REVIEW_SESSION_RETRIES: how many times OpenCode may retry a failing provider call within one attempt. 1 to 20, default 5. */
function investigationSteps(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 10;
  return parseOrThrow(z.string().regex(/^\d+$/).transform(Number).refine((n) => n >= 1 && n <= 50, "REVIEW_INVESTIGATION_STEPS must be an integer from 1 to 50"), value.trim());
}

function sessionRetries(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 5;
  return parseOrThrow(z.string().regex(/^\d+$/).transform(Number).refine((n) => n >= 1 && n <= 20, "REVIEW_SESSION_RETRIES must be an integer from 1 to 20"), value.trim());
}

export function loadConfig(env: Env): Config {
  // Presence alone is a failure, even when empty: the agent container must never be given the key.
  if (env["GROQ_API_KEY"] !== undefined) {
    throw new Error("GROQ_API_KEY must not be set in the agent environment; only the credential proxy holds it");
  }
  const groqBaseUrl = parseOrThrow(baseUrlSchema, env["GROQ_BASE_URL"]);
  const scale = timeoutScale(env["REVIEW_TIMEOUT_SCALE"]);
  const timeouts: Timeouts = Object.freeze({
    taskMs: 5 * MINUTE_MS * scale,
    codeQualityTaskMs: 10 * MINUTE_MS * scale,
    overallMs: 25 * MINUTE_MS * scale,
    inactivityMs: MINUTE_MS,
    heartbeatMs: MINUTE_MS / 2,
    abortGraceMs: MINUTE_MS,
  });
  return Object.freeze({
    groqBaseUrl,
    reviewerModel: modelFromEnv(env, "REVIEWER_MODEL", DEFAULT_REVIEWER_MODEL),
    coordinatorModel: modelFromEnv(env, "COORDINATOR_MODEL", DEFAULT_COORDINATOR_MODEL),
    verifierModel: modelFromEnv(env, "VERIFIER_MODEL", DEFAULT_VERIFIER_MODEL),
    fallbackModel: modelFromEnv(env, "FALLBACK_MODEL", DEFAULT_FALLBACK_MODEL),
    maxRetries: MAX_RETRIES,
    reviewerConcurrency: REVIEWER_CONCURRENCY,
    timeouts,
    session: Object.freeze({
      pollMs: 1000, requestTimeoutMs: 30_000, startGraceMs: 30_000, cleanupWaitMs: 10_000,
      maxProviderRetries: sessionRetries(env["REVIEW_SESSION_RETRIES"]), maxPollFailures: 2,
      maxInvestigationSteps: investigationSteps(env["REVIEW_INVESTIGATION_STEPS"]),
    }),
  });
}

export function loadProxyConfig(env: Env): ProxyConfig {
  const groqApiKey = parseOrThrow(nonEmpty("GROQ_API_KEY"), env["GROQ_API_KEY"]);
  const rawPort = env["PORT"]?.trim();
  const port = rawPort ? parseOrThrow(portSchema, rawPort) : DEFAULT_PROXY_PORT;
  return Object.freeze({ groqApiKey, port });
}

export function toSafeView(config: ProxyConfig): SafeProxyConfig {
  return Object.freeze({ groqApiKey: "[redacted]" as const, port: config.port });
}
