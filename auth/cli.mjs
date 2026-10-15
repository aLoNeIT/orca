#!/usr/bin/env node
// Orca 自托管 Auth —— 管理员命令行（零 npm 依赖）。
//
// 管理唯一入口（无任何对外的 admin HTTP 接口）。直接读写与 server 相同的 SQLite
// （WAL 模式，双连接并发写安全）；server 不缓存用户状态，改动下一个请求立即生效。
//
// 常用：
//   user add --email alice@team.com --name "李静"      建号 + 生成交付信息
//   user list                                          用户列表
//   user passwd --email alice@team.com                 重置密码
//   user disable|enable --email alice@team.com         禁用/启用
//   user logout --email alice@team.com                 踢下线（撤销全部会话）
//   device list [--email alice@team.com]               电脑列表（含配对手机数）
//   device block|unblock --host <relayHostId>          拉黑/解封
//   device label --host <relayHostId> --label "标签"   给电脑起名
//   sessions revoke-all --confirm                      全员注销（轮换签名密钥）
//   任意命令加 --json 输出机器可读结果

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as lib from './lib.mjs'

const BOOLEAN_FLAGS = new Set(['json', 'confirm'])

function fail(message, { json = false } = {}) {
  if (json) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error(`✖ ${message}`)
  process.exit(1)
}

function parseFlags(args) {
  const flags = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) fail(`未知参数：${arg}`)
    const name = arg.slice(2)
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) fail(`参数 --${name} 缺少值`)
    flags[name] = value
    i += 1
  }
  return flags
}

// ============================== 输出工具 ==============================

const displayWidth = (s) => [...String(s)].reduce((w, ch) => w + (ch.codePointAt(0) > 0xff ? 2 : 1), 0)
const pad = (s, width) => String(s) + ' '.repeat(Math.max(0, width - displayWidth(s)))

function printTable(header, rows) {
  const all = [header, ...rows]
  const widths = header.map((_, i) => Math.max(...all.map((row) => displayWidth(row[i] ?? ''))))
  console.log(all.map((row) => row.map((cell, i) => pad(cell ?? '', widths[i])).join('  ')).join('\n'))
}

