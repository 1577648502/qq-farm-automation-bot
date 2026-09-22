/**
 * 静态检查: 各文件 `const { a, b } = require('./x')` 里的名字在目标模块是否真的导出
 *
 * 为什么需要: 这类"导入了不存在的名字"不会在启动时报错, 只会在真正调用时抛
 *   "xxx is not a function" (本仓库已踩两次: readJson→readJsonFile、getItemImageById 漏导入)。
 *
 * 用法: node scripts/check-imports.js            # 扫 core/src 全部
 *       node scripts/check-imports.js --dir src/services
 * 退出码 1 = 有缺失
 */
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const ROOT = path.join(__dirname, '..');
const argIdx = process.argv.indexOf('--dir');
const scanDir = path.join(ROOT, argIdx > 0 ? process.argv[argIdx + 1] : 'src');
const NEED_PROTO = ['services/mengchong.js', 'services/treasure-rob.js', 'services/mall.js'];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

(async () => {
    // 部分模块 require 时依赖 proto/types, 先加载
    try {
        await require(path.join(ROOT, 'src/utils/proto')).loadProto();
    } catch (e) { /* 没 proto 也能查大部分 */ }

    let checked = 0;
    const problems = [];
    for (const file of walk(scanDir)) {
        const src = fs.readFileSync(file, 'utf8');
        const re = /const\s*\{([^}]+)\}\s*=\s*require\((['"`])([^'"`]+)\2\)/g;
        let m;
        while ((m = re.exec(src))) {
            const names = m[1].split(',')
                .map(s => s.split(':')[0].trim())
                .filter(n => n && /^[A-Za-z_$][\w$]*$/.test(n));
            const spec = m[3];
            if (!spec.startsWith('.')) continue;
            let mod = null;
            try {
                mod = require(path.resolve(path.dirname(file), spec));
            } catch (e) {
                problems.push(`${path.relative(ROOT, file)}: 无法加载 ${spec} (${e.message})`);
                continue;
            }
            const keys = new Set(Object.keys(mod || {}));
            for (const n of names) {
                checked += 1;
                if (!keys.has(n)) {
                    problems.push(`${path.relative(ROOT, file)}: 导入的 ${n} 在 ${spec} 里没有导出`);
                }
            }
        }
    }
    if (problems.length) {
        console.error(`✗ 检查 ${checked} 个导入名, 发现 ${problems.length} 个问题:`);
        problems.forEach(p => console.error('  - ' + p));
        process.exit(1);
    }
    console.log(`✓ 检查 ${checked} 个导入名, 全部存在`);
})();
