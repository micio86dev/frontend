# Multi-stage Dockerfile — frontend (Nuxt 4 SSR)
#
# Stage 1: Build — Bun 1.3 installs dependencies and runs nuxt build
# Stage 2: Runtime — Node 24 LTS serves the Nitro node-server output
#
# Per D17 (non-root, healthchecked, small final image) and D18 (Bun build → Node SSR).

# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM oven/bun:1.3.14 AS builder

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Sentry source-map upload credentials. These are BUILD-time only: nuxt.config.ts
# gates the upload on `Boolean(process.env['SENTRY_AUTH_TOKEN'])`, and a Docker
# build sees only what is declared as ARG. With none declared, the gate read
# false on every build and the upload never ran — silently, because a disabled
# upload is not an error. The symptom appears much later and somewhere else: a
# minified stack trace in Sentry on the one exception you actually needed.
#
# All three are required together (org + project + token); any one missing
# disables the upload. No defaults and no guard: a build without them is
# legitimate and must keep working — it simply ships without source maps.
#
# SENTRY_AUTH_TOKEN is a real secret, unlike the NUXT_PUBLIC_* values. It is
# declared HERE, in the builder stage, and deliberately never in the runtime
# stage: this is a multi-stage build and only /app/.output is copied forward,
# so the token cannot reach the published image or its history.
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ENV SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN}
ENV SENTRY_ORG=${SENTRY_ORG}
ENV SENTRY_PROJECT=${SENTRY_PROJECT}

# Build the Nuxt SSR app (Nitro preset: node-server)
RUN bun run build

# Assert the source maps were actually uploaded when credentials were supplied.
# Same reasoning as the bundle assertions elsewhere in this repo: proving the
# arg arrived is a different check from proving it had an effect, and the second
# failure is just as invisible from the outside as the first.
RUN if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      test -n "$SENTRY_ORG" && test -n "$SENTRY_PROJECT" || { \
        echo "ERROR: SENTRY_AUTH_TOKEN was supplied but SENTRY_ORG and/or SENTRY_PROJECT are empty."; \
        echo "  All three are required together; the upload silently no-ops otherwise."; \
        exit 1; \
      }; \
    fi

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:24.11-slim AS runtime

WORKDIR /app

# Create a non-root user
RUN addgroup --system --gid 1001 nuxtgroup \
  && adduser --system --uid 1001 --ingroup nuxtgroup nuxtuser

# Copy only the Nitro server output from the builder
COPY --from=builder --chown=nuxtuser:nuxtgroup /app/.output ./

# Switch to non-root
USER nuxtuser

EXPOSE 3000

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# The /api suffix is PART OF THE BASE (AGENTS.md, .env.example, backoffice/Dockerfile,
# docker-compose.yml). Composables append paths like /candidate/interview/start to it.
# Read at runtime by Nitro, so docker-compose / Railway can override it per environment.
ARG NUXT_PUBLIC_API_BASE=http://localhost:8000/api
ENV NUXT_PUBLIC_API_BASE=${NUXT_PUBLIC_API_BASE}

# Health check against the Nuxt health page
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const h = require('http'); h.get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server/index.mjs"]
