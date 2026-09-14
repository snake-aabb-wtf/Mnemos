FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
RUN groupadd --system mnemos && useradd --system --gid mnemos --home-dir /app mnemos
COPY --from=build --chown=mnemos:mnemos /app /app
RUN mkdir -p /data/artifacts && chown -R mnemos:mnemos /data
USER mnemos
ENV MNEMOS_PROFILE=production \
    MNEMOS_DB_PATH=/data/mnemos.sqlite \
    MNEMOS_ARTIFACT_DIR=/data/artifacts \
    MNEMOS_LOG_LEVEL=info
VOLUME ["/data"]
CMD ["node", "apps/cli/dist/index.js"]
