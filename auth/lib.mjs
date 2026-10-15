// Orca 自托管 Auth —— 共用库（零 npm 依赖，仅 node: 内置模块）。
// 供 server.mjs（契约服务）与 cli.mjs（管理命令行）共用：
//   配置 / SQLite 存取 / ES256 密钥 / JWT 签发验签 / 密码哈希 / relayHostId 派生 / 交付文案。
//
// 关键约束（与官方 relay、桌面客户端契约对齐，逐条见 .tmp/orca-auth技术选型与开发计划.md）：
//   1. ES256 签名必须 dsaEncoding:'ieee-p1363'（JWS 要求 64 字节裸 R||S）
//   2. exp/iat 一律用秒级时间戳（毫秒是经典错误）；只有 HTTP 响应里的 expiresAt 用毫秒
//   3. base64url 无填充；iss 与 relay 的 ORCA_RELAY_AUTH_ISSUER 逐字节一致（无尾斜杠）
//   4. kid 在 JWS header 与 JWKS 中保持一致

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  scryptSync,
  sign,
  timingSafeEqual,
  verify
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// ============================== 基础工具 ==============================

export const nowMs = () => Date.now()
export const nowSec = () => Math.floor(Date.now() / 1000)

/** JWS 风格的 base64url（无填充） */
export const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

/** 随机字节 → base64url */
export const randB64u = (bytes) => randomBytes(bytes).toString('base64url')

/** sha256 → base64url（PKCE challenge 与 relayHostId 派生用） */
export const sha256b64u = (v) => createHash('sha256').update(v).digest('base64url')

export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase()

export const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? ''))

/** 生成用户 id（u-xxxxxxxx） */
export const newUserId = () => `u-${randB64u(6)}`

/** 生成 refresh family id（f-xxxxxxxxxxxx） */
export const newFamilyId = () => `f-${randB64u(9)}`

/** 生成 jti（12 字符） */
export const newJti = () => randB64u(8)

// ============================== 配置 ==============================

/**
 * 读取部署配置。ORCA_RELAY_PUBLIC_URL 必填（纯 origin，不能带路径/尾斜杠——
 * 客户端 canonical origin 校验会拒绝，且它逐字节用作 relay 侧 issuer 比对）。
 */
export function loadConfig(env = process.env) {
  const raw = String(env.ORCA_RELAY_PUBLIC_URL ?? '').trim()
  if (!raw) {
    throw new Error('ORCA_RELAY_PUBLIC_URL 未设置（示例：https://relay.example.com）')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`ORCA_RELAY_PUBLIC_URL 不是合法 URL：${raw}`)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ORCA_RELAY_PUBLIC_URL 必须是纯 origin（不能带路径、查询串或尾斜杠）')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('ORCA_RELAY_PUBLIC_URL 必须使用 http(s) 协议')
  }
  return {
    // canonical origin：无尾斜杠，逐字节用作 iss
    publicUrl: url.origin,
    // 本服务监听端口（容器内 8080；对外由 Caddy 终结 HTTPS）
    port: Number(env.PORT || 8080),
    // auth 数据目录（SQLite + 签名密钥 + 交付信息存档）
    authDir: String(env.AUTH_DATA_DIR || '/data/auth'),
    // relay 数据目录（relay 自己的 SQLite；CLI 只读访问其配对信息）
    relayDataDir: String(env.ORCA_RELAY_DATA_DIR || '/data/relay'),
    // 单组织部署：所有用户归同一个组织
    orgId: String(env.ORCA_AUTH_ORG_ID || 'team'),
    orgName: String(env.ORCA_AUTH_ORG_NAME || 'Team')
  }
}

/** 原子写文件（tmp + rename），并收紧权限 */
function writeAtomic(path, data, mode) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}

// ============================== SQLite ==============================

/**
 * 打开（必要时创建）auth 数据库。WAL 模式 + busy_timeout 保证与 CLI 双连接并发写安全。
 */
