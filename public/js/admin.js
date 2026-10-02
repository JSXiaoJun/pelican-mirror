import { h, formatTime, relative } from './format.js'

const $ = (id) => document.getElementById(id)
let state = null

const CRED_FIELDS = [
  { key: 'email', label: '邮箱', type: 'email', show: (c) => c.email },
  { key: 'password', label: '密码', type: 'password', show: (c) => c.hasPassword && '已设置' },
  { key: 'totpSecret', label: '两步验证密钥（可选）', hint: '账号开了两步验证才需要填，base32 格式', type: 'password', show: (c) => c.hasTotp && '已设置' },
  {
    key: 'accessToken', label: 'Access Token（访问令牌）', area: true,
    show: (c) => c.accessToken && `${c.accessToken} · ${c.accessTokenExp ? formatTime(c.accessTokenExp) : '未知时间'}过期`
  },
  { key: 'refreshToken', label: 'Refresh Token（刷新令牌）', hint: 'rt_ 开头，每次刷新后自动更换', area: true, show: (c) => c.refreshToken }
]
const VIA = { login: '账号密码登录', 'login+2fa': '账号密码 + 两步验证登录', refresh: '刷新令牌' }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'pelican-admin', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && path !== '/api/admin/login') {
    showLogin()
    throw new Error(data.error || '未登录')
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

let toastTimer
function toast(msg, isError = false) {
  document.querySelector('.toast')?.remove()
  const el = h('div', { class: `toast${isError ? ' err' : ''}`, role: 'status' }, msg)
  document.body.append(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), isError ? 6000 : 2800)
}

async function busy(btn, fn) {
  btn.disabled = true
  try {
    await fn()
  } catch (err) {
    toast(err.message, true)
  } finally {
    btn.disabled = false
  }
}

function showLogin() {
  $('app').hidden = true
  $('login').hidden = false
  $('login-form').password.focus()
}

let pollTimer
function render(next) {
  state = next
  // While a background sync is running, refresh the status every 2 seconds so the panel is not stuck on "同步中"
  clearTimeout(pollTimer)
  if (next.status.syncing) {
    pollTimer = setTimeout(() => api('/api/admin/state').then(renderStatusOnly).catch(() => {}), 2000)
  }
  $('login').hidden = true
  $('app').hidden = false
  renderStats()
  renderSettings()
  renderCreds()
  renderGroups()
}

// Poll refreshes only the status, credentials and groups, so fields you are typing in are not overwritten
function renderStatusOnly(next) {
  state = next
  clearTimeout(pollTimer)
  if (next.status.syncing) {
    pollTimer = setTimeout(() => api('/api/admin/state').then(renderStatusOnly).catch(() => {}), 2000)
  }
  renderStats()
  // Groups appear once the first sync finishes; if they are already shown, do not rebuild them, so edits in progress are kept
  if (!document.querySelector('#groups-table tr[data-id]')) renderGroups()
}

$('use-browser-ua').addEventListener('click', () => {
  $('settings-form').elements.userAgent.value = navigator.userAgent
  toast('已填入，记得点「保存设置」')
})

function renderStats() {
  const s = state.status
  const c = state.credentials
  const st = s.lastStats
  const stat = (label, value, cls = '') => h('div', { class: `stat ${cls}` }, h('dt', {}, label), h('dd', {}, value || '—'))
  $('stats').replaceChildren(
    stat('上次成功同步', s.lastSuccessAt && `${relative(s.lastSuccessAt)}（${formatTime(s.lastSuccessAt)}）`, s.lastSuccessAt ? 'good' : ''),
    stat('最近同步错误', s.lastError ? `${s.lastError} · ${formatTime(s.lastErrorAt)}` : '无', s.lastError ? 'bad' : ''),
    stat('登录状态', s.authError ? `${s.authError}` : s.tokenUpdatedAt ? `正常 · ${formatTime(s.tokenUpdatedAt)} 通过${VIA[s.tokenVia] || s.tokenVia}` : '尚未登录', s.authError ? 'bad' : ''),
    stat('访问令牌过期时间', c.accessTokenExp && `${formatTime(c.accessTokenExp)}`),
    stat('本地缓存', s.counts && `${s.counts.total || 0} 条 · 已有预览 ${s.counts.with_content || 0} · 失败 ${s.counts.with_error || 0}`),
    stat('上次同步结果', st && `${st.groups} 个分组 / ${st.items} 条，清理 ${st.removed} 条，新增预览 ${st.fetched}，失败 ${st.failed}`),
    stat('上游配置', s.upstream && `${s.upstream.enabled ? '已开启' : '未开启'} · 每组最多 ${s.upstream.maxItems} 张 · 保留 ${s.upstream.retentionDays} 天`),
    stat('同步状态', s.syncing ? '同步中…' : '空闲')
  )
}

function renderSettings() {
  const form = $('settings-form')
  for (const [k, v] of Object.entries(state.settings)) {
    if (form.elements[k]) form.elements[k].value = v
  }
}

