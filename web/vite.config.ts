import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import viteCompression from 'vite-plugin-compression'

const corePackageJson = JSON.parse(readFileSync('../core/package.json', 'utf-8'))

// 打包分析报告(gzip/brotli 体积 + stats.html)很吃 CPU/内存, 只在显式需要时开启:
//   ANALYZE=1 pnpm -C web build
const ANALYZE = process.env.ANALYZE === '1' || process.env.ANALYZE === 'true'
// 产物 gzip 预压缩(便于 nginx 直接发 .gz): 默认开启, NO_GZIP=1 可关闭
const NO_GZIP = process.env.NO_GZIP === '1' || process.env.NO_GZIP === 'true'

const plugins: any[] = [vue(), UnoCSS()]
if (!NO_GZIP) {
  plugins.push(viteCompression({
    verbose: false,
    disable: false,
    threshold: 10240,
    algorithm: 'gzip',
    ext: '.gz',
  }))
}
if (ANALYZE) {
  plugins.push(visualizer({
    open: false,
    gzipSize: true,
    brotliSize: true,
  }))
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins,
  build: {
    // 关掉产物体积报告: 默认会对每个产物再算一次 gzip 体积, 小内存机器上会明显拖慢/卡住构建
    reportCompressedSize: false,
    sourcemap: false,
    // esbuild 压缩最快最省内存 (不要用 terser)
    minify: 'esbuild',
    rollupOptions: {
      // 限制并发文件操作, 降低小内存机器的内存/IO 峰值
      maxParallelFileOps: 4,
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('vue') || id.includes('pinia') || id.includes('vue-router') || id.includes('@vueuse')) {
              return 'vendor-vue'
            }
            if (id.includes('axios')) {
              return 'vendor-axios'
            }
            // Split other large dependencies if needed
            if (id.includes('echarts') || id.includes('zrender')) {
              return 'vendor-echarts'
            }
            // Default vendor chunk
            return 'vendor'
          }
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  define: {
    __APP_VERSION__: JSON.stringify(corePackageJson.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3007',
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3007',
        changeOrigin: true,
      },
      '/game-config': {
        target: 'http://localhost:3007',
        changeOrigin: true,
      },
    },
  },
})
