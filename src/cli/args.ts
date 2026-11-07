export type Command =
  | { readonly kind: "prepare"; readonly repo: string; readonly base: string; readonly head: string; readonly diff?: string; readonly outRepo: string; readonly outCtx: string }
  | { readonly kind: "review"; readonly repo: string; readonly ctx: string; readonly prompts: string; readonly out: string; readonly log: string };

export type ParseResult = { readonly ok: true; readonly command: Command } | { readonly ok: false; readonly error: string };

const PREPARE_FLAGS = ["repo", "base", "head", "diff", "out-repo", "out-ctx"] as const;
const REVIEW_FLAGS = ["repo", "ctx", "prompts", "out", "log"] as const;

const fail = (error: string): ParseResult => ({ ok: false, error });

/** Parses `prepare` / `review` arguments. Unknown flags, repeated flags and missing values are errors. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const [sub, ...rest] = argv;
  if (sub !== "prepare" && sub !== "review") return fail("usage: code-review-lite <prepare|review> [options]");
  const allowed: readonly string[] = sub === "prepare" ? PREPARE_FLAGS : REVIEW_FLAGS;
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? "";
    const value = rest[i + 1];
    if (!flag.startsWith("--") || !allowed.includes(flag.slice(2))) return fail(`unknown option: ${flag}`);
    if (value === undefined || value.startsWith("--")) return fail(`missing value for ${flag}`);
    if (values.has(flag.slice(2))) return fail(`repeated option: ${flag}`);
    values.set(flag.slice(2), value);
  }

  if (sub === "prepare") {
    const repo = values.get("repo");
    const base = values.get("base");
    const head = values.get("head");
    const outRepo = values.get("out-repo");
    const outCtx = values.get("out-ctx");
    if (!repo || !base || !head || !outRepo || !outCtx) return fail("prepare requires --repo --base --head --out-repo --out-ctx");
    const diff = values.get("diff");
    return { ok: true, command: { kind: "prepare", repo, base, head, outRepo, outCtx, ...(diff ? { diff } : {}) } };
  }
  const repo = values.get("repo");
  const ctx = values.get("ctx");
  const prompts = values.get("prompts");
  const out = values.get("out");
  if (!repo || !ctx || !prompts || !out) return fail("review requires --repo --ctx --prompts --out");
  return { ok: true, command: { kind: "review", repo, ctx, prompts, out, log: values.get("log") ?? out.replace(/[^/\\]*$/, "run.jsonl") } };
}
