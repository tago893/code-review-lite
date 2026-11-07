# Reviewer image. It contains NO repository content: /repo and /review/context are read-only mounts of the
# sanitised snapshot built by the prep container, and the raw checkout is never mounted here.
FROM node:22-slim
# ripgrep: OpenCode's grep/glob tools shell out to it and would otherwise try to download it (no internet here).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/spike
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund opencode-ai @opencode-ai/sdk \
 && npm ls --depth=0 > /opt/spike/versions.txt

ENV PATH=/opt/spike/node_modules/.bin:$PATH
USER node
WORKDIR /repo
CMD ["sh"]
