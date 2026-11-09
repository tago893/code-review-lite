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
  /** Hard run-wide deadline: when it passes, active work is cancelled and the review is incomplete. See REVIEW_DEADLINE_MINUTES. */
  readonly deadlineMs: number;
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
  /** Bytes of tool-result bodies kept in full in each model request; older ones become short references. 0 = off (default). See REVIEW_HISTORY_BUDGET_BYTES. */
  readonly historyBudgetBytes: number;
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

/** REVIEW_HISTORY_BUDGET_BYTES: 0 or unset = off. Otherwise 2000 to 500000 bytes of recent tool results kept in full per request. */
function historyBudget(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const message = "REVIEW_HISTORY_BUDGET_BYTES must be 0 (off) or an integer from 2000 to 500000";
  return parseOrThrow(z.string().regex(/^\d+$/, message).transform(Number).refine((n) => n === 0 || (n >= 2000 && n <= 500000), message), value.trim());
}

/** REVIEW_MAX_RETRIES: whole-attempt retries per model. 0 to 5, default 2. At 0 an unsuccessful investigation is not restarted and there is no model fallback. */
function maxRetries(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return MAX_RETRIES;
  return parseOrThrow(z.string().regex(/^\d+$/, "REVIEW_MAX_RETRIES must be an integer from 0 to 5").transform(Number).refine((n) => n <= 5, "REVIEW_MAX_RETRIES must be an integer from 0 to 5"), value.trim());
}

/** REVIEW_DEADLINE_MINUTES: hard run-wide deadline, 1 to 240 minutes. Default is the overall timeout (25 min x scale). */
function deadlineMs(value: string | undefined, fallbackMs: number): number {
  if (value === undefined || value.trim() === "") return fallbackMs;
  return MINUTE_MS * parseOrThrow(z.string().regex(/^\d+$/, "REVIEW_DEADLINE_MINUTES must be an integer from 1 to 240").transform(Number).refine((n) => n >= 1 && n <= 240, "REVIEW_DEADLINE_MINUTES must be an integer from 1 to 240"), value.trim());
}

/** Models to try, in order: primary then fallback. With no retries allowed there is no fallback either: one attempt. */
export function attemptModels(config: Pick<Config, "maxRetries" | "fallbackModel">, primary: string): readonly string[] {
  return config.maxRetries === 0 ? [primary] : [...new Set([primary, config.fallbackModel])];
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
    deadlineMs: deadlineMs(env["REVIEW_DEADLINE_MINUTES"], 25 * MINUTE_MS * scale),
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
    maxRetries: maxRetries(env["REVIEW_MAX_RETRIES"]),
    reviewerConcurrency: REVIEWER_CONCURRENCY,
    timeouts,
    session: Object.freeze({
      pollMs: 1000, requestTimeoutMs: 30_000, startGraceMs: 30_000, cleanupWaitMs: 10_000,
      maxProviderRetries: sessionRetries(env["REVIEW_SESSION_RETRIES"]), maxPollFailures: 2,
      maxInvestigationSteps: investigationSteps(env["REVIEW_INVESTIGATION_STEPS"]),
      historyBudgetBytes: historyBudget(env["REVIEW_HISTORY_BUDGET_BYTES"]),
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
