const CONTENT_BATCH = 150
const CONTENT_CONCURRENCY = 3

export function createSyncer(store, upstream, { log = console } = {}) {
  let running = null
  let timer = null

  async function doSync() {
    const started = Date.now()
    try {
      const data = await upstream.fetchShowcase()
      if (!data || !Array.isArray(data.groups)) throw new Error('上游返回格式不对：缺少 groups 字段')

      const stats = store.ingest(data, started)
      const settings = store.getSettings()
      const removed = store.prune(settings, started)
      const content = await fillContent()

      const status = store.patchStatus({
        lastSyncAt: started,
        lastSuccessAt: Date.now(),
        lastError: null,
        lastDurationMs: Date.now() - started,
        lastStats: { ...stats, removed, ...content },
        upstream: { enabled: data.enabled, maxItems: data.max_items, retentionDays: data.retention_days }
      })
      log.info?.(`[同步] 成功：${stats.groups} 个分组 / ${stats.items} 条，清理 ${removed} 条，新增预览 ${content.fetched}`)
      return status
    } catch (err) {
      store.patchStatus({ lastSyncAt: started, lastError: err.message, lastErrorAt: Date.now() })
      log.error?.(`[同步] 失败：${err.message}`)
      throw err
    }
  }

  async function fillContent() {
    if (!store.getSettings().contentUrlTemplate) return { fetched: 0, failed: 0 }
    const queue = store.itemsNeedingContent(CONTENT_BATCH)
    let fetched = 0
    let failed = 0
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const html = await upstream.fetchContent(item)
          if (html) {
            store.setItemContent(item.id, html)
            fetched++
          }
        } catch (err) {
          store.setItemContentError(item.id, err.message)
          failed++
        }
      }
    }
    await Promise.all(Array.from({ length: CONTENT_CONCURRENCY }, worker))
    return { fetched, failed }
  }

  function schedule() {
    clearTimeout(timer)
    const minutes = store.getSettings().syncIntervalMin
    timer = setTimeout(async () => {
      await syncNow().catch(() => {})
      schedule()
    }, minutes * 60_000)
    timer.unref?.()
  }

  // Concurrent calls share the same run
  function syncNow() {
    if (!running) running = doSync().finally(() => (running = null))
    return running
  }

  return {
    syncNow,
    isRunning: () => Boolean(running),
    start() {
      if (store.getSettings().baseUrl) syncNow().catch(() => {})
      schedule()
    },
    reschedule: schedule,
    stop: () => clearTimeout(timer)
  }
}
