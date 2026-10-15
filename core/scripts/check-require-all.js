/**
 * 冒烟检查：把 core/src 下所有模块都 require 一遍，确认没有"运行时才炸"的低级错误
 *
 * 背景（2026-10-15 线上事故）：
 *   我在 models/store.js 里用了 toNum(...)，但那文件没引入该函数 →
 *   应用启动时"载配置失败: toNum is not defined"，用户以为配置丢了。
 *   `node --check`(语法) 和单元测试都发现不了这种"只在加载时才炸"的问题 —— 于是加这道检查。
 *
 * 用法: node scripts/check-require-all.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src');
const SKIP_DIRS = new Set(['node_modules', '.git']);
// 这些模块 require 时会去连网络/起进程，跳过（只做静态加载检查没有意义）
const SKIP_FILES = new Set([
    'core/worker.js',              // worker 入口，需要 master 环境
    'runtime/worker-manager.js',   // 起子进程
    'services/mitm-proxy.js',      // 起代理服务
    'services/desktop-farm-capture.js',
]);

function walk(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) {
            if (SKIP_DIRS.has(name)) continue;
            walk(p, out);
        } else if (name.endsWith('.js')) {
            out.push(p);
        }
    }
    return out;
}

const files = walk(ROOT);
let ok = 0;
const failed = [];
for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    try {
        require(f);
        ok += 1;
    } catch (e) {
        failed.push({ rel, err: e.message });
    }
}

console.log(`[冒烟] require 成功 ${ok} / 失败 ${failed.length}（共扫描 ${files.length} 个文件）`);
for (const x of failed) {
    console.log(`  ✗ ${x.rel}: ${x.err}`);
}
if (failed.length) {
    console.log('✗ 存在加载即失败的模块，请修复后再启动应用');
    process.exit(1);
}
console.log('✓ 全部模块可正常加载');
