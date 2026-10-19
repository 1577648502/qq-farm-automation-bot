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
 *
 *   # summary 和解密落盘一次完成; --overwrite 会覆盖旧输出而不是追加
 *   node scripts/ws-capture-decode.js --in /tmp/wx_ws_capture.jsonl \
 *     --out /tmp/wx_ws_capture.decoded.jsonl --summary --overwrite
 *
 *   # 按抓包文件名自动生成同名 .decoded.jsonl + .summary.txt
 *   node scripts/ws-capture-decode.js --capture ../wx-code-grabber/captures/xxx.jsonl
 *
 *   # 自动选择 captures 目录里最新的原始抓包
 *   node scripts/ws-capture-decode.js --latest ../wx-code-grabber/captures
 *
 *   # 明确等待抓包写入稳定, 自定义 30 秒无变化且最多等待 120 秒
 *   node scripts/ws-capture-decode.js --latest ../wx-code-grabber/captures \
 *     --wait-stable --settle-secs 30 --timeout 120
 *
 *   # 运行脚本内置的最小回归自测
 *   node scripts/ws-capture-decode.js --self-test
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const readline = require('node:readline');
const { finished } = require('node:stream/promises');

const { loadProto } = require('../src/utils/proto');
const { decodeFrame } = require('./ws-frame-lib');

const CORE_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(CORE_ROOT, 'src');
const PROTO_DIR = path.join(CORE_ROOT, 'src', 'proto');

function parseArgs(argv) {
    const args = { flags: {} };
    const booleanFlags = new Set([
        'follow', 'summary', 'no-diff', 'overwrite', 'help', 'wait-stable', 'self-test',
    ]);
    const valueFlags = new Set([
        'in', 'out', 'filter', 'gap-secs', 'capture', 'latest', 'summary-out',
        'settle-secs', 'settle-timeout-secs', 'timeout',
    ]);
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') {
            args.flags.help = true;
            continue;
        }
        if (a.startsWith('--')) {
            const key = a.slice(2);
            if (booleanFlags.has(key)) {
                args.flags[key] = true;
            } else if (valueFlags.has(key)) {
                const value = argv[++i];
                if (value == null || value.startsWith('--')) {
                    throw new Error(`参数 --${key} 缺少值`);
                }
                args[key] = value;
            } else {
                throw new Error(`未知参数: ${a}`);
            }
        } else {
            throw new Error(`未知参数: ${a}`);
        }
    }
    if (args.flags.follow && args.flags.summary) {
        throw new Error('--follow 与 --summary 不能同时使用；请停止抓包后再生成接口清单');
    }
    if (args.flags['wait-stable'] && args.flags.follow) {
        throw new Error('--wait-stable 不能与 --follow 同时使用');
    }
    if (args.flags['self-test'] && Object.keys(args).some(key => key !== 'flags')) {
        throw new Error('--self-test 不能与其他参数同时使用');
    }
    if (args.capture && args.latest) {
        throw new Error('--capture 与 --latest 只能使用一个');
    }
    if ((args.capture || args.latest) && args.in) {
        throw new Error('--capture/--latest 不能与 --in 同时使用');
    }
    if ((args.capture || args.latest) && args.out) {
        throw new Error('--capture/--latest 会自动生成输出路径，不能与 --out 同时使用');
    }
    if ((args.capture || args.latest) && args['summary-out']) {
        throw new Error('--capture/--latest 会自动生成接口清单路径，不能与 --summary-out 同时使用');
    }
    if ((args.capture || args.latest) && args.filter) {
        throw new Error('--capture/--latest 需要生成完整解密结果，不能与 --filter 同时使用');
    }
    if ((args.capture || args.latest) && args.flags.follow) {
        throw new Error('--capture/--latest 用于已结束的抓包，不能与 --follow 同时使用');
    }
    if (args['summary-out']) args.flags.summary = true;
    if (args.capture || args.latest) {
        args.flags.summary = true;
        args.flags.overwrite = true;
    }
    if (args['gap-secs'] != null) {
        const gapSecs = Number(args['gap-secs']);
        if (!Number.isFinite(gapSecs) || gapSecs < 0) {
            throw new Error(`--gap-secs 必须是非负数字: ${args['gap-secs']}`);
        }
    }
    if (args['settle-secs'] != null) {
        const settleSecs = Number(args['settle-secs']);
        if (!Number.isFinite(settleSecs) || settleSecs < 0) {
            throw new Error(`--settle-secs 必须是非负数字: ${args['settle-secs']}`);
        }
    }
    if (args['settle-timeout-secs'] != null) {
        const timeoutSecs = Number(args['settle-timeout-secs']);
        if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) {
            throw new Error(`--settle-timeout-secs 必须是正数: ${args['settle-timeout-secs']}`);
        }
    }
    if (args.timeout != null) {
        if (args['settle-timeout-secs'] != null) {
            throw new Error('--timeout 与 --settle-timeout-secs 只能使用一个');
        }
        const timeoutSecs = Number(args.timeout);
        if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) {
            throw new Error(`--timeout 必须是正数: ${args.timeout}`);
        }
        args['settle-timeout-secs'] = args.timeout;
        delete args.timeout;
    }
    return args;
}

