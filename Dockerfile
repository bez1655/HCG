# --- Dockerfile for Hapstore Cyberpunk Board Game (Frontend + Backend) ---

FROM node:24-slim AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies (including dev deps needed for the build)
RUN npm ci

# Copy application source
COPY . .

# Build client SPA and bundle server into dist/server.cjs
RUN npm run build

# Production runtime stage
FROM node:24-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Copy dependency manifests and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled dist bundle and static public files.
# NOTE: firebase-applet-config.json is intentionally NOT copied — Firebase
# credentials are provided through environment variables at runtime.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Writable state directory owned by the unprivileged runtime user
RUN mkdir -p /app/data && chown -R node:node /app

# Drop root privileges
USER node

EXPOSE 3000

CMD ["node", "dist/server.cjs"]
