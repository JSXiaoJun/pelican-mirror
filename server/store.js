export const DEFAULT_SETTINGS = {
  baseUrl: '',
  timezone: 'Asia/Shanghai',
  // Path template for the per-item preview; supports {id} and {group_id}. Empty = do not fetch previews
  contentUrlTemplate: '',
  syncIntervalMin: 10,
  // User-Agent sent to the upstream. When upstream session binding is on, a token copied from the browser only works if this matches the browser's UA
  userAgent: '',
  localRetentionDays: 3, // 0 = never expire
  maxItemsPerGroup: 200,
  displayLimit: 60,
  siteTitle: '鹈鹕骑单车',
  siteSubtitle: '定时让各分组的模型画一只骑自行车的鹈鹕，看看谁是真的不降智。'
}
// Old English defaults from an earlier version; stored values equal to these are swapped for the Chinese defaults on read
const LEGACY_DEFAULTS = {
  siteTitle: 'Pelican on a Bicycle',
  siteSubtitle: 'Periodically asks each group\'s model to draw a pelican riding a bicycle, to see which one is really not being dumbed down.'
}

const SECRET_KEYS = ['email', 'password', 'totpSecret', 'accessToken', 'refreshToken']

export function createStore(db, cipher) {
  const kvGet = db.prepare('SELECT value FROM kv WHERE key = ?')
  const kvSet = db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

  const getJson = (key, fallback) => {
    const row = kvGet.get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value)
    } catch {
      return fallback
    }
  }
  const setJson = (key, value) => kvSet.run(key, JSON.stringify(value))

  const store = {
    db,

    getSettings() {
      const s = { ...DEFAULT_SETTINGS, ...getJson('settings', {}) }
      for (const [k, v] of Object.entries(LEGACY_DEFAULTS)) if (s[k] === v) s[k] = DEFAULT_SETTINGS[k]
      return s
    },
    saveSettings(patch) {
      const next = { ...store.getSettings(), ...sanitizeSettings(patch) }
      setJson('settings', next)
      return next
    },

    getSecrets() {
      const row = kvGet.get('secrets')
      if (!row) return {}
      try {
        return JSON.parse(cipher.decrypt(row.value))
      } catch {
        console.error('[store] 解密账号信息失败（APP_SECRET 可能变了），按空处理')
        return {}
      }
    },
    // A patch value of null or an empty string removes that key
    saveSecrets(patch) {
      const next = { ...store.getSecrets() }
      for (const k of SECRET_KEYS) {
        if (!(k in patch)) continue
        const v = typeof patch[k] === 'string' ? patch[k].trim() : patch[k]
        if (v) next[k] = v
        else delete next[k]
      }
      kvSet.run('secrets', cipher.encrypt(JSON.stringify(next)))
      return next
    },

    getStatus: () => getJson('status', {}),
    patchStatus(patch) {
      const next = { ...store.getStatus(), ...patch }
      setJson('status', next)
      return next
    },

    listGroups: () =>
      db.prepare(`
        SELECT g.*, (SELECT COUNT(*) FROM items i WHERE i.group_id = g.id) AS item_count,
               (SELECT MAX(generated_ts) FROM items i WHERE i.group_id = g.id) AS latest_ts
        FROM groups g ORDER BY g.sort_order ASC, g.id ASC
      `).all(),

    updateGroup(id, { displayName, visible, sortOrder }) {
      db.prepare(`
        UPDATE groups SET display_name = ?, visible = ?, sort_order = ? WHERE id = ?
      `).run(
        displayName ? String(displayName).trim().slice(0, 120) : null,
        visible ? 1 : 0,
        Number.isFinite(Number(sortOrder)) ? Math.trunc(Number(sortOrder)) : 0,
        Number(id)
      )
    },

    listItems: (groupId, limit) =>
      db.prepare(`
        SELECT id, group_id, model_id, reasoning_effort, latency_ms, generated_at, generated_ts,
               content IS NOT NULL AS has_content
        FROM items WHERE group_id = ? ORDER BY generated_ts DESC LIMIT ?
      `).all(groupId, limit),

    latestItem: () => db.prepare('SELECT id, group_id FROM items ORDER BY generated_ts DESC LIMIT 1').get() ?? null,

    getItemContent: (id) => db.prepare('SELECT content FROM items WHERE id = ?').get(Number(id))?.content ?? null,

    itemsNeedingContent: (limit, maxAttempts = 3) =>
      db.prepare(`
        SELECT id, group_id FROM items
        WHERE content IS NULL AND content_attempts < ?
        ORDER BY generated_ts DESC LIMIT ?
      `).all(maxAttempts, limit),

    setItemContent: (id, content) =>
      db.prepare('UPDATE items SET content = ?, content_error = NULL WHERE id = ?').run(content, id),

    setItemContentError: (id, message) =>
      db.prepare('UPDATE items SET content_error = ?, content_attempts = content_attempts + 1 WHERE id = ?')
        .run(String(message).slice(0, 500), id),

    resetContentErrors: () =>
      db.prepare('UPDATE items SET content_attempts = 0, content_error = NULL WHERE content IS NULL').run().changes,

    counts: () => db.prepare(`
      SELECT COUNT(*) AS total, SUM(content IS NOT NULL) AS with_content, SUM(content_error IS NOT NULL) AS with_error
      FROM items
    `).get(),

    // Write the upstream snapshot in a single transaction. Keep local display name / visibility / order, and keep fetched content.
    // Items that disappear upstream are not deleted, so local history can be retained longer than upstream's retention_days.
    ingest(payload, now = Date.now()) {
      const upGroup = db.prepare(`
        INSERT INTO groups(id, upstream_name, platform, sort_order, seen_at) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET upstream_name = excluded.upstream_name,
          platform = excluded.platform, seen_at = excluded.seen_at
      `)
      const upItem = db.prepare(`
        INSERT INTO items(id, group_id, model_id, reasoning_effort, latency_ms, generated_at, generated_ts, synced_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET group_id = excluded.group_id, model_id = excluded.model_id,
          reasoning_effort = excluded.reasoning_effort, latency_ms = excluded.latency_ms,
          generated_at = excluded.generated_at, generated_ts = excluded.generated_ts, synced_at = excluded.synced_at
      `)
      let groups = 0
      let items = 0
      db.exec('BEGIN')
      try {
        payload.groups.forEach((g, index) => {
          const gid = Number(g.id)
          if (!Number.isInteger(gid)) return
          upGroup.run(gid, String(g.name ?? ''), String(g.platform ?? ''), index, now)
          groups++
          for (const it of Array.isArray(g.items) ? g.items : []) {
            const iid = Number(it.id)
            const ts = parseTs(it.generated_at)
            if (!Number.isInteger(iid) || ts === null) continue
            upItem.run(iid, gid, String(it.model_id ?? ''), String(it.reasoning_effort ?? ''),
              Math.max(0, Math.round(Number(it.latency_ms) || 0)), String(it.generated_at), ts, now)
            items++
          }
        })
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      return { groups, items }
    },

    prune({ localRetentionDays, maxItemsPerGroup }, now = Date.now()) {
      let removed = 0
      if (localRetentionDays > 0) {
        removed += db.prepare('DELETE FROM items WHERE generated_ts < ?').run(now - localRetentionDays * 86400_000).changes
      }
      removed += db.prepare(`
        DELETE FROM items WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY generated_ts DESC) AS rn FROM items
          ) WHERE rn > ?
        )
      `).run(maxItemsPerGroup).changes
      return removed
    }
  }

  return store
}

