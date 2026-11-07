FROM node:22-slim
# ripgrep: OpenCode's grep/glob tools shell out to it and would otherwise try to download it (no internet here).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/spike
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund opencode-ai @opencode-ai/sdk \
 && npm ls --depth=0 > /opt/spike/versions.txt

# Fixtures baked into the image (spike only; Task 0b uses real read-only mounts).
COPY fixtures/repo /repo
RUN ln -s /etc /repo/escape
# Boundary fix: strip any symlink whose real target is outside /repo BEFORE the agent starts.
# (OpenCode's permission globs match the lexical path, so a symlink inside /repo bypasses them.
#  In production this runs in the prep stage on the checkout, before the read-only mount.)
RUN find /repo -type l | while read -r l; do       t=$(realpath -m "$l");       case "$t" in /repo/*) ;; *) echo "removing escaping symlink $l -> $t"; rm "$l";; esac;     done
COPY fixtures/context /review/context
RUN mkdir -p /review/out

COPY agent/spike.mjs /opt/spike/spike.mjs
ENV PATH=/opt/spike/node_modules/.bin:$PATH
USER node
WORKDIR /repo
CMD ["node", "/opt/spike/spike.mjs"]
