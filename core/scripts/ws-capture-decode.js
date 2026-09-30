/**
 * WS 抓包解码器 - 配合 wx-code-grabber 的 mitmproxy 抓包使用
 *
 * mitm_addon.py 在 WX_CAPTURE_WS=1 时会把每一帧 WS 游戏消息(原始 hex)追加到抓包
 * jsonl 文件 (capture-activity.sh 会自动开启并指定会话文件)。本脚本读取这些帧,
 * 用项目的 tsdk.wasm 解密 body, 解析出 service_name.method_name + 字段结构, 方便逆向新接口。
 *
 * 抓包文件里除了 hex 帧, 还会有事件行 (session_start / ws_open / ws_close / mark,
 * 由 mark.sh 打标记产生), 本脚本会还原成时间线分隔线。
 *
 * 用法:
 *   # 实时跟随(边操作小程序边解码), 默认读 /tmp/wx_ws_capture.jsonl
 *   node scripts/ws-capture-decode.js --follow
 *
 *   # 一次性解码已抓好的文件
 *   node scripts/ws-capture-decode.js --in /tmp/wx_ws_capture.jsonl
 *
 *   # 只看某个 service, 或指定输出
 *   node scripts/ws-capture-decode.js --follow --filter EmailService
 *   node scripts/ws-capture-decode.js --in /tmp/wx_ws_capture.jsonl --out data/ws-decoded.jsonl
 *
 *   # 列出出现过的 service.method (逆向时先摸清接口清单);
 *   # 并自动比对 core/src 里已实现的接口, 标出 ★ 未实现的新接口(新活动接口优先看这些)
 *   node scripts/ws-capture-decode.js --in /tmp/wx_ws_capture.jsonl --summary
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const readline = require('node:readline');

const { loadProto } = require('../src/utils/proto');
const { decodeFrame } = require('./ws-frame-lib');

const CORE_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(CORE_ROOT, 'src');
const PROTO_DIR = path.join(CORE_ROOT, 'src', 'proto');

function parseArgs(argv) {
    const args = { flags: {} };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--follow' || a === '--summary') args.flags[a.slice(2)] = true;
        else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    }
    return args;
}

function fmtTime(ts) {
    const d = new Date(ts * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 处理事件行 (session_start/ws_open/ws_close/mark/auto_mark), 返回是否为事件行 */
function handleEvent(rec, ctx) {
    if (!rec.ev) return false;
    switch (rec.ev) {
        case 'mark':
            ctx.marks.push({ ts: rec.ts, label: `■ ${rec.label || '(未命名)'} (手动)` });
            if (!ctx.summaryMode) {
                console.log(`\n━━━━━━ ${fmtTime(rec.ts)} [标记] ${rec.label || '(未命名)'} ━━━━━━`);
            }
            break;
        case 'auto_mark':
            ctx.marks.push({ ts: rec.ts, label: `⚡ ${rec.label || rec.key || ''} (自动)` });
            if (!ctx.summaryMode) {
                console.log(`\n────── ${fmtTime(rec.ts)} ⚡ 自动标记: ${rec.label || rec.key || ''} ──────`);
            }
            break;
        case 'ws_open':
            ctx.wsOpens += 1;
            if (!ctx.summaryMode) {
                console.log(`\n────── ${fmtTime(rec.ts)} 连接建立 (${rec.host || ''}) ──────`);
            }
            break;
        case 'ws_close':
            if (!ctx.summaryMode) {
                const f = rec.frames || {};
                console.log(`\n────── ${fmtTime(rec.ts)} 连接断开 (上行 ${f['C->S'] || 0} / 下行 ${f['S->C'] || 0} 帧) ──────`);
            }
            break;
        case 'session_start':
            if (!ctx.summaryMode) {
                console.log(`\n══════ 抓包会话${rec.label ? ` [${rec.label}]` : ''} ${fmtTime(rec.ts)} ══════`);
            }
            break;
        default:
            break;
    }
    return true;
}

/**
 * 从 core/src 源码里收集已实现的接口。
 * 支持两种调用形式:
 *   sendMsgAsync('gamepb.xxx.XxxService', 'Yyy')            字面量
 *   const SVC = 'gamepb.xxx.XxxService'; sendMsgAsync(SVC, 'Yyy')  同文件常量
 * @returns {Set<string>} 'service.method' 集合
 */