// Go's RFC3339Nano output can carry 6-9 fractional digits; normalize to milliseconds before parsing
export function parseTs(value) {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/(\.\d{3})\d+/, '$1')
  const ts = Date.parse(normalized)
  return Number.isFinite(ts) ? ts : null
}

function clampInt(v, min, max, fallback) {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function sanitizeSettings(patch = {}) {
  const out = {}
  const d = DEFAULT_SETTINGS
  if ('baseUrl' in patch) {
    const raw = String(patch.baseUrl || '').trim().replace(/\/+$/, '')
    if (raw) {
      let u
      try {
        u = new URL(raw)
      } catch {
        throw new Error('站点地址格式不对，例如 https://zl.yjapi.cc')
      }
      if (!/^https?:$/.test(u.protocol)) throw new Error('站点地址必须以 http:// 或 https:// 开头')
    }
    out.baseUrl = raw
  }
  if ('timezone' in patch) {
    const tz = String(patch.timezone || '').trim() || d.timezone
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz })
    } catch {
      throw new Error(`时区无效：${tz}，例如 Asia/Shanghai`)
    }
    out.timezone = tz
  }
  if ('contentUrlTemplate' in patch) {
    const t = String(patch.contentUrlTemplate || '').trim()
    if (t && !t.startsWith('/') && !/^https?:\/\//.test(t)) throw new Error('预览图路径必须以 / 或 http(s):// 开头')
    out.contentUrlTemplate = t
  }
  if ('userAgent' in patch) {
    const ua = String(patch.userAgent || '').trim()
    if (/[\r\n\x00-\x1f]/.test(ua)) throw new Error('User-Agent 不能包含换行等控制字符')
    out.userAgent = ua.slice(0, 512)
  }
  if ('syncIntervalMin' in patch) out.syncIntervalMin = clampInt(patch.syncIntervalMin, 1, 1440, d.syncIntervalMin)
  if ('localRetentionDays' in patch) out.localRetentionDays = clampInt(patch.localRetentionDays, 0, 365, d.localRetentionDays)
  if ('maxItemsPerGroup' in patch) out.maxItemsPerGroup = clampInt(patch.maxItemsPerGroup, 1, 5000, d.maxItemsPerGroup)
  if ('displayLimit' in patch) out.displayLimit = clampInt(patch.displayLimit, 1, 500, d.displayLimit)
  if ('siteTitle' in patch) out.siteTitle = String(patch.siteTitle || '').trim().slice(0, 80) || d.siteTitle
  if ('siteSubtitle' in patch) out.siteSubtitle = String(patch.siteSubtitle || '').trim().slice(0, 300)
  return out
}
