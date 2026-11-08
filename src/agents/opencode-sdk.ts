import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_NAME } from "../mcp/ids.js";
import { CONTEXT_ROOT } from "../workspace/permissions.js";
import { verifyToolset, type ToolsetApi } from "./toolset.js";
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
/** The agent that reviewer investigations run under; it carries the step cap. The coordinator uses the default agent. */
const INVESTIGATOR = "investigator";
/** The compiled MCP server, next to this directory in dist/. */
const MCP_SERVER_PATH = fileURLToPath(new URL("../mcp/server.js", import.meta.url));
const TOOLSET_WAIT_MS = 15_000;

/**
 * Environment OpenCode is always started with. Trusted reviewer configuration is passed inline from this module, never
 * read from the repository: with project config on, OpenCode loads plugins, tools and MCP servers from `.opencode/` and
 * `opencode.json` in the working directory (code execution) and puts AGENTS.md / CLAUDE.md into the system prompt.
 */
export const TRUSTED_OPENCODE_ENV: Readonly<Record<string, string>> = Object.freeze({
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
});

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
  readonly mcp: { status(params: Record<string, never>, opts: typeof THROW): Call<Readonly<Record<string, { status?: string }>>> };
  readonly tool: { ids(params: Record<string, never>, opts: typeof THROW): Call<readonly string[]> };
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
  Object.assign(process.env, TRUSTED_OPENCODE_ENV);
  // OpenCode's working directory is a fresh, empty, trusted directory, never the reviewed repository. Setting
  // OPENCODE_DISABLE_PROJECT_CONFIG alone is not enough: measured with 1.19.5, `.opencode/plugin/*.js` in the working
  // directory still executes when the first session starts. Repository files are reached by absolute path only.
  process.chdir(mkdtempSync(join(tmpdir(), "cra-opencode-")));
  const server = await sdk.createOpencodeServer({
    hostname: "127.0.0.1",
    port: PORT,
    config: {
      provider: { [PROVIDER_ID]: { options: { baseURL: options.baseUrl, apiKey: "proxy-placeholder" } } },
      permission: options.permissions.permission,
      // The only file tools: CRA's own bounded MCP server, a child process reading only the snapshot and review context.
      // Trusted configuration passed inline; nothing here comes from the repository.
      mcp: { [SERVER_NAME]: { type: "local", command: [process.execPath, MCP_SERVER_PATH], environment: { CRA_MCP_ROOT: options.repoRoot, CRA_MCP_CONTEXT: CONTEXT_ROOT }, enabled: true } },
      agent: { [INVESTIGATOR]: { mode: "primary", description: "Bounded read-only code investigation", steps: options.lifecycle.maxInvestigationSteps } },
      compaction: { auto: false, prune: false },
      share: "disabled",
      autoupdate: false,
    },
  });
  const client = sdk.createOpencodeClient({ baseUrl: server.url, fetch: boundedFetch(options.lifecycle.requestTimeoutMs) });
  try {
    await verifyToolset(toolsetApi(client), { waitMs: TOOLSET_WAIT_MS, pollMs: 250 });
  } catch (error) {
    server.close(); // no review runs without the verified bounded tools; an unbounded built-in is never a fallback
    throw error;
  }
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
    explore: ({ model, prompt, attemptId, stepLimited, signal }) => driveSession(api, { attemptId, model, prompt, ...(stepLimited ? { stepLimit: options.lifecycle.maxInvestigationSteps } : {}), ...(signal ? { signal } : {}) }, driver, sink),
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

function toolsetApi(client: SdkClient): ToolsetApi {
  return {
    mcpStatus: () => guarded(async () => (await client.mcp.status({}, THROW)).data ?? {}),
    toolIds: () => guarded(async () => (await client.tool.ids({}, THROW)).data ?? []),
  };
}

function sessionApi(client: SdkClient): SessionApi {
  const s = client.session;
  return {
    create: () => guarded(async () => (await s.create({ title: "review" }, THROW)).data.id),
    promptAsync: (sessionID, { model, text, stepLimited }) =>
      guarded(async () => { await s.promptAsync({ sessionID, ...(stepLimited ? { agent: INVESTIGATOR } : {}), model: { providerID: PROVIDER_ID, modelID: model }, parts: [{ type: "text", text }] }, THROW); }),
    messages: (sessionID) => guarded(async () => (await s.messages({ sessionID }, THROW)).data ?? []),
    status: () => guarded(async () => (await s.status({}, THROW)).data ?? {}),
    abort: (sessionID) => guarded(async () => { await s.abort({ sessionID }, THROW); }),
    remove: (sessionID) => guarded(async () => { await s.delete({ sessionID }, THROW); }),
  };
}
