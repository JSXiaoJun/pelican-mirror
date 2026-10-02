import { h, effortLabel, platformLabel, platformMark, seconds, formatTime, relative, speedClass, setTimezone } from './format.js'
import { observeThumb, resetThumbs } from './thumbs.js'
import { createViewer } from './viewer.js'

const PREVIEW_COUNT = 12 // Number of cards shown per group by default
const POLL_MS = 60_000

const $ = (id) => document.getElementById(id)
const viewer = createViewer($('viewer'))
const state = { data: null, active: 'all', expanded: new Set() }

async function load() {
  const res = await fetch('/api/showcase', { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const visibleGroups = () =>
  state.data.groups.filter((g) => state.active === 'all' || String(g.id) === state.active)

function renderHeader() {
  const { site, updatedAt } = state.data
  document.title = site.title
  $('site-title').textContent = site.title
  $('site-subtitle').textContent = site.subtitle || ''
  $('sync-meta').textContent = updatedAt ? `${relative(updatedAt)}同步` : '尚未同步'
  const days = state.data.retentionDays
  $('foot').textContent = days > 0 ? `保留最近 ${days} 天的记录 · 时间按 ${site.timezone} 显示` : `时间按 ${site.timezone} 显示`
}

function renderTabs() {
  const total = state.data.groups.reduce((n, g) => n + g.items.length, 0)
  const tab = (key, label, n) =>
    h('button', {
      class: 'tab', type: 'button', 'aria-pressed': String(state.active === key),
      onclick: () => {
        state.active = key
        history.replaceState(null, '', key === 'all' ? location.pathname : `#g${key}`)
        renderTabs()
        renderGroups()
      }
    }, label, h('span', { class: 'count' }, n))

  $('tabs').replaceChildren(
    tab('all', '全部分组', total),
    ...state.data.groups.map((g) => tab(String(g.id), g.name, g.items.length))
  )
}

function sparkline(group) {
  // Oldest to newest, left to right; bar height is proportional to latency
  const items = group.items.slice(0, 40).reverse()
  const max = Math.max(...items.map((i) => i.latencyMs), 1)
  return h('div', { class: 'spark-wrap', 'aria-hidden': 'true' },
    h('div', { class: 'spark' },
      items.map((i) => h('i', {
        class: speedClass(i.latencyMs, group.medianLatencyMs),
        style: `height:${Math.max(8, Math.round((i.latencyMs / max) * 100))}%`,
        title: `${formatTime(i.generatedAt)} · ${seconds(i.latencyMs)}`
      }))
    ),
    h('span', {}, '耗时趋势')
  )
}

function card(group, item, isLatest) {
  const thumb = h('div', {
    class: 'thumb',
    'data-src': item.hasContent ? `/api/items/${item.id}/content` : null,
    'data-title': `${item.model} 预览`
  })
  if (!item.hasContent) thumb.append(h('div', { class: 'ph' }, h('b', {}, platformMark(group.platform)), '暂无预览'))
  observeThumb(thumb)

  const speed = speedClass(item.latencyMs, group.medianLatencyMs)
  return h('article', { class: 'card' },
    isLatest && h('span', { class: 'tag-new' }, '最新'),
    thumb,
    h('div', { class: 'card-body' },
      h('div', { class: 'row' },
        h('span', { class: 'model', title: item.model }, item.model),
        h('span', { class: 'chip' }, effortLabel(item.effort))
      ),
      h('div', { class: 'row sub' },
        h('span', {}, formatTime(item.generatedAt)),
        h('span', { class: `lat ${speed}` }, seconds(item.latencyMs))
      )
    ),
    h('button', {
      class: 'card-hit', type: 'button',
      'aria-label': `查看大图：${group.name}，${item.model}，${formatTime(item.generatedAt)}`,
      onclick: () => openViewer(item.id)
    })
  )
}

function renderGroups() {
  resetThumbs()
  const root = $('groups')
  root.removeAttribute('aria-busy')
  const groups = visibleGroups()
  if (!groups.length) {
    root.replaceChildren(h('p', { class: 'empty' }, '暂时还没有数据，请先到后台配置上游并同步。'))
    return
  }
  root.replaceChildren(...groups.map((g) => {
    const expanded = state.expanded.has(g.id) || state.active !== 'all'
    const shown = expanded ? g.items : g.items.slice(0, PREVIEW_COUNT)
    const rest = g.items.length - shown.length
    return h('section', { class: 'group', 'aria-labelledby': `g-${g.id}` },
      h('div', { class: 'group-head' },
        h('div', { class: 'group-title' },
          h('span', { class: 'platform', title: platformLabel(g.platform) }, platformMark(g.platform)),
          h('div', {},
            h('h2', { id: `g-${g.id}` }, g.name),
            h('div', { class: 'group-meta' },
              [platformLabel(g.platform), `${g.items.length} 张`, g.medianLatencyMs && `耗时中位数 ${seconds(g.medianLatencyMs)}`,
                `${relative(g.latestAt)}更新`].filter(Boolean).join(' · '))
          )
        ),
        sparkline(g)
      ),
      h('div', { class: 'grid' }, shown.map((it, i) => card(g, it, i === 0))),
      rest > 0 && h('button', {
        class: 'more', type: 'button',
        onclick: () => {
          state.expanded.add(g.id)
          renderGroups()
        }
      }, `展开剩余 ${rest} 张`)
    )
  }))
}

function openViewer(itemId) {
  const entries = visibleGroups().flatMap((group) => group.items.map((item) => ({ group, item })))
  const index = entries.findIndex((e) => e.item.id === itemId)
  if (index >= 0) viewer.open(entries, index)
}

function render() {
  setTimezone(state.data.site.timezone)
  const hashGroup = location.hash.match(/^#g(\d+)$/)?.[1]
  if (hashGroup && state.data.groups.some((g) => String(g.id) === hashGroup)) state.active = hashGroup
  if (state.active !== 'all' && !state.data.groups.some((g) => String(g.id) === state.active)) state.active = 'all'
  renderHeader()
  renderTabs()
  renderGroups()
}

async function refresh({ manual = false } = {}) {
  const btn = $('refresh')
  btn.classList.add('spin')
  try {
    const data = await load()
    const changed = !state.data || JSON.stringify(data) !== JSON.stringify(state.data)
    state.data = data
    // Do not rebuild the page while the large preview is open, so the image being viewed is not reset
    if (changed && !$('viewer').open) render()
    else renderHeader()
  } catch (err) {
    if (!state.data) $('groups').replaceChildren(h('p', { class: 'empty' }, `加载失败：${err.message}`))
    else if (manual) $('sync-meta').textContent = `刷新失败：${err.message}`
  } finally {
    btn.classList.remove('spin')
  }
}

$('refresh').addEventListener('click', () => refresh({ manual: true }))
setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh())
refresh()
