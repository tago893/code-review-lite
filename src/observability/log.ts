import { redactSecrets } from "../safety/redact.js";

export interface Logger {
  /** Writes one JSON line. Never throws. */
  event(name: string, data?: object): void;
  /** Lines that could not be written or serialised. Not silent: callers can report it. */
  droppedLines(): number;
}

export interface LoggerOptions {
  readonly now?: () => Date;
}

const MAX_STRING = 2000;
const MAX_DEPTH = 6;

/**
 * JSON-lines logger. Every string (names, values, keys) is redacted before serialising, and the finished line is
 * redacted and re-parsed as a last check, so a secret that only appears across a key/value pair
 * ("password":"...") is still caught and the line is always valid JSON.
 */
export function createLogger(sink: (line: string) => void, options: LoggerOptions = {}): Logger {
  const now = options.now ?? (() => new Date());
  let dropped = 0;

  const write = (record: Record<string, unknown>): boolean => {
    try {
      const line = redactSecrets(JSON.stringify(record));
      JSON.parse(line); // a redaction that broke the line is a bug: refuse to emit it
      sink(line);
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    event(name: string, data: object = {}): void {
      const base = { ts: now().toISOString(), event: clean(name, 0) };
      const record = write({ ...base, ...(clean(data, 0) as object) }) || write({ ...base, log_error: "unserialisable_event_data" });
      if (!record) dropped++;
    },
    droppedLines: () => dropped,
  });
}

/** A deep copy with every string redacted and truncated, bigint turned into text, and cycles cut off. */
function clean(value: unknown, depth: number, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactSecrets(value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value) || depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[redactSecrets(key)] = clean(inner, depth + 1, seen);
  return out;
}

/** Emits a "heartbeat" event every `intervalMs` until the returned stop function is called (safe to call twice). */
export function startHeartbeat(log: Pick<Logger, "event">, intervalMs: number): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("heartbeat interval must be positive");
  const started = Date.now();
  const timer = setInterval(() => log.event("heartbeat", { elapsedMs: Date.now() - started }), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