function ago(ts) {
  const value = Number(ts)
  if (!value) return '—'
  const diff = Date.now() - value
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

const USAGE = `Orca 自托管 Auth 管理命令行

用法：
  node cli.mjs <命令> [选项]

用户管理：
  user add --email <邮箱> --name <姓名> [--password <密码>]     建号并生成交付信息
  user list                                                     用户列表
  user passwd --email <邮箱> [--password <密码>]                重置密码
  user disable --email <邮箱>                                   禁用（立即生效）
  user enable --email <邮箱>                                    启用
  user logout --email <邮箱>                                    踢下线（撤销全部会话）

设备管理：
  device list [--email <邮箱>]                                  电脑列表（含配对手机数）
  device block --host <relayHostId>                             拉黑设备
  device unblock --host <relayHostId>                           解除拉黑
  device label --host <relayHostId> --label <标签>              给电脑起名

会话管理：
  sessions revoke-all --confirm                                 全员注销（轮换签名密钥）

通用：
  任意命令追加 --json 输出机器可读 JSON

说明：
  数据目录取自 AUTH_DATA_DIR（默认 /data/auth）；交付信息自动存档到
  <AUTH_DATA_DIR>/onboarding/<邮箱>.txt。`

// ============================== 用户命令 ==============================

function requireUser(db, email) {
  const user = lib.getUserByEmail(db, email)
  if (!user) fail(`用户不存在：${email}`)
  return user
}

function cmdUser(db, cfg, sub, args) {
  const flags = parseFlags(args)
  const json = Boolean(flags.json)

  if (sub === 'add') {
    const email = lib.normalizeEmail(flags.email)
    const name = String(flags.name ?? '').trim()
    if (!email || !lib.isValidEmail(email)) fail('请提供合法邮箱：--email <邮箱>', { json })
    if (!name) fail('请提供姓名：--name <姓名>', { json })
    if (flags.password && String(flags.password).length < 8) fail('--password 至少 8 位', { json })

    if (lib.getUserByEmail(db, email)) {
      fail(`用户已存在：${email}（忘记密码可用 user passwd 重置）`, { json })
    }
    const password = flags.password || lib.generatePassword()
    const user = lib.createUser(db, { email, name, password })
    lib.audit(db, 'cli', 'user.add', `${email}`)

    const onboardingText = lib.buildOnboardingText({ publicUrl: cfg.publicUrl, name, email, password })
    const onboardingPath = lib.saveOnboarding(cfg.authDir, email, onboardingText)

    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          user: { id: user.id, email: user.email, displayName: user.display_name },
          password,
          onboardingPath,
          onboardingText
        })
      )
      return
    }
    console.log(`✔ 用户已创建：${name} <${email}>`)
    console.log(`  初始密码：${password}`)
    console.log(`  交付信息已存档：${onboardingPath}`)
    console.log('')
    console.log(onboardingText)
    return
  }

  if (sub === 'list') {
    const users = lib.listUsers(db)
    const rows = users.map((user) => {
      const deviceCount = db
        .prepare('SELECT COUNT(*) AS n FROM hosts WHERE user_id = ?')
        .get(user.id)
      const lastActive = db
        .prepare('SELECT MAX(last_used_at) AS t FROM refresh_families WHERE user_id = ?')
        .get(user.id)
      const hosts = lib.listHosts(db).filter((h) => h.user_id === user.id)
      const lastToken = hosts.reduce((max, h) => Math.max(max, Number(h.last_token_at) || 0), 0)
      return {
        email: user.email,
        name: user.display_name,
        status: user.disabled ? '已禁用' : '正常',
        devices: Number(deviceCount?.n ?? 0),
        sessions: lib.countUserFamilies(db, user.id),
        lastActive: Math.max(Number(lastActive?.t) || 0, lastToken),
        createdAt: Number(user.created_at)
      }
    })
    if (json) {
      console.log(JSON.stringify({ ok: true, users: rows }))
      return
    }
    if (!rows.length) {
      console.log('（还没有用户，用 user add 建号）')
      return
    }
    printTable(
      ['邮箱', '姓名', '状态', '设备', '会话', '最后活跃'],
      rows.map((r) => [r.email, r.name, r.status, String(r.devices), String(r.sessions), ago(r.lastActive)])
    )
    return
  }

  if (sub === 'passwd') {
    const email = lib.normalizeEmail(flags.email)
    if (!email) fail('请提供邮箱：--email <邮箱>', { json })
    if (flags.password && String(flags.password).length < 8) fail('--password 至少 8 位', { json })
    const user = requireUser(db, email)

    const password = flags.password || lib.generatePassword()
    lib.setUserPassword(db, user.id, password)
    lib.revokeUserFamilies(db, user.id)
    lib.audit(db, 'cli', 'user.passwd', email)

    const onboardingText = lib.buildOnboardingText({
      publicUrl: cfg.publicUrl,
      name: user.display_name,
      email,
      password,
      reset: true
    })
    const onboardingPath = lib.saveOnboarding(cfg.authDir, email, onboardingText)

    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          user: { id: user.id, email: user.email, displayName: user.display_name },
          password,
          onboardingPath,
          onboardingText
        })
      )
      return
    }
    console.log(`✔ 密码已重置：${user.display_name} <${email}>`)
    console.log(`  新密码：${password}`)
    console.log(`  该用户已登录的设备需重新登录；交付信息已存档：${onboardingPath}`)
    console.log('')
    console.log(onboardingText)
    return
  }

  if (sub === 'disable' || sub === 'enable') {
    const email = lib.normalizeEmail(flags.email)
    if (!email) fail('请提供邮箱：--email <邮箱>', { json })
    const user = requireUser(db, email)
    const disabled = sub === 'disable'
    lib.setUserDisabled(db, user.id, disabled)
    lib.audit(db, 'cli', `user.${sub}`, email)
    if (json) {
      console.log(JSON.stringify({ ok: true, email, disabled }))
      return
    }
    console.log(disabled ? `✔ 已禁用：${email}（新登录被拒；存量设备 ≤15 分钟断开）` : `✔ 已启用：${email}`)
    return
  }

  if (sub === 'logout') {
    const email = lib.normalizeEmail(flags.email)
    if (!email) fail('请提供邮箱：--email <邮箱>', { json })
    const user = requireUser(db, email)
    lib.revokeUserFamilies(db, user.id)
    lib.bumpTokenVersion(db, user.id)
    lib.audit(db, 'cli', 'user.logout', email)
    if (json) {
      console.log(JSON.stringify({ ok: true, email }))
      return
    }
    console.log(`✔ 已注销 ${email} 的全部会话（access/refresh 立即失效；电脑上需重新登录）`)
    return
  }

  fail(`未知 user 子命令：${sub ?? ''}（可用：add / list / passwd / disable / enable / logout）`, { json })
}

// ============================== 设备命令 ==============================

/** 从 relay 数据库读取电脑的在线信息（表名/列名对齐 relay/src/database.ts） */
function relayDeviceStats(cfg) {
  const dbPath = join(cfg.relayDataDir, 'orca-relay.sqlite')
  const stats = new Map()
  if (!existsSync(dbPath)) return stats
  let relayDb
  try {
    relayDb = new DatabaseSync(dbPath, { readOnly: true })
    for (const row of relayDb.prepare('SELECT relay_host_id, MAX(last_activity_at) AS t FROM relay_assignments GROUP BY relay_host_id').all()) {
      stats.set(String(row.relay_host_id), { lastActivity: Number(row.t) || 0, phones: 0 })
    }
    for (const row of relayDb.prepare('SELECT relay_host_id, COUNT(*) AS n FROM relay_devices WHERE revoked_at IS NULL GROUP BY relay_host_id').all()) {
      const current = stats.get(String(row.relay_host_id)) ?? { lastActivity: 0, phones: 0 }
      stats.set(String(row.relay_host_id), { ...current, phones: Number(row.n) || 0 })
    }
  } catch (error) {
    console.error(`⚠ 读取 relay 数据库失败（${dbPath}）：${error.message}`)
  } finally {
    relayDb?.close()
  }
  return stats
}

