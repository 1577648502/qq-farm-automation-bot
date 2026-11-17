#!/usr/bin/env node
/**
 * 解包 QQ 小程序 .tqapkg(mcboot 分包) —— 内含牧场官方文档与代码。
 *
 * 格式(逆向自 1112386029_*_mcboot.tqapkg):
 *   [头 0x12 字节] [文件表] [内容区]
 *   表项: u32 pathLen(含 \0) | path | \0 | u32 offset | u32 size
 *
 * 用法: node scripts/unpack-tqapkg.js <file.tqapkg> <outDir>
 */
const fs = require('node:fs');
const path = require('node:path');

const [, , src, outDir = 'unpacked'] = process.argv;
if (!src) { console.error('用法: node unpack-tqapkg.js <file.tqapkg> [outDir]'); process.exit(1); }

const buf = fs.readFileSync(src);
const entries = [];
let i = 0x12;   // 表起始(实测)
while (i < buf.length - 16) {
    const pathLen = buf.readUInt32BE(i);
    if (pathLen < 3 || pathLen > 400) break;
    const raw = buf.subarray(i + 4, i + 4 + pathLen);
    if (raw[0] !== 0x2f /* '/' */) break;
    const name = raw.toString('utf8').replace(/\0+$/, '');
    const j = i + 4 + pathLen;
    const offset = buf.readUInt32BE(j);
    const size = buf.readUInt32BE(j + 4);
    if (size === 0 || offset + size > buf.length) break;
    entries.push({ name, offset, size });
    i = j + 8;
}

console.log(`解析到 ${entries.length} 个文件`);
for (const e of entries) {
    const dest = path.join(outDir, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf.subarray(e.offset, e.offset + e.size));
    console.log(`  ${e.name}  ${e.size} bytes`);
}
