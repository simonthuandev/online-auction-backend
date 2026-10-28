# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
FROM base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
FROM dependencies AS development
ARG SERVICE_NAME
COPY nest-cli.json tsconfig*.json ./
COPY scripts ./scripts
COPY contracts ./contracts
COPY libs ./libs
COPY apps/${SERVICE_NAME}-service ./apps/${SERVICE_NAME}-service
RUN node scripts/platform/db.mjs generate ${SERVICE_NAME} && mkdir -p dist && chown -R node:node dist node_modules/@prisma/client
ENV SERVICE_NAME=${SERVICE_NAME}
USER node
CMD ["node", "scripts/platform/service.mjs", "watch"]
FROM dependencies AS build
ARG SERVICE_NAME
COPY nest-cli.json tsconfig*.json ./
COPY scripts ./scripts
COPY contracts ./contracts
COPY libs ./libs
COPY apps/${SERVICE_NAME}-service ./apps/${SERVICE_NAME}-service
RUN node scripts/platform/db.mjs generate ${SERVICE_NAME} && npx nest build ${SERVICE_NAME}-service
FROM base AS production-dependencies
COPY package.json package-lock.json ./
# npm can retain optional Prisma CLI/TypeScript peers from the monorepo lockfile.
# The generated per-service client copied below already contains its query engine.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --omit=peer --omit=optional && node -e "const fs=require('fs');for(const p of ['typescript','prisma','@prisma/engines'])fs.rmSync('node_modules/'+p,{recursive:true,force:true})"
FROM dependencies AS migration
ARG SERVICE_NAME
COPY scripts ./scripts
COPY apps/${SERVICE_NAME}-service/prisma ./apps/${SERVICE_NAME}-service/prisma
ENV SERVICE_NAME=${SERVICE_NAME}
USER node
CMD ["node", "scripts/platform/service.mjs", "migrate"]
FROM base AS runtime
ARG SERVICE_NAME
ENV NODE_ENV=production SERVICE_NAME=${SERVICE_NAME}
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/node_modules/@prisma/client/${SERVICE_NAME} ./node_modules/@prisma/client/${SERVICE_NAME}
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node scripts/platform/service.mjs scripts/platform/service.mjs
USER node
CMD ["node", "scripts/platform/service.mjs", "run"]