function cmdDevice(db, cfg, sub, args) {
  const flags = parseFlags(args)
  const json = Boolean(flags.json)

  if (sub === 'list') {
    const filterEmail = flags.email ? lib.normalizeEmail(flags.email) : null
    let rows = lib.listHosts(db)
    if (filterEmail) {
      const user = requireUser(db, filterEmail)
      rows = rows.filter((host) => host.user_id === user.id)
    }
    const stats = relayDeviceStats(cfg)
    const view = rows.map((host) => {
      const stat = stats.get(String(host.relay_host_id)) ?? { lastActivity: 0, phones: 0 }
      const owner = host.user_id ? lib.getUserById(db, host.user_id) : null
      return {
        relayHostId: host.relay_host_id,
        label: host.label,
        owner: owner?.email ?? '',
        status: host.blocked ? '已拉黑' : '正常',
        phones: stat.phones,
        firstSeen: Number(host.first_seen),
        lastActive: Math.max(Number(host.last_token_at) || 0, stat.lastActivity)
      }
    })
    if (json) {
      console.log(JSON.stringify({ ok: true, devices: view }))
      return
    }
    if (!view.length) {
      console.log('（还没有电脑连过，等成员在 Orca 里登录后会出现）')
      return
    }
    printTable(
      ['设备 ID', '标签', '所属用户', '状态', '手机', '最后活跃'],
      view.map((d) => [d.relayHostId, d.label || '—', d.owner || '—', d.status, String(d.phones), ago(d.lastActive)])
    )
    return
  }

  if (sub === 'block' || sub === 'unblock') {
    const hostId = String(flags.host ?? '').trim()
    if (!hostId) fail('请提供设备 ID：--host <relayHostId>', { json })
    const host = lib.getHost(db, hostId)
    if (!host) fail(`设备不存在：${hostId}（用 device list 查看）`, { json })
    lib.setHostBlocked(db, hostId, sub === 'block')
    lib.audit(db, 'cli', `device.${sub}`, hostId)
    if (json) {
      console.log(JSON.stringify({ ok: true, relayHostId: hostId, blocked: sub === 'block' }))
      return
    }
    console.log(sub === 'block' ? `✔ 已拉黑：${hostId}（无法再换 relay token；在线连接 15 分钟内断开）` : `✔ 已解除拉黑：${hostId}`)
    return
  }

  if (sub === 'label') {
    const hostId = String(flags.host ?? '').trim()
    const label = String(flags.label ?? '').trim()
    if (!hostId) fail('请提供设备 ID：--host <relayHostId>', { json })
    if (!label) fail('请提供标签：--label <文本>', { json })
    const host = lib.getHost(db, hostId)
    if (!host) fail(`设备不存在：${hostId}（用 device list 查看）`, { json })
    lib.setHostLabel(db, hostId, label)
    lib.audit(db, 'cli', 'device.label', `${hostId} = ${label}`)
    if (json) {
      console.log(JSON.stringify({ ok: true, relayHostId: hostId, label }))
      return
    }
    console.log(`✔ 已命名：${hostId} → ${label}`)
    return
  }

  fail(`未知 device 子命令：${sub ?? ''}（可用：list / block / unblock / label）`, { json })
}

// ============================== 会话命令 ==============================

function cmdSessions(db, cfg, sub, args) {
  const flags = parseFlags(args)
  const json = Boolean(flags.json)

  if (sub === 'revoke-all') {
    if (!flags.confirm) {
      fail('这是全员注销操作（应急用）：所有成员都会被强制重新登录。确认请加 --confirm', { json })
    }
    lib.rotateSigningKey(cfg.authDir)
    lib.revokeAllFamilies(db)
    lib.bumpAllTokenVersions(db)
    lib.audit(db, 'cli', 'sessions.revoke_all', 'signing key rotated')
    const users = lib.listUsers(db).length
    if (json) {
      console.log(JSON.stringify({ ok: true, users }))
      return
    }
    console.log(`✔ 已轮换签名密钥：${users} 个用户的全部 token 立即失效，所有人需重新登录。`)
    console.log('  已配对的手机不受影响；成员在各电脑重新登录后即可继续使用。')
    return
  }

  fail(`未知 sessions 子命令：${sub ?? ''}（可用：revoke-all）`, { json })
}

// ============================== 入口 ==============================

function main() {
  const [command, sub, ...rest] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }

  const cfg = lib.loadConfig()
  const db = lib.openDb(cfg.authDir)
  try {
    if (command === 'user') return cmdUser(db, cfg, sub, rest)
    if (command === 'device') return cmdDevice(db, cfg, sub, rest)
    if (command === 'sessions') return cmdSessions(db, cfg, sub, rest)
    fail(`未知命令：${command}（可用：user / device / sessions / help）`)
  } finally {
    db.close()
  }
}

main()
