/**
 * 部署/启动前检查前端产物是否需要重建。
 *
 * 判断依据(而不是只看 dist 存不存在):
 *   1. dist 缺失 → 构建
 *   2. web 源码(web/**，忽略 node_modules/dist)或 core/package.json 的**最新修改时间** 晚于 **上次构建时间** → 构建
 *      (git pull 更新代码后会自动重新构建; 没更新时重启秒起)
 *   3. FORCE_BUILD_WEB=1 → 强制构建; SKIP_WEB_BUILD=1 → 强制跳过
 *
 * 构建用快速模式(跳过 vue-tsc 类型检查, 省约 500MB 内存), 并给 Node 堆设上限,
 * 避免小内存服务器在构建阶段被拖到假死。
 *
 * 用法:
 *   node scripts/ensure-web-build.mjs                       # 源码有更新才构建
 *   FORCE_BUILD_WEB=1 node scripts/ensure-web-build.mjs     # 强制重建
 *   SKIP_WEB_BUILD=1 node scripts/ensure-web-build.mjs      # 强制跳过
 *   NO_GZIP=1 ...                                           # 不生成 .gz 产物
 *   WEB_BUILD_HEAP_MB=1024 ...                              # 调整构建堆上限(默认 1536)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const webDir = join(root, 'web')
const distDir = join(webDir, 'dist')
const distIndex = join(distDir, 'index.html')
const stampPath = join(distDir, '.build-stamp.json')

const force = process.env.FORCE_BUILD_WEB === '1' || process.env.FORCE_BUILD_WEB === 'true'
const skip = process.env.SKIP_WEB_BUILD === '1' || process.env.SKIP_WEB_BUILD === 'true'
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.vite'])

/** 目录树里最新的文件修改时间 */
function newestMtime(dir, seen = { t: 0 }) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return seen.t
  }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name))
      continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      newestMtime(full, seen)
      continue
    }
    if (!e.isFile())
      continue
    try {
      const m = statSync(full).mtimeMs
      if (m > seen.t) seen.t = m
    } catch { /* 忽略读取失败 */ }
  }
  return seen.t
}

/** 上次构建完成时间 */
function lastBuiltAt() {
  if (existsSync(stampPath)) {
    try {
      const j = JSON.parse(readFileSync(stampPath, 'utf-8'))
      if (j && j.builtAt) return Number(j.builtAt)
    } catch { /* 回退到 index.html 时间 */ }
  }
  if (existsSync(distIndex)) {
    try { return statSync(distIndex).mtimeMs } catch { /* ignore */ }
  }
  return 0
}

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-'
}

const builtAt = lastBuiltAt()
const newest = Math.max(
  newestMtime(webDir),
  // vite define 里读了 core/package.json(版本号), 它变了也要重建
  (() => { try { return statSync(join(root, 'core', 'package.json')).mtimeMs } catch { return 0 } })(),
)

if (skip) {
  console.log('[web] SKIP_WEB_BUILD=1, 跳过前端构建')
  process.exit(0)
}

let needBuild = force
let why = force ? 'FORCE_BUILD_WEB=1' : ''
if (!needBuild && !existsSync(distIndex)) {
  needBuild = true
  why = 'dist 不存在'
}
if (!needBuild && newest > builtAt + 1000) {
  needBuild = true
  why = `源码有更新 (源码 ${fmt(newest)} > 上次构建 ${fmt(builtAt)})`
}

if (!needBuild) {
  console.log(`[web] 前端产物是最新的, 跳过构建 (上次构建 ${fmt(builtAt)}; 需要重建: FORCE_BUILD_WEB=1)`)
  process.exit(0)
}

console.log(`[web] 开始构建前端 (${why}) — 快速模式, 跳过类型检查...`)

// 优先直接调用本地 vite, 不依赖全局 pnpm 是否在 PATH
const viteBin = join(webDir, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const useVite = existsSync(viteBin)
const cmd = useVite ? viteBin : 'pnpm'
const args = useVite ? ['build'] : ['-C', 'web', 'build:fast']
const cwd = useVite ? webDir : root

const r = spawnSync(cmd, args, {
  stdio: 'inherit',
  cwd,
  shell: !useVite,
  env: {
    ...process.env,
    // 限制 Node 堆: 小内存服务器超出时会明确报错, 而不是整机假死
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=${process.env.WEB_BUILD_HEAP_MB || 1536}`.trim(),
  },
})
if (r.error) {
  console.error('[web] 构建启动失败:', r.error.message)
  process.exit(r.status ?? 1)
}
if ((r.status ?? 1) !== 0) {
  console.error('[web] 构建失败, 退出码', r.status)
  process.exit(r.status ?? 1)
}

// 记录构建时间, 下次据此判断是否需要重建
try {
  writeFileSync(stampPath, `${JSON.stringify({ builtAt: Date.now() }, null, 2)}\n`)
} catch { /* 写入失败不影响本次启动 */ }
console.log('[web] 前端构建完成')
