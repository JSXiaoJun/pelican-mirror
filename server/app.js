import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionSigner, safeEqual } from './crypto.js'
import { HttpError, sendJson, readJsonBody, parseCookies, clientIp, isHttps, serveStatic } from './http.js'
import { PREVIEW_CANDIDATES } from './upstream.js'
import { thumbnailDoc } from './content.js'

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
const COOKIE = 'pm_admin'
const LOGIN_MAX_FAILS = 5
const LOGIN_LOCK_MS = 15 * 60_000

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}
// The preview document is served standalone, with a CSP sandbox that forces an opaque origin: scripts cannot read this site's cookies or storage
const CONTENT_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: https:; script-src 'unsafe-inline' https:; media-src data: blob: https:",
  'Cache-Control': 'public, max-age=86400',
  'X-Content-Type-Options': 'nosniff'
}
const THUMB_HEADERS = {
  ...CONTENT_HEADERS,
  'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: https:"
}

export function buildShowcase(store) {
  const settings = store.getSettings()
  const status = store.getStatus()
  const groups = store.listGroups()
    .filter((g) => g.visible)
    .map((g) => {
      const items = store.listItems(g.id, settings.displayLimit)
      const latencies = items.map((i) => i.latency_ms).filter((n) => n > 0).sort((a, b) => a - b)
      return {
        id: g.id,
        name: g.display_name || g.upstream_name || `分组 ${g.id}`,
        platform: g.platform,
        total: g.item_count,
        latestAt: g.latest_ts,
        medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
        items: items.map((i) => ({
          id: i.id,
          model: i.model_id,
          effort: i.reasoning_effort,
          latencyMs: i.latency_ms,
          generatedAt: i.generated_ts,
          hasContent: Boolean(i.has_content)
        }))
      }
    })
    .filter((g) => g.items.length > 0)
  return {
    site: { title: settings.siteTitle, subtitle: settings.siteSubtitle, timezone: settings.timezone },
    updatedAt: status.lastSuccessAt || null,
    retentionDays: settings.localRetentionDays,
    groups
  }
}

