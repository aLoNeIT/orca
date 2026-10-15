// Orca 自托管 Auth 契约服务（零 npm 依赖）。
//
// 一个公网端口承担四件事：
//   /.well-known/jwks.json   ES256 公钥（relay 验签 + 浏览器）
//   /v1/desktop/auth/*       官方桌面客户端契约端点（authorize/session/refresh/.../relay-token）
//   /account                 用户自助改密页
//   其余请求（HTTP + WebSocket）→ 反向代理到 loopback 上的 relay 子进程
//
// 管理能力收敛在 cli.mjs（无任何对外的 admin HTTP 接口）。
// 契约来源：桌面客户端 profile-cloud-client.ts / relay-http-client.ts，relay 侧 relay-token-verifier.ts。

import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as lib from './lib.mjs'

// ============================== 初始化 ==============================

const cfg = lib.loadConfig()
const db = lib.openDb(cfg.authDir)
const signingKey = lib.loadOrCreateSigningKey(cfg.authDir)
const assignmentKey = lib.resolveAssignmentKey(cfg)

const TTL_SEC = {
  access: 60 * 60,              // 1 小时
  refresh: 90 * 24 * 60 * 60,   // 90 天
  relay: 15 * 60                // 15 分钟（relay 侧建议值，客户端会自动续）
}
const REFRESH_GRACE_MS = 5 * 60_000 // refresh 重放宽限期
const LOOPBACK_CALLBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\/callback$/

// 时序均衡用假哈希：用户不存在时也跑一次 scrypt，避免"用户是否存在"被时序区分
const DUMMY_HASH = lib.hashPassword('timing-equalizer-dummy-password')

console.log(`[auth] public origin: ${cfg.publicUrl}`)
console.log(`[auth] data dir: ${cfg.authDir}, relay data dir: ${cfg.relayDataDir}`)

// ============================== relay 子进程 ==============================

let relay = null
let stopping = false
let restartDelayMs = 1000

const relayEntry = process.env.ORCA_RELAY_ENTRY || fileURLToPath(new URL('../apps/relay/dist/index.js', import.meta.url))

function relayEnv() {
  return {
    ...process.env,
    PORT: String(cfg.relayPort),
    NODE_ENV: 'production',
    ORCA_RELAY_ROLE: 'combined',
    ORCA_RELAY_PUBLIC_URL: cfg.publicUrl,
    ORCA_RELAY_CELL_URL: cfg.publicUrl,
    ORCA_RELAY_AUTH_ISSUER: cfg.publicUrl,
    ORCA_RELAY_AUTH_AUDIENCE: 'orca-relay',
    ORCA_RELAY_JWKS_URL: `http://127.0.0.1:${cfg.port}/.well-known/jwks.json`,
    ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: assignmentKey,
    // 占位值：官方 Google 身份校验的 admin 路由保持不可用（本部署不用官方运维功能）
    ORCA_RELAY_ADMIN_AUDIENCE: 'https://admin.invalid',
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'nobody@invalid.example',
    ORCA_RELAY_DATA_DIR: cfg.relayDataDir
  }
}

function startRelay() {
  if (!existsSync(relayEntry)) {
    console.warn(`[auth] relay 入口不存在（${relayEntry}），跳过启动。仅契约端点可用（开发/冒烟测试模式）。`)
    return
  }
  mkdirSync(cfg.relayDataDir, { recursive: true })
  const startedAt = Date.now()
  relay = spawn(process.execPath, [relayEntry], { stdio: 'inherit', env: relayEnv() })
  relay.on('error', (error) => console.error('[auth] relay 启动失败:', error.message))
  relay.on('exit', (code, signal) => {
    if (stopping) return
    if (Date.now() - startedAt < 10_000) restartDelayMs = Math.min(restartDelayMs * 2, 30_000)
    else restartDelayMs = 1000
    console.error(`[auth] relay 退出（code=${code} signal=${signal}），${restartDelayMs}ms 后重启`)
    setTimeout(startRelay, restartDelayMs)
  })
}

function shutdown(signal) {
  if (stopping) return
  stopping = true
  try {
    relay?.kill(signal)
  } catch {
    /* 忽略 */
  }
  setTimeout(() => process.exit(0), 2500).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ============================== HTTP 小工具 ==============================

function send(res, status, body, contentType) {
  const buf = Buffer.from(body)
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
  })
  res.end(buf)
}