export function openDb(authDir) {
  mkdirSync(authDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(authDir, 'auth.sqlite'))
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_families (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      current_jti TEXT NOT NULL,
      prev_jti TEXT,
      prev_expires_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_families_user ON refresh_families(user_id);

    CREATE TABLE IF NOT EXISTS hosts (
      relay_host_id TEXT PRIMARY KEY,
      user_id TEXT,
      label TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL,
      last_token_at INTEGER NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_hosts_user ON hosts(user_id);

    CREATE TABLE IF NOT EXISTS auth_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      challenge TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      nonce TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
  `)
  return db
}

// ============================== ES256 密钥 ==============================

const newSigningKeyPem = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })

function loadSigningKeyFrom(pemPath) {
  const privateKey = createPrivateKey(readFileSync(pemPath, 'utf8'))
  const publicKey = createPublicKey(privateKey)
  const kid = sha256b64u(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16)
  return {
    privateKey,
    publicKey,
    kid,
    jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }] }
  }
}

/** 读取（首次自动生成）auth 签名密钥；存放在 <authDir>/keys/signing-key.pem（0600） */
export function loadOrCreateSigningKey(authDir) {
  const keyDir = join(authDir, 'keys')
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  const pemPath = join(keyDir, 'signing-key.pem')
  if (!existsSync(pemPath)) writeAtomic(pemPath, newSigningKeyPem(), 0o600)
  return loadSigningKeyFrom(pemPath)
}

/** 轮换签名密钥（所有已签发 token 立即失效 = 全员注销） */
export function rotateSigningKey(authDir) {
  const keyDir = join(authDir, 'keys')
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  const pemPath = join(keyDir, 'signing-key.pem')
  writeAtomic(pemPath, newSigningKeyPem(), 0o600)
  return loadSigningKeyFrom(pemPath)
}

// ============================== JWT（手写 ES256） ==============================

/**
 * 签发 JWT。claims 会与 { iss, iat, exp } 合并；exp = now + ttlSec（秒）。
 */
export function signJwt(key, iss, claims, ttlSec) {
  const now = nowSec()
  const header = { alg: 'ES256', typ: 'JWT', kid: key.kid }
  const payload = { iss, iat: now, exp: now + ttlSec, ...claims }
  const body = `${b64u(header)}.${b64u(payload)}`
  const sig = sign('sha256', Buffer.from(body), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${body}.${sig.toString('base64url')}`
}

/**
 * 验签 + 校验 iss/typ/exp。失败返回 null。
 * ignoreExp 仅用于 logout 场景（token 刚过期的宽限撤销）。
 */
export function verifyJwt(key, token, { iss, typ, ignoreExp = false } = {}) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null
  const [h, p, s] = parts
  let ok = false
  try {
    ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: key.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url')
    )
  } catch {
    return null
  }
  if (!ok) return null
  let claims
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!claims || typeof claims !== 'object') return null
  if (iss && claims.iss !== iss) return null
  if (typ && claims.typ !== typ) return null
  if (!ignoreExp && !(typeof claims.exp === 'number' && claims.exp > nowSec())) return null
  return claims
}

// ============================== 密码 ==============================

/** scrypt 哈希（格式：scrypt$salt$hash，均 base64url） */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, 64)
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

/** 恒时比较校验密码 */
export function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored ?? '').split('$')
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false
  let expected
  try {
    expected = Buffer.from(hashB64, 'base64url')
  } catch {
    return false
  }
  const actual = scryptSync(String(password ?? ''), Buffer.from(saltB64, 'base64url'), expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// 初始密码词表（128 词，动物/颜色/自然），格式 Word-Word-XXXX
const WORDS = [
  // 动物
  'Falcon', 'Otter', 'Panda', 'Tiger', 'Eagle', 'Dolphin', 'Fox', 'Wolf', 'Bear', 'Rabbit',
  'Koala', 'Penguin', 'Turtle', 'Whale', 'Hawk', 'Owl', 'Lion', 'Jaguar', 'Leopard', 'Cheetah',
  'Bison', 'Camel', 'Cobra', 'Coyote', 'Crane', 'Deer', 'Gecko', 'Heron', 'Lynx', 'Moose',
  'Puma', 'Raven',
  // 颜色
  'Amber', 'Azure', 'Coral', 'Crimson', 'Emerald', 'Indigo', 'Ivory', 'Jade', 'Lavender', 'Magenta',
  'Maroon', 'Navy', 'Olive', 'Peach', 'Ruby', 'Sienna', 'Teal', 'Violet', 'Scarlet', 'Golden',
  'Bronze', 'Copper', 'Pearl', 'Topaz',
  // 自然
  'Aurora', 'Blossom', 'Cedar', 'Cloud', 'Dawn', 'Delta', 'Dusk', 'Forest', 'Glacier', 'Harbor',
  'Horizon', 'Island', 'Lagoon', 'Maple', 'Meadow', 'Meteor', 'Mist', 'Moon', 'Mountain', 'Ocean',
  'Prairie', 'Rain', 'Rainbow', 'River', 'Sierra', 'Sky', 'Snow', 'Solar', 'Star', 'Storm',
  'Summit', 'Sunset', 'Thunder', 'Tide', 'Valley', 'Willow', 'Wind', 'Winter', 'Zenith', 'Canyon',
  // 意象
  'Breeze', 'Brook', 'Cliff', 'Creek', 'Crystal', 'Dune', 'Fern', 'Flame', 'Frost', 'Grove',
  'Marsh', 'Moss', 'Nimbus', 'Pebble', 'Reef', 'Ridge', 'Spring', 'Stone', 'Stream', 'Timber',
  'Trail', 'Bloom', 'Comet', 'Eclipse', 'Ember', 'Galaxy', 'Orion', 'Nebula', 'Nova', 'Orbit',
  'Quasar', 'Solstice'
]

// 去歧义字符表（排除 0 O 1 l I），大小写 + 数字
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * 生成初始密码：Word-Word-XXXX（熵约 38 bit，配合登录限速足够防爆破）。
 * 去歧义字符便于口头/短信传播。
 */
export function generatePassword() {
  const word1 = WORDS[randomInt(WORDS.length)]
  const word2 = WORDS[randomInt(WORDS.length)]
  let suffix = ''
  for (let i = 0; i < 4; i += 1) suffix += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
  return `${word1}-${word2}-${suffix}`
}

// ============================== relayHostId 派生 ==============================

/**
 * relayHostId = base64url(sha256(hostPublicKey 原始 32 字节)).slice(0,16)
 * 公钥不是 32 字节（非 X25519 原生格式）时返回 null。
 */
export function deriveRelayHostId(hostPublicKeyB64) {
  const raw = Buffer.from(String(hostPublicKeyB64 ?? ''), 'base64')
  if (raw.length !== 32) return null
  return sha256b64u(raw).slice(0, 16)
}

// ============================== 用户 ==============================

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(String(id ?? '')) ?? null
}

