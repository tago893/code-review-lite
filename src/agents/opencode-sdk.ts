import { sanitizeEnv } from "../safety/sanitize.js";
import type { ExploreSession, LaunchOptions } from "./opencode.js";

// The binding to the real OpenCode SDK, used only inside the agent container (the SDK is installed in that image,
// not in this package). It is a thin adapter around calls exercised in the Task 0 spike. It has NOT been run against
// a live OpenCode server in Task 8; runtime tool-access and proxy-isolation tests are pending acceptance criteria.

const SDK_MODULE = "@opencode-ai/sdk"; // held in a variable so TypeScript does not require the package at build time
const PROVIDER_ID = "groq";
const PORT = 4096;

interface Part {
  readonly type?: string;
  readonly text?: string;
}

interface PromptResponse {
  readonly data?: {
    readonly info?: { readonly error?: unknown; readonly tokens?: { readonly input?: number; readonly output?: number } };
    readonly parts?: readonly Part[];
  };
}

interface SdkClient {
  readonly session: {
    create(body: { title: string }, opts: { throwOnError: boolean }): Promise<{ data: { id: string } }>;
    prompt(body: unknown, opts: { throwOnError: boolean; signal?: AbortSignal }): Promise<PromptResponse>;
  };
}

interface SdkHandle {
  readonly client: SdkClient;
  readonly server: { close(): void };
}

type CreateOpencode = (options: { hostname: string; port: number; config: unknown }) => Promise<SdkHandle>;

/**
 * Starts one OpenCode server in the sanitised snapshot and returns a Phase 1 explore session. It refuses to start if
 * the environment still holds anything credential-like (fail closed), and gives OpenCode only the proxy base URL and a
 * placeholder key. A provider error reported inside the response is thrown so the caller's scrubbing and retry logic
 * see it, rather than being mistaken for empty notes.
 */
export async function launchOpenCode(options: LaunchOptions, processEnv: NodeJS.ProcessEnv = process.env): Promise<ExploreSession> {
  if (Object.keys(sanitizeEnv(processEnv)).length !== Object.keys(processEnv).filter((k) => processEnv[k] !== undefined).length) {
    throw new Error("agent environment still contains credentials; refusing to start OpenCode");
  }
  const sdk = (await import(SDK_MODULE)) as { createOpencode: CreateOpencode };
  process.chdir(options.repoRoot);
  const handle = await sdk.createOpencode({
    hostname: "127.0.0.1",
    port: PORT,
    config: {
      provider: { [PROVIDER_ID]: { options: { baseURL: options.baseUrl, apiKey: "proxy-placeholder" } } },
      permission: options.permissions.permission,
      share: "disabled",
      autoupdate: false,
    },
  });

  return {
    async explore({ model, prompt, signal }) {
      const created = await handle.client.session.create({ title: "review" }, { throwOnError: true });
      const body = { sessionID: created.data.id, model: { providerID: PROVIDER_ID, modelID: model }, parts: [{ type: "text", text: prompt }] };
      const response = await handle.client.session.prompt(body, { throwOnError: true, ...(signal ? { signal } : {}) });
      const info = response.data?.info;
      if (info?.error !== undefined) throw info.error;
      const text = (response.data?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      return { text, tokensIn: info?.tokens?.input ?? 0, tokensOut: info?.tokens?.output ?? 0 };
    },
    async close() {
      handle.server.close();
    },
  };
}
