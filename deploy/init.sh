#!/usr/bin/env bash
# Orca 自托管部署 · 一键初始化：检查环境 + 生成 .env（域名 + 随机密钥）。
#
# 用法：
#   ./init.sh                    # 交互式，询问域名
#   ./init.sh relay.example.com  # 直接指定域名（不含 https://）
set -euo pipefail
cd "$(dirname "$0")"

# ---------- 0. 环境检查 ----------
if ! command -v docker >/dev/null 2>&1; then
  echo "✖ 未检测到 docker，请先安装 Docker Engine：https://docs.docker.com/engine/install/"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "✖ 未检测到 docker compose 插件（docker compose 子命令）"
  exit 1
fi

# ---------- 1. 域名 ----------
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  read -r -p "请输入部署域名（如 relay.example.com，不含 https://）: " DOMAIN
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr -d '[:space:]')"
if [ -z "$DOMAIN" ]; then
  echo "✖ 域名不能为空"
  exit 1
fi
case "$DOMAIN" in
  *://*)
    echo "✖ 只填裸域名，不要带 https:// 前缀"
    exit 1
    ;;
esac

# ---------- 2. 已有 .env 保护 ----------
if [ -f .env ]; then
  echo "⚠ .env 已存在，重新生成会覆盖其中的配置（data/ 目录中的账号与密钥不受影响）。"
  read -r -p "确认覆盖？输入 yes 继续: " CONFIRM
  if [ "${CONFIRM}" != "yes" ]; then
    echo "已取消。"
    exit 0
  fi
fi

# ---------- 3. 生成随机密钥 ----------
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}
ASSIGNMENT_KEY="$(rand_hex)"

# ---------- 4. 数据目录（SQLite / 密钥直接落盘，便于查看与备份） ----------
DATA_DIR="./data"
mkdir -p "${DATA_DIR}/auth" "${DATA_DIR}/relay"
# 容器内以 node 用户（uid 1000）运行；Linux 上若以 root 执行初始化则预置归属，
# 非 root 也无妨：容器启动时会自行修复绑定目录的归属。
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 "${DATA_DIR}/auth" "${DATA_DIR}/relay" 2>/dev/null || true
fi

# ---------- 5. 写 .env（权限 600） ----------
cat > .env <<EOF
# Orca 自托管部署配置（由 init.sh 生成）
# ⚠ 本文件含密钥，勿提交到 git / 勿外发。

# 客户端访问的完整 origin：由宿主机 Nginx 终结 TLS 后转发（https、不带路径/尾斜杠）。
# 桌面端会做 canonical origin 校验，且它逐字节用作 token issuer（须与 Nginx 访问域名一致）。
ORCA_RELAY_PUBLIC_URL=https://${DOMAIN}

# relay 的 assignment 签名密钥（≥32 字节 hex）
ORCA_RELAY_ASSIGNMENT_SIGNING_KEY=${ASSIGNMENT_KEY}

# 对外端口：宿主机 Nginx 转发到本端口（容器内固定 8080）
ORCA_AUTH_PORT=8080

# 数据目录（两个 SQLite 库 / auth 签名密钥都落在这里）
# 相对路径基于本目录（默认 ./data），也可改为绝对路径（如 /srv/orca/data）；
# 备份 = 直接打包复制该目录。
ORCA_DATA_DIR=./data

# 镜像名（compose 直接引用，不做本地编译；构建用 ./build.sh）
# 单仓库双 tag：orca:relay / orca:auth 是滚动 tag；build.sh 另打版本 tag
# （orca:relay-v1.4.237），部署建议钉版本 tag。也可改为私有仓库完整地址，例如：
#   ORCA_RELAY_IMAGE=swr.cn-east-3.myhuaweicloud.com/xryf/orca:relay-v1.4.237
#   ORCA_AUTH_IMAGE=swr.cn-east-3.myhuaweicloud.com/xryf/orca:auth-v1.4.237
ORCA_RELAY_IMAGE=orca:relay
ORCA_AUTH_IMAGE=orca:auth

# 组织名（客户端显示用，可选修改）
# ORCA_AUTH_ORG_ID=team
# ORCA_AUTH_ORG_NAME=Team

# 构建镜像时的 npm registry（国内服务器可换成镜像源加速）
# NPM_REGISTRY=https://registry.npmmirror.com
EOF
chmod 600 .env

# ---------- 6. 完成提示 ----------
echo ""
echo "✔ 初始化完成：deploy/.env 已生成（域名 ${DOMAIN}）"
echo ""
echo "下一步："
echo "  1. 准备镜像（二选一）："
echo "       本机构建：  ./build.sh"
echo "       已有镜像：  把 .env 里 ORCA_RELAY_IMAGE / ORCA_AUTH_IMAGE 改成仓库地址后 docker login"
echo "  2. 启动："
echo "       docker compose up -d"
echo "  3. 在宿主机 Nginx 上配置转发（要点见 deploy/nginx.example.conf）："
echo "       https://${DOMAIN}  →  http://127.0.0.1:8080（ORCA_AUTH_PORT）"
echo "       必须转发 WebSocket 升级头（/v1/connect 长连接）与 X-Forwarded-For（登录限速按真实 IP）"
echo "  4. 验证："
echo "       curl https://${DOMAIN}/.well-known/jwks.json"
echo "  5. 给成员建号（自动生成初始密码 + 交付信息，可直接转发）："
echo "       ./orca-auth user add --email alice@team.com --name \"李静\""
echo ""
echo "数据与备份："
echo "  数据目录：deploy/data/（两个 SQLite 库、auth 密钥可直接查看）"
echo "  备份：    tar czf orca-data-\$(date +%F).tgz data/"
echo ""
echo "常用命令："
echo "  ./orca-auth user list                 查看用户"
echo "  ./orca-auth device list               查看已连接的电脑"
echo "  docker compose logs -f relay          查看 relay 日志"
echo "  docker compose logs -f auth           查看 auth 日志"
