#!/usr/bin/env bash
# 构建 Orca 的两个镜像（relay + auth），配合 docker-compose.yml 的「只引用镜像名」模式。
# compose 不做本地编译——镜像名在 .env 的 ORCA_RELAY_IMAGE / ORCA_AUTH_IMAGE 配置。
#
# 用法（在 deploy/ 目录）：
#   ./build.sh            按 .env 里的镜像名构建（默认 orca-relay:latest / orca-auth:latest）
#   ./build.sh --push     构建后推送到镜像仓库（需先 docker login）
#
# 典型流程：
#   本机构建 + 推送私有仓库：  改 .env 镜像名为仓库地址 → ./build.sh --push → 服务器 docker compose up -d
#   服务器直接构建：           服务器上 git clone 本仓库 → ./build.sh → docker compose up -d
#   离线搬运：                 docker save orca-relay:latest orca-auth:latest | gzip > orca-images.tgz
#                             服务器：gunzip -c orca-images.tgz | docker load
set -euo pipefail
cd "$(dirname "$0")"

PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "✖ 未知参数：$arg（支持：--push）" >&2; exit 1 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "✖ 未检测到 docker" >&2; exit 1; }

# 从 .env 读取镜像名（不 source 整个文件，容忍 CRLF；缺省用默认名）
env_value() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '\r' || true
}
RELAY_IMAGE="$(env_value ORCA_RELAY_IMAGE)"; RELAY_IMAGE="${RELAY_IMAGE:-orca-relay:latest}"
AUTH_IMAGE="$(env_value ORCA_AUTH_IMAGE)"; AUTH_IMAGE="${AUTH_IMAGE:-orca-auth:latest}"
NPM_REGISTRY="$(env_value NPM_REGISTRY)"; NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

echo "==> 构建 auth 镜像：${AUTH_IMAGE}（上下文 auth/，无编译步骤）"
docker build -f Dockerfile.auth -t "${AUTH_IMAGE}" ../auth

echo "==> 构建 relay 镜像：${RELAY_IMAGE}（首次构建约 1-3 分钟，npm 源 ${NPM_REGISTRY}）"
docker build -f Dockerfile.relay --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" -t "${RELAY_IMAGE}" ..

if [ "${PUSH}" = "1" ]; then
  echo "==> 推送镜像（需已 docker login）"
  docker push "${RELAY_IMAGE}"
  docker push "${AUTH_IMAGE}"
fi

echo ""
echo "✔ 镜像就绪："
echo "   ${RELAY_IMAGE}"
echo "   ${AUTH_IMAGE}"
echo ""
echo "下一步：docker compose up -d"
