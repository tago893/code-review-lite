import { describe, expect, it } from "vitest";
import { describeRedactions, redactSecrets, redactSecretsDetailed } from "../../src/safety/sanitize.js";
import { fake, filler } from "./fakes.js";

const lineCount = (text: string): number => text.split("\n").length;

describe("redactSecrets: provider keys", () => {
  it.each([
    ["Groq", fake.groq()],
    ["OpenAI", fake.openai()],
    ["Anthropic", fake.anthropic()],
    ["AWS", fake.aws()],
    ["GitHub", fake.github()],
    ["GitHub fine-grained", fake.githubFineGrained()],
    ["Slack", fake.slack()],
    ["Google", fake.google()],
    ["Stripe", fake.stripe()],
    ["npm", fake.npm()],
    ["GitLab", fake.gitlab()],
    ["JWT", fake.jwt()],
  ])("redacts a %s key anywhere in a line", (_name, secret) => {
    const out = redactSecrets(`const x = call("${secret}", opts);`);
    expect(out).not.toContain(secret);
    expect(out).toBe('const x = call("[REDACTED]", opts);');
  });

  it("matches the plan's short Groq example", () => {
    expect(redactSecrets("key=gsk_abc12345xyz")).not.toContain("abc12345xyz");
  });

  it("does not touch words that merely contain 'sk-'", () => {
    const text = "see task-12345678901234567890 and risk-assessment-framework-documents";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactSecrets: authorization headers and bearer tokens", () => {
  it("redacts the credential in an Authorization header and keeps the scheme", () => {
    const token = filler(30);
    expect(redactSecrets(`Authorization: Bearer ${token}`)).toBe("Authorization: Bearer [REDACTED]");
    expect(redactSecrets(`curl -H "Authorization: Basic ${filler(24)}=" https://x`)).toBe(
      'curl -H "Authorization: Basic [REDACTED]" https://x',
    );
    expect(redactSecrets(`headers = {"Proxy-Authorization": "Token ${token}"}`)).not.toContain(token);
  });

  it("redacts a bare 'Bearer xyz' as the plan requires", () => {
    const out = redactSecrets("send Bearer xyz now");
    expect(out).not.toContain("xyz");
    expect(out).toContain("[REDACTED]");
  });

  it("leaves code that builds the header from a variable", () => {
    for (const line of [
      'headers: { Authorization: "Bearer " + token },',
      "headers: { Authorization: `Bearer ${token}` },",
      'auth = f"Bearer {token}"',
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });

  it("does not redact prose that follows the word Bearer", () => {
    const text = "Bearer authentication is described in the token section";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactSecrets: credentials in connection strings", () => {
  it("redacts only the password and keeps scheme, user and host", () => {
    const pw = fake.password();
    expect(redactSecrets(`DB = "postgres://app:${pw}@db.internal:5432/main"`)).toBe(
      'DB = "postgres://app:[REDACTED]@db.internal:5432/main"',
    );
    expect(redactSecrets(`url: mongodb+srv://svc:${pw}@cluster0.example.net/x`)).toBe(
      "url: mongodb+srv://svc:[REDACTED]@cluster0.example.net/x",
    );
    expect(redactSecrets(`git clone https://ci:${pw}@git.example.com/a.git`)).not.toContain(pw);
  });

  it("redacts ADO-style Password= and password query parameters", () => {
    const pw = fake.password();
    expect(redactSecrets(`Server=db;User Id=sa;Password=${pw};Encrypt=true`)).toBe(
      "Server=db;User Id=sa;Password=[REDACTED];Encrypt=true",
    );
    expect(redactSecrets(`GET /login?user=a&password=${pw}&x=1`)).toBe("GET /login?user=a&password=[REDACTED]&x=1");
  });

  it("leaves URLs without credentials and placeholder passwords alone", () => {
    for (const line of [
      "http://localhost:3000/api",
      "postgres://app@db.internal/main",
      "postgres://user:password@localhost/db",
      "postgres://user:${DB_PASSWORD}@localhost/db",
      "postgres://user:<password>@localhost/db",
      "mysql://root:changeme@localhost/db",
      "Password=%s;",
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });
});

describe("redactSecrets: private keys", () => {
  it("redacts every body line of a PEM block and keeps the markers and the line count", () => {
    const body = fake.privateKeyBody();
    const text = ["const a = 1;", fake.pemHeader(), ...body, fake.pemFooter(), "const b = 2;"].join("\n");
    const out = redactSecrets(text);
    for (const piece of body) expect(out).not.toContain(piece);
    expect(out.split("\n")).toEqual([
      "const a = 1;", fake.pemHeader(), "[REDACTED]", "[REDACTED]", "[REDACTED]", fake.pemFooter(), "const b = 2;",
    ]);
    expect(lineCount(out)).toBe(lineCount(text));
  });

  it.each(["", "EC ", "OPENSSH ", "ENCRYPTED ", "DSA "])("handles the %sPRIVATE KEY variant", (kind) => {
    const body = filler(60);
    const out = redactSecrets([fake.pemHeader(kind), body, fake.pemFooter(kind)].join("\n"));
    expect(out).not.toContain(body);
  });

  it("redacts a key written on one line with escaped newlines", () => {
    const body = filler(80);
    const line = `const key = "${fake.pemHeader()}\\n${body}\\n${fake.pemFooter()}\\n";`;
    const out = redactSecrets(line);
    expect(out).not.toContain(body);
    expect(out.startsWith('const key = "')).toBe(true);
    expect(out.endsWith('";')).toBe(true);
  });

  it("fails closed on a key with no END marker: the rest of the text is redacted", () => {
    const body = filler(64);
    const out = redactSecrets([fake.pemHeader(), body, "more text"].join("\n"));
    expect(out).not.toContain(body);
    expect(out).not.toContain("more text");
  });

  it("does not treat a PUBLIC key block as secret", () => {
    const text = ["-----BEGIN PUBLIC " + "KEY-----", filler(64), "-----END PUBLIC " + "KEY-----"].join("\n");
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactSecrets: secret-named assignments", () => {
  it("redacts quoted literals and keeps the quotes, so the code and JSON stay valid", () => {
    const pw = fake.password();
    expect(redactSecrets(`const password = "${pw}";`)).toBe('const password = "[REDACTED]";');
    expect(redactSecrets(`api_key = '${filler(24)}'`)).toBe("api_key = '[REDACTED]'");
    const json = redactSecrets(`{"client_secret": "${pw}", "id": "abc"}`);
    expect(JSON.parse(json)).toEqual({ client_secret: "[REDACTED]", id: "abc" });
  });

  it("redacts dotenv and YAML style lines", () => {
    const secret = "hunter2" + "hunter2";
    expect(redactSecrets(`DB_PASSWORD=${secret}`)).toBe("DB_PASSWORD=[REDACTED]");
    expect(redactSecrets(`export API_TOKEN=${filler(20)}`)).toBe("export API_TOKEN=[REDACTED]");
    expect(redactSecrets(`  password: ${secret}`)).toBe("  password: [REDACTED]");
  });

  it("is case-insensitive about the name", () => {
    expect(redactSecrets(`ApiKey: "${filler(24)}"`)).toBe('ApiKey: "[REDACTED]"');
  });
});

describe("redactSecrets: ordinary code is not redacted", () => {
  it.each([
    "const token = getToken();",
    'password = os.environ["APP_PASSWORD"]',
    'const secret = process.env.SECRET;',
    'api_key = "your-api-key"',
    'secret: "${SECRET}"',
    'token: ${{ secrets.NPM_TOKEN }}',
    'token_type = "Bearer"',
    'const TOKEN_URL = "https://example.com/oauth/token";',
    'password: "changeme"',
    'error = "invalid_token"',
    'const state = "authorization_pending";',
    '"password": ""',
    'secret_name = "my-secret-name"',
    'const maxTokens = 4096;',
    'token_limit = 100000000',
    'password = getpass()',
    'token = self.token_value',
    'integrity "sha512-' + filler(60) + '"',
    "sha = 9fceb02d0ae598e95dc970b74767f19372d61af8",
    'id = "123e4567-e89b-12d3-a456-426614174000"',
    'const msg = "Invalid token provided, please sign in again";',
    "password: [REDACTED]",
  ])("keeps %s", (line) => {
    expect(redactSecrets(line)).toBe(line);
  });
});

describe("redactSecretsDetailed: structure, traceability and no secondary leaks", () => {
  const pw = fake.password();
  const text = [
    "line one",
    `const password = "${pw}";`,
    "line three",
    fake.pemHeader(),
    ...fake.privateKeyBody(),
    fake.pemFooter(),
    `token = "${fake.github()}"`,
  ].join("\n");

  it("keeps the line count and leaves non-secret lines byte-identical", () => {
    const { text: out } = redactSecretsDetailed(text);
    const before = text.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length);
    for (const i of [0, 2, 3, 7]) expect(after[i]).toBe(before[i]);
  });

  it("reports the kind and the 1-based input line, never the value", () => {
    const { findings } = redactSecretsDetailed(text);
    expect(findings).toEqual([
      { kind: "secret_assignment", line: 2 },
      { kind: "private_key", line: 4 },
      { kind: "provider_key", line: 9 },
    ]);
    const serialised = JSON.stringify(findings);
    expect(serialised).not.toContain(pw);
    expect(serialised).not.toContain("ghp_");
  });

  it("produces a log-safe summary with no values", () => {
    const summary = describeRedactions(redactSecretsDetailed(text).findings);
    expect(summary).toMatch(/3 redaction/);
    expect(summary).toMatch(/private_key/);
    expect(summary).not.toContain(pw);
    expect(describeRedactions([])).toBe("no redactions");
  });

  it("preserves CRLF line endings", () => {
    const out = redactSecrets(`a\r\npassword = "${pw}"\r\nb\r\n`);
    expect(out).toBe('a\r\npassword = "[REDACTED]"\r\nb\r\n');
  });

  it("is idempotent: redacting the output finds nothing more", () => {
    const first = redactSecretsDetailed(text);
    const second = redactSecretsDetailed(first.text);
    expect(second.findings).toEqual([]);
    expect(second.text).toBe(first.text);
  });

  it("is deterministic", () => {
    expect(redactSecretsDetailed(text)).toEqual(redactSecretsDetailed(text));
  });

  it("returns frozen results", () => {
    const result = redactSecretsDetailed(text);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
  });
});
