import { createHash } from "node:crypto";

// Bounded tool-result history for an OpenCode investigation. OpenCode re-sends every earlier tool result with every model
// request, so a long investigation grows without limit. This module decides, deterministically and from recency alone,
// which OLD tool results to replace with a short reference. It never looks at what a result says, and it never decides
// which file matters: the model can always repeat a call, because the source snapshot is immutable and the tools are
// deterministic. Pure: it reads messages and returns a plan; applying the plan is the caller's job.

/** The part of an OpenCode message part this module reads. Real parts carry more. */
export interface ToolPartLike {
  readonly type?: string;
  readonly tool?: string;
  readonly state?: { readonly status?: string; readonly output?: unknown };
}

export interface HistoryMessageLike {
  readonly parts?: readonly ToolPartLike[];
}

export interface Replacement {
  /** The part whose `state.output` should be replaced. Identity, not a copy. */
  readonly part: ToolPartLike;
  readonly output: string;
}

export interface PruneStats {
  /** Completed tool results with a text body, in the conversation. */
  readonly toolResults: number;
  /** Bodies left as they were (the newest ones that fit the budget). */
  readonly kept: number;
  /** Bodies that are references after this plan (including ones already pruned before). */
  readonly pruned: number;
  /** Bytes of the bodies still sent in full. */
  readonly keptBytes: number;
  /** Bytes removed from the conversation by this plan. */
  readonly savedBytes: number;
}

export interface PrunePlan {
  readonly replacements: readonly Replacement[];
  readonly stats: PruneStats;
}

/** Marks a reference. A body that starts with this has already been pruned. */
export const PRUNED_MARKER = "[cra:pruned";

const SAFE_PATH = /^[A-Za-z0-9_./@+-]{1,160}$/;
const SAFE_TOOL = /^[a-z][a-z0-9_]{0,30}$/;
const READ_HEADER = /^(\S{1,200}) \(lines (\d{1,9})-(\d{1,9}) of (\d{1,9})\)/;

/**
 * Keeps the newest completed tool results whose bodies fit `budgetBytes` in total (always at least the newest one) and
 * replaces every older body with a reference. Strictly by recency: once a result does not fit, it and everything older
 * are pruned, so a small old result never jumps the queue. Failed tool calls are untouched. Idempotent.
 */
export function planPruning(messages: readonly HistoryMessageLike[], budgetBytes: number): PrunePlan {
  const results = collect(messages);
  let keptBytes = 0;
  let kept = 0;
  let cut = results.length; // results[0..cut) are old, results[cut..] are kept
  for (let i = results.length - 1; i >= 0; i--) {
    const entry = results[i] as Collected;
    const fits = keptBytes + entry.bytes <= budgetBytes;
    if (!fits && kept > 0) break;
    keptBytes += entry.bytes;
    kept += 1;
    cut = i;
    if (!fits) break; // the newest result alone exceeds the budget: it is still kept, nothing older is
  }

  const replacements: Replacement[] = [];
  let savedBytes = 0;
  for (const entry of results.slice(0, cut)) {
    if (entry.body.startsWith(PRUNED_MARKER)) continue;
    const output = referenceFor(entry.part.tool, entry.body);
    savedBytes += entry.bytes - Buffer.byteLength(output);
    replacements.push({ part: entry.part, output });
  }
  return Object.freeze({ replacements, stats: Object.freeze({ toolResults: results.length, kept, pruned: results.length - kept, keptBytes, savedBytes }) });
}

/**
 * A short, fixed-shape reference. It carries the tool name, the size and a hash of the original body, and for a file read
 * the path and line range that CRA's own tool printed. It never copies model- or repository-controlled text beyond a path
 * that passes a strict character filter. The model still sees its own call (with arguments) right next to it.
 */
export function referenceFor(tool: string | undefined, body: string): string {
  const bytes = Buffer.byteLength(body);
  const sha = createHash("sha256").update(body).digest("hex").slice(0, 12);
  const name = tool !== undefined && SAFE_TOOL.test(tool) ? tool : "tool";
  const header = READ_HEADER.exec(body);
  const where = header && SAFE_PATH.test(header[1] as string) ? ` path=${header[1]} lines=${header[2]}-${header[3]} of=${header[4]}` : "";
  return `${PRUNED_MARKER} tool=${name}${where} bytes=${bytes} sha256=${sha}. The result was removed to save context; repeat the same call to see it again.]`;
}

interface Collected {
  readonly part: ToolPartLike;
  readonly body: string;
  readonly bytes: number;
}

function collect(messages: readonly HistoryMessageLike[]): Collected[] {
  const out: Collected[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== "tool" || part.state?.status !== "completed" || typeof part.state.output !== "string") continue;
      out.push({ part, body: part.state.output, bytes: Buffer.byteLength(part.state.output) });
    }
  }
  return out;
}
