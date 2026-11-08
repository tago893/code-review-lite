# Reviewer image. It contains NO repository content: /repo and /review/context are read-only mounts of the
# sanitised snapshot built by the prep container, and the raw checkout is never mounted here.
# It holds the compiled CLI, the prompts and the pinned OpenCode; it never holds a provider key.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:22-slim
# ripgrep: OpenCode's grep/glob tools shell out to it and would otherwise try to download it (no internet here).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# One install tree so the dynamic import of the SDK from dist/ resolves. Versions are the ones exercised in Task 0.
WORKDIR /opt/crl
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm install --no-save --no-audit --no-fund opencode-ai@1.19.5 @opencode-ai/sdk@1.19.5 \
 && npm ls --depth=0 > /opt/crl/versions.txt
COPY --from=build /app/dist ./dist
COPY prompts ./prompts
RUN mkdir -p /review/out && chown node:node /review/out

# Project config off: OpenCode must never load plugins, tools, MCP servers or AGENTS.md from the reviewed repository.
ENV PATH=/opt/crl/node_modules/.bin:$PATH
ENV OPENCODE_DISABLE_PROJECT_CONFIG=1
ENV OPENCODE_DISABLE_EXTERNAL_SKILLS=1
USER node
WORKDIR /repo
CMD ["sh"]