function renderCreds() {
  const c = state.credentials
  $('cred-fields').replaceChildren(...CRED_FIELDS.map((f) => {
    const current = f.show(c)
    const input = f.area
      ? h('textarea', { class: 'input', name: `cred.${f.key}`, rows: 2, spellcheck: 'false', autocomplete: 'off', placeholder: current ? '留空则不修改' : '' })
      : h('input', { class: 'input', name: `cred.${f.key}`, type: f.type, autocomplete: 'off', placeholder: current ? '留空则不修改' : '' })
    return h('label', { class: `f${f.area ? ' wide' : ''}` },
      h('span', {}, f.label, f.hint && h('small', {}, ` ${f.hint}`)),
      input,
      h('span', { class: 'cred-state' },
        current ? h('span', { class: 'on' }, `● ${current}`) : h('span', {}, '○ 未设置'),
        current && h('button', {
          class: 'link-btn', type: 'button',
          onclick: (e) => busy(e.currentTarget, async () => {
            if (!confirm(`确定清除「${f.label}」吗？`)) return
            render(await api('/api/admin/settings', { method: 'PUT', body: { credentials: { [f.key]: null } } }))
            toast(`已清除${f.label}`)
          })
        }, '清除')
      )
    )
  }))
}

function renderGroups() {
  if (!state.groups.length) {
    $('groups-table').replaceChildren(h('p', { class: 'hint' }, '还没有分组，先配置上游并同步一次。'))
    return
  }
  $('groups-table').replaceChildren(h('table', { class: 'groups' },
    h('thead', {}, h('tr', {}, ['显示名称', '显示', '排序', '缓存', '最新'].map((t) => h('th', {}, t)))),
    h('tbody', {}, state.groups.map((g) => h('tr', { 'data-id': g.id },
      h('td', {},
        h('input', { class: 'input', name: 'displayName', value: g.displayName, placeholder: g.upstreamName, 'aria-label': `分组 ${g.id} 的显示名称`, maxlength: 120 }),
        h('div', { class: 'up' }, `#${g.id} · ${g.platform} · 上游原名：${g.upstreamName}`)
      ),
      h('td', {}, h('input', { type: 'checkbox', name: 'visible', checked: g.visible, 'aria-label': '在前台显示' })),
      h('td', {}, h('input', { class: 'input num', type: 'number', name: 'sortOrder', value: g.sortOrder, 'aria-label': '排序' })),
      h('td', {}, String(g.itemCount)),
      h('td', {}, g.latestAt ? relative(g.latestAt) : '—')
    )))
  ))
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const form = e.currentTarget
  busy(form.querySelector('button'), async () => {
    await api('/api/admin/login', { method: 'POST', body: { password: form.password.value } })
    form.reset()
    render(await api('/api/admin/state'))
  })
})

$('logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {})
  showLogin()
})

$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const form = e.currentTarget
  const settings = {}
  const credentials = {}
  for (const el of form.elements) {
    if (!el.name) continue
    if (el.name.startsWith('cred.')) credentials[el.name.slice(5)] = el.value
    else settings[el.name] = el.type === 'number' ? Number(el.value) : el.value
  }
  busy(form.querySelector('button[type=submit]'), async () => {
    render(await api('/api/admin/settings', { method: 'PUT', body: { settings, credentials } }))
    toast('已保存')
  })
})

$('save-groups').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const groups = [...document.querySelectorAll('#groups-table tr[data-id]')].map((tr) => ({
    id: Number(tr.dataset.id),
    displayName: tr.querySelector('[name=displayName]').value,
    visible: tr.querySelector('[name=visible]').checked,
    sortOrder: Number(tr.querySelector('[name=sortOrder]').value)
  }))
  render(await api('/api/admin/groups', { method: 'PUT', body: { groups } }))
  toast('分组已保存')
}))

$('probe').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  toast('正在逐个尝试可能的地址，大概要十几秒…')
  const res = await api('/api/admin/content/probe', { method: 'POST' })
  render(res.state)
  const log = $('probe-log')
  log.textContent = '尝试记录：\n' + res.tried.map((t) => `${t.template}\n    → ${t.result}`).join('\n')
  log.hidden = false
  if (res.template) toast(`找到了：${res.template}，已自动保存，后台开始抓取预览`)
  else toast('没找到，看下面的尝试记录，或者按 F12 在「网络」里找请求地址', true)
}))

const ACTIONS = {
  sync: ['/api/admin/sync', '同步完成'],
  renew: ['/api/admin/auth/renew', '登录 / 刷新成功'],
  retry: ['/api/admin/content/retry', '已加入重试，后台开始同步']
}
for (const btn of document.querySelectorAll('[data-action]')) {
  btn.addEventListener('click', () => busy(btn, async () => {
    const [path, msg] = ACTIONS[btn.dataset.action]
    const res = await api(path, { method: 'POST' })
    render(res.settings ? res : await api('/api/admin/state'))
    toast(msg)
  }))
}

api('/api/admin/state').then(render).catch(() => {})
