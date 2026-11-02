# Multi-stage Dockerfile for the You.com MCP Server Apify Actor (Standby mode).
#
# Bun is used directly rather than compiled into a standalone binary so the
# Apify SDK keeps full Node runtime compatibility (dynamic requires, native
# optional deps).

FROM oven/bun:1.4.2 AS deps

WORKDIR /app

COPY package.json bun.lock ./

# --ignore-scripts keeps git hooks and other install-time side effects out of
# the image; nothing in this project needs them.
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.2 AS production

WORKDIR /app

# Run as a non-root user.
RUN groupadd --system --gid 1001 bunuser \
    && useradd --system --uid 1001 --gid bunuser --no-create-home bunuser

COPY --from=deps --chown=bunuser:bunuser /app/node_modules ./node_modules
COPY --chown=bunuser:bunuser package.json ./
COPY --chown=bunuser:bunuser src/ ./src/

ENV NODE_ENV=production
# Apify sets ACTOR_WEB_SERVER_PORT at runtime; this is only a documentation
# default matching the SDK's local fallback.
ENV ACTOR_WEB_SERVER_PORT=4321
EXPOSE 4321

USER bunuser

CMD ["bun", "src/main.ts"]
