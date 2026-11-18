#!/usr/bin/env node
/**
 * 系统缺口分析 —— 把「抓包里出现过什么」「官方文档写了什么」「代码实现了什么」「页面暴露了什么」
 * 四份信息交叉对一遍, 输出真正缺的东西。
 *
 * 为什么要这个:
 *   之前每次判断"还缺啥"都靠人翻抓包 + 翻文档 + 翻代码, 一次半小时且容易漏。
 *   缺口其实分两类, 必须分开看:
 *     · 后端缺: 抓包里有接口/字段, 但 services 从不调用  → 功能不存在
 *     · 前端缺: 后端有 op/RPC, 但页面上点不到            → 功能存在但用户用不了
 *
 * 用法:
 *   node scripts/gap-report.js                  # 全部维度
 *   node scripts/gap-report.js --section backend
 *   node scripts/gap-report.js --json
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WEB = path.join(ROOT, '..', 'web', 'src');
const CAPTURES = path.join(ROOT, '..', 'wx-code-grabber', 'captures');
const DOCS = path.join(ROOT, '..', 'docs', 'mc-ranch');

/** 这些是客户端必发但机器人不需要的接口, 统计时要单独归为"噪音"而不是缺口 */
const NOISE_PATTERNS = [
    /acepb\.AceService/,          // 反作弊上报
    /BatchClientReportFlow/,      // 客户端埋点
    /ReportForeground/,           // 前后台切换上报
    /BatchModerateText/,          // 文本审核
    /DecryptOpenData/,            // 开放数据解密
    /avatarframepb/,              // 头像框
    /skinpb/,                     // 皮肤
    /marqueepb/,                  // 跑马灯
    /bulletinboardpb/,            // 公告板
    /msgboardpb/,                 // 留言板
    /uicproxypb/,                 // UI 代理
    /subscribewxmsg/,             // 订阅消息
    /PayService|rechargebonus/i,  // 充值
    /GetWXRecommendations/,       // 微信推荐好友
    /GetShareKey/,
    /GetUserSettings/,
    /PlayerLogin/,                // 登录握手(机器人有自己的登录)
];

function isNoise(key) {
    return NOISE_PATTERNS.some(re => re.test(key));
}

function walk(dir, out = []) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.js') || e.name.endsWith('.ts') || e.name.endsWith('.vue')) out.push(p);
    }
    return out;
}