export function createApp({ config, store, upstream, syncer }) {
  const session = createSessionSigner(config.appSecret, config.adminPassword)
  const loginFails = new Map()

  const isAdmin = (req) => session.verify(parseCookies(req)[COOKIE])

  function adminState() {
    const status = store.getStatus()
    return {
      settings: store.getSettings(),
      credentials: upstream.tokenInfo(),
      status: { ...status, syncing: syncer.isRunning(), counts: store.counts() },
      groups: store.listGroups().map((g) => ({
        id: g.id,
        upstreamName: g.upstream_name,
        displayName: g.display_name || '',
        platform: g.platform,
        visible: Boolean(g.visible),
        sortOrder: g.sort_order,
        itemCount: g.item_count,
        latestAt: g.latest_ts
      }))
    }
  }

  function checkLoginThrottle(ip) {
    const rec = loginFails.get(ip)
    if (rec && rec.count >= LOGIN_MAX_FAILS && Date.now() - rec.at < LOGIN_LOCK_MS) {
      throw new HttpError(429, '密码错误次数太多，请 15 分钟后再试')
    }
  }
  function recordLoginFail(ip) {
    const rec = loginFails.get(ip)
    const fresh = !rec || Date.now() - rec.at > LOGIN_LOCK_MS
    loginFails.set(ip, { count: fresh ? 1 : rec.count + 1, at: Date.now() })
  }

  async function handleAdmin(req, res, p) {
    const ip = clientIp(req, config.trustProxy)

    if (p === '/api/admin/login' && req.method === 'POST') {
      checkLoginThrottle(ip)
      const { password } = await readJsonBody(req)
      if (!password || !safeEqual(password, config.adminPassword)) {
        recordLoginFail(ip)
        throw new HttpError(401, '密码错误')
      }
      loginFails.delete(ip)
      const secure = isHttps(req, config.trustProxy) ? '; Secure' : ''
      const maxAge = Math.floor(session.ttlMs / 1000)
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE}=${session.issue()}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
      })
    }
    if (p === '/api/admin/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0` })
    }

    if (!isAdmin(req)) throw new HttpError(401, '未登录')
    // CSRF: besides SameSite=Strict, require a custom header on writes (cross-origin forms cannot set it)
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'pelican-admin') {
      throw new HttpError(403, '缺少请求头')
    }

    if (p === '/api/admin/state' && req.method === 'GET') return sendJson(res, 200, adminState())

    if (p === '/api/admin/settings' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      try {
        if (body.settings) store.saveSettings(body.settings)
      } catch (err) {
        throw new HttpError(400, err.message)
      }
      if (body.credentials) {
        const c = body.credentials
        const patch = {}
        // Empty strings mean "leave unchanged"; to clear, pass null explicitly
        for (const k of ['email', 'password', 'totpSecret', 'accessToken', 'refreshToken']) {
          if (c[k] === null) patch[k] = null
          else if (typeof c[k] === 'string' && c[k].trim()) patch[k] = c[k]
        }
        if (patch.accessToken && patch.accessToken.startsWith('rt_')) {
          throw new HttpError(400, '这看起来是 Refresh Token（rt_ 开头），请填到 Refresh Token 那一栏')
        }
        if (patch.refreshToken && !patch.refreshToken.startsWith('rt_')) {
          throw new HttpError(400, 'sub2api 的 Refresh Token 应该以 rt_ 开头')
        }
        store.saveSecrets(patch)
      }
      syncer.reschedule()
      // After the first configuration, sync once in the background right away so the admin does not have to wait for the next interval
      if (store.getSettings().baseUrl && !store.getStatus().lastSuccessAt) syncer.syncNow().catch(() => {})
      return sendJson(res, 200, adminState())
    }

    if (p === '/api/admin/groups' && req.method === 'PUT') {
      const { groups } = await readJsonBody(req)
      if (!Array.isArray(groups)) throw new HttpError(400, 'groups 必须是数组')
      for (const g of groups) store.updateGroup(g.id, g)
      return sendJson(res, 200, adminState())
    }

    if (p === '/api/admin/auth/renew' && req.method === 'POST') {
      try {
        await upstream.renewOnce()
      } catch (err) {
        throw new HttpError(502, `登录 / 刷新失败：${err.message}`)
      }
      return sendJson(res, 200, adminState())
    }

    if (p === '/api/admin/sync' && req.method === 'POST') {
      try {
        await syncer.syncNow()
      } catch (err) {
        throw new HttpError(502, `同步失败：${err.message}`)
      }
      return sendJson(res, 200, adminState())
    }

    if (p === '/api/admin/content/probe' && req.method === 'POST') {
      const item = store.latestItem()
      if (!item) throw new HttpError(400, '还没有同步到任何记录，先点「立即同步」')
      const result = await upstream.probeContent(item, PREVIEW_CANDIDATES)
      if (result.template) {
        store.saveSettings({ contentUrlTemplate: result.template })
        store.resetContentErrors()
        // If a sync is already running it read the old (empty) template; run one more after it
        const kick = () => syncer.syncNow().catch(() => {})
        if (syncer.isRunning()) kick().then(kick)
        else kick()
      }
      return sendJson(res, 200, { ...result, state: adminState() })
    }

    if (p === '/api/admin/content/retry' && req.method === 'POST') {
      const reset = store.resetContentErrors()
      syncer.syncNow().catch(() => {})
      return sendJson(res, 200, { reset })
    }

    throw new HttpError(404, 'Not Found')
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname

    if (p === '/api/showcase' && req.method === 'GET') {
      return sendJson(res, 200, buildShowcase(store), { 'Cache-Control': 'public, max-age=30' })
    }
    const m = p.match(/^\/api\/items\/(\d+)\/(content|thumb)$/)
    if (m && req.method === 'GET') {
      const raw = store.getItemContent(m[1])
      if (!raw) throw new HttpError(404, '暂无预览')
      const isThumb = m[2] === 'thumb'
      const html = isThumb ? thumbnailDoc(raw) : raw
      res.writeHead(200, { ...(isThumb ? THUMB_HEADERS : CONTENT_HEADERS), 'Content-Length': Buffer.byteLength(html) })
      return res.end(html)
    }
    if (p.startsWith('/api/admin/')) return handleAdmin(req, res, p)
    if (p.startsWith('/api/')) throw new HttpError(404, 'Not Found')

    if (req.method === 'GET' || req.method === 'HEAD') {
      // The admin panel must not be embedded; the showcase page may be embedded anywhere (it is meant to be a nested page)
      const extra = p.startsWith('/admin')
        ? { ...SECURITY_HEADERS, 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }
        : SECURITY_HEADERS
      if (serveStatic(PUBLIC_DIR, req, res, extra)) return
    }
    throw new HttpError(404, 'Not Found')
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error('[http]', err)
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? '服务器内部错误，请看启动窗口里的日志' : err.message })
      else res.destroy()
    })
  })
}
