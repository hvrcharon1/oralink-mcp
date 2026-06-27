# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Create the persistent data directory and hand ownership to the non-root user
RUN mkdir -p .data && chown -R node:node .data

# Run as non-root
USER node

# Mount a volume here to persist connections across container restarts:
#   docker run -v oralink_data:/app/.data ...
# or via docker-compose.yml volumes block (see docker-compose.yml).
VOLUME ["/app/.data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