const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json')
const sendHtml = (res, status, html) => send(res, status, html, 'text/html; charset=utf-8')

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' })
  res.end()
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const esc = (v) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'

const bearer = (req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null

// ============================== 登录限速（按邮箱 + 按 IP） ==============================

const throttleRecords = new Map()
const THROTTLE_BASE_MS = 2000
const THROTTLE_MAX_MS = 5 * 60_000
const THROTTLE_FREE_ATTEMPTS = 5

function throttleWait(keys) {
  const now = Date.now()
  let longest = 0
  for (const key of keys) {
    const rec = throttleRecords.get(key)
    if (rec && rec.blockUntil > now) longest = Math.max(longest, rec.blockUntil - now)
  }
  return longest
}

function throttleFail(keys) {
  const now = Date.now()
  for (const key of keys) {
    const rec = throttleRecords.get(key) ?? { count: 0, blockUntil: 0, lastAt: 0 }
    if (now - rec.lastAt > 60 * 60_000) rec.count = 0 // 一小时无失败则重新计数
    rec.count += 1
    rec.lastAt = now
    const delay =
      rec.count <= THROTTLE_FREE_ATTEMPTS
        ? THROTTLE_BASE_MS
        : Math.min(THROTTLE_BASE_MS * 2 ** (rec.count - THROTTLE_FREE_ATTEMPTS), THROTTLE_MAX_MS)
    rec.blockUntil = now + delay
    throttleRecords.set(key, rec)
  }
}

function throttleClear(keys) {
  for (const key of keys) throttleRecords.delete(key)
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000
  for (const [key, rec] of throttleRecords) {
    if (rec.blockUntil < cutoff && rec.lastAt < cutoff) throttleRecords.delete(key)
  }
  try {
    lib.purgeExpiredCodes(db)
  } catch {
    /* 忽略 */
  }
}, 10 * 60_000).unref()

// ============================== 会话/账户响应构建 ==============================

function buildAccount(user) {
  const now = Date.now()
  return {
    cloud: {
      cloudProfileId: user.id,
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      activeOrgId: cfg.orgId,
      activeOrgName: cfg.orgName,
      linkedAt: now
    },
    organizations: [{ orgId: cfg.orgId, name: cfg.orgName, role: 'Owner' }],
    // 只开 relay.use：share/team 会触发客户端调用本服务未实现的云 API
    capabilities: { flags: { 'relay.use': true }, refreshedAt: now }
  }
}

function buildSession(user) {
  const jti = lib.newJti()
  const familyId = lib.createFamily(db, user.id, jti)
  return issueSessionForFamily(user, familyId, jti)
}

function issueSessionForFamily(user, familyId, jti) {
  const accessToken = lib.signJwt(signingKey, cfg.publicUrl, { sub: user.id, typ: 'access', tv: user.token_version }, TTL_SEC.access)
  const refreshToken = lib.signJwt(
    signingKey,
    cfg.publicUrl,
    { sub: user.id, typ: 'refresh', jti, fam: familyId, tv: user.token_version },
    TTL_SEC.refresh
  )
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + TTL_SEC.access * 1000,
    ...buildAccount(user)
  }
}

/** Bearer access token 鉴权：签名 + iss + typ + exp + 用户状态 + token_version */
function authenticate(req) {
  const token = bearer(req)
  if (!token) return { user: null }
  const claims = lib.verifyJwt(signingKey, token, { iss: cfg.publicUrl, typ: 'access' })
  if (!claims) return { user: null }
  const user = lib.getUserById(db, claims.sub)
  if (!user || user.disabled) return { user: null }
  if (Number(claims.tv) !== Number(user.token_version)) return { user: null }
  return { user }
}

// ============================== 页面 ==============================

