/**
 * 设置字段一致性检查: 「能保存的字段」是否都能「读回来」
 *
 * 为什么需要:
 *   设置链路有三处独立白名单, 新增字段时最容易漏掉某一处, 表现为
 *   "改了没保存" / "保存了但页面回显成默认值":
 *     ① 前端 settings 默认对象(web/src/stores/setting.ts)      —— 页面认哪些字段
 *     ② 保存侧 data-provider.js saveSettings 的 snapshot 对象   —— 哪些字段能存进 store
 *     ③ 读取侧 admin.js GET /api/settings 的 res.json data 对象 —— 哪些字段能读回来
 *   本仓库已因此踩过两次(robMaxPerRun/robDailyLimit/buyBookEnabled/buyBookCount 全漏过)。
 *
 * 用法: node scripts/check-settings-fields.js
 * 退出码 1 = 保存侧有字段读不回来(必须修)
 */
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, '..', 'web');

/**
 * 从某段源码里按"固定缩进 + key:"提取对象字面量的键
 * @param regionMarker 先定位到这个标记之后, 再找 startMarker(避免命中文件里更早的同名代码)
 */
function extractKeys(file, startMarker, indent, regionMarker = '') {
    if (!fs.existsSync(file)) return new Set();
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const from = regionMarker ? lines.findIndex(l => l.includes(regionMarker)) : 0;
    if (from < 0) return new Set();
    const start = lines.findIndex((l, i) => i > from && l.includes(startMarker));
    if (start < 0) return new Set();
    const keys = new Set();
    const pad = ' '.repeat(indent);
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*$/.test(line) || /^\s*\/\//.test(line)) continue;
        const cur = line.match(/^ */)[0].length;
        // 还没进入目标对象时(如 res.json({ 下的 ok/data 行)先跳过; 取到键之后再遇到更浅的缩进才算结束
        if (cur < indent) {
            if (keys.size) break;
            continue;
        }
        if (cur !== indent) continue;                  // 嵌套内容
        // 兼容 `key: value` 与简写 `key,`(读取侧很多字段是简写)
        const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/) || line.match(/^\s*([A-Za-z_$][\w$]*)\s*,\s*$/);
        if (m) keys.add(m[1]);
    }
    return keys;
}

const saveKeys = extractKeys(path.join(ROOT, 'src/runtime/data-provider.js'), 'const snapshot = {', 16);
const readKeys = extractKeys(path.join(ROOT, 'src/controllers/admin.js'), 'res.json({', 20, "app.get('/api/settings'");
readKeys.add('intervals');   // 读取侧有若干字段来自局部变量拼接, 这里放宽
const frontKeys = extractKeys(path.join(WEB, 'src/stores/setting.ts'), 'robTreasureIntervalMinutes: 10,', 2);

// 只关心这些前缀(避免把 intervals/ui 等历史噪音算进来)
const WATCH = /^(rob|buyBook|stealth|fertilizer|plant|bagSeed|steal)/;

// 前端有意做的字段别名(读取侧用短名, 前端再映射成长名)
const ALIASES = {
    plantingStrategy: ['strategy'],
    preferredSeedId: ['preferredSeed'],
};
const isReadable = (key) => readKeys.has(key)
    || (ALIASES[key] || []).some(alias => readKeys.has(alias));

const canSaveNotRead = [...saveKeys].filter(k => WATCH.test(k) && !isReadable(k)).sort();
const expectNotRead = [...frontKeys].filter(k => WATCH.test(k) && !readKeys.has(k) && !saveKeys.has(k)).sort();

let bad = 0;
if (canSaveNotRead.length) {
    bad += canSaveNotRead.length;
    console.error('✗ 保存侧有、读取侧没有(会导致"保存了但回显默认值"):');
    canSaveNotRead.forEach(k => console.error(`  - ${k}  → 需要加到 admin.js GET /api/settings 的 res.json data 里`));
}
if (expectNotRead.length) {
    console.error(`⚠ 前端有默认值、接口既不返回也不能保存(仅提示): ${expectNotRead.join(', ')}`);
}

console.log(`保存侧字段 ${saveKeys.size} 个 / 读取侧 ${readKeys.size} 个 / 前端默认 ${frontKeys.size} 个`);
if (bad) process.exit(1);
console.log('✓ 设置字段读写一致');
