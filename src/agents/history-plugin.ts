import { appendFileSync } from "node:fs";
import { planPruning, type HistoryMessageLike } from "./history.js";

// CRA's own OpenCode plugin: bounds the tool-result history of a reviewer investigation. OpenCode loads it ONLY because
// trusted CRA configuration lists it (see opencode-sdk.ts); a plugin in the reviewed repository is never loaded.
//
// Two hooks, one contract:
//  1. experimental.chat.messages.transform prunes the in-memory messages before each model request. If it throws, OpenCode
//     sends no request at all (measured with 1.19.5), so a failing prune cannot leak a full-size request.
//  2. chat.headers stamps the outgoing provider request with `x-cra-history` ONLY after a prune succeeded for it. The
//     credential proxy refuses tool-enabled requests without the stamp, so a plugin that is missing, failed to load, or
//     is not being invoked cannot silently send unpruned history. Each successful prune authorises exactly one stamp.
//
// Only the plugin function is exported: OpenCode treats every export of a plugin module as a plugin.

const HISTORY_HEADER = "x-cra-history";
const BUDGET_ENV = "CRA_HISTORY_BUDGET_BYTES";
const STATE_ENV = "CRA_HISTORY_STATE_FILE";

interface StateWriter {
  (record: Readonly<Record<string, unknown>>): void;
}

function stateWriter(path: string | undefined): StateWriter {
  return (record) => {
    if (!path) return;
    try {
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    } catch {
      // The state file is evidence for the driver; if it cannot be written the driver reports pruning as unverified.
    }
  };
}

export const CraHistoryPlugin = async () => {
  const budget = Number(process.env[BUDGET_ENV]);
  const write = stateWriter(process.env[STATE_ENV]);
  if (!Number.isInteger(budget) || budget < 1) {
    write({ kind: "error", message: "invalid history budget" });
    throw new Error("CRA history plugin: invalid budget");
  }
  let pruned = 0; // successful prunes not yet matched with a stamped request
  write({ kind: "loaded", budget });
  return {
    "experimental.chat.messages.transform": async (_input: unknown, output: { messages?: readonly HistoryMessageLike[] }) => {
      try {
        const plan = planPruning(output.messages ?? [], budget);
        for (const r of plan.replacements) (r.part.state as { output: unknown }).output = r.output;
        pruned += 1;
        write({ kind: "prune", ...plan.stats });
      } catch (error) {
        write({ kind: "error", message: error instanceof Error ? error.message.slice(0, 200) : "prune failed" });
        throw error;
      }
    },
    "chat.headers": async (_input: unknown, output: { headers: Record<string, string> }) => {
      if (pruned < 1) return; // no prune ran for this request: leave it unstamped so the proxy refuses it
      pruned -= 1;
      output.headers[HISTORY_HEADER] = String(budget);
      write({ kind: "stamp" });
    },
  };
};