function harvestKnownInterfaces() {
    const known = new Set();
    const constRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]\s*;?/g;
    const callRe = /sendMsg(?:Async)?\s*\(\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*,\s*['"]([^'"]+)['"]/g;
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(full);
            } else if (e.isFile() && e.name.endsWith('.js')) {
                let src;
                try {
                    src = fs.readFileSync(full, 'utf8');
                } catch {
                    continue;
                }
                // 先收集本文件的字符串常量, 再匹配调用点 (常量名 -> 值)
                const consts = {};
                let cm;
                while ((cm = constRe.exec(src))) {
                    consts[cm[1]] = cm[2];
                }
                let m;
                while ((m = callRe.exec(src))) {
                    const svc = m[1] || m[2] || consts[m[3]] || '';
                    if (svc) known.add(`${svc}.${m[4]}`);
                }
            }
        }
    };
    walk(SRC_DIR);
    return known;
}

/**
 * 从 proto 定义里收集所有 xxxNotify 消息短名 + 各 service 方法, 作为"已知"兜底
 * @returns {Set<string>} notify 短名集合
 */
function harvestKnownNotifies() {
    const known = new Set(['Kickout']);
    try {
        for (const f of fs.readdirSync(PROTO_DIR)) {
            if (!f.endsWith('.proto')) continue;
            const src = fs.readFileSync(path.join(PROTO_DIR, f), 'utf8');
            for (const m of src.matchAll(/message\s+(\w*Notify)\b/g)) {
                known.add(m[1]);
            }
        }
    } catch { /* proto 目录不存在时忽略 */ }
    return known;
}

function shortNotifyName(notifyType) {
    const s = String(notifyType || '');
    return s.includes('.') ? s.split('.').pop() : s;
}

function printSummary(seen, marks, known, knownNotifies) {
    const rows = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
    const knownList = known ? [...known].sort() : null;

    if (marks.length) {
        console.log('\n===== 时间线标记 =====');
        for (const m of marks) {
            console.log(`  ${fmtTime(m.ts)}  ${m.label}`);
        }
    }

    console.log('\n===== 接口清单 (service.method) =====');
    const unknownRows = [];
    for (const [key, v] of rows) {
        const isKnown = knownList
            ? knownList.includes(key) || (key.startsWith('[Notify] ') && knownNotifies.has(shortNotifyName(key.slice(9))))
            : null;
        const flag = isKnown === false ? ' ★ 新' : '';
        console.log(`  ${key}  [${[...v.types].join('/')}]  x${v.count}${flag}`);
        if (isKnown === false) unknownRows.push([key, v]);
    }
    console.log(`共 ${rows.length} 个接口。`);

    if (knownList) {
        if (unknownRows.length) {
            console.log('\n===== ★ 项目未实现的新接口 (优先逆向这些) =====');
            for (const [key, v] of unknownRows) {
                console.log(`  ${key}  x${v.count}`);
                const filterWord = key.startsWith('[Notify] ')
                    ? shortNotifyName(key.slice(9))
                    : key.split('.').pop();
                console.log(`    看详细字段: node scripts/ws-capture-decode.js --in <抓包文件> --filter '${filterWord}'`);
            }
            console.log(`共 ${unknownRows.length} 个新接口 (项目已实现 ${knownList.length} 个)。`);
        } else {
            console.log(`\n本次抓包没有发现项目未实现的接口 (已比对源码中 ${knownList.length} 个已实现接口)。`);
        }
    }
}

