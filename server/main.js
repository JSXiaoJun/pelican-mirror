import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createCipher } from './crypto.js'
import { createStore } from './store.js'
import { createUpstream } from './upstream.js'
import { createSyncer } from './sync.js'
import { createApp } from './app.js'

const config = loadConfig()
const store = createStore(openDb(config.dbPath), createCipher(config.appSecret))
const upstream = createUpstream(store)
const syncer = createSyncer(store, upstream)
const server = createApp({ config, store, upstream, syncer })

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[启动] 端口 ${config.port} 已被占用，请改 .env 里的 PORT，或关掉之前开的窗口`)
  else console.error('[启动] 启动失败：', err.message)
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  console.log(`[启动] 展示页    http://localhost:${config.port}/`)
  console.log(`[启动] 后台管理  http://localhost:${config.port}/admin`)
  console.log('[启动] 这个窗口不要关，关了网站就停了')
  syncer.start()
})

const shutdown = () => {
  syncer.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