export function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) ?? null
}

export function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all()
}

/** 建号（email 冲突会抛 SQLITE_CONSTRAINT） */
export function createUser(db, { email, name, password, now = nowMs() }) {
  const id = newUserId()
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, normalizeEmail(email), String(name ?? '').trim() || normalizeEmail(email), hashPassword(password), now)
  return getUserById(db, id)
}

/** 改密：同时 bump token_version（旧 access/refresh 立即失效） */
export function setUserPassword(db, userId, password) {
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
    hashPassword(password),
    userId
  )
}

/** 禁用/启用：bump token_version 让存量 access token 立即失效 */
export function setUserDisabled(db, userId, disabled) {
  db.prepare('UPDATE users SET disabled = ?, token_version = token_version + 1 WHERE id = ?').run(
    disabled ? 1 : 0,
    userId
  )
}

export function bumpTokenVersion(db, userId) {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId)
}

export function bumpAllTokenVersions(db) {
  db.prepare('UPDATE users SET token_version = token_version + 1').run()
}

// ============================== 设备（hosts） ==============================

export function getHost(db, relayHostId) {
  return db.prepare('SELECT * FROM hosts WHERE relay_host_id = ?').get(String(relayHostId ?? '')) ?? null
}

export function listHosts(db) {
  return db.prepare('SELECT * FROM hosts ORDER BY last_token_at DESC').all()
}

/**
 * 设备归属"先到先得"：
 *  - 被拉黑 → host_blocked
 *  - 已被其他用户领取 → host_claimed
 *  - 首次/同用户 → 记录并放行
 */
