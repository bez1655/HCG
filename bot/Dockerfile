# --- Dockerfile for the HCG Telegram bot ---
#
# Two stages. The builder compiles TypeScript to JavaScript; the runtime image
# then needs neither the compiler nor the TypeScript loader.
#
# Why this matters: the previous single-stage version set NODE_ENV=production
# *before* `npm ci`, which makes npm skip devDependencies. tsx lives there, and
# the container started with `tsx src/index.ts` — so the image built fine and
# then failed at runtime with "sh: 1: tsx: not found", restarting forever.
#
# Running compiled JavaScript removes that whole class of problem: the runtime
# has no build tooling at all, so it cannot be missing any.

# ---------- build stage ----------
FROM node:24-slim AS builder

WORKDIR /app

# NODE_ENV is deliberately NOT set here: the build needs devDependencies
# (typescript). Setting it to production would silently skip them.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Emit JavaScript into dist/
RUN npm run build

# ---------- runtime stage ----------
FROM node:24-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# Production dependencies only. Safe here: nothing in dist/ needs the compiler.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Writable state directory owned by the unprivileged runtime user
RUN mkdir -p /app/data && chown -R node:node /app

USER node

CMD ["node", "dist/index.js"]