async function decodeLine(raw, filter, outStream, ctx) {
    let rec;
    try {
        rec = JSON.parse(raw);
    } catch {
        return;
    }
    if (rec.ev) {
        handleEvent(rec, ctx);
        ctx.lastTs = rec.ts || ctx.lastTs;
        return;
    }
    if (!rec.hex) return;

    // 空闲间隔分隔: 相邻记录间隔超过阈值自动插入 (帮助定位操作边界, --gap-secs 0 关闭)
    if (!ctx.summaryMode && ctx.gapSecs > 0 && ctx.lastTs && rec.ts - ctx.lastTs >= ctx.gapSecs) {
        console.log(`\n······ 空闲 ${(rec.ts - ctx.lastTs).toFixed(1)}s ······`);
    }
    ctx.lastTs = rec.ts;

    const frame = Buffer.from(rec.hex, 'hex');
    const res = await decodeFrame(frame, { decrypt: true });
    if (!res.ok) {
        if (!ctx.summaryMode) console.log(`[${rec.dir}] <解析失败> ${res.error}`);
        return;
    }

    const m = res.meta;
    const key = m.message_type === 3
        ? `[Notify] ${res.notifyType || '(未知)'}`
        : `${m.service_name}.${m.method_name}`;
    if (filter && !key.includes(filter)) return;

    if (ctx.summaryMode) {
        const cur = ctx.seen.get(key) || { count: 0, types: new Set() };
        cur.count += 1;
        cur.types.add(m.message_type_name);
        ctx.seen.set(key, cur);
        return;
    }

    const errTag = m.error_code ? ` ERR=${m.error_code}${m.error_message ? '(' + m.error_message + ')' : ''}` : '';
    console.log(`\n[${fmtTime(rec.ts)} ${rec.dir}] ${key}  type=${m.message_type_name} seq=${m.client_seq || m.server_seq}${errTag}`);
    if (res.decrypted && res.fields && res.fields.length) {
        console.log(res.fields.join('\n'));
    } else if (res.bodyHex) {
        console.log(`  body(hex): ${res.bodyHex}`);
    }

    if (outStream) {
        outStream.write(`${JSON.stringify({
            ts: rec.ts, dir: rec.dir, meta: m, decrypted: res.decrypted,
            bodyHex: res.bodyHex, fields: res.fields,
        })}\n`);
    }
}

async function runOnce(inPath, args, outStream) {
    const ctx = {
        seen: new Map(), marks: [], wsOpens: 0, lastTs: 0,
        summaryMode: !!args.flags.summary,
        gapSecs: args['gap-secs'] != null ? Number(args['gap-secs']) : 2,
    };
    if (Number.isNaN(ctx.gapSecs)) ctx.gapSecs = 2;
    const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
    for await (const line of rl) {
        if (line.trim()) await decodeLine(line, args.filter, outStream, ctx);
    }
    finish(ctx, args, outStream);
}

async function runFollow(inPath, args, outStream) {
    const ctx = {
        seen: new Map(), marks: [], wsOpens: 0, lastTs: 0, summaryMode: false,
        gapSecs: args['gap-secs'] != null ? Number(args['gap-secs']) : 2,
    };
    if (Number.isNaN(ctx.gapSecs)) ctx.gapSecs = 2;
    let offset = 0;
    let buffer = '';

    async function drain() {
        let stat;
        try {
            stat = fs.statSync(inPath);
        } catch {
            return; // 文件还没被 mitmproxy 创建
        }
        if (stat.size < offset) offset = 0; // 文件被截断/重建
        if (stat.size === offset) return;
        const stream = fs.createReadStream(inPath, { start: offset, end: stat.size - 1 });
        for await (const chunk of stream) buffer += chunk.toString('utf8');
        offset = stat.size;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 末尾可能是半行
        for (const line of lines) {
            if (line.trim()) await decodeLine(line, args.filter, outStream, ctx);
        }
    }

    console.log(`[follow] 跟随 ${inPath} ... (Ctrl-C 退出)`);
    await drain();
    const timer = setInterval(() => { drain().catch((e) => console.error(e)); }, 500);
    process.on('SIGINT', () => {
        clearInterval(timer);
        if (outStream) outStream.end();
        console.log('\n已停止。');
        process.exit(0);
    });
}

function finish(ctx, args, outStream) {
    if (ctx.summaryMode) {
        const known = args['no-diff'] ? null : harvestKnownInterfaces();
        const knownNotifies = args['no-diff'] ? new Set() : harvestKnownNotifies();
        printSummary(ctx.seen, ctx.marks, known, knownNotifies);
    }
    if (outStream) outStream.end();
}

async function main() {
    const args = parseArgs(process.argv);
    const inPath = args.in || '/tmp/wx_ws_capture.jsonl';
    await loadProto();

    let outStream = null;
    if (args.out) {
        const outPath = path.isAbsolute(args.out) ? args.out : path.join(CORE_ROOT, args.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        outStream = fs.createWriteStream(outPath, { flags: 'a' });
        console.log(`[out] 解码结果写入 ${outPath}`);
    }

    if (args.flags.follow) {
        await runFollow(inPath, args, outStream);
    } else {
        if (!fs.existsSync(inPath)) {
            console.error(`输入文件不存在: ${inPath} (先用 capture-activity.sh 抓帧, 或用 --follow)`);
            process.exit(1);
        }
        await runOnce(inPath, args, outStream);
    }
}

main().catch((e) => {
    console.error('执行出错:', e);
    process.exit(1);
});
