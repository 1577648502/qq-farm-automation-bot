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

/**
 * 固定清单: 覆盖"启动即加载"和我经常改动的模块
 * (不做成扫描全部文件 —— 全量 require 会把内存吃满被 OOM 杀掉)
 */
const MODULES = [
    'config/config',
    'config/gameConfig',
    'config/runtime-paths',
    'models/store',
    'models/user-store',
    'services/milk-tea',
    'services/happy-share',
    'services/autumn-wish',
    'services/friend',
    'services/warehouse',
    'services/mengchong',
    'services/game-config-sync',
    'services/json-db',
    'services/ad-gift',
    'services/interact',
    'services/treasure-rob',
    'services/mall',
    'controllers/admin',
    'runtime/data-provider',
    'runtime/runtime-state',
];

let ok = 0;
const failed = [];
let current = '';
process.on('uncaughtException', (e) => {
    failed.push({ rel: current, err: `(异步) ${e.message}` });
});
// 有些模块加载时会自己 process.exit —— 拦下来记为失败, 免得检查静默中断
const origExit = process.exit;
process.exit = function (code) {
    if (current) failed.push({ rel: current, err: `模块加载时调用了 process.exit(${code})` });
    return undefined;
};

for (const rel of MODULES) {
    const f = path.join(ROOT, rel + '.js');
    if (!fs.existsSync(f)) {
        failed.push({ rel, err: '文件不存在' });
        continue;
    }
    current = rel;
    try {
        require(f);
        ok += 1;
    } catch (e) {
        failed.push({ rel, err: e.message });
    }
}

process.exit = origExit;
console.log(`[冒烟] 核心模块 require 成功 ${ok} / 失败 ${failed.length}（共 ${MODULES.length} 个）`);
for (const x of failed) {
    console.log(`  ✗ ${x.rel}: ${x.err}`);
}
if (failed.length) {
    console.log('✗ 存在加载即失败的模块，请修复后再启动应用');
    process.exit(1);
}
console.log('✓ 全部模块可正常加载');
