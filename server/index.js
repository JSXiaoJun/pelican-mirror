// Startup entry point: check the Node version and load .env first, then dynamically import the main program.
// Uses a dynamic import because node:sqlite is resolved when modules load; on an old Node a static import
// would crash before any code runs, with no readable error.
import fs from 'node:fs'
import path from 'node:path'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`[启动] 当前 Node 版本是 ${process.versions.node}，本项目需要 22.13 或更高（用到了内置 SQLite）。`)
  console.error('[启动] 请到 https://nodejs.org 下载 LTS 版本安装后再试。')
  process.exit(1)
}

// Minimal .env parser: KEY=VALUE, # comments, optional quotes; does not override existing environment variables
const envFile = path.resolve('.env')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || m[1] in process.env) continue
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

process.removeAllListeners('warning') // Suppress the ExperimentalWarning from node:sqlite
await import('./main.js')
