// Normalize the preview returned upstream (HTML / SVG / image / JSON-wrapped) into a standalone HTML document.
// The frontend renders it through a sandboxed iframe, so scripts can run without touching this site's cookies or DOM.

const CONTENT_KEYS = ['html', 'svg', 'content', 'code', 'output', 'result', 'text', 'image_url', 'image', 'url']

export function normalizeContent(buf, contentType = '') {
  const ct = contentType.toLowerCase()
  if (ct.startsWith('image/') && !ct.includes('svg')) {
    return imageDoc(`data:${ct.split(';')[0]};base64,${buf.toString('base64')}`)
  }
  const text = buf.toString('utf8')
  if (ct.includes('json') || /^\s*[{[]/.test(text)) {
    try {
      const picked = pickContent(JSON.parse(text))
      if (picked) return normalizeMarkup(picked)
    } catch {
      // Not JSON; treat it as markup
    }
  }
  return normalizeMarkup(text)
}

const MARKUP_RE = /<(svg|html|!doctype|body|canvas|div|main)\b/i

// Longest string anywhere in the JSON that looks like markup, whatever its key is called (html, preview_html, ...)
function findMarkup(node) {
  let best = null
  const visit = (v, depth) => {
    if (depth > 6 || v == null) return
    if (typeof v === 'string') {
      if (MARKUP_RE.test(v) && (!best || v.length > best.length)) best = v
    } else if (typeof v === 'object') {
      for (const x of Object.values(v)) visit(x, depth + 1)
    }
  }
  visit(node, 0)
  return best
}

// sub2api's own frontend index.html; a wrong path can return it with HTTP 200
export function isAppShell(text) {
  return /<div id=["']app["']/i.test(text)
}

// Used by auto-detection: does this response actually contain a drawing?
export function looksLikeDrawing(buf, contentType = '') {
  const ct = contentType.toLowerCase()
  if (ct.startsWith('image/')) return buf.length > 0
  const text = buf.toString('utf8')
  let markup = text
  if (ct.includes('json') || /^\s*[{[]/.test(text)) {
    try {
      markup = findMarkup(JSON.parse(text)) || ''
    } catch {
      // Not JSON; check the raw text
    }
  }
  if (isAppShell(markup)) return false
  return /<(svg|canvas)\b|<img[^>]+src=["']data:/i.test(markup)
}

function pickContent(node, depth = 0) {
  if (depth > 4 || node == null) return null
  if (typeof node === 'string') return node.trim() ? node : null
  if (typeof node !== 'object') return null
  if ('code' in node && 'data' in node && typeof node.code === 'number') return pickContent(node.data, depth + 1)
  const markup = findMarkup(node)
  if (markup) return markup
  for (const k of CONTENT_KEYS) {
    if (typeof node[k] === 'string' && node[k].trim()) return node[k]
  }
  for (const k of ['data', 'item', 'result']) {
    if (node[k] && typeof node[k] === 'object') {
      const found = pickContent(node[k], depth + 1)
      if (found) return found
    }
  }
  return null
}

export function normalizeMarkup(raw) {
  let s = String(raw).trim()
  const fence = s.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/)
  if (fence) s = fence[1].trim()

  if (/^data:image\//i.test(s) || /^https?:\/\/\S+\.(png|jpe?g|webp|gif|svg)(\?\S*)?$/i.test(s)) return imageDoc(s)
  if (/^<!doctype html|^<html[\s>]/i.test(s)) return s
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s)) {
    return wrapDoc(s.replace(/^<\?xml[^>]*>\s*/i, ''), 'svg{max-width:100%;max-height:100vh;height:auto}')
  }
  return wrapDoc(s, '', false)
}

function imageDoc(src) {
  const safe = src.replace(/"/g, '&quot;')
  return wrapDoc(`<img src="${safe}" alt="">`, 'img{max-width:100%;max-height:100vh;object-fit:contain}')
}

// center=true is only for single images/SVGs; HTML fragments keep their own layout
function wrapDoc(body, css = '', center = true) {
  const base = center
    ? 'html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;background:#fff}'
    : 'body{margin:0}'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${base}${css}</style>
</head><body>${body}</body></html>`
}