function printHelp() {
    console.log(`WS 抓包解码器

用法:
  node scripts/ws-capture-decode.js --in <抓包.jsonl> [选项]
  node scripts/ws-capture-decode.js --follow [选项]
  node scripts/ws-capture-decode.js --capture <抓包.jsonl> [选项]
  node scripts/ws-capture-decode.js --latest <captures目录> [选项]

选项:
  --in <文件>        输入 JSONL, 默认 /tmp/wx_ws_capture.jsonl
  --out <文件>       解密后的结构化 JSONL (默认追加)
  --summary-out <文件> 将接口清单同时写入文件
  --overwrite        写 --out 前覆盖旧文件
  --summary          输出接口清单并比对 core/src 已实现接口
  --no-diff          summary 模式不比对 core/src
  --filter <关键字>  只处理 service.method 命中的帧
  --gap-secs <秒>    普通解码时空闲分隔阈值, 默认 2; 0 关闭
  --follow           持续跟随抓包文件
  --capture <文件>   自动生成同名 .decoded.jsonl 和 .summary.txt
  --latest <目录>    自动解码目录中最新的原始 .jsonl 抓包
  --wait-stable      处理 --in 前也等待抓包写入稳定
  --settle-secs <秒> 抓包文件写入静默多久后开始处理, 默认 2; 0 表示关闭等待
  --timeout <秒>     等待抓包稳定最长时间, 默认 600
  --settle-timeout-secs <秒> --timeout 的兼容写法
  --self-test        运行内置的最小回归自测
  -h, --help         显示帮助`);
}

function deriveCapturePaths(inPath) {
    const input = path.resolve(inPath);
    if (!input.endsWith('.jsonl')) {
        throw new Error(`抓包文件必须使用 .jsonl 后缀: ${input}`);
    }
    if (input.endsWith('.decoded.jsonl')) {
        throw new Error(`--capture 需要原始抓包，不能输入已解码文件: ${input}`);
    }
    const base = input.slice(0, -'.jsonl'.length);
    return {
        input,
        output: `${base}.decoded.jsonl`,
        summary: `${base}.summary.txt`,
    };
}

