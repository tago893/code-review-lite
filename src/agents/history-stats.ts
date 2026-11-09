import { readFileSync } from "node:fs";

// Reads the evidence the history plugin leaves in its state file (one JSON object per line). The plugin runs inside
// OpenCode's process, so a file is the only channel back to CRA. The reader is tolerant of damage but never optimistic:
// a line it cannot parse counts as a malformed record, and a missing file reads as "plugin never ran".

export interface HistoryState {
  /** The plugin module was loaded and initialised. */
  readonly loaded: boolean;
  /** Errors the plugin recorded (failed prune, bad budget) plus unreadable lines. */
  readonly errors: number;
  /** Successful prunes, one per model request the hook ran for. */
  readonly prunes: number;
  /** Provider requests stamped as pruned. */
  readonly stamps: number;
  /** Largest number of completed tool results seen in one request. */
  readonly maxToolResults: number;
  /** Largest total of tool-result bytes still sent in full in one request. */
  readonly maxKeptBytes: number;
  /** Bytes removed from requests, summed over all prunes. A request-by-request saving, not a one-off total. */
  readonly savedBytes: number;
  /** Results that were references in the most recent prune. */
  readonly lastPruned: number;
}

export const EMPTY_HISTORY_STATE: HistoryState = Object.freeze({ loaded: false, errors: 0, prunes: 0, stamps: 0, maxToolResults: 0, maxKeptBytes: 0, savedBytes: 0, lastPruned: 0 });

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

export function parseHistoryState(text: string): HistoryState {
  let state = EMPTY_HISTORY_STATE;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
      record = parsed as Record<string, unknown>;
    } catch {
      state = { ...state, errors: state.errors + 1 };
      continue;
    }
    switch (record["kind"]) {
      case "loaded": state = { ...state, loaded: true }; break;
      case "error": state = { ...state, errors: state.errors + 1 }; break;
      case "stamp": state = { ...state, stamps: state.stamps + 1 }; break;
      case "prune":
        state = {
          ...state, prunes: state.prunes + 1,
          maxToolResults: Math.max(state.maxToolResults, num(record["toolResults"])),
          maxKeptBytes: Math.max(state.maxKeptBytes, num(record["keptBytes"])),
          savedBytes: state.savedBytes + num(record["savedBytes"]),
          lastPruned: num(record["pruned"]),
        };
        break;
      default: state = { ...state, errors: state.errors + 1 };
    }
  }
  return Object.freeze(state);
}

/** Reads the state file. A missing or unreadable file is "nothing happened", never an exception. */
export function readHistoryState(path: string): HistoryState {
  try {
    return parseHistoryState(readFileSync(path, "utf8"));
  } catch {
    return EMPTY_HISTORY_STATE;
  }
}
