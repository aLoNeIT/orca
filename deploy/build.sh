#!/usr/bin/env bash
# 构建 Orca 的两个镜像（relay + auth），配合 docker-compose.yml 的「只引用镜像名」模式。
# compose 不做本地编译——镜像名在 .env 的 ORCA_RELAY_IMAGE / ORCA_AUTH_IMAGE 配置。
#
# 命名约定（单仓库双 tag）：orca:relay / orca:auth 是滚动 tag；
# 每次构建会额外打版本 tag orca:relay-v1.4.237 / orca:auth-v1.4.237，
# 部署时钉版本 tag、回滚只需改 .env 的 tag。
#
# 用法（在 deploy/ 目录）：
#   ./build.sh                          按 .env 里的镜像名构建（默认 orca:relay / orca:auth）
#   ./build.sh --push                   构建并推送滚动 tag + 版本 tag（需先 docker login）
#   ORCA_VERSION=1.4.238 ./build.sh     手动指定版本号（默认自动探测）
#
# 典型流程：
#   本机构建 + 推送私有仓库：  .env 镜像名改为仓库地址 → ./build.sh --push → 服务器 docker compose up -d
#   服务器直接构建：           服务器上 git clone 本仓库 → ./build.sh → docker compose up -d
#   离线搬运：                 docker save orca:relay-v1.4.237 orca:auth-v1.4.237 | gzip > orca-images.tgz
#                             服务器：gunzip -c orca-images.tgz | docker load
set -euo pipefail
cd "$(dirname "$0")"

PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "✖ 未知参数：$arg（支持：--push）" >&2; exit 1 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "✖ 未检测到 docker" >&2; exit 1; }

# 从 .env 读取镜像名（不 source 整个文件，容忍 CRLF；缺省用默认名）
env_value() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '\r' || true
}
RELAY_IMAGE="$(env_value ORCA_RELAY_IMAGE)"; RELAY_IMAGE="${RELAY_IMAGE:-orca:relay}"
AUTH_IMAGE="$(env_value ORCA_AUTH_IMAGE)"; AUTH_IMAGE="${AUTH_IMAGE:-orca:auth}"
NPM_REGISTRY="$(env_value NPM_REGISTRY)"; NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

# 版本号：ORCA_VERSION > 本地最新 v1.* tag > 根 package.json（服务器无 git 时走最后一项）
detect_version() {
  if [ -n "${ORCA_VERSION:-}" ]; then printf '%s' "${ORCA_VERSION#v}"; return; fi
  local tag
  tag="$(git -C .. tag --list 'v1.*' --sort=-v:refname 2>/dev/null | head -1 || true)"
  if [ -n "${tag}" ]; then printf '%s' "${tag#v}"; return; fi
  sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' ../package.json 2>/dev/null | head -1 || true
}
VERSION="$(detect_version)"

# orca:relay + 1.4.237 -> orca:relay-v1.4.237（镜像名带仓库前缀/端口也能正确拆分）
version_tag() {
  local image="$1" repo tag
  if [[ "${image##*/}" == *:* ]]; then
    repo="${image%:*}"; tag="${image##*:}"
  else
    repo="${image}"; tag="latest"
  fi
  printf '%s:%s-v%s' "${repo}" "${tag}" "${VERSION}"
}
RELAY_VERSION_IMAGE=""; AUTH_VERSION_IMAGE=""
if [ -n "${VERSION}" ]; then
  RELAY_VERSION_IMAGE="$(version_tag "${RELAY_IMAGE}")"
  AUTH_VERSION_IMAGE="$(version_tag "${AUTH_IMAGE}")"
else
  echo "⚠ 未探测到版本号，跳过版本 tag（可用 ORCA_VERSION=1.4.237 ./build.sh 指定）" >&2
fi

echo "==> 构建 auth 镜像：${AUTH_IMAGE}（上下文 auth/，无编译步骤）"
docker build -f Dockerfile.auth -t "${AUTH_IMAGE}" ../auth

echo "==> 构建 relay 镜像：${RELAY_IMAGE}（首次构建约 1-3 分钟，npm 源 ${NPM_REGISTRY}）"
docker build -f Dockerfile.relay --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" -t "${RELAY_IMAGE}" ..

if [ -n "${RELAY_VERSION_IMAGE}" ]; then
  docker tag "${RELAY_IMAGE}" "${RELAY_VERSION_IMAGE}"
  docker tag "${AUTH_IMAGE}" "${AUTH_VERSION_IMAGE}"
fi

if [ "${PUSH}" = "1" ]; then
  echo "==> 推送镜像（需已 docker login）"
  docker push "${RELAY_IMAGE}"
  docker push "${AUTH_IMAGE}"
  if [ -n "${RELAY_VERSION_IMAGE}" ]; then
    docker push "${RELAY_VERSION_IMAGE}"
    docker push "${AUTH_VERSION_IMAGE}"
  fi
fi

echo ""
echo "✔ 镜像就绪："
echo "   滚动 tag： ${RELAY_IMAGE}    ${AUTH_IMAGE}"
[ -n "${RELAY_VERSION_IMAGE}" ] && echo "   版本 tag： ${RELAY_VERSION_IMAGE}    ${AUTH_VERSION_IMAGE}"
echo ""
echo "下一步：docker compose up -d"
