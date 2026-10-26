# Orca 自托管部署手册（Runbook）

> 适用：把 `relay + auth` 双容器部署到一台 Linux 服务器，10 人团队手机远程访问电脑。
> 全部命令在 **`deploy/` 目录**下执行。本文件与 `docker-compose.yml` / `init.sh` / `build.sh` 同源同版本（提交 `4c569ea7`，relay 上游 v1.4.237 + 761 提交）。

---

## 0. 现状核对（2026-10-22 实测）

| 核对项 | 结果 |
| --- | --- |
| 代码基线 | `main @ 4c569ea7`（已合并上游 v1.4.237 及其后 761 个提交），工作区干净 |
| 部署编排 | `deploy/` 13 个文件齐全，`docker compose config` 语法通过 |
| 镜像 | 本机已有 `orca-relay:latest`（243MB）/ `orca-auth:latest`（172MB） |
| 数据目录 | `deploy/data/{auth,relay}` 存在，SQLite + 签名密钥 + 交付存档可读 |
| 本地容器 | `orca-relay-1` / `orca-auth-1` 已停止（演示验证完毕） |
| 本地 `.env` | 仍是**演示配置**（`http://localhost:8080`），上服务器必须重新生成 |
| 已知干扰 | 本机 8080 被 `p2s-target-vuln` 占用，直接 `up -d` 会端口冲突 |

结论：**代码和编排可直接上线，只剩「准备服务器 → 生成正式 .env → 备好镜像 → 起服务 → 配 Nginx」五步。**

---

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| 服务器 | Linux（Debian 12 / Ubuntu 22.04+ / Rocky 9），2C4G 起，磁盘 ≥ 20G |
| Docker | Engine 24+ 且带 `docker compose` 子命令（`docker compose version` 有输出） |
| 域名 | 一条 A 记录指向服务器公网 IP，如 `relay.yourteam.com` |
| 证书 | 有效 HTTPS 证书（certbot 或已有证书）；**打包版桌面端拒绝 http**，没有 https 客户端登不上 |
| Nginx | 宿主机已装并运行（本方案不内置 Caddy，TLS 由它终结） |
| 网络 | 外网只需放行 80 / 443；**不要**对公网开放 8080 |

---

## 2. 拿代码：二选一

**A. 只搬部署包（推荐——服务器不编译时用这个，几 KB）**

```bash
tar czf orca-deploy.tgz -C /path/to/orca deploy --exclude=deploy/data --exclude=deploy/.env
scp orca-deploy.tgz root@server:/srv/orca/ && ssh root@server 'tar xzf /srv/orca/orca-deploy.tgz -C /srv/orca'
```

**B. 服务器直接 clone（只有要在服务器上编译才需要）**

```bash
git clone --depth 1 git@github.com:aLoNeIT/orca.git /srv/orca   # 私有库需部署密钥/token
cd /srv/orca/deploy
```

---

## 3. 生成正式配置（必做，覆盖演示 .env）

```bash
cd /srv/orca/deploy
./init.sh relay.yourteam.com     # 只填裸域名，不带 https://
```

生成内容：`.env`（权限 600）+ `data/auth`、`data/relay` 目录。
它会写入 `ORCA_RELAY_PUBLIC_URL=https://<域名>` 和随机的 `ORCA_RELAY_ASSIGNMENT_SIGNING_KEY`。

> ⚠ 三个「逐字节一致」的硬约束，改错就登不上：
> 1. `ORCA_RELAY_PUBLIC_URL` = Nginx 上实际访问的域名 = 桌面端 `ORCA_RELAY_URL`；
> 2. 带 `https`、无尾斜杠、无路径；
> 3. 上线后再改域名，等于换 issuer，所有人的 token 全部失效（需重新登录）。

---

## 4. 备镜像：**服务器不必编译**

> 结论先说：服务器只要有 Docker，**不需要 Node、pnpm、源码，也不用跑 `build.sh`**。
> relay 是 TypeScript 编译产物，编译发生在**构建镜像时**，构建可以在任何一台有 Docker 的机器上做（你的 Windows 本机也行）。服务器只负责 `pull` + 运行。

