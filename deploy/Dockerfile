# Orca 自托管部署镜像：官方 relay 产物 + 自研 auth 同容器（node:24-alpine）。
#
# 构建方式与官方 cloud/apps/relay/Dockerfile 及社区生产版（orca-railway）完全一致，
# 差异只有两处：构建上下文用本地仓库（不依赖容器内访问 GitHub），
# 以及把 auth/*.mjs 打包进 /app/auth，由 server.mjs 在同容器内拉起 relay 子进程。
#
# 手工构建（在仓库根目录执行）：
#   docker build -f deploy/Dockerfile -t orca-relay:local .
# 国内服务器可加：--build-arg NPM_REGISTRY=https://registry.npmmirror.com
# 常规方式直接用 deploy/docker-compose.yml（推荐）。

# ---------- Stage 1: 构建 relay（步骤对齐官方 Dockerfile） ----------
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
# 国内服务器可传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com 加速
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN pnpm config set registry "$NPM_REGISTRY"
COPY cloud/package.json cloud/pnpm-lock.yaml cloud/pnpm-workspace.yaml cloud/tsconfig.base.json ./
COPY cloud/packages/relay-contract/package.json packages/relay-contract/package.json
COPY cloud/packages/postgres-schema/package.json packages/postgres-schema/package.json
COPY cloud/apps/relay/package.json apps/relay/package.json
RUN pnpm install --frozen-lockfile --filter @orca-cloud/relay...
COPY cloud/packages/relay-contract packages/relay-contract
COPY cloud/packages/postgres-schema packages/postgres-schema
COPY cloud/apps/relay apps/relay
RUN pnpm --filter @orca-cloud/postgres-schema build && pnpm --filter @orca-cloud/relay-contract build && pnpm --filter @orca-cloud/relay build

# ---------- Stage 2: 运行时 ----------
FROM node:24-alpine
WORKDIR /app
RUN corepack enable && apk add --no-cache su-exec
ENV NODE_ENV=production \
    PORT=8080 \
    AUTH_DATA_DIR=/data/auth \
    ORCA_RELAY_DATA_DIR=/data/relay
# 生产依赖（relay 的运行依赖）
COPY cloud/package.json cloud/pnpm-lock.yaml cloud/pnpm-workspace.yaml ./
COPY cloud/packages/relay-contract/package.json packages/relay-contract/package.json
COPY cloud/packages/postgres-schema/package.json packages/postgres-schema/package.json
COPY cloud/apps/relay/package.json apps/relay/package.json
COPY --from=build /app/packages/relay-contract/dist packages/relay-contract/dist
COPY --from=build /app/packages/postgres-schema/dist packages/postgres-schema/dist
COPY --from=build /app/apps/relay/dist apps/relay/dist
RUN pnpm install --prod --frozen-lockfile --filter @orca-cloud/relay...
# 自研 auth：三个零依赖 .mjs，复制即运行，无构建步骤
COPY auth /app/auth
EXPOSE 8080
# 数据卷以 root 挂载：入口先确保目录存在并归属 node，再降权运行
# （--disable-warning=ExperimentalWarning 关闭 node:sqlite 的实验性提示）
CMD ["sh", "-c", "mkdir -p /data/auth /data/relay && chown -R node:node /data && exec su-exec node node --disable-warning=ExperimentalWarning /app/auth/server.mjs"]
