import { totp } from './totp.js'
import { normalizeContent, looksLikeDrawing, isAppShell } from './content.js'

// Likely per-item preview endpoints on the friend's sub2api fork, tried in order by auto-detection
export const PREVIEW_CANDIDATES = [
  '/api/v1/pelican-showcase/items/{id}',
  '/api/v1/pelican-showcase/items/{id}/html',
  '/api/v1/pelican-showcase/items/{id}/content',
  '/api/v1/pelican-showcase/items/{id}/preview',
  '/api/v1/pelican-showcase/items/{id}/raw',
  '/api/v1/pelican-showcase/item/{id}',
  '/api/v1/pelican-showcase/{id}',
  '/api/v1/pelican-showcase/{id}/html',
  '/api/v1/pelican-showcase/groups/{group_id}/items/{id}'
]

// Use a fixed UA for every request to the upstream. sub2api can enable session binding (IP+UA),
// and a UA that stays constant keeps the refresh token family from being revoked for a changed fingerprint.
const USER_AGENT = 'Mozilla/5.0 (compatible; PelicanMirror/0.1)'
const TIMEOUT_MS = 30_000
const REFRESH_LEEWAY_MS = 5 * 60_000
const MAX_CONTENT_BYTES = 5 * 1024 * 1024

const BINDING_REASON = 'SESSION_BINDING_MISMATCH'
const bindingError = () =>
  new UpstreamError(
    '上游开启了「会话绑定」（IP + 浏览器 UA）：从浏览器复制的令牌拿到本程序用时指纹对不上，上游已把这组令牌作废（浏览器那边通常也会被登出）。' +
      '建议改填账号密码；或者在「上游设置」里填入浏览器的 User-Agent，再到浏览器重新登录、复制新令牌。',
    { status: 401, reason: BINDING_REASON }
  )

export class UpstreamError extends Error {
  constructor(message, { status = 0, reason = '' } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.reason = reason
  }
  get isAuth() {
    return this.status === 401 || this.status === 403
  }
}

// sub2api wraps responses as { code, message, data }; code 0 means success. Tolerate unwrapped payloads too
export function unwrapEnvelope(json) {
  if (json && typeof json === 'object' && 'code' in json && ('data' in json || 'message' in json)) {
    if (json.code !== 0) throw new UpstreamError(json.message || `code ${json.code}`, { status: json.code, reason: json.reason })
    return json.data
  }
  return json
}

export function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

export function mask(token) {
  if (!token) return ''
  return token.length <= 12 ? '***' : `${token.slice(0, 6)}…${token.slice(-4)}`
}

