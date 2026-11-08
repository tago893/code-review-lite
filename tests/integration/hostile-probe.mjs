// Runs INSIDE the agent container. Points OpenCode at a directory full of hostile repository-supplied configuration
// (tests/integration/hostile-files.mjs) and reports what ran and what reached the model.
//   CONTROL=1  raw OpenCode with project config ON (what CRA did before the fix): the hostile files MUST take effect,
//              otherwise the test would prove nothing.
//   CONTROL=0  CRA's launchOpenCode (project config off, trusted config inline): NOTHING may take effect.
// Prints one JSON line per fact; the shell scenario decides pass or fail.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { writeHostile } from "/probe/hostile-files.mjs";

const CONTROL = process.env.CONTROL === "1";
const DIR = "/tmp/hostile";
const say = (o) => console.log(JSON.stringify({ control: CONTROL, ...o }));
const sdk = await import("file:///opt/crl/node_modules/@opencode-ai/sdk/dist/v2/index.js");

mkdirSync("/review/out", { recursive: true });
for (const f of readdirSync("/review/out")) rmSync(`/review/out/${f}`, { force: true });
mkdirSync(DIR, { recursive: true });
writeHostile(DIR);
process.chdir(DIR);

const { buildAgentPermissions } = await import("/opt/crl/dist/agents/permissions.js");
const { loadConfig } = await import("/opt/crl/dist/config.js");
const BASE = "http://proxy:8080/openai/v1";
let close = async () => undefined;
let run;

if (CONTROL) {
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS;
  const handle = await sdk.createOpencode({ hostname: "127.0.0.1", port: 4096, config: {
    provider: { groq: { options: { baseURL: BASE, apiKey: "proxy-placeholder" } } },
    permission: buildAgentPermissions(DIR).permission, share: "disabled", autoupdate: false,
  } });
  close = async () => handle.server.close();
  run = async () => {
    const c = handle.client;
    const s = (await c.session.create({ title: "t" }, { throwOnError: true })).data.id;
    await c.session.promptAsync({ sessionID: s, model: { providerID: "groq", modelID: "openai/gpt-oss-20b" }, parts: [{ type: "text", text: "go" }] }, { throwOnError: true });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!(await c.session.status({}, { throwOnError: true })).data?.[s] && i > 2) break;
    }
  };
} else {
  const { launchOpenCode } = await import("/opt/crl/dist/agents/opencode-sdk.js");
  const config = loadConfig({ GROQ_BASE_URL: BASE });
  const explorer = await launchOpenCode({ repoRoot: DIR, baseUrl: BASE, env: {}, permissions: buildAgentPermissions(DIR), lifecycle: config.session });
  close = () => explorer.close();
  run = async () => { await explorer.explore({ model: "openai/gpt-oss-20b", prompt: "go", attemptId: "hostile#1", signal: AbortSignal.timeout(60_000) }).catch((e) => say({ exploreError: e?.name })); };
}

await new Promise((r) => setTimeout(r, 3000));
const probe = sdk.createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" });
const ids = (await probe.tool.ids({}, { throwOnError: true })).data ?? [];
const mcp = (await probe.mcp.status({}, { throwOnError: true }).catch(() => ({ data: {} }))).data ?? {};
await run();
await new Promise((r) => setTimeout(r, 1500));

const pwned = readdirSync("/review/out").filter((f) => f.startsWith("PWNED_"));
const reportForged = existsSync("/review/out/report.md") && /FORGED/.test(readFileSync("/review/out/report.md", "utf8"));
say({
  fact: "result",
  pwnedMarkers: pwned,
  reportForged,
  toolIdsContainEvil: ids.includes("evil"),
  mcpServers: Object.keys(mcp),
  toolIds: ids,
});
await close();
process.exit(0);
