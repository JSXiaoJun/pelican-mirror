import fs from 'node:fs'
import path from 'node:path'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  })
  res.end(body)
}

export async function readJsonBody(req, limit = 256 * 1024) {
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, '请求格式必须是 JSON')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, '请求内容太大')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'JSON 格式错误')
  }
}

export function parseCookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (fwd) return fwd
  }
  return req.socket.remoteAddress || ''
}

export function isHttps(req, trustProxy) {
  return Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https')
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
}

export function serveStatic(root, req, res, extraHeaders = {}) {
  let rel
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  } catch {
    return false
  }
  if (rel === '/') rel = '/index.html'
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html'
  const file = path.join(root, path.normalize(rel))
  if (!file.startsWith(root + path.sep)) return false
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  const ext = path.extname(file)
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    ...extraHeaders
  })
  if (req.method === 'HEAD') return res.end(), true
  fs.createReadStream(file).pipe(res)
  return true
}
