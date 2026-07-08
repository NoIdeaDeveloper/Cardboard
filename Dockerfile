# ── Build stage: bundle and minify frontend assets ────────────────────────────
FROM node:20-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY build.js ./
COPY frontend/ ./frontend/
RUN node build.js

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM python:3.12.9-slim

# Prevent Python from buffering stdout/stderr and writing .pyc files
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATABASE_URL=sqlite:////app/data/cardboard.db \
    FRONTEND_PATH=/app/frontend

WORKDIR /app

# Install dependencies first (separate layer for better cache reuse)
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Install curl for the Docker health check
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Copy backend source
COPY backend/ ./

# Copy the built (hashed + minified) frontend from the build stage
COPY --from=build /build/frontend/dist /app/frontend

# Pre-create the data directory; the Docker volume will be mounted here at runtime
RUN mkdir -p /app/data

# Run as a non-root user for better security
RUN useradd --system --no-create-home --uid 1000 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

# Run migrations then start the server
# --access-log is omitted: the app's log_requests middleware handles API logging
# with share-token redaction. Uvicorn's access log would log unredacted tokens.
CMD alembic upgrade head && \
    uvicorn main:app \
      --host 0.0.0.0 \
      --port 8000 \
      --log-level info
