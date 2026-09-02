# Builds the SPA to static files. Caddy serves them; there is no Node at runtime.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @managedops/shared build && pnpm --filter @managedops/web build

FROM caddy:2.8-alpine AS runtime
COPY --from=build /app/apps/web/dist /srv
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
