# ─── Stage 1: deps + Prisma client ──────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
# Install deps without postinstall (we run prisma generate explicitly below)
COPY package*.json prisma.config.js ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts || npm install --ignore-scripts
RUN npx prisma generate --schema=./prisma/schema.prisma

# ─── Stage 2: runner ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
# openssl: required by the Prisma engine.
# tini:    proper PID 1 — forwards SIGTERM to Node (so the app's graceful
#          shutdown runs on redeploy) and reaps zombies.
RUN apk add --no-cache openssl tini
ENV NODE_ENV=production
# node_modules (incl. generated Prisma client at node_modules/.prisma/client)
COPY --from=deps /app/node_modules ./node_modules
# Source (node_modules / .env excluded via .dockerignore)
COPY . .
# App reads $PORT (Railway injects it) and falls back to 3000; EXPOSE is docs-only.
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
