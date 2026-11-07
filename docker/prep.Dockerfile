# Trusted preparation image: builds the sanitised reviewer workspace from a raw checkout.
# It holds no credentials and runs with no network (see compose.workspace.yml).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.build.json
CMD ["node", "dist/workspace/cli.js"]
