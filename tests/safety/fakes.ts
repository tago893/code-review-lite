// Synthetic secrets only. Every value is assembled at runtime from fragments so that no secret-shaped
// string sits in the repository (and secret scanners have nothing to flag). None of these is a real credential.

/** Deterministic mixed-case alphanumeric filler of exactly `length` characters. */
export const filler = (length: number): string =>
  "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1eF3hJ5kL7nP9rS1uV3xY5zA7cD9fG1iJ3lM5oN7qR9tU1wX3yZ5".repeat(3).slice(0, length);

export const fake = {
  groq: (): string => "gsk_" + filler(52),
  openai: (): string => "sk-" + "proj-" + filler(40),
  anthropic: (): string => "sk-ant-" + "api03-" + filler(40),
  // The documented, publicly known AWS example access key id.
  aws: (): string => "AKIA" + "IOSFODNN7EXAMPLE",
  github: (): string => "ghp_" + filler(36),
  githubFineGrained: (): string => "github_pat_" + filler(30),
  slack: (): string => "xoxb-" + "123456789012-" + filler(24),
  google: (): string => "AIza" + filler(35),
  stripe: (): string => "sk_live_" + filler(24),
  npm: (): string => "npm_" + filler(36),
  gitlab: (): string => "glpat-" + filler(20),
  jwt: (): string => ["eyJ" + filler(20), "eyJ" + filler(24), filler(30)].join("."),
  password: (): string => "Sup3r" + "S3cret!" + "Pass",
  privateKeyBody: (): string[] => [filler(64), filler(64), filler(40)],
  pemHeader: (kind = "RSA "): string => "-----BEGIN " + kind + "PRIVATE KEY-----",
  pemFooter: (kind = "RSA "): string => "-----END " + kind + "PRIVATE KEY-----",
};
