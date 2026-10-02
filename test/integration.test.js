import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openDb } from '../server/db.js'
import { createCipher } from '../server/crypto.js'
import { createStore } from '../server/store.js'
import { createUpstream } from '../server/upstream.js'
import { createSyncer } from '../server/sync.js'
import { createApp } from '../server/app.js'

// ---- Mock sub2api: login -> rt rotation -> auth required on showcase ----
const jwt = (expSec) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`
const up = { validAccess: new Set(), validRefresh: new Set(), seq: 0, calls: [] }

function issue() {
  const at = jwt(Math.floor(Date.now() / 1000) + 3600) + ++up.seq
  const rt = `rt_${up.seq}`
  up.validAccess.add(at)
  up.validRefresh.add(rt)
  return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'Bearer' }
}

const ok = (res, data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 0, message: 'success', data }))
const fail = (res, status, message) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: status, message }))

const mock = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const url = new URL(req.url, 'http://x')
  up.calls.push(url.pathname)
  const auth = (req.headers.authorization || '').replace('Bearer ', '')

  if (url.pathname === '/api/v1/auth/login') {
    const { email, password } = JSON.parse(body)
    return email === 'me@x.com' && password === 'pw' ? ok(res, issue()) : fail(res, 401, 'invalid credentials')
  }
  if (url.pathname === '/api/v1/auth/refresh') {
    const { refresh_token } = JSON.parse(body)
    if (!up.validRefresh.delete(refresh_token)) return fail(res, 401, 'refresh token invalid')
    return ok(res, issue())
  }
  if (String(req.headers['user-agent']).includes('WrongBrowser')) {
    return res.writeHead(401, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ code: 401, message: 'Session network fingerprint changed', reason: 'SESSION_BINDING_MISMATCH' }))
  }
  if (!up.validAccess.has(auth)) return fail(res, 401, 'unauthorized')
  if (url.pathname === '/api/v1/pelican-showcase') {
    assert.equal(url.searchParams.get('timezone'), 'Asia/Shanghai')
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      enabled: true, max_items: 50, retention_days: 1,
      groups: [{
        id: 2, name: 'GPT-不降智', platform: 'openai',
        items: [
          { id: 196, group_id: 2, model_id: 'gpt-6-astra', reasoning_effort: 'low', latency_ms: 139101, generated_at: new Date().toISOString() },
          { id: 194, group_id: 2, model_id: 'gpt-6-astra', reasoning_effort: 'low', latency_ms: 118487, generated_at: new Date(Date.now() - 1800_000).toISOString() }
        ]
      }]
    }))
  }
  const m = url.pathname.match(/^\/api\/v1\/pelican-showcase\/items\/(\d+)\/svg$/)
  if (m) return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(`<svg id="p${m[1]}"></svg>`)
  fail(res, 404, 'not found')
})

let app, base, store, upstream
const config = { appSecret: 'test-secret-0123456789', adminPassword: 'admin-pw', trustProxy: false }

before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  store = createStore(openDb(':memory:'), createCipher(config.appSecret))
  store.saveSettings({
    baseUrl: `http://127.0.0.1:${mock.address().port}`,
    contentUrlTemplate: '/api/v1/pelican-showcase/items/{id}/svg'
  })
  const quiet = { info() {}, warn() {}, error() {} }
  upstream = createUpstream(store, { log: quiet })
  app = createApp({ config, store, upstream, syncer: createSyncer(store, upstream, { log: quiet }) })
  await new Promise((r) => app.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${app.address().port}`
})

after(() => {
  app.close()
  mock.close()
})

async function adminCookie() {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin-pw' })
  })
  assert.equal(res.status, 200)
  return res.headers.get('set-cookie').split(';')[0]
}
const adminHeaders = (cookie) => ({ Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'pelican-admin' })

test('admin endpoints require login and the CSRF header', async () => {
  assert.equal((await fetch(`${base}/api/admin/state`)).status, 401)
  const bad = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' })
  })
  assert.equal(bad.status, 401)
  const cookie = await adminCookie()
  const noHeader = await fetch(`${base}/api/admin/sync`, { method: 'POST', headers: { Cookie: cookie } })
  assert.equal(noHeader.status, 403)
})

test('password login -> sync -> showcase with renamed group', async () => {
  const cookie = await adminCookie()
  let res = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT', headers: adminHeaders(cookie),
    body: JSON.stringify({ credentials: { email: 'me@x.com', password: 'pw' } })
  })
  const state = await res.json()
  assert.equal(state.credentials.hasPassword, true)
  assert.ok(!JSON.stringify(state).includes('"pw"'), 'password must never be echoed back')

  res = await fetch(`${base}/api/admin/sync`, { method: 'POST', headers: adminHeaders(cookie) })
  assert.equal(res.status, 200)
  assert.ok(up.calls.includes('/api/v1/auth/login'))

  await fetch(`${base}/api/admin/groups`, {
    method: 'PUT', headers: adminHeaders(cookie),
    body: JSON.stringify({ groups: [{ id: 2, displayName: 'My Custom Name', visible: true, sortOrder: 0 }] })
  })

  const show = await (await fetch(`${base}/api/showcase`)).json()
  assert.equal(show.groups.length, 1)
  assert.equal(show.groups[0].name, 'My Custom Name')
  assert.equal(show.groups[0].items[0].id, 196)
  assert.equal(show.groups[0].items[0].hasContent, true)
  assert.ok(!JSON.stringify(show).includes('127.0.0.1'), 'upstream address must not leak to the public API')

  const content = await fetch(`${base}/api/items/196/content`)
  assert.equal(content.status, 200)
  assert.match(content.headers.get('content-security-policy'), /sandbox allow-scripts/)
  assert.match(await content.text(), /<svg id="p196">/)
})

test('expired access token is refreshed via rotated refresh token', async () => {
  up.validAccess.clear() // Simulate the access token being revoked/expired upstream
  const before = store.getSecrets().refreshToken
  const data = await upstream.fetchShowcase()
  assert.equal(data.groups.length, 1)
  const after = store.getSecrets().refreshToken
  assert.notEqual(after, before, 'rotated refresh token must be persisted')
  assert.ok(!up.validRefresh.has(before))
})

test('falls back to password login when refresh token is dead', async () => {
  up.validAccess.clear()
  up.validRefresh.clear()
  const logins = up.calls.filter((c) => c === '/api/v1/auth/login').length
  await upstream.fetchShowcase()
  assert.equal(up.calls.filter((c) => c === '/api/v1/auth/login').length, logins + 1)
})

test('concurrent 401s trigger a single refresh', async () => {
  up.validAccess.clear()
  const refreshes = up.calls.filter((c) => c === '/api/v1/auth/refresh').length
  await Promise.all([upstream.fetchShowcase(), upstream.fetchShowcase(), upstream.fetchShowcase()])
  assert.equal(up.calls.filter((c) => c === '/api/v1/auth/refresh').length, refreshes + 1)
})

test('token-only mode works without email/password', async () => {
  store.saveSecrets({ email: null, password: null })
  up.validAccess.clear()
  await upstream.fetchShowcase() // Refreshes with the stored rt only
  assert.ok(store.getSecrets().accessToken)
})

// Must run last: it revokes the stored tokens
test('session binding mismatch (tokens only) is reported clearly without burning a refresh', async () => {
  store.saveSettings({ userAgent: 'WrongBrowser/1.0' })
  const refreshes = up.calls.filter((c) => c === '/api/v1/auth/refresh').length
  await assert.rejects(upstream.fetchShowcase(), /会话绑定/)
  assert.equal(up.calls.filter((c) => c === '/api/v1/auth/refresh').length, refreshes)
  assert.match(store.getStatus().authError, /会话绑定/)
  assert.equal(store.getSecrets().refreshToken, undefined)
  store.saveSettings({ userAgent: '' })
})
