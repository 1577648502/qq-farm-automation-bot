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

// ④ 保存规格表: data-provider 把字段塞进 snapshot 之后, applyConfigSnapshot 才是
//   真正写进 store 的地方, 而它**只认 ACCOUNT_CONFIG_NORMALIZERS 规格表**里的字段。
//   没登记 = 悄悄丢弃(2026-11-19 线上: ranchCubStrategy 选了 max_level 保存不成功)。
const storeSrc = fs.readFileSync(path.join(ROOT, 'src/models/store.js'), 'utf8');
const tableMatch = storeSrc.match(/const ACCOUNT_CONFIG_NORMALIZERS = \{([\s\S]*?)\n\};/);
const normalizerKeys = new Set();
if (tableMatch) {
    for (const line of tableMatch[1].split('\n')) {
        const m = line.match(/^\s{4}([A-Za-z_$][\w$]*)\s*:/);
        if (m) normalizerKeys.add(m[1]);
    }
}
// 这些字段由 applyConfigSnapshot 的"显式写法"分支单独处理, 不在规格表里也正常
const EXPLICIT_HANDLED = new Set([
    'plantingStrategy', 'bagSeedPriority', 'bagSeedFallbackStrategy',
    'plantBlacklist', 'plantSeedExclude', 'knownFriendGids',
    'milkTeaStoreName', 'milkTeaEmployerGid', 'milkTeaHireGids',
    'intervals', 'friendQuietHours', 'ui', 'automation',
    // 已下线功能: applyConfigSnapshot 里显式强制关闭, 不接受保存值
    'milkTeaAutoTask',
]);

const droppedOnSave = [...saveKeys]
    .filter(k => !EXPLICIT_HANDLED.has(k) && !normalizerKeys.has(k))
    .sort();

const canSaveNotRead = [...saveKeys].filter(k => WATCH.test(k) && !isReadable(k)).sort();
const expectNotRead = [...frontKeys].filter(k => WATCH.test(k) && !readKeys.has(k) && !saveKeys.has(k)).sort();

// ⑤ 前端保存 payload: settings.ts 的 performSaveSettings 里那个大对象。
//   前端"页面上有输入框、类型里也有字段"但**没放进 payload** → 后端永远收不到,
//   表现同样是"改了保存不成功"(2026-11-19 牧场幼崽策略就是这样)。
const settingTs = fs.readFileSync(path.join(WEB, 'src/stores/setting.ts'), 'utf8');
const payloadMatch = settingTs.match(/const settingsPayload = \{([\s\S]*?)\n      \}/);
const frontPayloadKeys = new Set();
if (payloadMatch) {
    for (const line of payloadMatch[1].split('\n')) {
        const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
        if (m) frontPayloadKeys.add(m[1]);
    }
}
// 后端能保存的字段(排除只读/仅服务端设置项)都应该能从界面发出去
// 这些字段界面上没有输入控件(历史遗留 / 由别的接口单独设置), 不算漏发
const NO_UI_FIELDS = new Set([
    'milkTeaAutoHire', 'milkTeaAutoTask', 'milkTeaEmployerGid', 'milkTeaHireGids',
]);
const frontMissing = [...saveKeys]
    .filter(k => k !== 'accountId' && !NO_UI_FIELDS.has(k) && !frontPayloadKeys.has(k))
    .sort();

let bad = 0;
if (frontMissing.length) {
    bad += frontMissing.length;
    console.error('✗ 后端可保存、但前端保存 payload 没带(改了不会生效):');
    frontMissing.forEach(k => console.error(`  - ${k}  → 加到 web/src/stores/setting.ts 的 settingsPayload`));
}
if (droppedOnSave.length) {
    bad += droppedOnSave.length;
    console.error('✗ 保存侧有、applyConfigSnapshot 规格表没有(会被静默丢弃, 表现为"保存不成功"):');
    droppedOnSave.forEach(k => console.error(`  - ${k}  → 加到 store.js 的 ACCOUNT_CONFIG_NORMALIZERS, 或写显式分支`));
}
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
