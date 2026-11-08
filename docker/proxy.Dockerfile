FROM node:22-slim
WORKDIR /app
COPY docker/proxy/server.mjs /app/server.mjs
# /logs exists so a test run can mount a volume there for the request log; it is empty and unused otherwise.
RUN mkdir -p /logs && chown node:node /logs
USER node
CMD ["node", "/app/server.mjs"]
