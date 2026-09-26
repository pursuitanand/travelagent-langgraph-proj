# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 - compile TypeScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

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

RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public

# This image holds no credentials at all - BACKEND_URL is the only
# configuration it needs, supplied at runtime from a ConfigMap.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