| 方式 | 服务器需要什么 | 耗时 | 什么时候用 |
| --- | --- | --- | --- |
| ① **本地构建 + 推私有仓库**（推荐） | 只需 `docker login` + `pull` | 秒级 | 团队已有 SWR/ACR；要「本地验证过的镜像 = 线上跑的镜像」 |
| ② 服务器自己构建 | 源码 + Docker + 能访问 node/npm 源 | 2–3 分钟 | 服务器能出网、只有这一台机器、不想维护仓库 |
| ③ `docker save` 离线搬运 | 只解压 tar | 视带宽 | 服务器完全离线/内网 |

### 推荐路径：本地构建 → 推仓库 → 服务器只拉

```bash
# 1) 本地：镜像名写成仓库地址，并打版本 tag（别用 latest）
#    deploy/.env
#      ORCA_RELAY_IMAGE=swr.cn-east-3.myhuaweicloud.com/xryf/orca-relay:v1.4.237
#      ORCA_AUTH_IMAGE=swr.cn-east-3.myhuaweicloud.com/xryf/orca-auth:v1.4.237

# 2) 本地构建并推送（需先 docker login）
cd deploy && ./build.sh --push

# 3) 服务器：只拉不编
docker login swr.cn-east-3.myhuaweicloud.com
cd /srv/orca/deploy && docker compose pull && docker compose up -d
```

服务器上**最小部署包**（不构建就只要这几个文件，Dockerfile / build.sh / 源码都可以不搬）：

```
deploy/
├── docker-compose.yml
├── init.sh
├── orca-auth
├── nginx.example.conf
└── .env              ← init.sh 生成，含密钥，单独 scp，别走 git
```

### 方式②：确实想在服务器上编译

```bash
cd /srv/orca/deploy && ./build.sh        # 需要完整仓库（含 cloud/）
```

> 构建需要 Docker 能访问 Alpine 软件源与 npm 源；国内网络下 `apk` 偶发 `TLS: unspecified error`，**重跑一次即可**（实测第二次就过）。
> relay 的 pnpm 版本由 `cloud/package.json` 的 `packageManager`（当前 `pnpm@12`）决定，镜像里用 npm 直接安装，不走 corepack。

### 方式③：离线搬运

```bash
# 本地
docker save orca-relay:v1.4.237 orca-auth:v1.4.237 | gzip > orca-images.tgz
scp orca-images.tgz root@server:/srv/orca/
# 服务器
gunzip -c orca-images.tgz | docker load
```

> 三种方式都建议用**版本 tag**（`v1.4.237` 而不是 `latest`）：回滚就是 `.env` 改回旧 tag + `up -d`，代码不用动。
> 服务器自建镜像和本地镜像**不保证逐字节相同**（依赖解析、基础镜像浮动），所以「本地验过再推仓库」比「服务器现场编译」更可控。

---

## 5. 起服务

```bash
cd /srv/orca/deploy
docker compose up -d
docker compose ps                       # relay / auth 均应为 running
docker compose logs --tail=50 auth      # 无异常即可
```

