FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.mjs ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/palette-engine/package.json packages/palette-engine/package.json
COPY packages/pattern-engine/package.json packages/pattern-engine/package.json
RUN pnpm install --frozen-lockfile --filter @beadflow/api...
COPY apps/api apps/api
COPY packages/shared-types packages/shared-types
COPY packages/palette-engine packages/palette-engine
COPY packages/pattern-engine packages/pattern-engine
COPY assets/palettes assets/palettes
RUN pnpm --filter @beadflow/api build

FROM node:22-alpine
WORKDIR /app/apps/api
ENV NODE_ENV=production
ENV MARD_PALETTE_PATH=/app/assets/palettes/mard221.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/assets /app/assets
EXPOSE 3001
CMD ["node", "dist/server.js"]
