# Stage 1: Dependency & Source Build Stage
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy dependency specs
COPY backend/package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy backend source files
COPY backend/ .

# Stage 2: Production Runner Stage
FROM node:20-bookworm-slim AS runner

# Install curl for container health check
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed production dependencies and source from builder stage with node user ownership
COPY --chown=node:node --from=builder /app ./

# Ensure upload directory exists with write permissions for node user
RUN mkdir -p /app/guest-documents && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:5000/api/health || exit 1

CMD ["node", "server.js"]