自检（服务器本机，绕过 Nginx）：

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health   # 期望 200
```

---

## 6. Nginx + TLS

1. 把 `deploy/nginx.example.conf` 的 `map` 段放进 `http {}`（如 `/etc/nginx/conf.d/orca-upgrade.conf`），`server` 段放进 `sites-available`；
2. 改 `server_name`、证书路径、`proxy_pass` 端口（= `.env` 的 `ORCA_AUTH_PORT`，默认 8080）；
3. 没有证书就先签：

```bash
sudo certbot --nginx -d relay.yourteam.com
sudo nginx -t && sudo systemctl reload nginx
```

三个不能省的转发项：`Upgrade`/`Connection`（WebSocket 长连接）、`X-Forwarded-For`（登录限速按真实 IP，缺了会全员互相误伤）、`proxy_read_timeout 3600s`（默认 60s 会掐断手机连接）。

> 建议顺手加固：把 compose 里 auth 的端口改成只绑回环 `"127.0.0.1:${ORCA_AUTH_PORT:-8080}:8080"`，避免 8080 暴露公网。

---

## 7. 端到端验收

```bash
curl -fsS https://relay.yourteam.com/.well-known/jwks.json | head -c 200   # 应含 "kty":"EC"
curl -fsS https://relay.yourteam.com/v1/regions                            # 反代到 relay 正常
curl -fsS -o /dev/null -w '%{http_code}\n' https://relay.yourteam.com/health
```

三项都过 = auth 与 relay 容器网络、JWKS 互信、Nginx 反代全通。

---

## 8. 建号 + 交付

```bash
./orca-auth user add --email alice@team.com --name "李静"
```

输出即**可直接转发的交付文案**（初始密码 + 电脑端 3 条环境变量 + 手机配对步骤），同时存档在 `data/auth/onboarding/alice@team.com.txt`。

成员侧三步（文案里已含）：

| 步骤 | 操作 |
| --- | --- |
| 1 电脑端 | `setx ORCA_CLOUD_API_URL "https://域名"` / `setx ORCA_RELAY_URL "https://域名"` / `setx ORCA_CLOUD_CLIENT_ID "orca-desktop"`，然后**完全退出** Orca 重开（macOS 用 `launchctl setenv`） |
| 2 登录 | Orca → 左侧 Orca Mobile → 选 Orca Relay → Sign in for Relay → 浏览器用邮箱 + 初始密码登录 |
| 3 手机 | 装 Orca Mobile → 扫电脑上的二维码完成配对 |

---

## 9. 日常运维

| 动作 | 命令 |
| --- | --- |
| 看日志 | `docker compose logs -f auth` / `-f relay` |
| 用户列表 / 重置密码 | `./orca-auth user list` / `./orca-auth user passwd --email x@y.com` |
| 停用账号 | `./orca-auth user disable --email x@y.com` |
| 已配对电脑 | `./orca-auth device list`（含配对手机数、最后活跃） |
| 全员强制重登 | `./orca-auth sessions revoke-all --confirm`（轮换签名密钥，所有人 token 失效） |
| 备份 | `docker compose stop && tar czf orca-data-$(date +%F).tgz data/ && docker compose start` |
| 升级（用仓库镜像，推荐） | 本地 `./build.sh --push` 推新 tag → 服务器改 `.env` 的 tag → `docker compose pull && docker compose up -d` |
| 升级（服务器自建镜像） | `git pull && ./build.sh && docker compose up -d` |
| 回滚 | `.env` 改回旧 tag → `docker compose up -d` |

**唯一不能丢的东西**：`deploy/data/`（两个 SQLite + `auth/keys/signing-key.pem` + 交付存档）。删了 = 账号和配对全没。

---

## 10. 常见坑（都踩过）

| 现象 | 原因 / 处理 |
| --- | --- |
| 桌面端提示「未配置登录」 | 打包版只认 https；用 http 域名或 localhost 会被 `allowLoopbackHttp` 判为未配置 |
| 登录 401 / token 校验失败 | `ORCA_RELAY_PUBLIC_URL` 与桌面端 `ORCA_RELAY_URL` 不一致（issuer 逐字节比对） |
| 手机扫码后连不上 | `ORCA_RELAY_PUBLIC_URL` 不是手机可达地址；或 Nginx 没转发 WS 升级头 |
| 全员频繁被限速 | Nginx 漏了 `X-Forwarded-For` |
| `up -d` 报端口占用 | 8080 被别的服务占（本机就有 `p2s-target-vuln`），改 `.env` 的 `ORCA_AUTH_PORT` |
| 数据目录权限报错 | 容器启动时会 `chown` 修复；仍失败则 `chown -R 1000:1000 data/` |

---

_文档与部署包同源维护：改动 `docker-compose.yml` / `init.sh` / `build.sh` 时同步更新本文件。_
