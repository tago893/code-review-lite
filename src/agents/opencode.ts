import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gateForModel } from "../workspace/gate.js";
import { sanitizeEnv } from "../safety/sanitize.js";
import type { Config, SessionLifecycle } from "../config.js";
import { buildAgentPermissions, type AgentPermissions } from "./permissions.js";
import { ReviewerSecurityError, type ReviewerRequest, type ReviewerRunner, type RunnerResult, type SecurityStage } from "./runner.js";
import { scrubProviderError } from "./scrub.js";
import type { TraceEvent } from "./session-driver.js";
import { createStructuredCall, type StructuredCall } from "./structured.js";

/** A tool-enabled OpenCode session working in the sanitised snapshot (Phase 1). */
export interface ExploreSession {
  explore(input: { model: string; prompt: string; attemptId: string; signal?: AbortSignal }): Promise<{ text: string; tokensIn: number; tokensOut: number; tokensKnown: boolean }>;
  close(): Promise<void>;
}

export type { TraceEvent };

export interface LaunchOptions {
  readonly repoRoot: string;
  readonly baseUrl: string;
  /** Already stripped of credentials. */
  readonly env: NodeJS.ProcessEnv;
  readonly permissions: AgentPermissions;
  /** How sessions are driven: polling, per-request transport timeout, cleanup waits and the provider retry budget. */
  readonly lifecycle: SessionLifecycle;
  /** Sanitised diagnostics, emitted as they happen (tool calls, retries, compaction, cleanup), including for failed attempts. */
  readonly onTrace?: (event: TraceEvent) => void;
}

export type OpenCodeLauncher = (options: LaunchOptions) => Promise<ExploreSession>;

export interface SessionDeps {
  readonly config: Config;
  readonly launcher: OpenCodeLauncher;
  /** The parent environment. It is sanitised before anything is launched. */
  readonly env?: NodeJS.ProcessEnv;
  readonly onTrace?: (event: TraceEvent) => void;
}

export interface OpenCodeRunnerDeps extends SessionDeps {
  readonly structured?: StructuredCall;
  /** Share one OpenCode server between reviewers and the coordinator. Created from the launcher when omitted. */
  readonly sessions?: SessionProvider;
}

/** Returns the one OpenCode explore session for a workspace, launching it on first use. */
export type SessionProvider = (repoRoot: string) => Promise<ExploreSession>;

export function createSessionProvider(deps: SessionDeps): SessionProvider {
  const env = sanitizeEnv(deps.env ?? process.env);
  let session: Promise<ExploreSession> | undefined;
  return (repoRoot) => {
    session ??= deps.launcher({ repoRoot, baseUrl: deps.config.groqBaseUrl, env, permissions: buildAgentPermissions(repoRoot), lifecycle: deps.config.session, ...(deps.onTrace ? { onTrace: deps.onTrace } : {}) });
    return session;
  };
}

const PHASE2_HEADING = /^## Phase 2\b.*$/m;
const NO_FINDINGS = "No findings.";
const EMPTY_FINDINGS = '{"findings":[]}';

/**
 * The OpenCode-backed ReviewerRunner. Phase 1 is a tool-enabled session over the sanitised read-only snapshot that
 * writes plain-text notes; Phase 2 is a separate no-tools structured call that may only restate those notes.
 * Text crosses to a model only through gateForModel: the shared context before Phase 1, and the Phase 1 notes
 * before Phase 2. If either cannot be sanitised the run fails with ReviewerSecurityError and nothing is sent.
 * Provider and SDK errors are scrubbed before they leave this module.
 */
export function createOpenCodeRunner(deps: OpenCodeRunnerDeps): ReviewerRunner {
  const structured = deps.structured ?? createStructuredCall(deps.config.groqBaseUrl);
  const sessionFor = deps.sessions ?? createSessionProvider(deps);

  return {
    async run(req: ReviewerRequest): Promise<RunnerResult> {
      const prompts = await loadPrompts(req);
      const context = gate("phase1_context", await readFile(req.sharedContextPath, "utf8"));

      const explorer = await sessionFor(req.repoRoot).catch((error: unknown) => { throw scrubProviderError(error); });
      const phase1 = await explorer
        .explore({ model: req.model, prompt: buildPhase1(prompts, context, req), attemptId: req.attemptId ?? `${req.category}#1`, ...(req.signal ? { signal: req.signal } : {}) })
        .catch((error: unknown) => { throw scrubProviderError(error); });

      const notes = gate("phase2_notes", phase1.text).trim();
      if (notes.length === 0) throw Object.assign(new Error("provider_unknown"), { name: "ProviderError" }); // empty notes: a failure, not "no findings"
      if (notes === NO_FINDINGS) return { raw: EMPTY_FINDINGS, tokensIn: phase1.tokensIn, tokensOut: phase1.tokensOut, tokensKnown: phase1.tokensKnown };

      const phase2 = await structured({ model: req.model, system: prompts.phase2, user: notes, ...(req.signal ? { signal: req.signal } : {}) })
        .catch((error: unknown) => { throw keepPhase1Usage(error, phase1); });
      return {
        raw: phase2.content, tokensIn: phase1.tokensIn + phase2.tokensIn, tokensOut: phase1.tokensOut + phase2.tokensOut,
        tokensKnown: phase1.tokensKnown && phase2.tokensKnown !== false,
      };
    },
  };
}

/** A Phase 2 failure must not lose the tokens Phase 1 already spent. */
function keepPhase1Usage(error: unknown, phase1: { tokensIn: number; tokensOut: number; tokensKnown: boolean }): unknown {
  if (error === null || typeof error !== "object" || !phase1.tokensKnown) return error;
  const prior = (error as { usage?: { input?: number; output?: number } }).usage;
  return Object.assign(error, { usage: { input: phase1.tokensIn + (prior?.input ?? 0), output: phase1.tokensOut + (prior?.output ?? 0), complete: false } });
}

function gate(stage: SecurityStage, text: string): string {
  const result = gateForModel(stage, text);
  if (result.status !== "ok") throw new ReviewerSecurityError(stage, result.reason);
  return result.text;
}

interface Prompts {
  readonly phase1: string;
  readonly phase2: string;
}

/** Our own prompt files (trusted, static, no repository data). The shared file splits at its "## Phase 2" heading. */
async function loadPrompts(req: ReviewerRequest): Promise<Prompts> {
  const [shared, category] = await Promise.all([
    readFile(join(dirname(req.promptPath), "REVIEWER_SHARED.md"), "utf8"),
    readFile(req.promptPath, "utf8"),
  ]);
  const split = PHASE2_HEADING.exec(shared);
  const at = split?.index ?? shared.length;
  return { phase1: `${shared.slice(0, at)}\n${category}`, phase2: split ? shared.slice(at) : shared };
}

function buildPhase1(prompts: Prompts, context: string, req: ReviewerRequest): string {
  return [
    prompts.phase1,
    `Per-file patches are in ${req.patchDir}. The change under review:`,
    "<shared_context>",
    context,
    "</shared_context>",
    "Investigate now and write your Phase 1 notes.",
  ].join("\n\n");
}