const BASE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #e7eaf6;
    background:
      radial-gradient(1100px 700px at 15% -10%, rgba(64, 96, 220, .38) 0%, rgba(64, 96, 220, 0) 60%),
      radial-gradient(900px 650px at 110% 115%, rgba(139, 92, 246, .32) 0%, rgba(139, 92, 246, 0) 55%),
      linear-gradient(160deg, #0b1020 0%, #101529 55%, #150f2a 100%);
  }
  .card {
    width: 100%; max-width: 392px; padding: 30px 28px 24px;
    background: linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.035));
    border: 1px solid rgba(255,255,255,.11); border-radius: 20px;
    box-shadow: 0 24px 70px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08);
    backdrop-filter: blur(14px);
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  .mark {
    width: 40px; height: 40px; border-radius: 13px; flex: none;
    background: linear-gradient(135deg, #5b7cfa, #8b5cf6 60%, #c084fc);
    box-shadow: 0 8px 22px rgba(99,102,241,.45), inset 0 1px 0 rgba(255,255,255,.35);
    display: flex; align-items: center; justify-content: center;
    font-size: 19px; font-weight: 700; color: #fff;
  }
  .t1 { font-size: 16px; font-weight: 650; letter-spacing: .2px; }
  .t2 { font-size: 12px; color: #9aa3c0; margin-top: 2px; }
  h1 { font-size: 17px; margin: 0 0 6px; font-weight: 650; }
  p.sub { margin: 0 0 18px; font-size: 13px; color: #9aa3c0; line-height: 1.6; }
  form { display: flex; flex-direction: column; gap: 11px; }
  label { font-size: 12.5px; color: #b9c0d8; margin-bottom: -4px; }
  input {
    width: 100%; padding: 12px 14px; border-radius: 12px; font-size: 14px;
    border: 1px solid rgba(255,255,255,.14); background: rgba(8,12,26,.62); color: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  input::placeholder { color: #6b7392; }
  input:focus { outline: none; border-color: rgba(124,109,255,.85); box-shadow: 0 0 0 3px rgba(124,109,255,.22); }
  button {
    margin-top: 6px; width: 100%; padding: 12.5px; border: 0; border-radius: 12px; cursor: pointer;
    font-size: 14.5px; font-weight: 650; letter-spacing: .3px; color: #fff;
    background: linear-gradient(135deg, #5b7cfa, #8b5cf6);
    box-shadow: 0 10px 26px rgba(99,102,241,.4), inset 0 1px 0 rgba(255,255,255,.28);
    transition: filter .15s, transform .05s;
  }
  button:hover { filter: brightness(1.09); }
  button:active { transform: translateY(1px); }
  .msg { padding: 10px 13px; border-radius: 12px; font-size: 13px; line-height: 1.55; margin-bottom: 14px; }
  .err { background: rgba(239,68,68,.13); border: 1px solid rgba(239,68,68,.38); color: #fca5a5; }
  .ok { background: rgba(34,197,94,.12); border: 1px solid rgba(34,197,94,.36); color: #86efac; }
  .foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.08);
    display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .mut { font-size: 12px; color: #8b93b0; line-height: 1.6; margin: 0; }
  a { color: #a5b4ff; text-decoration: none; font-size: 12.5px; }
  a:hover { text-decoration: underline; }
  .center { text-align: center; }
`

function layout({ title, body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'">
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
${body}
</body>
</html>`
}

function brand() {
  return `<div class="brand">
  <div class="mark">O</div>
  <div><div class="t1">Orca 远程访问</div><div class="t2">${esc(cfg.publicUrl.replace(/^https?:\/\//, ''))}</div></div>
</div>`
}

function loginPage(params, { error = '', email = '' } = {}) {
  const hidden = new URLSearchParams(params)
  hidden.delete('password')
  hidden.delete('email')
  const hiddenHtml = [...hidden.entries()]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n')
  const redirectUri = params.get('redirect_uri') ?? ''
  const state = params.get('state') ?? ''
  const cancelUrl = redirectUri ? `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}` : ''
  return layout({
    title: 'Orca 远程访问 · 登录',
    body: `<main class="card">
${brand()}
<h1>连接这台电脑</h1>
<p class="sub">使用管理员发放的账号登录，登录后即可用手机远程访问这台电脑。</p>
${error ? `<div class="msg err">${esc(error)}</div>` : ''}
<form method="post" action="/v1/desktop/auth/authorize">
${hiddenHtml}
<label for="email">邮箱</label>
<input id="email" name="email" type="email" autocomplete="username" placeholder="you@example.com" value="${esc(email)}" required autofocus>
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" placeholder="登录密码" required>
<button type="submit">登录并连接</button>
</form>
<div class="foot">
  <p class="mut">忘记密码？联系管理员重置。</p>
  ${cancelUrl ? `<a href="${esc(cancelUrl)}">取消</a>` : ''}
</div>
</main>`
  })
}

function accountPage({ error = '', ok = '' } = {}) {
  return layout({
    title: 'Orca 远程访问 · 修改密码',
    body: `<main class="card">
${brand()}
<h1>修改密码</h1>
<p class="sub">验证当前密码后设置新密码。修改成功后，其他设备上已登录的 Orca 需要重新登录。</p>
${error ? `<div class="msg err">${esc(error)}</div>` : ''}
${ok ? `<div class="msg ok">${esc(ok)}</div>` : ''}
<form method="post" action="/account">
<label for="email">邮箱</label>
<input id="email" name="email" type="email" autocomplete="username" placeholder="you@example.com" required>
<label for="current">当前密码</label>
<input id="current" name="current" type="password" autocomplete="current-password" placeholder="当前登录密码" required>
<label for="next">新密码</label>
<input id="next" name="next" type="password" autocomplete="new-password" placeholder="至少 8 位" minlength="8" required>
<label for="confirm">重复新密码</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" placeholder="再输入一次" minlength="8" required>
<button type="submit">更新密码</button>
</form>
</main>`
  })
}

function errorPage(title, detail) {
  return layout({
    title: 'Orca 远程访问',
    body: `<main class="card center">
${brand()}
<div class="msg err">${esc(detail)}</div>
<p class="mut">${esc(title)}</p>
</main>`
  })
}

// ============================== /v1/desktop/auth/authorize ==============================

async function handleAuthorize(req, res, url) {
  const params = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : url.searchParams
  const redirectUri = params.get('redirect_uri') ?? ''

  // 严格校验（防开放重定向）：redirect_uri 仅允许桌面端本机回环回调
  if (
    params.get('response_type') !== 'code' ||
    !LOOPBACK_CALLBACK.test(redirectUri) ||
    params.get('code_challenge_method') !== 'S256' ||
    !params.get('code_challenge') ||
    !params.get('state')
  ) {
    return sendHtml(res, 400, errorPage('无效的登录请求', '登录参数不完整或不被接受（redirect_uri 仅允许本机 127.0.0.1 回调）。请从 Orca 客户端内重新发起登录。'))
  }

  if (req.method !== 'POST') return sendHtml(res, 200, loginPage(params))

  // POST：校验账号密码
  const email = lib.normalizeEmail(params.get('email'))
  const password = params.get('password') ?? ''
  const ip = clientIp(req)
  const throttleKeys = [`e:${email}`, `ip:${ip}`]

  const waitMs = throttleWait(throttleKeys)
  if (waitMs > 0) {
    lib.audit(db, email || ip, 'login.throttled', `ip=${ip}`)
    return sendHtml(res, 429, loginPage(params, { error: `尝试过于频繁，请约 ${Math.ceil(waitMs / 1000)} 秒后再试。`, email }))
  }

  const user = lib.getUserByEmail(db, email)
  // 无论用户是否存在都执行一次 scrypt（时序一致）
  const passwordOk = lib.verifyPassword(password, user ? user.password_hash : DUMMY_HASH)

  if (!user || !passwordOk || user.disabled) {
    throttleFail(throttleKeys)
    lib.audit(db, email || ip, 'login.failed', `ip=${ip} userExists=${Boolean(user)} disabled=${Boolean(user?.disabled)}`)
    const error = user?.disabled ? '该账号已被禁用，请联系管理员。' : '邮箱或密码不正确。'
    return sendHtml(res, 401, loginPage(params, { error, email }))
  }

  throttleClear(throttleKeys)
  const code = lib.createAuthCode(db, {
    userId: user.id,
    challenge: params.get('code_challenge'),
    redirectUri,
    nonce: params.get('nonce'),
    state: params.get('state')
  })
  lib.audit(db, user.email, 'login.authorize_ok', `ip=${ip}`)

  const to = new URL(redirectUri)
  to.searchParams.set('code', code)
  to.searchParams.set('state', params.get('state'))
  return redirect(res, to.toString())
}

// ============================== /v1/desktop/auth/* 其余端点 ==============================

async function handleAuthApi(req, res, url) {
  const op = url.pathname.slice('/v1/desktop/auth/'.length)
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })

  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    return sendJson(res, 400, { error: 'bad_request' })
  }
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad_request' })

  const ip = clientIp(req)

  // ---- PKCE 换票（无鉴权） ----
  if (op === 'session') {
    const entry = lib.consumeAuthCode(db, body.code)
    if (!entry || Number(entry.expires_at) < Date.now()) return sendJson(res, 400, { error: 'invalid_grant' })
    const challenge = lib.sha256b64u(String(body.codeVerifier ?? ''))
    if (entry.challenge !== challenge) return sendJson(res, 400, { error: 'invalid_grant' })
    if (entry.redirect_uri !== String(body.redirectUri ?? '')) return sendJson(res, 400, { error: 'invalid_grant' })
    if (entry.nonce && body.nonce && entry.nonce !== String(body.nonce)) return sendJson(res, 400, { error: 'invalid_grant' })
    if (entry.state && body.state && entry.state !== String(body.state)) return sendJson(res, 400, { error: 'invalid_grant' })
    const user = lib.getUserById(db, entry.user_id)
    if (!user || user.disabled) return sendJson(res, 400, { error: 'invalid_grant' })
    const payload = buildSession(user)
    lib.audit(db, user.email, 'auth.session_issued', `ip=${ip}`)
    return sendJson(res, 200, payload)
  }

  // ---- 换新票（refresh，无鉴权但有重放保护 + 宽限） ----
  if (op === 'refresh') {
    return handleRefresh(req, res, body, ip)
  }

  // ---- 注销（Bearer + refreshToken） ----
  if (op === 'logout') {
    const { user } = authenticate(req)
    if (!user) return sendJson(res, 401, { error: 'unauthorized' })
    // token 可能刚过期：签名对即可撤销
    const claims = lib.verifyJwt(signingKey, body.refreshToken, { iss: cfg.publicUrl, typ: 'refresh', ignoreExp: true })
    if (claims && claims.sub === user.id) {
      lib.revokeFamily(db, claims.fam)
      lib.audit(db, user.email, 'auth.logout', `ip=${ip}`)
    }
    return sendJson(res, 200, {})
  }

  // ---- 以下端点均要求 Bearer access token ----
  const { user } = authenticate(req)
  if (!user) return sendJson(res, 401, { error: 'unauthorized' })

  if (op === 'capabilities') return sendJson(res, 200, buildAccount(user))
  if (op === 'profile') return sendJson(res, 200, buildSession(user))
  if (op === 'org') return sendJson(res, 200, buildAccount(user))

  if (op === 'relay-token') {
    // 设备公钥绑定校验：relayHostId 必须等于 sha256(公钥原始字节) 前 16 字符
    const hostId = String(body.relayHostId ?? '')
    const derived = lib.deriveRelayHostId(body.hostPublicKeyB64)
    if (!derived || derived !== hostId) return sendJson(res, 400, { error: 'invalid_host' })

    const { error } = lib.claimHost(db, hostId, user.id)
    if (error === 'host_blocked') return sendJson(res, 403, { error: 'host_blocked' })
    if (error === 'host_claimed') return sendJson(res, 403, { error: 'host_claimed' })

    const relayToken = lib.signJwt(
      signingKey,
      cfg.publicUrl,
      {
        aud: 'orca-relay',
        sub: user.id,
        prof: user.id,
        org: cfg.orgId,
        relayHostId: hostId,
        purpose: 'host-control'
      },
      TTL_SEC.relay
    )
    // 客户端 zod .strict()：响应必须严格只有这两个字段
    return sendJson(res, 200, { relayToken, expiresAt: Date.now() + TTL_SEC.relay * 1000 })
  }

  return sendJson(res, 404, { error: 'not_found' })
}

function handleRefresh(req, res, body, ip) {
  const claims = lib.verifyJwt(signingKey, body.refreshToken, { iss: cfg.publicUrl, typ: 'refresh' })
  if (!claims) return sendJson(res, 401, { error: 'invalid_grant' })

  const family = lib.getFamily(db, claims.fam)
  const user = lib.getUserById(db, claims.sub)
  if (
    !family ||
    family.user_id !== claims.sub ||
    family.revoked ||
    !user ||
    user.disabled ||
    Number(claims.tv) !== Number(user.token_version)
  ) {
    return sendJson(res, 401, { error: 'invalid_grant' })
  }

  const now = Date.now()
  const jti = String(claims.jti ?? '')
  let mode = null
  if (jti === family.current_jti) mode = 'rotate'
  else if (jti === family.prev_jti && now < Number(family.prev_expires_at)) mode = 'grace'

  if (!mode) {
    // 罕见路径（旧 token 重放 / 疑似窃取）：撤销整个 family
    lib.revokeFamily(db, family.id)
    lib.audit(db, user.email, 'auth.refresh_rejected', `family=${family.id} ip=${ip}`)
    return sendJson(res, 401, { error: 'invalid_grant' })
  }

  const newJtiValue = lib.newJti()
  if (mode === 'rotate') lib.rotateFamily(db, family.id, newJtiValue, now + REFRESH_GRACE_MS, now)
  else lib.rotateFamilyFromPrev(db, family.id, newJtiValue, now)

  const payload = issueSessionForFamily(user, family.id, newJtiValue)
  lib.audit(db, user.email, `auth.refresh_${mode}`, `family=${family.id} ip=${ip}`)
  return sendJson(res, 200, payload)
}

// ============================== /account 自助改密 ==============================

async function handleAccount(req, res, url) {
  if (req.method === 'GET') return sendHtml(res, 200, accountPage())
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })

  let form
  try {
    form = new URLSearchParams(await readBody(req))
  } catch {
    return sendHtml(res, 400, accountPage({ error: '请求无效。' }))
  }
  const email = lib.normalizeEmail(form.get('email'))
  const current = form.get('current') ?? ''
  const next = form.get('next') ?? ''
  const confirm = form.get('confirm') ?? ''
  const ip = clientIp(req)
  const throttleKeys = [`e:${email}`, `ip:${ip}`]

  const waitMs = throttleWait(throttleKeys)
  if (waitMs > 0) {
    return sendHtml(res, 429, accountPage({ error: `尝试过于频繁，请约 ${Math.ceil(waitMs / 1000)} 秒后再试。` }))
  }
  if (next.length < 8) return sendHtml(res, 400, accountPage({ error: '新密码至少 8 位。' }))
  if (next !== confirm) return sendHtml(res, 400, accountPage({ error: '两次输入的新密码不一致。' }))

  const user = lib.getUserByEmail(db, email)
  const passwordOk = lib.verifyPassword(current, user ? user.password_hash : DUMMY_HASH)
  if (!user || !passwordOk || user.disabled) {
    throttleFail(throttleKeys)
    lib.audit(db, email || ip, 'account.change_failed', `ip=${ip}`)
    return sendHtml(res, 401, accountPage({ error: '邮箱或当前密码不正确。' }))
  }

  throttleClear(throttleKeys)
  lib.setUserPassword(db, user.id, next)
  lib.revokeUserFamilies(db, user.id)
  lib.audit(db, user.email, 'account.password_changed', `ip=${ip}`)
  return sendHtml(res, 200, accountPage({ ok: '密码已更新。其他设备上已登录的 Orca 需要重新登录，手机上已配对的设备不受影响。' }))
}

// ============================== 反向代理（HTTP + WebSocket → relay） ==============================

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function filterHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v
  }
  return out
}

function proxyHttp(req, res) {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: cfg.relayPort,
      method: req.method,
      path: req.url,
      headers: filterHeaders(req.headers)
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, filterHeaders(up.headers))
      up.pipe(res)
    }
  )
  upstream.on('error', (error) => {
    console.error('[auth] proxy error:', error.message)
    if (!res.headersSent) sendJson(res, 502, { error: 'relay_unavailable' })
    else res.end()
  })
  req.pipe(upstream)
}

