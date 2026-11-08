import type { Completion, Finding, FindingLevel } from "../types.js";

export type DropReason = "citation" | "refuted" | "invalid" | "judge";

export interface TokenCount {
  readonly input: number;
  readonly output: number;
}

/** Plain numbers and names only. No finding text ever enters metrics. */
export interface MetricsSnapshot {
  readonly findings: {
    readonly total: number;
    readonly byReviewer: Readonly<Record<string, number>>;
    readonly bySeverity: Readonly<Record<string, number>>;
    readonly byStatus: Readonly<Record<string, number>>;
  };
  readonly tokens: TokenCount & { readonly byAgent: Readonly<Record<string, TokenCount>> };
  /**
   * How trustworthy `tokens` is. A run whose provider reported no usage adds nothing to `tokens` (it is not a zero) and
   * is counted in `unreportedRuns`; usage from work that was cut short makes the total a lower bound.
   */
  readonly usage: { readonly unreportedRuns: number; readonly lowerBound: boolean };
  readonly costUsd: number;
  readonly drops: { readonly total: number; readonly byReason: Readonly<Record<string, number>> };
  readonly retries: number;
  readonly fallbacks: number;
  readonly durationMs?: number;
  readonly completion?: Completion;
}

export interface Metrics {
  recordFinding(finding: Pick<Finding, "reviewer" | "severity">, status: FindingLevel): Metrics;
  recordDrop(reason: DropReason): Metrics;
  /** `complete: false` marks the usage as a lower bound (the work was cut short). */
  recordTokens(agent: string, input: number, output: number, complete?: boolean): Metrics;
  /** A run that used the provider but reported no usage: its tokens are unknown, not zero. */
  recordUnreportedTokens(agent: string): Metrics;
  recordCost(usd: number): Metrics;
  recordRetry(): Metrics;
  recordFallback(): Metrics;
  recordDuration(ms: number): Metrics;
  recordCompletion(completion: Completion): Metrics;
  snapshot(): MetricsSnapshot;
}

const EMPTY: MetricsSnapshot = {
  findings: { total: 0, byReviewer: {}, bySeverity: {}, byStatus: {} },
  tokens: { input: 0, output: 0, byAgent: {} },
  usage: { unreportedRuns: 0, lowerBound: false },
  costUsd: 0,
  drops: { total: 0, byReason: {} },
  retries: 0,
  fallbacks: 0,
};

/** Immutable metrics: every record* returns a new Metrics and leaves the previous one unchanged. */
export function createMetrics(): Metrics {
  return wrap(deepFreeze(EMPTY));
}

const bump = (counts: Readonly<Record<string, number>>, key: string): Record<string, number> => ({ ...counts, [key]: (counts[key] ?? 0) + 1 });
const valid = (n: number): boolean => Number.isFinite(n) && n >= 0;

function wrap(s: MetricsSnapshot): Metrics {
  const next = (patch: Partial<MetricsSnapshot>): Metrics => wrap(deepFreeze({ ...s, ...patch }));
  const metrics: Metrics = {
    recordFinding: (finding, status) =>
      next({
        findings: {
          total: s.findings.total + 1,
          byReviewer: bump(s.findings.byReviewer, finding.reviewer),
          bySeverity: bump(s.findings.bySeverity, finding.severity),
          byStatus: bump(s.findings.byStatus, status),
        },
      }),
    recordDrop: (reason) => next({ drops: { total: s.drops.total + 1, byReason: bump(s.drops.byReason, reason) } }),
    recordTokens: (agent, input, output, complete = true) => {
      const i = valid(input) ? input : 0;
      const o = valid(output) ? output : 0;
      const prior = s.tokens.byAgent[agent] ?? { input: 0, output: 0 };
      return next({
        tokens: {
          input: s.tokens.input + i,
          output: s.tokens.output + o,
          byAgent: { ...s.tokens.byAgent, [agent]: { input: prior.input + i, output: prior.output + o } },
        },
        usage: { ...s.usage, lowerBound: s.usage.lowerBound || !complete },
      });
    },
    recordUnreportedTokens: () => next({ usage: { unreportedRuns: s.usage.unreportedRuns + 1, lowerBound: true } }),
    recordCost: (usd) => next({ costUsd: s.costUsd + (valid(usd) ? usd : 0) }),
    recordRetry: () => next({ retries: s.retries + 1 }),
    recordFallback: () => next({ fallbacks: s.fallbacks + 1 }),
    recordDuration: (ms) => (valid(ms) ? next({ durationMs: ms }) : wrap(s)),
    recordCompletion: (completion) => next({ completion }),
    snapshot: () => s,
  };
  return Object.freeze(metrics);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
