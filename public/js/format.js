const EFFORT = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高' }
const PLATFORM = { openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini', antigravity: 'Antigravity' }
const PLATFORM_MARK = { openai: 'AI', anthropic: 'C', gemini: 'G', antigravity: 'AG' }

export const effortLabel = (e) => EFFORT[e] || e || '—'
export const platformLabel = (p) => PLATFORM[p] || p || '其他'
export const platformMark = (p) => PLATFORM_MARK[p] || (p ? p.slice(0, 2).toUpperCase() : '·')
export const seconds = (ms) => (ms ? `${(ms / 1000).toFixed(1)} 秒` : '—')

let timeFmt = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
export function setTimezone(timeZone) {
  try {
    timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch {
    // Invalid timezone: keep the browser's local timezone
  }
}
export const formatTime = (ts) => (ts ? timeFmt.format(ts) : '—')

export function relative(ts, now = Date.now()) {
  if (!ts) return '从未同步'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

// Relative to the group's median latency: 15% faster = fast, 25% slower = slow
export function speedClass(ms, median) {
  if (!ms || !median) return ''
  if (ms <= median * 0.85) return 'fast'
  if (ms >= median * 1.25) return 'slow'
  return ''
}

// Minimal DOM builder; all text goes through text nodes, never innerHTML
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style') el.style.cssText = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
  }
  return el
}