function proxyUpgrade(req, socket, head) {
  const upstream = netConnect(cfg.relayPort, '127.0.0.1', () => {
    // 原样重建请求行与全部头（含 Upgrade/Sec-WebSocket-*）
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const destroy = () => {
    socket.destroy()
    upstream.destroy()
  }
  socket.on('error', destroy)
  upstream.on('error', destroy)
}

// ============================== 服务器 ==============================

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  try {
    if (path === '/.well-known/jwks.json') {
      const body = Buffer.from(JSON.stringify(signingKey.jwks))
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': body.length,
        'cache-control': 'public, max-age=300'
      })
      return res.end(body)
    }
    if (path === '/account') return await handleAccount(req, res, url)
    if (path === '/v1/desktop/auth/authorize') return await handleAuthorize(req, res, url)
    if (path.startsWith('/v1/desktop/auth/')) return await handleAuthApi(req, res, url)
    // 其余全部（/health /ready /v1/regions /v1/connect ...）反代给 relay
    return proxyHttp(req, res)
  } catch (error) {
    console.error('[auth] 请求处理异常:', error?.stack ?? error)
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' })
    else res.end()
  }
})

server.on('upgrade', (req, socket, head) => {
  try {
    proxyUpgrade(req, socket, head)
  } catch (error) {
    console.error('[auth] upgrade 代理异常:', error?.message)
    socket.destroy()
  }
})

server.listen(cfg.port, '::', () => {
  console.log(`[auth] listening on :${cfg.port}（relay → 127.0.0.1:${cfg.relayPort}）`)
  startRelay()
})