/** 从代码里收集"真正会发出去的 RPC" */
function harvestImplementedRpc(dir) {
    const impl = new Set();
    for (const file of walk(dir)) {
        let src;
        try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
        // SERVICE 常量 → 值
        const consts = {};
        for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([a-zA-Z0-9_.]+Service)['"]/g)) {
            consts[m[1]] = m[2];
        }
        // sendMsgAsync(SVC, 'Method')
        for (const m of src.matchAll(/sendMsg(?:Async)?\s*\(\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*,\s*'([A-Za-z0-9_]+)'/g)) {
            const svc = m[1] || m[2] || consts[m[3]];
            if (svc) impl.add(`${svc}.${m[4]}`);
        }
        // call('Method') 动态封装(ranch-facility 那种)
        for (const val of Object.values(consts)) {
            for (const m of src.matchAll(/\bcall(?:Rpc|Service)?\s*\(\s*'([A-Za-z0-9_]+)'/g)) {
                impl.add(`${val}.${m[1]}`);
            }
        }
    }
    return impl;
}

/** 从抓包目录里收集"客户端实际用过什么" */
function harvestCapturedRpc() {
    const seen = new Map(); // key -> {count, files:Set}
    let files = [];
    try {
        files = fs.readdirSync(CAPTURES).filter(f => f.endsWith('.jsonl'));
    } catch {
        return seen;
    }
    // 只统计最近两天的抓包(游戏每周更新, 老抓包里的接口可能已下线, 算进来只会产生噪音)
    const recent = recentDatePrefixes(2);
    for (const f of files) {
        if (f.includes('.http.') || f.includes('.decoded.')) continue;
        const day = f.slice(0, 8);   // YYYYMMDD
        if (!recent.has(day)) continue;
        const full = path.join(CAPTURES, f);
        let raw;
        try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            if (j.ev || !j.key || !j.hex) continue;
            const key = String(j.key).replace(/^notify:/, '[Notify] ');
            const cur = seen.get(key) || { count: 0, files: new Set() };
            cur.count += 1;
            cur.files.add(f);
            seen.set(key, cur);
        }
    }
    return seen;
}

/** 最近 n 天对应的 YYYYMMDD 前缀集合(按抓包文件名前缀) */
function recentDatePrefixes(n) {
    const out = new Set();
    const now = new Date();
    for (let i = 0; i < n; i++) {
        const d = new Date(now.getTime() - i * 86400000);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        out.add(`${y}${m}${day}`);
    }
    return out;
}

/** proto 里定义了哪些 service 方法 */
function harvestProtoRpc() {
    const defined = new Set();
    const dir = path.join(SRC, 'proto');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.proto')); } catch { return defined; }
    for (const f of files) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        const pkg = (src.match(/^package\s+([\w.]+);/m) || [])[1] || '';
        for (const sm of src.matchAll(/service\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
            for (const r of sm[2].matchAll(/rpc\s+(\w+)\s*\(/g)) {
                defined.add(`${pkg}.${sm[1]}.${r[1]}`);
            }
        }
    }
    return defined;
}

/** 前端页面调用了哪些 op / API */
function harvestFrontendOps() {
    const ops = new Set();
    const apis = new Set();
    for (const file of walk(WEB)) {
        let src;
        try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const m of src.matchAll(/op:\s*'([a-z]+)'/g)) ops.add(m[1]);
        for (const m of src.matchAll(/runOp\('([a-z]+)'/g)) ops.add(m[1]);
        for (const m of src.matchAll(/runBatch\('([a-z]+)'/g)) ops.add(`batch:${m[1]}`);
        for (const m of src.matchAll(/['"`](\/api\/[a-zA-Z0-9/_-]+)['"`]/g)) apis.add(m[1]);
    }
    return { ops, apis };
}

/** 后端支持哪些 op */
function harvestBackendOps() {
    const ops = new Set();
    const file = path.join(SRC, 'services', 'ranch.js');
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch { return ops; }
    for (const m of src.matchAll(/case '([a-z]+)':/g)) ops.add(m[1]);
    // batch 的子操作
    const batchBlock = src.slice(src.indexOf("case 'batch'"));
    for (const m of batchBlock.matchAll(/sub === '([a-z]+)'/g)) ops.add(`batch:${m[1]}`);
    return ops;
}

/** 后端暴露了哪些 /api 路由 */
function harvestBackendRoutes() {
    const routes = new Set();
    const file = path.join(SRC, 'controllers', 'admin.js');
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch { return routes; }
    for (const m of src.matchAll(/app\.(?:get|post|delete|put)\('(\/api\/[^']+)'/g)) {
        routes.add(m[1]);
    }
    return routes;
}

/** 官方文档里提到的 RPC */
function harvestDocRpc() {
    const rpc = new Set();
    let files = [];
    try { files = fs.readdirSync(DOCS).filter(f => f.endsWith('.md')); } catch { return rpc; }
    for (const f of files) {
        const txt = fs.readFileSync(path.join(DOCS, f), 'utf8');
        for (const m of txt.matchAll(/\b([A-Z][A-Za-z]*Service)\.([A-Z][A-Za-z0-9]*)/g)) {
            rpc.add(`${m[1]}.${m[2]}`);
        }
    }
    return rpc;
}

function main() {
    const args = process.argv.slice(2);
    const jsonMode = args.includes('--json');
    const sectionFilter = args.includes('--section') ? args[args.indexOf('--section') + 1] : '';

    const impl = harvestImplementedRpc(SRC);
    const captured = harvestCapturedRpc();
    const protoRpc = harvestProtoRpc();
    const { ops: feOps, apis: feApis } = harvestFrontendOps();
    const beOps = harvestBackendOps();
    const beRoutes = harvestBackendRoutes();
    const docRpc = harvestDocRpc();

    // ---- 维度1: 抓包出现但从未实现 ----
    const missingBackend = [];
    const noise = [];
    for (const [key, meta] of captured) {
        if (key.startsWith('[Notify] ')) continue;      // 推送单独看
        if (impl.has(key)) continue;
        (isNoise(key) ? noise : missingBackend).push({ key, count: meta.count, files: meta.files.size });
    }
    missingBackend.sort((a, b) => b.count - a.count);
    noise.sort((a, b) => b.count - a.count);

    // ---- 维度2: proto 定义了但没调用 ----
    const protoUnused = [...protoRpc].filter(k => !impl.has(k)).sort();

    // ---- 维度3: 后端 op 但页面点不到 ----
    const opMissingInFe = [...beOps].filter(o => !feOps.has(o)).sort();

    // ---- 维度4: 后端路由但前端没调用 ----
    const apiMissingInFe = [...beRoutes]
        .filter(r => !r.includes(':') && !r.includes('*'))
        .filter(r => !feApis.has(r))
        .sort();

    // ---- 维度5: 文档提到但代码没有 ----
    const docMissing = [...docRpc].filter(d => {
        const short = d.split('.').pop();
        return ![...impl].some(k => k.endsWith(`.${short}`));
    }).sort();

    const report = {
        summary: {
            capturedInterfaces: captured.size,
            implementedInterfaces: impl.size,
            protoDefined: protoRpc.size,
            backendOps: beOps.size,
            frontendOps: feOps.size,
            backendRoutes: beRoutes.size,
            frontendApis: feApis.size,
        },
        missingBackend,
        noise,
        protoUnused,
        opMissingInFe,
        apiMissingInFe,
        docMissing,
    };

    if (jsonMode) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    const want = (s) => !sectionFilter || sectionFilter === s;

    if (want('summary')) {
        console.log('===== 系统缺口分析 =====\n');
        console.log(`抓包出现过接口   : ${report.summary.capturedInterfaces}`);
        console.log(`代码已实现接口   : ${report.summary.implementedInterfaces}`);
        console.log(`proto 已定义 RPC : ${report.summary.protoDefined}`);
        console.log(`后端 op / 前端 op : ${report.summary.backendOps} / ${report.summary.frontendOps}`);
        console.log(`后端路由/前端调用 : ${report.summary.backendRoutes} / ${report.summary.frontendApis}`);
        console.log('');
    }

    if (want('backend')) {
        console.log(`===== A. 抓包里有、但后端从未实现 (${missingBackend.length}) =====`);
        if (!missingBackend.length) console.log('  无');
        for (const x of missingBackend) {
            console.log(`  ${String(x.count).padStart(5)}x  ${x.key}   (${x.files} 份抓包)`);
        }
        console.log(`\n  [噪音 ${noise.length} 个: 反作弊/皮肤/排行榜/埋点等, 机器人不需要]`);
        console.log('');
    }

    if (want('proto')) {
        console.log(`===== B. proto 定义了但代码从不调用 (${protoUnused.length}) =====`);
        if (!protoUnused.length) console.log('  无');
        for (const x of protoUnused) console.log(`  ${x}`);
        console.log('');
    }

    if (want('ops')) {
        console.log(`===== C. 后端有 op、页面点不到 (${opMissingInFe.length}) =====`);
        if (!opMissingInFe.length) console.log('  无');
        for (const x of opMissingInFe) console.log(`  ${x}`);
        console.log('');
    }

    if (want('api')) {
        console.log(`===== D. 后端有路由、前端从不调用 (${apiMissingInFe.length}) =====`);
        if (!apiMissingInFe.length) console.log('  无');
        for (const x of apiMissingInFe) console.log(`  ${x}`);
        console.log('');
    }

    if (want('doc')) {
        console.log(`===== E. 官方文档提到、代码找不到 (${docMissing.length}) =====`);
        if (!docMissing.length) console.log('  无');
        for (const x of docMissing) console.log(`  ${x}`);
        console.log('');
    }
}

main();
