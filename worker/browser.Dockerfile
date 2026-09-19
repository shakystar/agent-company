FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
WORKDIR /app
RUN npm install --prefix /app --save-exact --ignore-scripts --no-audit --no-fund playwright@1.63.0 \
    && node /app/node_modules/playwright/cli.js install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /app /opt/playwright-browsers
COPY --chown=root:root browser.mjs /app/browser.mjs
USER node
ENV HOME=/tmp TMPDIR=/tmp LANG=C.UTF-8
ENTRYPOINT ["node", "/app/browser.mjs"]
