# Talos relay image (spec 11). Build from the REPOSITORY ROOT:
#   docker build -f apps/relay/Dockerfile -t talos-relay .
# Stage 1 installs and builds the web app and the relay bundle; stage 2 carries only the relay's runtime dependencies
# (better-sqlite3 is a native module, so it is installed for this exact base image), the bundle and the built web app.

FROM node:24-bookworm-slim AS build
ENV CI=1 PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# python3, make and g++ build better-sqlite3 (node-gyp) when pnpm installs it.
RUN corepack enable \
 && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relay/package.json apps/relay/
COPY apps/web/package.json apps/web/
COPY apps/bridge/package.json apps/bridge/
COPY packages/protocol/package.json packages/protocol/
COPY packages/integrations/package.json packages/integrations/
COPY packages/testkit/package.json packages/testkit/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile --filter @talos-app/relay... --filter @talos-app/web...

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/relay apps/relay
COPY apps/web apps/web
# One build-time version for /healthz, /api/me and the web app: pass --build-arg APP_VERSION=$(node scripts/version.mjs),
# or let the platform's commit sha (Railway sets RAILWAY_GIT_COMMIT_SHA) stand in.
ARG APP_VERSION
ARG RAILWAY_GIT_COMMIT_SHA
# Optional brand for the web build (a [data-brand] block in tokens.css and a public/brand folder); unset builds talos.
ARG VITE_BRAND
COPY scripts/version.mjs scripts/version.mjs
RUN export APP_VERSION="$(node scripts/version.mjs)" VITE_APP_VERSION="$(node scripts/version.mjs)" ${VITE_BRAND:+VITE_BRAND="$VITE_BRAND"} \
 && pnpm --filter @talos-app/web build && pnpm --filter @talos-app/relay build
# A self-contained folder with only the relay's production dependencies (native module included).
RUN pnpm --filter @talos-app/relay deploy --legacy --prod /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    TALOS_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/relay/dist ./dist
COPY --from=build /repo/apps/relay/migrations ./migrations
COPY --from=build /repo/apps/web/dist ./web
# /data is the Railway volume mount point (SQLite database and uploaded media). Railway mounts it at start-up, owned
# by root, and bans the VOLUME keyword: so start as root, hand /data to talos, then drop to talos for the process.
RUN groupadd --system --gid 10001 talos \
 && useradd --system --uid 10001 --gid talos --home-dir /app --shell /usr/sbin/nologin talos \
 && mkdir -p /data && chown -R talos:talos /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "chown -R talos:talos \"${DATA_DIR:-/data}\" && exec setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all node dist/index.js"]