export function createUpstream(store, { fetchImpl = globalThis.fetch, log = console } = {}) {
  let refreshing = null

  const baseUrl = () => {
    const { baseUrl } = store.getSettings()
    if (!baseUrl) throw new UpstreamError('还没有填写上游站点地址')
    return baseUrl
  }
  // Paths starting with / are appended to baseUrl; this avoids new URL() dropping a path prefix inside baseUrl
  const resolve = (p) => (/^https?:\/\//.test(p) ? p : baseUrl() + (p.startsWith('/') ? p : `/${p}`))

  async function send(p, { method = 'GET', token, body, accept = 'application/json' } = {}) {
    const target = resolve(p)
    const headers = { 'User-Agent': store.getSettings().userAgent || USER_AGENT, Accept: accept }
    // Only attach the token to requests on the same origin as baseUrl, so it cannot leak to a third-party preview address
    if (token && new URL(target).origin === new URL(baseUrl()).origin) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      return await fetchImpl(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow'
      })
    } catch (err) {
      if (err instanceof UpstreamError) throw err
      const code = err.cause?.code || err.name
      const hint = code === 'TimeoutError' ? '请求超时' : code === 'ENOTFOUND' ? '域名解析失败' : code === 'ECONNREFUSED' ? '连接被拒绝' : ''
      throw new UpstreamError(`连接上游失败：${hint || err.cause?.code || err.message}`)
    }
  }

  async function readJson(res) {
    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      throw new UpstreamError(`上游返回的不是 JSON（HTTP ${res.status}），检查站点地址是否填对`, { status: res.status })
    }
    if (!res.ok) {
      throw new UpstreamError(json?.message || `HTTP ${res.status}`, { status: res.status, reason: json?.reason })
    }
    return unwrapEnvelope(json)
  }

  function saveTokens(data, via) {
    if (!data?.access_token) throw new UpstreamError('上游登录返回里没有 access_token')
    const patch = { accessToken: data.access_token }
    // With refresh token rotation the old rt is invalid right away, so it must be written to disk immediately
    if (data.refresh_token) patch.refreshToken = data.refresh_token
    store.saveSecrets(patch)
    store.patchStatus({ tokenUpdatedAt: Date.now(), tokenVia: via, authError: null })
    return data.access_token
  }

  async function refreshWith(refreshToken) {
    const res = await send('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } })
    return saveTokens(await readJson(res), 'refresh')
  }

  async function loginWithPassword({ email, password, totpSecret }) {
    const res = await send('/api/v1/auth/login', { method: 'POST', body: { email, password } })
    const data = await readJson(res)
    if (data?.requires_2fa) {
      if (!totpSecret) throw new UpstreamError('这个账号开了两步验证，请在后台填写两步验证密钥', { status: 401 })
      const res2 = await send('/api/v1/auth/login/2fa', {
        method: 'POST',
        body: { temp_token: data.temp_token, totp_code: totp(totpSecret) }
      })
      return saveTokens(await readJson(res2), 'login+2fa')
    }
    return saveTokens(data, 'login')
  }

  // Renew order: refresh token first; if it is invalid, fall back to password login
  async function renew() {
    const secrets = store.getSecrets()
    if (secrets.refreshToken) {
      try {
        return await refreshWith(secrets.refreshToken)
      } catch (err) {
        if (!(err instanceof UpstreamError) || !err.isAuth) throw err // Network errors keep the rt
        log.warn(`[上游] Refresh Token 已失效：${err.message}`)
        store.saveSecrets({ refreshToken: null })
        if (!(secrets.email && secrets.password)) {
          throw err.reason === BINDING_REASON
            ? bindingError()
            : new UpstreamError(`Refresh Token 已失效（上游返回：${err.message}），且没有配置账号密码，请重新填写`, { status: 401 })
        }
      }
    }
    if (secrets.email && secrets.password) return await loginWithPassword(secrets)
    throw new UpstreamError('没有可用的登录方式：Refresh Token 已失效，也没有配置账号密码', { status: 401 })
  }

  function renewOnce() {
    if (!refreshing) {
      refreshing = renew()
        .catch((err) => {
          store.patchStatus({ authError: err.message, authErrorAt: Date.now() })
          throw err
        })
        .finally(() => {
          refreshing = null
        })
    }
    return refreshing
  }

  // failedToken: the token that just got a 401. If the stored token has already changed (renewed concurrently), reuse the new one
  async function getAccessToken({ failedToken } = {}) {
    const { accessToken, refreshToken, email, password } = store.getSecrets()
    const canRenew = Boolean(refreshToken || (email && password))
    if (!accessToken && !canRenew) return null // No credentials: fall back to anonymous requests

    if (accessToken && failedToken && accessToken !== failedToken) return accessToken
    if (accessToken && !failedToken) {
      const exp = jwtExp(accessToken)
      if (exp === null || exp - Date.now() > REFRESH_LEEWAY_MS) return accessToken
      if (!canRenew) return accessToken
      try {
        return await renewOnce()
      } catch (err) {
        if (exp > Date.now()) return accessToken // Proactive renewal failed but the token is still valid; keep using it
        throw err
      }
    }
    if (!canRenew) throw new UpstreamError('Access Token 已失效，且没有配置 Refresh Token 或账号密码', { status: 401 })
    return renewOnce()
  }

  async function authedSend(p, opts = {}) {
    const token = await getAccessToken()
    let res = await send(p, { ...opts, token })
    if (res.status === 401 && token) {
      const text = await res.text().catch(() => '')
      let reason = ''
      try {
        reason = JSON.parse(text).reason || ''
      } catch {}
      // Upstream has already revoked this whole session; refreshing again cannot succeed, so report the real cause
      if (reason === BINDING_REASON) {
        store.saveSecrets({ accessToken: null, refreshToken: null }) // Both are revoked upstream; keeping them is useless
        const { email, password } = store.getSecrets()
        if (!(email && password)) {
          const err = bindingError()
          store.patchStatus({ authError: err.message, authErrorAt: Date.now() })
          throw err
        }
        log.warn('[上游] 会话绑定不匹配，改用账号密码重新登录')
      }
      const next = await getAccessToken({ failedToken: token })
      res = await send(p, { ...opts, token: next })
    }
    return res
  }

  async function fetchRaw(item, template) {
    const p = template
      .replaceAll('{id}', encodeURIComponent(item.id))
      .replaceAll('{group_id}', encodeURIComponent(item.group_id))
    const res = await authedSend(p, { accept: 'text/html, image/svg+xml, application/json;q=0.9, */*;q=0.5' })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let msg = `HTTP ${res.status}`
      try {
        msg = JSON.parse(text).message || msg
      } catch {}
      throw new UpstreamError(msg, { status: res.status })
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_CONTENT_BYTES) throw new UpstreamError(`预览内容太大（${buf.length} 字节）`)
    return { buf, contentType: res.headers.get('content-type') || '' }
  }

  return {
    getAccessToken,
    renewOnce,

    async fetchShowcase() {
      const { timezone } = store.getSettings()
      const res = await authedSend(`/api/v1/pelican-showcase?timezone=${encodeURIComponent(timezone)}`)
      return readJson(res)
    },

    async fetchContent(item) {
      const { contentUrlTemplate } = store.getSettings()
      if (!contentUrlTemplate) return null
      const { buf, contentType } = await fetchRaw(item, contentUrlTemplate)
      if (isAppShell(buf.toString('utf8'))) throw new UpstreamError('返回的是站点首页而不是画，预览路径可能填错了')
      return normalizeContent(buf, contentType)
    },

    // Try candidate paths one by one against a real item; stop at the first one that returns a drawing
    async probeContent(item, candidates) {
      const tried = []
      for (const template of candidates) {
        try {
          const { buf, contentType } = await fetchRaw(item, template)
          const ok = looksLikeDrawing(buf, contentType)
          tried.push({ template, result: ok ? '找到了' : `有返回，但不是画（${contentType || '未知类型'}，${buf.length} 字节）` })
          if (ok) return { template, tried }
        } catch (err) {
          tried.push({ template, result: err.message })
          // Login problem: stop, so probing does not keep burning refresh tokens
          if (err instanceof UpstreamError && err.isAuth) break
        }
      }
      return { template: null, tried }
    },

    tokenInfo() {
      const s = store.getSecrets()
      return {
        hasEmail: Boolean(s.email),
        email: s.email || '',
        hasPassword: Boolean(s.password),
        hasTotp: Boolean(s.totpSecret),
        accessToken: mask(s.accessToken),
        accessTokenExp: s.accessToken ? jwtExp(s.accessToken) : null,
        refreshToken: mask(s.refreshToken)
      }
    }
  }
}
