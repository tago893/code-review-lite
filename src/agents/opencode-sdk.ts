import { sanitizeEnv } from "../safety/sanitize.js";
import type { ExploreSession, LaunchOptions, ToolCall } from "./opencode.js";

// The binding to the real OpenCode SDK, used only inside the agent container (the SDK is installed in that image,
// not in this package). Task 10 runs it against a live OpenCode server in that container.

const SDK_MODULE = "@opencode-ai/sdk/v2"; // held in a variable so TypeScript does not require the package at build time
const PROVIDER_ID = "groq";
const PORT = 4096;

interface Part {
  readonly type?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly state?: { readonly status?: string; readonly input?: Record<string, unknown>; readonly output?: unknown; readonly error?: unknown };
}

interface Tokens {
  readonly input?: number;
  readonly output?: number;
}

interface MessageInfo {
  readonly role?: string;
  readonly error?: unknown;
  readonly tokens?: Tokens;
}

interface PromptResponse {
  readonly data?: { readonly info?: MessageInfo; readonly parts?: readonly Part[] };
}

interface MessagesResponse {
  readonly data?: readonly { readonly info?: MessageInfo; readonly parts?: readonly Part[] }[];
}

interface SdkClient {
  readonly session: {
    create(body: { title: string }, opts: { throwOnError: boolean }): Promise<{ data: { id: string } }>;
    prompt(body: unknown, opts: { throwOnError: boolean; signal?: AbortSignal }): Promise<PromptResponse>;
    messages(params: { sessionID: string }, opts: { throwOnError: boolean }): Promise<MessagesResponse>;
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
 * see it, rather than being mistaken for empty notes. OpenCode runs one assistant message per step, so tokens and tool
 * calls are collected across the whole session message list, not just the final message.
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
      const sessionID = created.data.id;
      const body = { sessionID, model: { providerID: PROVIDER_ID, modelID: model }, parts: [{ type: "text", text: prompt }] };
      const response = await handle.client.session.prompt(body, { throwOnError: true, ...(signal ? { signal } : {}) });
      const info = response.data?.info;
      if (info?.error !== undefined) throw info.error;

      const history = await handle.client.session.messages({ sessionID }, { throwOnError: true }).catch(() => undefined);
      const assistant = (history?.data ?? []).filter((m) => m.info?.role === "assistant");
      const tokens = assistant.length > 0 ? assistant.map((m) => m.info?.tokens) : [info?.tokens];
      for (const call of assistant.flatMap((m) => toolCalls(m.parts ?? []))) options.onToolCall?.(call);

      const text = (response.data?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      return { text, tokensIn: sum(tokens, "input"), tokensOut: sum(tokens, "output") };
    },
    async close() {
      handle.server.close();
    },
  };
}

const sum = (tokens: readonly (Tokens | undefined)[], key: keyof Tokens): number =>
  tokens.reduce<number>((total, t) => total + (typeof t?.[key] === "number" ? (t[key] as number) : 0), 0);

function toolCalls(parts: readonly Part[]): ToolCall[] {
  return parts
    .filter((p) => p.type === "tool" && typeof p.tool === "string")
    .map((p) => {
      const output = p.state?.output;
      const error = p.state?.error;
      return {
        tool: p.tool ?? "unknown",
        status: p.state?.status ?? "unknown",
        input: p.state?.input ?? {},
        outputChars: typeof output === "string" ? output.length : 0,
        ...(typeof error === "string" ? { error } : {}),
      };
    });
}
