# Trusted preparation image: builds the sanitised reviewer workspace from a raw checkout.
# It holds no credentials and runs with no network (see the compose files).
FROM node:22-slim
# git: `prepare` pins revisions and regenerates the diff itself. The checkout is a read-only mount owned by another
# user, so git must be told to trust it (system-wide, inside this network-less container).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.build.json
CMD ["node", "dist/workspace/cli.js"]
