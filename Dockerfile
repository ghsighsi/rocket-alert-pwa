# ── Build stage ──
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Production stage ──
FROM node:20-alpine

LABEL maintainer="Idan"
LABEL description="Real-time Israeli Rocket Alert PWA"

# Security: non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application files
COPY package.json ./
COPY server.js ./
COPY public/ ./public/

# Set ownership
RUN chown -R appuser:appgroup /app

USER appuser

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3088}/api/config || exit 1

EXPOSE ${PORT:-3088}

CMD ["node", "--watch", "server.js"]
