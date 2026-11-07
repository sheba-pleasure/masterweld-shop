# Интернет-магазин «Мастер Сварщик» — standalone Node.js образ (вне Lovable).
# Сборка: docker build --build-arg GIT_SHA=<40-hex> --build-arg VITE_SUPABASE_URL=... \
#   --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=... --build-arg VITE_SUPABASE_PROJECT_ID=... \
#   -t masterweld-shop:<40-hex> .
# В образ не попадают секреты: VITE_* — публичные ключи браузера, серверные
# ключи передаются только при запуске через --env-file (см. docs/WORKFLOW.md).

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install -g bun@1.2 && npm cache clean --force
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
ARG GIT_SHA
ARG VITE_APP_ENV
ARG PUBLIC_ORIGIN
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ENV GIT_SHA=$GIT_SHA \
    VITE_APP_ENV=$VITE_APP_ENV \
    PUBLIC_ORIGIN=$PUBLIC_ORIGIN \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID \
    NITRO_PRESET=node-server
# Vite использует собственную конфигурацию и upstream Nitro с пресетом node-server.
RUN node ops/check-independence.mjs && npx vite build && node ops/check-independence.mjs --built && test -f .output/server/index.mjs && node ops/runtime/write-manifest.mjs \
    && bun build src/lib/orders/notification-worker.server.ts --target=node --outfile=.output/order-notifications.mjs

FROM node:22-bookworm-slim AS runtime
ARG GIT_SHA
RUN test -n "$GIT_SHA" && echo "$GIT_SHA" | grep -Eq '^[0-9a-f]{40}$'
LABEL org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.title="masterweld-shop" \
      mw.capabilities.source-facts="1"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 RELEASE_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/ops/runtime ./ops/runtime
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/public/release-health').then(async r=>{const d=await r.json();if(!r.ok||d.ready!==true||d.revision!==process.env.RELEASE_SHA||d.environment!==process.env.APP_ENV)process.exit(1);const page=await fetch('http://127.0.0.1:3000/');process.exit(page.ok?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "ops/runtime/start.mjs"]
