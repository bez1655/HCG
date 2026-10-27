# --- Dockerfile for the HCG proxy harvester ---
#
# Same two-stage shape as the bot, for the same reason: a single-stage image
# that sets NODE_ENV=production before `npm ci` skips devDependencies, and the
# container then dies at runtime with "tsx: not found". Compiling to plain
# JavaScript means the runtime image needs no build tooling at all.

# ---------- build stage ----------
FROM node:24-slim AS builder

WORKDIR /app

# NODE_ENV deliberately unset: the build needs typescript from devDependencies.
COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime stage ----------
FROM node:24-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PROXY_DATA_DIR=/app/data

# CA certificates: every probe is an HTTPS request to api.telegram.org, and
# node:24-slim ships without a trust store. Without this the harvester would
# reject every proxy with UNABLE_TO_VERIFY_LEAF_SIGNATURE and report an empty
# list — indistinguishable from "no working proxies exist".
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "dist/main.js"]
