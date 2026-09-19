FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.153.4
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --include=optional @openai/codex@${CODEX_VERSION} \
    && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}" \
    && mkdir -p /workspace /home/node/.codex \
    && chown -R node:node /workspace /home/node/.codex
WORKDIR /workspace
COPY --chown=root:root entry.mjs /app/entry.mjs
COPY --chown=root:root principles.mjs /app/principles.mjs
COPY --chown=root:root team-mcp.mjs /app/team-mcp.mjs
COPY --chown=root:root browser-source.mjs /app/browser-source.mjs
COPY --chown=root:root workspace.mjs /app/workspace.mjs
COPY --chown=root:root storage.mjs /app/storage.mjs
COPY --chown=root:root growth.mjs /app/growth.mjs
COPY --chown=root:root environment.mjs /app/environment.mjs
COPY --chown=root:root npm-empty.npmrc /app/npm-empty.npmrc
USER node
ENV HOME=/home/node CODEX_HOME=/home/node/.codex
ENTRYPOINT ["node", "/app/entry.mjs"]