function findLatestCapture(dirPath) {
    const dir = path.resolve(dirPath);
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            throw new Error(`抓包目录不存在: ${dir}`);
        }
        throw new Error(`无法读取抓包目录 ${dir}: ${e.message}`);
    }
    const candidates = entries
        .filter(e => e.isFile() && e.name.endsWith('.jsonl') && !e.name.endsWith('.decoded.jsonl'))
        .map((e) => {
            const full = path.join(dir, e.name);
            return { full, mtimeMs: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.full.localeCompare(a.full));
    if (!candidates.length) {
        throw new Error(`目录中没有原始 .jsonl 抓包: ${dir}`);
    }
    return candidates[0].full;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCaptureSettled(inPath, args) {
    const settleSecs = args['settle-secs'] != null ? Number(args['settle-secs']) : 2;
    const timeoutSecs = args['settle-timeout-secs'] != null
        ? Number(args['settle-timeout-secs'])
        : 600;
    if (settleSecs === 0) return;

    const settleMs = settleSecs * 1000;
    const timeoutMs = timeoutSecs * 1000;
    const startedAt = Date.now();
    let stableSince = startedAt;
    let previousSignature = null;
    let lastLogAt = 0;

    while (true) {
        let stat;
        try {
            stat = fs.statSync(inPath);
        } catch (e) {
            throw new Error(`无法读取抓包文件 ${inPath}: ${e.message}`);
        }
        if (!stat.isFile()) throw new Error(`抓包路径不是文件: ${inPath}`);

        const signature = `${stat.size}:${stat.mtimeMs}`;
        const now = Date.now();
        if (signature !== previousSignature) {
            previousSignature = signature;
            stableSince = now;
        } else if (now - stableSince >= settleMs) {
            console.log(`[settle] 抓包已稳定 ${settleSecs}s: ${inPath}`);
            return;
        }

        if (now - startedAt >= timeoutMs) {
            throw new Error(
                `等待抓包稳定超时 ${timeoutSecs}s；抓包可能仍在写入: ${inPath}`,
            );
        }
        if (now - lastLogAt >= 5000) {
            console.log(`[settle] 等待抓包写入完成 (${Math.ceil((now - startedAt) / 1000)}s)...`);
            lastLogAt = now;
        }
        await sleep(250);
    }
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
                for (;;) {
                    const cm = constRe.exec(src);
                    if (!cm) break;
                    consts[cm[1]] = cm[2];
                }
                for (;;) {
                    const m = callRe.exec(src);
                    if (!m) break;
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

function addErrorSample(stats, rec, message) {
    if (stats.errorSamples.length >= 20) return;
    stats.errorSamples.push(`${rec.dir || '?'} ${rec.key || '(unknown)'}: ${message}`);
}

/**
 * 归类一帧的解码结果。解密失败只进入失败计数, 绝不增加“已解密请求”或“成功解码”。
 */
function classifyDecodedFrame(ctx, rec, res) {
    const m = res.meta;
    if (m.message_type === 1) {
        ctx.stats.requestFrames += 1;
        if (!res.bodyHex) {
            ctx.stats.emptyRequests += 1;
            ctx.stats.decoded += 1;
            return { kind: 'empty-request', ok: true };
        }

        ctx.stats.encryptedRequests += 1;
        if (res.decryptError) {
            ctx.stats.decryptFailures += 1;
            addErrorSample(ctx.stats, rec, `解密失败: ${res.decryptError}`);
            return {
                kind: 'decrypt-error',
                ok: false,
                reason: res.decryptError,
            };
        }
        if (!res.decrypted) {
            ctx.stats.decryptFailures += 1;
            addErrorSample(ctx.stats, rec, '解密失败: 请求体非空但未成功解密');
            return {
                kind: 'decrypt-error',
                ok: false,
                reason: '请求体非空但未成功解密',
            };
        }

        ctx.stats.decrypted += 1;
        ctx.stats.decoded += 1;
        return { kind: 'request-decrypted', ok: true };
    }

    ctx.stats.plainFrames += 1;
    ctx.stats.decoded += 1;
    return { kind: 'plain', ok: true };
}

function evaluateCaptureReadiness(stats) {
    if (stats.frames === 0) {
        return { ok: false, reason: '抓包中没有游戏帧' };
    }
    if (stats.requestFrames === 0) {
        return {
            ok: false,
            reason: '抓包中没有检测到请求帧（message_type=1），无法验证请求解密协议',
        };
    }
    if (stats.encryptedRequests === 0) {
        return {
            ok: false,
            reason: '抓包中没有检测到非空加密请求（message_type=1），可能只抓到了响应/通知，或请求体为空',
        };
    }
    if (stats.decrypted === 0) {
        return {
            ok: false,
            reason: `加密请求全部解密失败: ${stats.decryptFailures}/${stats.encryptedRequests} 帧`,
        };
    }
    return {
        ok: true,
        warning: stats.decryptFailures > 0
            ? `有 ${stats.decryptFailures}/${stats.encryptedRequests} 条加密请求解密失败；失败记录已保留，协议判定仍基于其余成功请求`
            : '',
    };
}

function buildSummary(seen, marks, known, knownNotifies, meta = {}) {
    const lines = [];
    const add = (line = '') => lines.push(line);
    const rows = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
    const knownList = known ? [...known].sort() : null;

    add('===== 抓包解码摘要 =====');
    if (meta.input) add(`输入: ${meta.input}`);
    if (meta.output) add(`解密帧: ${meta.output}`);

    if (meta.readiness) {
        add('');
        add('===== 协议抓包结果 =====');
        add(meta.readiness.ok ? '成功: 至少一条加密请求已成功解密。' : `失败: ${meta.readiness.reason}`);
        if (meta.readiness.warning) add(`警告: ${meta.readiness.warning}`);
    }

    if (marks.length) {
        add('');
        add('===== 时间线标记 =====');
        for (const m of marks) {
            add(`  ${fmtTime(m.ts)}  ${m.label}`);
        }
    }

    add('');
    add('===== 接口清单 (service.method) =====');
    const unknownRows = [];
    for (const [key, v] of rows) {
        const isKnown = knownList
            ? knownList.includes(key) || (key.startsWith('[Notify] ') && knownNotifies.has(shortNotifyName(key.slice(9))))
            : null;
        const flag = isKnown === false ? ' ★ 新' : '';
        add(`  ${key}  [${[...v.types].join('/')}]  x${v.count}${flag}`);
        if (isKnown === false) unknownRows.push([key, v]);
    }
    add(`共 ${rows.length} 个接口。`);

    if (knownList) {
        if (unknownRows.length) {
            add('');
            add('===== ★ 项目未实现的新接口 (优先逆向这些) =====');
            for (const [key, v] of unknownRows) {
                add(`  ${key}  x${v.count}`);
                const filterWord = key.startsWith('[Notify] ')
                    ? shortNotifyName(key.slice(9))
                    : key.split('.').pop();
                add(`    看详细字段: node scripts/ws-capture-decode.js --in <抓包文件> --filter '${filterWord}'`);
            }
            add(`共 ${unknownRows.length} 个新接口 (项目已实现 ${knownList.length} 个)。`);
        } else {
            add('');
            add(`本次抓包没有发现项目未实现的接口 (已比对源码中 ${knownList.length} 个已实现接口)。`);
        }
    }

    if (meta.stats) {
        const s = meta.stats;
        add('');
        add('===== 解码统计 =====');
        add(`原始帧: ${s.frames}`);
        add(`请求帧: ${s.requestFrames}`);
        add(`空请求: ${s.emptyRequests}`);
        add(`加密请求: ${s.encryptedRequests}`);
        add(`请求解密成功: ${s.decrypted}`);
        add(`请求解密失败: ${s.decryptFailures}`);
        add(`明文响应/通知: ${s.plainFrames}`);
        add(`成功解码: ${s.decoded}`);
        add(`解析失败: ${s.decodeFailures}`);
        add(`非法 JSON 行: ${s.invalidLines}`);
        add(`过滤跳过: ${s.filtered}`);
        if (s.errorSamples && s.errorSamples.length) {
            add('失败样例:');
            for (const item of s.errorSamples) add(`  ${item}`);
        }
    }

    return `${lines.join('\n')}\n`;
}

function printSummary(seen, marks, known, knownNotifies, meta = {}) {
    const text = buildSummary(seen, marks, known, knownNotifies, meta);
    process.stdout.write(text);
    return text;
}

function writeFileAtomic(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`,
    );
    try {
        fs.writeFileSync(tempPath, content, { flag: 'wx' });
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        try { fs.unlinkSync(tempPath); } catch { /* 临时文件可能尚未创建 */ }
        throw e;
    }
}

async function runSelfTest() {
    const assert = (condition, message) => {
        if (!condition) throw new Error(`自测失败: ${message}`);
    };

    const parsed = parseArgs([
        'node', 'ws-capture-decode.js', '--latest', 'captures',
        '--wait-stable', '--settle-secs', '3', '--timeout', '12',
    ]);
    assert(parsed.flags['wait-stable'], '--wait-stable 未解析');
    assert(parsed['settle-timeout-secs'] === '12', '--timeout 别名未归一化');

    const failedCtx = createContext(false, {});
    const failedClass = classifyDecodedFrame(failedCtx, { dir: 'C->S', key: 'Req' }, {
        meta: { message_type: 1 },
        bodyHex: 'deadbeef',
        decrypted: false,
        decryptError: 'bad ciphertext',
    });
    assert(failedClass.kind === 'decrypt-error', '解密异常归类错误');
    assert(failedCtx.stats.encryptedRequests === 1, '加密请求计数错误');
    assert(failedCtx.stats.decryptFailures === 1, '解密失败计数错误');
    assert(failedCtx.stats.decrypted === 0, '解密异常被计为成功');
    assert(failedCtx.stats.decoded === 0, '解密异常被计为成功解码');
    assert(evaluateCaptureReadiness(failedCtx.stats).ok === false, '全部解密失败却判定成功');
    const failedRecord = buildOutputRecord(
        { ts: 1, dir: 'C->S', key: 'Req' },
        { meta: { message_type: 1 }, bodyHex: 'deadbeef', decrypted: false, decryptError: 'bad ciphertext' },
        'selftest.Req.Run',
        failedClass,
    );
    assert(failedRecord.decryptError === 'bad ciphertext', 'decryptError 未保留到输出记录');

    const plainCtx = createContext(false, {});
    plainCtx.stats.frames = 1;
    classifyDecodedFrame(plainCtx, { dir: 'S->C', key: 'Resp' }, {
        meta: { message_type: 2 },
        bodyHex: '0a00',
        decrypted: false,
    });
    const noRequest = evaluateCaptureReadiness(plainCtx.stats);
    assert(noRequest.ok === false && noRequest.reason.includes('请求帧'), '无请求帧未给出明确失败');
    assert(plainCtx.stats.plainFrames === 1, '明文响应计数错误');

    const okCtx = createContext(false, {});
    okCtx.stats.frames = 1;
    classifyDecodedFrame(okCtx, { dir: 'C->S', key: 'Req' }, {
        meta: { message_type: 1 },
        bodyHex: '0a00',
        decrypted: true,
    });
    assert(okCtx.stats.decrypted === 1 && okCtx.stats.decoded === 1, '成功解密计数错误');
    assert(evaluateCaptureReadiness(okCtx.stats).ok === true, '成功解密请求未通过协议判定');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-decode-selftest-'));
    const target = path.join(tempDir, 'result.jsonl');
    try {
        fs.writeFileSync(target, 'old\n');
        const output = createOutputTarget(target, true);
        output.stream.write('atomic-output\n');
        await closeOutput(output);
        assert(fs.readFileSync(target, 'utf8') === 'atomic-output\n', '原子输出流结果错误');
        writeFileAtomic(target, 'new\n');
        assert(fs.readFileSync(target, 'utf8') === 'new\n', '原子摘要结果错误');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log('[self-test] 通过: 参数别名、解密失败归类/保留、协议成功门槛、明文计数、原子输出流/摘要');
}

function buildOutputRecord(rec, res, key, classification) {
    const outputRecord = {
        ts: rec.ts, dir: rec.dir, flow: rec.flow, host: rec.host, idx: rec.idx,
        key, meta: res.meta, decrypted: res.decrypted, bodyHex: res.bodyHex,
    };
    if (classification.ok) {
        outputRecord.fields = res.fields;
    } else {
        outputRecord.decryptError = classification.reason;
    }
    return outputRecord;
}

async function decodeLine(raw, filter, outStream, ctx) {
    let rec;
    try {
        rec = JSON.parse(raw);
    } catch {
        ctx.stats.invalidLines += 1;
        return;
    }
    if (rec.ev) {
        ctx.stats.events += 1;
        handleEvent(rec, ctx);
        ctx.lastTs = rec.ts || ctx.lastTs;
        return;
    }
    if (!rec.hex) return;
    ctx.stats.frames += 1;

    // 空闲间隔分隔: 相邻记录间隔超过阈值自动插入 (帮助定位操作边界, --gap-secs 0 关闭)
    if (!ctx.summaryMode && ctx.gapSecs > 0 && ctx.lastTs && rec.ts - ctx.lastTs >= ctx.gapSecs) {
        console.log(`\n······ 空闲 ${(rec.ts - ctx.lastTs).toFixed(1)}s ······`);
    }
    ctx.lastTs = rec.ts;

    const frame = Buffer.from(rec.hex, 'hex');
    let res;
    try {
        res = await decodeFrame(frame, { decrypt: true });
    } catch (e) {
        ctx.stats.decodeFailures += 1;
        addErrorSample(ctx.stats, rec, e.message);
        if (!ctx.summaryMode) console.log(`[${rec.dir}] <解析失败> ${e.message}`);
        return;
    }
    if (!res.ok) {
        ctx.stats.decodeFailures += 1;
        addErrorSample(ctx.stats, rec, res.error);
        if (!ctx.summaryMode) console.log(`[${rec.dir}] <解析失败> ${res.error}`);
        return;
    }

    const m = res.meta;
    const key = m.message_type === 3
        ? `[Notify] ${res.notifyType || '(未知)'}`
        : `${m.service_name}.${m.method_name}`;
    const classification = classifyDecodedFrame(ctx, rec, res);
    if (filter && !key.includes(filter)) {
        ctx.stats.filtered += 1;
        return;
    }

    if (outStream) {
        const outputRecord = buildOutputRecord(rec, res, key, classification);
        outStream.write(`${JSON.stringify(outputRecord)}\n`);
    }

    if (!classification.ok) {
        if (!ctx.summaryMode) {
            console.log(`[${rec.dir}] <解密失败> ${key}: ${classification.reason}`);
        }
        return;
    }

    if (ctx.summaryMode) {
        const cur = ctx.seen.get(key) || { count: 0, types: new Set() };
        cur.count += 1;
        cur.types.add(m.message_type_name);
        ctx.seen.set(key, cur);
        return;
    }

    const errorDetail = m.error_message ? `(${m.error_message})` : '';
    const errTag = m.error_code ? ` ERR=${m.error_code}${errorDetail}` : '';
    console.log(`\n[${fmtTime(rec.ts)} ${rec.dir}] ${key}  type=${m.message_type_name} seq=${m.client_seq || m.server_seq}${errTag}`);
    if (res.decrypted && res.fields && res.fields.length) {
        console.log(res.fields.join('\n'));
    } else if (res.bodyHex) {
        console.log(`  body(hex): ${res.bodyHex}`);
    }
}

function createContext(summaryMode, args) {
    const ctx = {
        seen: new Map(), marks: [], wsOpens: 0, lastTs: 0,
        summaryMode,
        gapSecs: args['gap-secs'] != null ? Number(args['gap-secs']) : 2,
        stats: {
            events: 0,
            frames: 0,
            requestFrames: 0,
            encryptedRequests: 0,
            emptyRequests: 0,
            decrypted: 0,
            plainFrames: 0,
            decoded: 0,
            decryptFailures: 0,
            decodeFailures: 0,
            invalidLines: 0,
            filtered: 0,
            errorSamples: [],
        },
    };
    if (Number.isNaN(ctx.gapSecs)) ctx.gapSecs = 2;
    return ctx;
}

function createOutputTarget(outPath, overwrite) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tempPath = overwrite
        ? path.join(path.dirname(outPath), `.${path.basename(outPath)}.tmp-${process.pid}-${Date.now()}`)
        : null;
    const writePath = tempPath || outPath;
    return {
        finalPath: outPath,
        tempPath,
        stream: fs.createWriteStream(writePath, { flags: overwrite ? 'wx' : 'a' }),
    };
}

async function closeOutput(output) {
    if (!output) return;
    if (!output.stream.writableEnded) output.stream.end();
    await finished(output.stream);
    if (output.tempPath) fs.renameSync(output.tempPath, output.finalPath);
}

async function discardOutput(output) {
    if (!output) return;
    if (!output.stream.destroyed) output.stream.destroy();
    try { await finished(output.stream); } catch { /* 已在写入失败路径 */ }
    if (output.tempPath) {
        try { fs.unlinkSync(output.tempPath); } catch { /* 临时文件可能已清理 */ }
    }
}

async function runOnce(inPath, args, output) {
    const ctx = createContext(!!args.flags.summary, args);
    const outStream = output ? output.stream : null;
    const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
    for await (const line of rl) {
        if (line.trim()) await decodeLine(line, args.filter, outStream, ctx);
    }
    return ctx;
}

async function runFollow(inPath, args, output) {
    const ctx = createContext(false, args);
    const outStream = output ? output.stream : null;
    let offset = 0;
    let buffer = '';
    let draining = false;

    async function drain() {
        if (draining) return;
        draining = true;
        let stat;
        try {
            stat = fs.statSync(inPath);
        } catch {
            draining = false;
            return; // 文件还没被 mitmproxy 创建
        }
        try {
            if (stat.size < offset) {
                offset = 0; // 文件被截断/重建
                buffer = '';
            }
            if (stat.size === offset) return;
            const stream = fs.createReadStream(inPath, { start: offset, end: stat.size - 1 });
            for await (const chunk of stream) buffer += chunk.toString('utf8');
            offset = stat.size;
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 末尾可能是半行
            for (const line of lines) {
                if (line.trim()) await decodeLine(line, args.filter, outStream, ctx);
            }
        } finally {
            draining = false;
        }
    }

    console.log(`[follow] 跟随 ${inPath} ... (Ctrl-C 退出)`);
    await drain();
    await new Promise((resolve, reject) => {
        let stopping = false;
        const timer = setInterval(() => {
            drain().catch((e) => {
                clearInterval(timer);
                reject(e);
            });
        }, 500);
        const stop = async () => {
            if (stopping) return;
            stopping = true;
            clearInterval(timer);
            try {
                await new Promise((resolveDrain) => {
                    const checkDrain = () => {
                        if (draining) {
                            setTimeout(checkDrain, 25);
                        } else {
                            resolveDrain();
                        }
                    };
                    checkDrain();
                });
                if (buffer.trim()) {
                    await decodeLine(buffer, args.filter, outStream, ctx);
                    buffer = '';
                }
                await closeOutput(output);
                console.log('\n已停止。');
                resolve();
            } catch (e) {
                reject(e);
            }
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}

async function finish(ctx, args, inPath, output, summaryPath, readiness) {
    if (ctx.summaryMode) {
        const known = args.flags['no-diff'] ? null : harvestKnownInterfaces();
        const knownNotifies = args.flags['no-diff'] ? new Set() : harvestKnownNotifies();
        const text = printSummary(ctx.seen, ctx.marks, known, knownNotifies, {
            input: path.resolve(inPath),
            output: output ? output.finalPath : '',
            stats: ctx.stats,
            readiness,
        });
        if (summaryPath) writeFileAtomic(summaryPath, text);
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.flags.help) {
        printHelp();
        return;
    }
    if (args.flags['self-test']) {
        await runSelfTest();
        return;
    }

    const captureMode = !!(args.capture || args.latest);
    let inPath = args.in || '/tmp/wx_ws_capture.jsonl';
    let outPath = null;
    let summaryPath = null;

    try {
        if (args.latest) {
            inPath = findLatestCapture(args.latest);
            console.log(`[latest] 最新原始抓包: ${inPath}`);
        }
        if (captureMode) {
            const paths = deriveCapturePaths(args.capture || inPath);
            inPath = paths.input;
            outPath = paths.output;
            summaryPath = paths.summary;
        } else {
            if (args.out) {
                outPath = path.isAbsolute(args.out) ? args.out : path.join(CORE_ROOT, args.out);
            }
            if (args['summary-out']) {
                summaryPath = path.isAbsolute(args['summary-out'])
                    ? args['summary-out']
                    : path.join(CORE_ROOT, args['summary-out']);
            }
        }

        if (!args.flags.follow && !fs.existsSync(inPath)) {
            throw new Error(`输入文件不存在: ${inPath} (先用 capture-activity.sh 抓帧, 或用 --follow)`);
        }
        if (captureMode || args.flags['wait-stable']) {
            await waitForCaptureSettled(inPath, args);
        }
        if (outPath && path.resolve(outPath) === path.resolve(inPath)) {
            throw new Error(`输出不能与输入文件相同: ${outPath}`);
        }
        if (summaryPath && path.resolve(summaryPath) === path.resolve(inPath)) {
            throw new Error(`接口清单不能覆盖输入文件: ${summaryPath}`);
        }

        await loadProto();

        let output = null;
        if (outPath) {
            output = createOutputTarget(outPath, !!args.flags.overwrite);
            console.log(`[out] 解码结果写入 ${outPath}`);
        }

        try {
            if (args.flags.follow) {
                await runFollow(inPath, args, output);
                output = null;
            } else {
                const ctx = await runOnce(inPath, args, output);
                const readiness = captureMode ? evaluateCaptureReadiness(ctx.stats) : null;
                const completedOutput = output;
                await closeOutput(output);
                output = null;
                await finish(ctx, args, inPath, completedOutput, summaryPath, readiness);

                if (readiness && !readiness.ok) {
                    const sample = ctx.stats.errorSamples[0]
                        ? `；首个错误: ${ctx.stats.errorSamples[0]}`
                        : '';
                    throw new Error(`协议抓包失败: ${readiness.reason}${sample}`);
                }
                if (readiness && readiness.warning) {
                    console.warn(`[warn] ${readiness.warning}`);
                }
            }
        } catch (e) {
            await discardOutput(output);
            throw e;
        }

        if (captureMode) {
            console.log(`[ok] 原始抓包已保留: ${path.resolve(inPath)}`);
            console.log(`[ok] 解密结果: ${outPath}`);
            console.log(`[ok] 接口清单: ${summaryPath}`);
            console.log('[ok] 协议抓包成功: 至少一条加密请求已成功解密');
        }
    } catch (e) {
        let hasInput = false;
        try {
            hasInput = fs.statSync(inPath).isFile();
        } catch { /* 输入尚未创建或路径本身无效 */ }
        if (captureMode && hasInput) {
            e.message += `\n原始抓包已保留: ${path.resolve(inPath)}`
                + `\n重试: node scripts/ws-capture-decode.js --capture "${path.resolve(inPath)}"`;
        }
        throw e;
    }
}

main().catch((e) => {
    console.error('执行出错:', e && e.message ? e.message : e);
    if (process.env.WX_DECODE_DEBUG === '1' && e && e.stack) console.error(e.stack);
    process.exit(1);
});
