import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Runtime config comes from environment variables; everything editable at
// runtime (upstream URL, credentials, group names) lives in SQLite instead.
export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || './data')
  fs.mkdirSync(dataDir, { recursive: true })

  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT) || 8787,
    dataDir,
    dbPath: path.join(dataDir, 'mirror.db'),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    appSecret: resolveAppSecret(env.APP_SECRET, dataDir),
    adminPassword: resolveAdminPassword(env.ADMIN_PASSWORD, dataDir)
  }
}

function resolveAppSecret(fromEnv, dataDir) {
  if (fromEnv && fromEnv.length >= 16) return fromEnv
  const file = path.join(dataDir, '.secret')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

function resolveAdminPassword(fromEnv, dataDir) {
  if (fromEnv) return fromEnv
  const file = path.join(dataDir, '.admin-password')
  if (fs.existsSync(file)) {
    console.log(`[配置] 后台密码保存在 ${file}`)
    return fs.readFileSync(file, 'utf8').trim()
  }
  const generated = crypto.randomBytes(18).toString('base64url')
  fs.writeFileSync(file, generated, { mode: 0o600 })
  console.warn(`[配置] 没有设置 ADMIN_PASSWORD，已自动生成后台密码：${generated}`)
  console.warn(`[配置] 密码已保存到 ${file}，以后重启不会变；删掉这个文件再重启即可重新生成`)
  return generated
}
