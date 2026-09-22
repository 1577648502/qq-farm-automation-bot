/**
 * 跑 core/test 下所有回归测试(每个测试独立子进程, 互不污染)
 *
 * 用法: node test/run-all.js        (或 pnpm test)
 *       node test/run-all.js rob    (只跑文件名含 rob 的)
 *
 * 背景: 这些测试原本写在 /tmp, 但 macOS 会定期清理 /tmp, 测试文件连同沙箱一起消失
 *       (已经丢过两批)。现在放进仓库, 沙箱由 test/harness.js 自动重建。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const process = require('node:process');

const dir = __dirname;
const filter = (process.argv[2] || '').trim();
const files = fs.readdirSync(dir)
    .filter(f => /^test-.*\.js$/.test(f))
    .filter(f => !filter || f.includes(filter))
    .sort();

if (!files.length) {
    console.log('没有匹配的测试文件' + (filter ? ` (过滤: ${filter})` : ''));
    process.exit(0);
}

let failed = 0;
const summary = [];
for (const file of files) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/通过 (\d+) \/ (\d+)/);
    const ok = r.status === 0;
    if (!ok) failed += 1;
    const stat = m ? `${m[1]}/${m[2]}` : (ok ? 'ok' : 'FAILED');
    summary.push({ file, ok, stat, ms: Date.now() - started });
    console.log(`${ok ? '✓' : '✗'} ${file.padEnd(26)} ${stat.padStart(9)}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (!ok) console.log(out.split('\n').slice(-12).join('\n'));
}

console.log('');
if (failed) {
    console.log(`✗ ${failed}/${files.length} 个测试文件失败`);
    process.exit(1);
}
console.log(`✓ ${files.length} 个测试文件全部通过`);
