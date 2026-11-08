import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { COORDINATOR_SCHEMA, judge } from "../agents/coordinator.js";
import { createOpenCodeRunner, createSessionProvider } from "../agents/opencode.js";
import { launchOpenCode } from "../agents/opencode-sdk.js";
import { createStructuredCall } from "../agents/structured.js";
import { VERIFIER_SCHEMA, createVerifier } from "../agents/verifier.js";
import { loadConfig } from "../config.js";
import { fileSink } from "../io/provider.js";
import { createLogger } from "../observability/log.js";
import { runReview } from "../pipeline.js";
import { toWorkspaceError } from "../workspace/errors.js";
import { loadReviewContext } from "../workspace/review-context.js";
import type { Command } from "./args.js";

type Review = Extract<Command, { kind: "review" }>;

const CATEGORIES = ["code_quality", "security", "performance"] as const;

/** REVIEW_AGENTS=security,code_quality narrows a run (smoke tests, low-rate-limit tiers). Unknown names are an error. */
function restrictedAgents(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const names = value.split(",").map((s) => s.trim());
  if (names.some((n) => !(CATEGORIES as readonly string[]).includes(n))) throw new Error("REVIEW_AGENTS names an unknown reviewer");
  return names;
}

/**
 * Agent side. Reads only the sanitised snapshot and the prepared context; never the raw checkout. The OpenCode
 * launcher is the real SDK launcher and has not been exercised against a live server.
 */
export async function review(cmd: Review, env: NodeJS.ProcessEnv, write: (text: string) => void): Promise<{ readonly exitCode: 0 | 2; readonly status: string }> {
  try {
    const config = loadConfig(env);
    const loaded = await loadReviewContext(cmd.ctx, cmd.repo, cmd.prompts);
    const only = restrictedAgents(env["REVIEW_AGENTS"]);
    const context = only === undefined ? loaded : { ...loaded, plan: { ...loaded.plan, agents: loaded.plan.agents.filter((a) => only.includes(a)) } };
    if (context.plan.agents.length === 0 && context.plan.disposition === "review") throw new Error("REVIEW_AGENTS excludes every reviewer the plan needs");
    const notes = only === undefined ? [] : [`restricted run: only ${context.plan.agents.join(", ")} executed (REVIEW_AGENTS); this is not a full review`];
    const log = createLogger((line) => appendFileSync(cmd.log, `${line}\n`));
    const launcher = (options: Parameters<typeof launchOpenCode>[0]): ReturnType<typeof launchOpenCode> => launchOpenCode(options, env);
    const sessions = createSessionProvider({ config, launcher, env, onToolCall: (call) => log.event("tool_call", call) });
    const runner = createOpenCodeRunner({ config, launcher, sessions, env });
    const judgeStructured = createStructuredCall(config.groqBaseUrl, undefined, COORDINATOR_SCHEMA, "judgments");
    const verifierStructured = createStructuredCall(config.groqBaseUrl, undefined, VERIFIER_SCHEMA, "verdict");
    const result = await runReview(
      { plan: context.plan, meta: context.meta, paths: context.paths, notes },
      {
        config, log, runner, verifier: createVerifier(verifierStructured, config.verifierModel),
        judge: (findings, model, signal) => judge(findings, { sessions, structured: judgeStructured, model, repoRoot: cmd.repo, promptPath: join(cmd.prompts, "coordinator.md"), signal }),
      },
    );
    write(result.report);
    await fileSink(cmd.out).write(result.report, result.metrics);
    return { exitCode: result.exitCode, status: result.completion };
  } catch (error) {
    return { exitCode: 2, status: `review_failed:${toWorkspaceError(error).code}` };
  }
}