export function claimHost(db, relayHostId, userId, now = nowMs()) {
  const row = getHost(db, relayHostId)
  if (!row) {
    db.prepare(
      'INSERT INTO hosts (relay_host_id, user_id, label, first_seen, last_token_at, blocked) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(relayHostId, userId, '', now, now)
    return { host: getHost(db, relayHostId), error: null }
  }
  if (row.blocked) return { host: row, error: 'host_blocked' }
  if (row.user_id && row.user_id !== userId) return { host: row, error: 'host_claimed' }
  db.prepare('UPDATE hosts SET user_id = COALESCE(user_id, ?), last_token_at = ? WHERE relay_host_id = ?').run(
    userId,
    now,
    relayHostId
  )
  return { host: getHost(db, relayHostId), error: null }
}

export function setHostBlocked(db, relayHostId, blocked) {
  db.prepare('UPDATE hosts SET blocked = ? WHERE relay_host_id = ?').run(blocked ? 1 : 0, String(relayHostId))
}

export function setHostLabel(db, relayHostId, label) {
  db.prepare('UPDATE hosts SET label = ? WHERE relay_host_id = ?').run(String(label ?? '').slice(0, 60), String(relayHostId))
}

// ============================== refresh families ==============================

export function getFamily(db, id) {
  return db.prepare('SELECT * FROM refresh_families WHERE id = ?').get(String(id ?? '')) ?? null
}

export function countUserFamilies(db, userId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM refresh_families WHERE user_id = ? AND revoked = 0').get(userId)
  return Number(row?.n ?? 0)
}

/** 登录成功时创建新 family（当前 jti 即刚签发的 refresh jti） */
export function createFamily(db, userId, jti, now = nowMs()) {
  const id = newFamilyId()
  db.prepare(
    'INSERT INTO refresh_families (id, user_id, current_jti, revoked, created_at, last_used_at) VALUES (?, ?, ?, 0, ?, ?)'
  ).run(id, userId, jti, now, now)
  return id
}

/** 正常轮换：current → prev（带宽限窗口），写入新 current */
export function rotateFamily(db, familyId, newJti, prevGraceExpiresAt, now = nowMs()) {
  db.prepare(
    'UPDATE refresh_families SET prev_jti = current_jti, prev_expires_at = ?, current_jti = ?, last_used_at = ? WHERE id = ?'
  ).run(prevGraceExpiresAt, newJti, now, familyId)
}

/** 宽限重放（视为客户端重试）：仅替换 current，prev 窗口不延长 */
export function rotateFamilyFromPrev(db, familyId, newJti, now = nowMs()) {
  db.prepare('UPDATE refresh_families SET current_jti = ?, last_used_at = ? WHERE id = ?').run(newJti, now, familyId)
}

export function revokeFamily(db, familyId) {
  db.prepare('UPDATE refresh_families SET revoked = 1 WHERE id = ?').run(familyId)
}

export function revokeUserFamilies(db, userId) {
  db.prepare('UPDATE refresh_families SET revoked = 1 WHERE user_id = ? AND revoked = 0').run(userId)
}

export function revokeAllFamilies(db) {
  db.prepare('UPDATE refresh_families SET revoked = 1 WHERE revoked = 0').run()
}

// ============================== 授权码（PKCE code） ==============================

export function createAuthCode(db, { userId, challenge, redirectUri, nonce, state, ttlMs = 5 * 60_000 }) {
  const code = randB64u(32)
  const now = nowMs()
  db.prepare(
    'INSERT INTO auth_codes (code, user_id, challenge, redirect_uri, nonce, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(code, userId, challenge, redirectUri, String(nonce ?? ''), String(state ?? ''), now, now + ttlMs)
  return code
}

/** 一次性消费：查询并删除 */
export function consumeAuthCode(db, code) {
  const row = db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(String(code ?? ''))
  if (row) db.prepare('DELETE FROM auth_codes WHERE code = ?').run(row.code)
  return row ?? null
}

export function purgeExpiredCodes(db, now = nowMs()) {
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(now)
}

// ============================== 审计 ==============================

export function audit(db, actor, action, detail = '') {
  try {
    db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)').run(
      nowMs(),
      String(actor ?? ''),
      String(action ?? ''),
      String(detail ?? '').slice(0, 500)
    )
  } catch {
    /* 审计失败不影响主流程 */
  }
}

// ============================== 交付文案 ==============================

export const sanitizeEmailForPath = (email) => String(email).replace(/[^A-Za-z0-9@._-]/g, '_')

/**
 * 生成"可直接复制发给成员"的交付信息（user add / user passwd 时存档）。
 * 域名自动取自部署配置 ORCA_RELAY_PUBLIC_URL。
 */
export function buildOnboardingText({ publicUrl, name, email, password, reset = false }) {
  const greeting = reset
    ? `${name} 你好，你的 Orca 手机远程访问登录密码已重置（其余配置不变）。`
    : `${name} 你好，Orca 手机远程访问已为你开通，按下面提示操作即可（一次性，约 3 分钟）。`
  const passwordLabel = reset ? '新密码' : '初始密码'
  return `──────────────── 以下内容直接复制发给${name} ────────────────
${greeting}

【一】电脑端：打开「终端」（Windows 按 Win+R 输入 cmd），粘贴执行：

macOS：
  launchctl setenv ORCA_CLOUD_API_URL ${publicUrl}
  launchctl setenv ORCA_RELAY_URL ${publicUrl}
  launchctl setenv ORCA_CLOUD_CLIENT_ID orca-desktop
  （执行后重启一次 Orca；重启 Mac 后需重跑本步）

Windows：
  setx ORCA_CLOUD_API_URL "${publicUrl}"
  setx ORCA_RELAY_URL "${publicUrl}"
  setx ORCA_CLOUD_CLIENT_ID "orca-desktop"
  （执行后完全退出 Orca 再重新打开）

【二】登录：
  Orca → 左侧「Orca Mobile」→ 选「Orca Relay」→ 点「Sign in for Relay」
  浏览器打开登录页后，输入：
    账号：${email}
    ${passwordLabel}：${password}

【三】手机：
  手机安装 Orca Mobile App → 扫描电脑上显示的二维码 → 完成配对。

登录后建议尽快修改密码：${publicUrl}/account
遇到问题联系管理员。
──────────────── 复制结束 ────────────────`
}

/** 存档交付信息到 <authDir>/onboarding/<email>.txt（0600），返回文件路径 */
export function saveOnboarding(authDir, email, text) {
  const dir = join(authDir, 'onboarding')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${sanitizeEmailForPath(email)}.txt`)
  writeFileSync(file, `${text}\n`, { mode: 0o600 })
  return file
}
