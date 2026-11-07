import { parseArgs } from "./cli/args.js";
import { prepare } from "./cli/prepare.js";
import { review } from "./cli/review.js";

// code-review-lite prepare|review. `prepare` runs on the trusted side (raw checkout, no model access);
// `review` runs in the agent container (sanitised snapshot only). Exit codes: 0 complete, 2 incomplete or failed.
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const result =
    parsed.command.kind === "prepare"
      ? await prepare(parsed.command)
      : await review(parsed.command, process.env, (text) => void process.stdout.write(text));
  process.stderr.write(`${JSON.stringify({ status: result.status })}\n`);
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(2),
);
