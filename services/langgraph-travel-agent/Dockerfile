# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 - install every dependency and compile TypeScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 - production dependencies only
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 3 - runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards SIGTERM, which Kubernetes relies on.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Seeded flight inventory. Swap for FLIGHT_REPOSITORY=postgres in production.
COPY --chown=node:node data ./data

# No secrets are baked in: SERPER_API_KEY, ANTHROPIC_API_KEY and DATABASE_URL
# are all supplied at runtime from the environment (a Kubernetes Secret).
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
