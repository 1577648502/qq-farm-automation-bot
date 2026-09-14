/**
 * 部署/启动前检查前端产物是否已存在。
 * - 已有 web/dist/index.html 且未设置 FORCE_BUILD_WEB=1 → 跳过构建
 *   (重启秒起, 避免每次重启都跑 vite build 把服务器 CPU/内存打满)
 * - 缺失或强制 → 执行快速构建(跳过 vue-tsc 类型检查, 省约 500MB 内存)
 *
 * 用法:
 *   node scripts/ensure-web-build.mjs                       # 缺了才构建
 *   FORCE_BUILD_WEB=1 node scripts/ensure-web-build.mjs     # 强制重建
 *   NO_GZIP=1 ...                                           # 不生成 .gz 产物
 *   WEB_BUILD_HEAP_MB=1024 ...                              # 调整构建堆上限(默认 1536)
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const webDir = join(root, 'web')
const distIndex = join(webDir, 'dist', 'index.html')
const force = process.env.FORCE_BUILD_WEB === '1' || process.env.FORCE_BUILD_WEB === 'true'

if (existsSync(distIndex) && !force) {
  console.log('[web] 已存在 web/dist/index.html, 跳过前端构建 (需要重建: FORCE_BUILD_WEB=1)')
  process.exit(0)
}

console.log('[web] 开始构建前端 (快速模式, 跳过类型检查)...')

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
if (r.error) console.error('[web] 构建启动失败:', r.error.message)
process.exit(r.status ?? 1)
