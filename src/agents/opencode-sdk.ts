import { TRANSPORT_MARKER } from "../resilience/errors.js";
import { sanitizeEnv } from "../safety/sanitize.js";
import type { ExploreSession, LaunchOptions } from "./opencode.js";
import { driveSession, type DriverOptions, type MessageLike, type SessionApi, type SessionStatus } from "./session-driver.js";

// The binding to the real OpenCode SDK, used only inside the agent container (the SDK is installed in that image,
// not in this package). Sessions are driven by session-driver.ts through the supported promptAsync / messages /
// status / abort / delete calls; no long-lived HTTP request is held open.

const SDK_MODULE = "@opencode-ai/sdk/v2"; // held in a variable so TypeScript does not require the package at build time
const PROVIDER_ID = "groq";
const PORT = 4096;

type Call<T> = Promise<{ data?: T }>;
const THROW = { throwOnError: true } as const;

interface SdkClient {
  readonly session: {
    create(body: { title: string }, opts: typeof THROW): Promise<{ data: { id: string } }>;
    promptAsync(body: unknown, opts: typeof THROW): Promise<unknown>;
    messages(params: { sessionID: string }, opts: typeof THROW): Call<readonly MessageLike[]>;
    status(params: Record<string, never>, opts: typeof THROW): Call<Readonly<Record<string, SessionStatus>>>;
    abort(params: { sessionID: string }, opts: typeof THROW): Promise<unknown>;
    delete(params: { sessionID: string }, opts: typeof THROW): Promise<unknown>;
  };
}

interface SdkModule {
  createOpencodeServer(options: { hostname: string; port: number; config: unknown }): Promise<{ url: string; close(): void }>;
  createOpencodeClient(config: { baseUrl: string; fetch: (request: Request) => Promise<Response> }): SdkClient;
}

/**
 * Starts one OpenCode server in the sanitised snapshot and returns a Phase 1 explore session. It refuses to start if
 * the environment still holds anything credential-like (fail closed), and gives OpenCode only the proxy base URL and a
 * placeholder key.
 *
 * Automatic compaction and pruning are switched off. With them on, a provider "request too large" reply makes OpenCode
 * silently summarise the investigation and carry on, which would make a compacted review look like an uncompacted one.
 * With them off the overflow surfaces as a ContextOverflowError and the attempt fails visibly and non-retryably.
 *
 * OpenCode 1.19.5's `tool_output` limits do not apply to the read and grep tools (measured: the same 56 KB read result
 * with and without them), so no tool-output limit is configured. See docs/execution-lifecycle.md.
 */
export async function launchOpenCode(options: LaunchOptions, processEnv: NodeJS.ProcessEnv = process.env): Promise<ExploreSession> {
  if (Object.keys(sanitizeEnv(processEnv)).length !== Object.keys(processEnv).filter((k) => processEnv[k] !== undefined).length) {
    throw new Error("agent environment still contains credentials; refusing to start OpenCode");
  }
  const sdk = (await import(SDK_MODULE)) as SdkModule;
  process.chdir(options.repoRoot);
  const server = await sdk.createOpencodeServer({
    hostname: "127.0.0.1",
    port: PORT,
    config: {
      provider: { [PROVIDER_ID]: { options: { baseURL: options.baseUrl, apiKey: "proxy-placeholder" } } },
      permission: options.permissions.permission,
      compaction: { auto: false, prune: false },
      share: "disabled",
      autoupdate: false,
    },
  });
  const client = sdk.createOpencodeClient({ baseUrl: server.url, fetch: boundedFetch(options.lifecycle.requestTimeoutMs) });
  const api = sessionApi(client);
  const driver: DriverOptions = {
    pollMs: options.lifecycle.pollMs,
    startGraceMs: options.lifecycle.startGraceMs,
    cleanupWaitMs: options.lifecycle.cleanupWaitMs,
    maxProviderRetries: options.lifecycle.maxProviderRetries,
    maxPollFailures: options.lifecycle.maxPollFailures,
  };
  const sink = options.onTrace ?? (() => undefined);

  return {
    explore: ({ model, prompt, attemptId, signal }) => driveSession(api, { attemptId, model, prompt, ...(signal ? { signal } : {}) }, driver, sink),
    async close() {
      server.close();
    },
  };
}

/**
 * A fetch with a timeout per HTTP call to the local OpenCode server. Every call is short (a poll, a cancel, a delete),
 * so this is a guard against a wedged local server and never what ends an attempt: the attempt deadline is enforced
 * by the caller's abort signal. A timeout here is reported as a transport error, not as an upstream server error.
 */
export function boundedFetch(timeoutMs: number, base: typeof fetch = fetch): (request: Request) => Promise<Response> {
  return async (request) => {
    const timer = AbortSignal.timeout(timeoutMs);
    try {
      return await base(request, { signal: AbortSignal.any([request.signal, timer]) });
    } catch (error) {
      if (timer.aborted && !request.signal.aborted) {
        throw Object.assign(new Error("request to the local OpenCode server timed out"), { name: "TransportTimeoutError" });
      }
      throw error;
    }
  };
}

/** The SDK reports a failed connection as an Error with no code; make sure it is still recognised as transport. */
function asTransport(error: unknown): unknown {
  if (error instanceof Error && /network error \(no response\)/i.test(error.message)) {
    return Object.assign(error, { code: TRANSPORT_MARKER });
  }
  return error;
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asTransport(error);
  }
}

function sessionApi(client: SdkClient): SessionApi {
  const s = client.session;
  return {
    create: () => guarded(async () => (await s.create({ title: "review" }, THROW)).data.id),
    promptAsync: (sessionID, { model, text }) =>
      guarded(async () => { await s.promptAsync({ sessionID, model: { providerID: PROVIDER_ID, modelID: model }, parts: [{ type: "text", text }] }, THROW); }),
    messages: (sessionID) => guarded(async () => (await s.messages({ sessionID }, THROW)).data ?? []),
    status: () => guarded(async () => (await s.status({}, THROW)).data ?? {}),
    abort: (sessionID) => guarded(async () => { await s.abort({ sessionID }, THROW); }),
    remove: (sessionID) => guarded(async () => { await s.delete({ sessionID }, THROW); }),
  };
}
