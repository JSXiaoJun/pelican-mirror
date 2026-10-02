import { test } from 'node:test'
import assert from 'node:assert/strict'
import { totp } from '../server/totp.js'
import { jwtExp, unwrapEnvelope, UpstreamError } from '../server/upstream.js'
import { normalizeContent, looksLikeDrawing } from '../server/content.js'
import { parseTs, sanitizeSettings } from '../server/store.js'
import { createCipher, createSessionSigner } from '../server/crypto.js'
import { loadConfig } from '../server/config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('admin password is generated once, persisted, and overridable by env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'))
  try {
    const first = loadConfig({ DATA_DIR: dir }).adminPassword
    assert.ok(first.length >= 24)
    assert.equal(fs.readFileSync(path.join(dir, '.admin-password'), 'utf8'), first)
    assert.equal(loadConfig({ DATA_DIR: dir }).adminPassword, first)
    assert.equal(loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'x' }).adminPassword, 'x')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('totp matches the RFC 6238 SHA1 test vectors', () => {
  // Secret "12345678901234567890" in base32
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  assert.equal(totp(secret, 59_000, 30, 8), '94287082')
  assert.equal(totp(secret, 1111111109_000, 30, 8), '07081804')
  assert.equal(totp(secret, 59_000).length, 6)
})

test('jwtExp reads the exp claim', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1700000000 })).toString('base64url')
  assert.equal(jwtExp(`x.${payload}.y`), 1700000000_000)
  assert.equal(jwtExp('not-a-jwt'), null)
})

test('unwrapEnvelope handles the sub2api envelope and bare payloads', () => {
  assert.deepEqual(unwrapEnvelope({ code: 0, message: 'success', data: { a: 1 } }), { a: 1 })
  assert.deepEqual(unwrapEnvelope({ enabled: true, groups: [] }), { enabled: true, groups: [] })
  assert.throws(() => unwrapEnvelope({ code: 401, message: 'bad' }), UpstreamError)
})

test('parseTs handles Go microsecond timestamps', () => {
  assert.equal(parseTs('2026-09-30T16:00:10.013351+08:00'), Date.parse('2026-09-30T08:00:10.013Z'))
  assert.equal(parseTs('garbage'), null)
})

test('normalizeContent wraps SVG, unpacks JSON and markdown fences', () => {
  const svg = normalizeContent(Buffer.from('<svg viewBox="0 0 1 1"></svg>'), 'image/svg+xml')
  assert.match(svg, /^<!doctype html>/)
  assert.match(svg, /<svg viewBox/)

  const json = normalizeContent(Buffer.from(JSON.stringify({ code: 0, data: { html: '<!doctype html><p>hi</p>' } })), 'application/json')
  assert.equal(json, '<!doctype html><p>hi</p>')

  const fenced = normalizeContent(Buffer.from('```html\n<!DOCTYPE html><b>x</b>\n```'), 'text/plain')
  assert.equal(fenced, '<!DOCTYPE html><b>x</b>')

  const png = normalizeContent(Buffer.from([1, 2, 3]), 'image/png')
  assert.match(png, /data:image\/png;base64,AQID/)
})

test('preview detection finds markup under any key and rejects the app shell', () => {
  const json = Buffer.from(JSON.stringify({ code: 0, data: { id: 1, preview_html: '<!doctype html><svg></svg>' } }))
  assert.match(normalizeContent(json, 'application/json'), /<svg><\/svg>/)
  assert.ok(looksLikeDrawing(json, 'application/json'))
  assert.ok(looksLikeDrawing(Buffer.from('<svg viewBox="0 0 1 1"></svg>'), 'image/svg+xml'))
  assert.ok(!looksLikeDrawing(Buffer.from('<!doctype html><div id="app"></div>'), 'text/html'))
  assert.ok(!looksLikeDrawing(Buffer.from(JSON.stringify({ code: 0, data: { groups: [] } })), 'application/json'))
})

test('sanitizeSettings validates input', () => {
  assert.equal(sanitizeSettings({ baseUrl: 'https://a.com/' }).baseUrl, 'https://a.com')
  assert.throws(() => sanitizeSettings({ baseUrl: 'ftp://a.com' }))
  assert.throws(() => sanitizeSettings({ timezone: 'Mars/Base' }))
  assert.throws(() => sanitizeSettings({ contentUrlTemplate: 'javascript:alert(1)' }))
  assert.equal(sanitizeSettings({ syncIntervalMin: 0 }).syncIntervalMin, 1)
})

test('cipher round-trips and session signer rejects tampering', () => {
  const c = createCipher('secret-secret-secret')
  assert.equal(c.decrypt(c.encrypt('hello')), 'hello')
  const s = createSessionSigner('secret-secret-secret', 'pw')
  const tok = s.issue()
  assert.ok(s.verify(tok))
  assert.ok(!s.verify(tok.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'))))
  assert.ok(!createSessionSigner('secret-secret-secret', 'other').verify(tok))
})
