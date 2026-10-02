import crypto from 'node:crypto'

// AES-256-GCM for upstream credentials stored at rest.
export function createCipher(appSecret) {
  const key = crypto.createHash('sha256').update(`enc:${appSecret}`).digest()

  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
    },
    decrypt(payload) {
      const [iv, tag, data] = payload.split('.').map((s) => Buffer.from(s, 'base64'))
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(data), d.final()]).toString('utf8')
    }
  }
}

// Stateless signed session token for the admin panel. The key includes the
// admin password, so changing ADMIN_PASSWORD invalidates existing sessions.
export function createSessionSigner(appSecret, adminPassword, ttlMs = 7 * 86400_000) {
  const key = crypto.createHash('sha256').update(`sess:${appSecret}:${adminPassword}`).digest()
  const sign = (body) => crypto.createHmac('sha256', key).update(body).digest('base64url')

  return {
    ttlMs,
    issue() {
      const body = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url')
      return `${body}.${sign(body)}`
    },
    verify(token) {
      if (typeof token !== 'string') return false
      const [body, sig] = token.split('.')
      if (!body || !sig) return false
      const expected = Buffer.from(sign(body))
      const given = Buffer.from(sig)
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false
      try {
        return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now()
      } catch {
        return false
      }
    }
  }
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}
