#!/usr/bin/env node
/**
 * 一键抓 QQ 农场 code —— 协议注入法（无需系统代理、无需辅助功能权限、无需你操作）
 *
 * 复用机器人自带的 core/src/services/protocol-code-capture.js 的注入能力：
 *   1) 先关掉已在跑的农场小程序（不关的话缓存 game.js 不会重新加载，注入不生效）
 *   2) 清掉旧的 _code.txt
 *   3) 往农场缓存 game.js 注入 qq.login() 嗅探
 *   4) 用 tencent://ntqq-open/... 让 QQ 自己打开农场（零权限）
 *   5) 只认「本次新写入的 _code.txt」（不走剪贴板，避免读到残留值）
 *   6) finally 还原 game.js（.bak）
 *
 * ⚠️ 农场更新版本会导致"注入白打"：客户端启动瞬间会下载新版本到**新的缓存目录**
 *    （1112386029_3_<新hash>）并改用它，我们注入的旧目录被丢弃 → 一直等不到 code。
 *    对策：等待期间每 3s 数一次缓存目录数，变多了就关掉小程序 → 重新注入 → 再开一轮
 *    （最多 3 轮）。首次跑通后新目录已存在，后续就正常了。
 *
 * 用法:
 *   node grab-code.js                  # 默认最多等 90s
 *   node grab-code.js --timeout 60
 *   node grab-code.js --reopen         # 自动关掉并重新唤起农场(默认不唤起, 自己手动打开), 抓完再关掉
 *   node grab-code.js --reopen --keep-open   # 抓完把农场窗口留着不关
 *   node grab-code.js --json           # 只输出一行 JSON
 *   node grab-code.js --submit         # 抓到后提交到 submit.config.json 里的接口
 *   node grab-code.js --submit --no-start   # 提交后不自动启动账号（默认会）
 *   node grab-code.js --submit --proxy http://127.0.0.1:7897   # 显式走本地代理
 *   node grab-code.js --submit --no-proxy-fallback             # 关掉"直连失败自动回退代理"
 *
 * 提交配置（本地凭据，不进 git）: wx-code-grabber/submit.config.json
 *   { "mode": "accounts|qr-check", "url": "...", "accountId": "2",
 *     "username": "admin", "password": "...", "startIfDown": true,
 *     "proxy": "http://127.0.0.1:7897", "proxyAutoFallback": true }
 *   也可用环境变量覆盖: WX_SUBMIT_URL / WX_SUBMIT_ACCOUNT_ID / WX_SUBMIT_MODE
 *                      WX_SUBMIT_TOKEN / WX_SUBMIT_USERNAME / WX_SUBMIT_PASSWORD
 *                      WX_SUBMIT_START_IF_DOWN（0 关）
 *                      WX_SUBMIT_PROXY / WX_SUBMIT_PROXY_AUTO（0 关自动回退）
 *                      WX_SUBMIT_PROXY_FALLBACK（默认 http://127.0.0.1:7897）
 *   - 代理说明: 目标站直连偶发超时（HTTP 000 / fetch failed）时，脚本会**自动**改走本机常见
 *     代理端口（Clash 混合端口 7897）重跑一次；不需要任何配置。配了 "proxy" 则全程走它。
 *   - accounts: POST https://<host>/api/accounts body {"id","code"}（默认）→ 落库 + 账号在跑时重登
 *     落库后若账号**没在跑**，会自动 POST /api/accounts/<id>/start 把它启起来（`--no-start` 可关）。
 *   - qr-check: POST <url> body {"code"} + x-account-id/x-admin-token 头
 *     ⚠️ /api/qr/check 是只读的扫码状态轮询接口(queryStatus)，不落库、不改账号，别用它提交！
 *
 * token 说明: 服务端 admin token 是**纯内存**的（登录时签发、服务一重启就全清空），
 *   所以写死静态 token 迟早 401。给 username/password 后，脚本会：
 *   用缓存的 token → 401 就自动 POST /api/login 换新 token 重试一次（缓存进 .admin-token.json）。
 *
 * 注意: 注入的嗅探脚本会把 code 同时写进系统剪贴板（项目原有行为），会覆盖你当前的剪贴板。
 *       QQ 会复用未过期的 login code，所以短时间内重复抓可能拿到同一个 code，属正常。
 *
 * 退出码: 0=抓到  2=超时  3=环境问题（找不到缓存 / game.js）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');

const CORE_SERVICES = path.join(__dirname, '..', 'core', 'src', 'services');
const CORE_UTILS = path.join(__dirname, '..', 'core', 'src', 'utils');

let protocol;
let platform;
try {
    protocol = require(path.join(CORE_SERVICES, 'protocol-code-capture.js'));
    platform = require(path.join(CORE_UTILS, 'platform.js'));
} catch (e) {
    console.error('[grab-code] 无法加载 core 的协议抓包模块: ' + e.message);
    process.exit(3);
}

const { patchAllGameJs, openMiniApp, readCodeFiles, clearCodeFiles, restoreGameJs, findTargetFolders } = protocol;

// ---- 参数 ----
const argv = process.argv.slice(2);
let timeoutMs = 90 * 1000;
// 2026-11-16 起默认不自动唤起/重启农场, 用户自己打开; 要旧行为加 --reopen
// (自动唤起会 tencent:// 拉起小程序并先关掉已在跑的实例)
let reopen = false;
// 抓完是否关闭我们拉起的农场窗口: --reopen 时默认关(2026-11-26 用户要求"打开后要自动关"),
// 手动开的窗口不动; 想留着看画面加 --keep-open
let keepOpen = false;
let jsonOnly = false;
let submit = false;
let cliNoStart = false;
let cliProxy = '';
let cliNoProxyFallback = false;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout') { timeoutMs = Number(argv[++i]) * 1000 || timeoutMs; }
    else if (a.startsWith('--timeout=')) { timeoutMs = Number(a.split('=')[1]) * 1000 || timeoutMs; }
    else if (a === '--reopen' || a === '--trigger') { reopen = true; }
    else if (a === '--no-reopen') { reopen = false; }
    else if (a === '--keep-open' || a === '--no-close') { keepOpen = true; }
    else if (a === '--json') { jsonOnly = true; }
    else if (a === '--submit') { submit = true; }
    else if (a === '--no-start') { cliNoStart = true; }
    else if (a === '--proxy') { cliProxy = argv[++i] || ''; }
    else if (a.startsWith('--proxy=')) { cliProxy = a.split('=')[1] || ''; }
    else if (a === '--no-proxy-fallback') { cliNoProxyFallback = true; }
    else if (a === '-h' || a === '--help') {
        const head = fs.readFileSync(__filename, 'utf8').split('\n');
        const end = head.findIndex((l, idx) => idx > 0 && !l.startsWith(' *') && !l.startsWith('/*'));
        console.log(head.slice(0, end).join('\n').replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
        process.exit(0);
    }
}

function log(msg) { if (!jsonOnly) console.log('[grab-code] ' + msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- 可选本地代理（提交/查询直连不通时用） ----------
// 背景: nc.winxxx.ggff.net 直连偶发 25s 超时（HTTP 000），但经 Clash 混合端口就正常。
// 用法: submit.config.json 里给 "proxy": "http://127.0.0.1:7897"（显式指定），
//       或什么都不用配 —— 直连网络失败时会自动回退到本机常见代理端口（见 PROXY_FALLBACK）。
//       想彻底关掉自动回退: "proxyAutoFallback": false（或环境变量 WX_SUBMIT_PROXY_AUTO=0）
const PROXY_FALLBACK = process.env.WX_SUBMIT_PROXY_FALLBACK || 'http://127.0.0.1:7897';

// 造一个"走 HTTP CONNECT 隧道"的 Agent。
// ⚠️ Base 必须和目标协议一致（https 目标要 extends https.Agent），否则 Node 会报
//    Protocol "https:" not supported. Expected "http:"。https 的 TLS 由我们自己在隧道里做。
function makeProxyAgent(Base, proxyUrl) {
    return class extends Base {
        constructor() { super({ keepAlive: false, maxSockets: 4 }); }
        createConnection(options, cb) {
            let pu;
            try { pu = new URL(proxyUrl); } catch (_) { return cb(new Error('代理 URL 非法: ' + proxyUrl)); }
            const target = options.host + ':' + (options.port || (options.protocol === 'http:' ? 80 : 443));
            const req = http.request({
                host: pu.hostname,
                port: Number(pu.port) || 80,
                method: 'CONNECT',
                path: target,
                headers: { host: target, 'proxy-connection': 'keep-alive' },
                timeout: 10000,
            });
            req.on('connect', (res, socket) => {
                if (res.statusCode !== 200) {
                    socket.destroy();
                    return cb(new Error('代理 CONNECT 失败 HTTP ' + res.statusCode));
                }
                if (options.protocol === 'http:') return cb(null, socket);
                const secure = tls.connect({ socket, servername: options.host }, () => cb(null, secure));
                secure.on('error', cb);
            });
            req.on('error', cb);
            req.on('timeout', () => req.destroy(new Error('代理连接超时')));
            req.end();
        }
    };
}

// 当前生效的代理（null = 直连）。按目标协议各缓存一个 agent 类。
let REQUEST_PROXY = null;
let AGENT_HTTP = null;
let AGENT_HTTPS = null;
function setProxy(proxyUrl) {
    REQUEST_PROXY = proxyUrl || null;
    AGENT_HTTP = REQUEST_PROXY ? new (makeProxyAgent(http.Agent, REQUEST_PROXY))() : null;
    AGENT_HTTPS = REQUEST_PROXY ? new (makeProxyAgent(https.Agent, REQUEST_PROXY))() : null;
}
function agentFor(protocol) {
    if (!REQUEST_PROXY) return undefined;
    return protocol === 'http:' ? AGENT_HTTP : AGENT_HTTPS;
}

function hasRunningFarm() {
    try {
        const out = execFileSync('ps', ['-Ao', 'command='], { timeout: 5000, encoding: 'utf8' });
        return /QQEXMiniProgram/.test(out);
    } catch (_) { return false; }
}

function closeRunningFarm() {
    try { execFileSync('pkill', ['-f', 'QQEXMiniProgram'], { timeout: 5000 }); } catch (_) { /* 无匹配时退出码 1 */ }
}

/**
 * 关掉农场小程序并等它真的退干净。
 * pkill 是异步的, 直接 ps 会抓到还在退出的进程(2026-11-26 实测残留 1 个, 200ms 后才消失),
 * 所以这里补一次 -9 兜底再确认。
 */
async function closeFarmAndWait() {
    closeRunningFarm();
    await sleep(400);
    if (hasRunningFarm()) {
        try { execFileSync('pkill', ['-9', '-f', 'QQEXMiniProgram'], { timeout: 5000 }); } catch (_) { /* 同上 */ }
        await sleep(250);
    }
    return !hasRunningFarm();
}

function fail(msg, detail, code) {
    if (jsonOnly) {
        console.log(JSON.stringify({ ok: false, error: msg, detail: detail || null }));
    } else {
        console.error('[grab-code] ⚠️  ' + msg);
        if (detail) console.error('  ' + detail);
    }
    process.exit(code);
}

// ---------- 抓到后提交到机器人 ----------
const SUBMIT_CONFIG_PATH = process.env.WX_SUBMIT_CONFIG || path.join(__dirname, 'submit.config.json');
// token 缓存：admin token 是**服务端纯内存**的，服务一重启就全失效。
// 缓存 + 401 自动重登，避免每次都要手工换 token。
const TOKEN_CACHE_PATH = process.env.WX_SUBMIT_TOKEN_CACHE || path.join(__dirname, '.admin-token.json');

function loadSubmitConfig() {
    let fileCfg = {};
    try {
        fileCfg = JSON.parse(fs.readFileSync(SUBMIT_CONFIG_PATH, 'utf8'));
    } catch (_) { /* 没配置文件就只认环境变量 */ }
    return {
        mode: process.env.WX_SUBMIT_MODE || fileCfg.mode || 'accounts',
        url: process.env.WX_SUBMIT_URL || fileCfg.url || '',
        accountId: process.env.WX_SUBMIT_ACCOUNT_ID || fileCfg.accountId || '',
        adminToken: process.env.WX_SUBMIT_TOKEN || fileCfg.adminToken || '',
        username: process.env.WX_SUBMIT_USERNAME || fileCfg.username || '',
        password: process.env.WX_SUBMIT_PASSWORD || fileCfg.password || '',
        startIfDown: process.env.WX_SUBMIT_START_IF_DOWN !== undefined
            ? String(process.env.WX_SUBMIT_START_IF_DOWN) !== '0'
            : (fileCfg.startIfDown !== undefined ? !!fileCfg.startIfDown : true),
        // 显式代理（如 'http://127.0.0.1:7897'）；留空 = 先直连，失败再自动回退
        proxy: cliProxy || process.env.WX_SUBMIT_PROXY || fileCfg.proxy || '',
        proxyAutoFallback: cliNoProxyFallback
            ? false
            : (process.env.WX_SUBMIT_PROXY_AUTO !== undefined
                ? String(process.env.WX_SUBMIT_PROXY_AUTO) !== '0'
                : (fileCfg.proxyAutoFallback !== undefined ? !!fileCfg.proxyAutoFallback : true)),
    };
}

function readTokenCache() {
    try {
        const j = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
        if (j && j.token) return j.token;
    } catch (_) { /* 没缓存 */ }
    return '';
}

function writeTokenCache(token) {
    try { fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({ token, ts: Date.now() }), 'utf8'); } catch (_) {}
}

function clearTokenCache() {
    try { fs.unlinkSync(TOKEN_CACHE_PATH); } catch (_) {}
}

// 用 username/password 换一个新 token（服务重启后 token 失效时用）
async function loginForToken(cfg, origin) {
    if (!cfg.username || !cfg.password) {
        return { ok: false, error: '未配置 username/password，无法自动重登（请改用 fresh token 或补上账号密码）' };
    }
    const r = await postJson(origin + '/api/login', { username: cfg.username, password: cfg.password }, {
        'origin': origin,
        'referer': origin + '/',
        'sec-fetch-site': 'same-origin',
    });
    if (!r.ok) return { ok: false, error: '登录失败', status: r.status, body: r.body };
    let token = '';
    try { token = (JSON.parse(r.body).data || {}).token || ''; } catch (_) {}
    if (!token) return { ok: false, error: '登录响应里没有 token', body: r.body };
    writeTokenCache(token);
    return { ok: true, token };
}

function postJson(urlStr, body, extraHeaders) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(urlStr); } catch (_) { return resolve({ ok: false, error: 'URL 非法: ' + urlStr }); }
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        const headers = Object.assign({
            'content-type': 'application/json',
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'content-length': payload.length,
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        }, extraHeaders || {});
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request({
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search,
            method: 'POST',
            headers,
            agent: agentFor(u.protocol),
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                body: text.slice(0, 1500),
            }));
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
        req.write(payload);
        req.end();
    });
}

function getJson(urlStr, extraHeaders) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(urlStr); } catch (_) { return resolve({ ok: false, error: 'URL 非法: ' + urlStr }); }
        const headers = Object.assign({
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        }, extraHeaders || {});
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request({
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search,
            method: 'GET',
            headers,
            agent: agentFor(u.protocol),
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                body: text.slice(0, 1500),
            }));
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
        req.end();
    });
}

// 提交完 code 后：账号若没在跑，`/api/accounts` 只会改 code、不会启动它（要 wasRunning 才 restart）。
// 这里补一步：查 connection.connected，false 就 POST /api/accounts/<id>/start。
async function ensureAccountRunning(cfg, origin, token) {
    if (!cfg.accountId) return { skipped: '未配置 accountId' };
    const auth = { 'x-admin-token': token, 'x-account-id': String(cfg.accountId) };

    const readConnected = async () => {
        const st = await getJson(origin + '/api/status', auth);
        try { return JSON.parse(st.body).data.connection.connected; } catch (_) { return null; }
    };

    let connected = await readConnected();
    if (connected === true) return { checked: true, connected: true, started: false };

    const res = await postJson(origin + '/api/accounts/' + encodeURIComponent(cfg.accountId) + '/start', {}, auth);
    const out = {
        checked: true,
        connected: connected,          // 启动前的状态（false / null=未知）
        started: res.ok,
        status: res.status,
        body: res.body,
        error: res.error,
    };
    // 启动请求在客户端超时，不代表服务端没执行 —— 再查一次真实状态，避免假失败
    if (!res.ok && !res.status) {
        const after = await readConnected();
        if (after === true) {
            out.started = true;
            out.connected = false;
            out.note = '启动请求超时，但复查已在跑';
        }
    }
    return out;
}

// 网络层失败（超时/连不上）≠ 业务报错。用它区分"该换代理重试"和"服务端明确拒绝"。
const isNetworkFailure = (r) => !!r && !r.ok && (r.error || r.status === 0 || r.status === undefined);

// 先直连跑一遍；若网络层失败（提交失败，或提交成功但补启动失败）→ 无显式代理时自动回退本地代理重跑
async function withProxyFallback(cfg, runFn) {
    if (cfg.proxy) setProxy(cfg.proxy);
    let res = await runFn();
    const netFail = isNetworkFailure(res) || isNetworkFailure(res.ensureRunning);
    if (netFail && !cfg.proxy && cfg.proxyAutoFallback && PROXY_FALLBACK) {
        log('直连失败（' + (res.error || (res.ensureRunning && res.ensureRunning.error) || ('HTTP ' + res.status)) +
            '）→ 回退到本地代理 ' + PROXY_FALLBACK);
        setProxy(PROXY_FALLBACK);
        try {
            const r2 = await runFn();
            if (r2.ok) {
                r2.viaProxy = PROXY_FALLBACK;
                res = r2;
            } else {
                res.proxyRetry = { error: r2.error, status: r2.status, proxy: PROXY_FALLBACK };
            }
        } catch (e) {
            res.proxyRetry = { error: e.message, proxy: PROXY_FALLBACK };
        } finally {
            setProxy(null);
        }
    }
    return res;
}

async function submitCode(code) {
    const cfg = loadSubmitConfig();
    if (!cfg.url) return { ok: false, error: '未配置提交接口（' + SUBMIT_CONFIG_PATH + ' 或 WX_SUBMIT_URL）' };
    let origin;
    try { origin = new URL(cfg.url).origin; } catch (_) { return { ok: false, error: 'URL 非法: ' + cfg.url }; }

    const build = (tk) => {
        const headers = {
            'origin': origin,
            'referer': origin + '/settings',
            'sec-fetch-site': 'same-origin',
            'x-account-id': String(cfg.accountId || ''),
        };
        if (tk) headers['x-admin-token'] = tk;
        let targetUrl = cfg.url;
        const body = { code };
        if (cfg.mode === 'accounts') {
            targetUrl = origin + '/api/accounts';
            if (cfg.accountId) body.id = String(cfg.accountId);
        }
        return { targetUrl, body, headers };
    };

    let usedToken = '';
    const attempt = async (tk) => {
        const { targetUrl, body, headers } = build(tk);
        const res = await postJson(targetUrl, body, headers);
        if (res.ok) usedToken = tk;
        return Object.assign({ mode: cfg.mode, url: targetUrl, body, accountId: String(cfg.accountId || '') }, res);
    };

    const runOnce = async () => {
        // 优先用缓存里的 token（比配置里的静态 token 新；静态 token 服务一重启就失效）
        let token = readTokenCache() || cfg.adminToken;
        let res = await attempt(token);

        // token 失效（服务重启会清空内存 token）→ 自动重登拿新 token 再试一次
        const unauthorized = res.status === 401 || /Unauthorized/.test(String(res.body || ''));
        if (unauthorized) {
            clearTokenCache();
            const relogin = await loginForToken(cfg, origin);
            if (relogin.ok) {
                res = await attempt(relogin.token);
                res.relogin = true;
            } else {
                res.reloginFailed = relogin.error + (relogin.status ? ' HTTP ' + relogin.status + ' ' + relogin.body : '');
            }
        }

        // 落库成功后：账号若没在跑，`/api/accounts` 不会启动它（要 wasRunning 才重启）→ 补一步启动
        const startIfDown = !cliNoStart && cfg.startIfDown !== false;
        if (res.ok && cfg.mode === 'accounts' && startIfDown && usedToken) {
            try {
                res.ensureRunning = await ensureAccountRunning(cfg, origin, usedToken);
            } catch (e) {
                res.ensureRunning = { error: e.message };
            }
        }
        return res;
    };

    return await withProxyFallback(cfg, runOnce);
}

(async function main() {
    const miniAppRoot = platform.getMiniAppRoot();
    // _code.txt 落在 miniapp/fs/<uin>/1112386029/usr/ —— 只扫这一小块，
    // 别递归扫整个 QQEX（blob_storage / Cache 一大堆，每次轮询都遍历会很慢）
    const codeFileRoot = path.join(platform.getQqexRoot(), 'miniapp', 'fs');

    if (!jsonOnly) {
        console.log('='.repeat(30));
        log('模式: 协议注入（无需代理）');
        log('缓存目录: ' + miniAppRoot);
        log('最长等待: ' + Math.round(timeoutMs / 1000) + 's');
    }

    let captured = null;
    let patchInfo = null;
    try {
        if (reopen && hasRunningFarm()) {
            log('农场小程序在运行 → 先关掉，保证重新加载注入后的缓存');
            closeRunningFarm();
            await sleep(900);
        } else {
            log('不自动关闭/唤起农场（默认），请自己打开 QQ 农场；注入会在下次加载时生效');
        }

        try { clearCodeFiles(codeFileRoot); } catch (_) { /* 清不掉也无所谓，后面按 mtime 过滤 */ }

        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        let lastNote = 0;
        let attempt = 0;
        const MAX_ATTEMPTS = 3;

        while (!captured && Date.now() < deadline && attempt < MAX_ATTEMPTS) {
            attempt++;
            if (attempt > 1) {
                if (reopen) {
                    log('重试 #' + attempt + '：关掉小程序 → 重新注入 → 再开一次');
                    closeRunningFarm();
                    await sleep(1200);
                } else {
                    log('重试 #' + attempt + '：已重新注入缓存 —— 请手动退出并重进 QQ 农场');
                }
            }

            patchInfo = patchAllGameJs(miniAppRoot);
            if (!patchInfo.ok) {
                fail('未找到可注入的农场 game.js 缓存',
                    '先手动打开一次 QQ 农场（让本机缓存里出现 1112386029_3_* 目录），之后就能一直自动抓了。', 3);
            }
            const patchedCount = patchInfo.patched.length;
            log('已注入嗅探到 ' + patchedCount + ' 个缓存目录' + (attempt > 1 ? '（第 ' + attempt + ' 次尝试）' : ''));

            if (reopen) {
                const opened = openMiniApp();
                if (!opened) {
                    log('⚠️  tencent:// 唤起失败，请手动打开 QQ 农场');
                } else {
                    log('已让 QQ 打开「QQ农场」小程序，等它调 qq.login()...');
                }
            } else {
                log('等待你手动打开 QQ 农场，等它调 qq.login()...');
            }

            // 本轮等待。同时盯着有没有「新的缓存目录」冒出来：
            // 游戏更新时客户端会在启动瞬间下载新版本到新目录并改用它 →
            // 我们注入的旧目录被丢弃 → 白跑。发现新目录就重开一轮，把注入打进新目录。
            const sliceEnd = Math.min(deadline, Date.now() + 30000);
            let nextDirCheck = Date.now() + 3000;
            let sawNewFolder = false;
            while (Date.now() < sliceEnd) {
                const hit = readCodeFiles(codeFileRoot, startedAt - 500);
                if (hit && hit.code) { captured = hit; break; }
                if (Date.now() >= nextDirCheck) {
                    nextDirCheck = Date.now() + 3000;
                    let nowCount = patchedCount;
                    try { nowCount = findTargetFolders(miniAppRoot).length; } catch (_) { /* 数不到就跳过 */ }
                    if (nowCount > patchedCount) { sawNewFolder = true; break; }
                }
                if (!jsonOnly && Date.now() - lastNote > 15000) {
                    lastNote = Date.now();
                    log('等待中... 剩余 ' + Math.round((deadline - Date.now()) / 1000) + 's');
                }
                await sleep(150);
            }

            if (captured) break;
            if (sawNewFolder) log('检测到新的缓存目录（农场更新了新版本）→ 重开一轮，把注入打进新目录');
        }
    } finally {
        try { restoreGameJs(miniAppRoot); } catch (_) { /* 还原失败不阻塞结果 */ }
    }

    if (!captured) {
        fail('超时没抓到 code',
            '排查: 1) QQ 在跑且已登录  2) 农场能被 QQ 正常打开  3) 再跑一次 --timeout 120', 2);
    }

    let submitResult = null;
    if (submit) {
        if (!jsonOnly) log('提交到机器人...');
        submitResult = await submitCode(captured.code);
        if (!jsonOnly) {
            if (submitResult.relogin) log('token 已失效 → 已用账号密码自动重登换取新 token，重试成功');
            if (submitResult.ok) {
                log('提交返回 HTTP ' + submitResult.status + ': ' + submitResult.body);
                const er = submitResult.ensureRunning;
                if (er) {
                    if (er.connected === true) log('账号在跑，无需启动');
                    else if (er.started) log('账号原本没在跑 → 已自动启动（POST /api/accounts/' + submitResult.accountId + '/start）' + (er.note ? '（' + er.note + '）' : ''));
                    else if (er.skipped) log('跳过启动: ' + er.skipped);
                    else log('⚠️  自动启动失败: ' + (er.error || '') + (er.status ? ' HTTP ' + er.status + ' ' + er.body : ''));
                }
            } else {
                log('⚠️  提交失败: ' + (submitResult.error || '') +
                    (submitResult.status ? ' HTTP ' + submitResult.status + ' ' + submitResult.body : ''));
                if (submitResult.reloginFailed) log('  (自动重登也没成: ' + submitResult.reloginFailed + ')');
            }
        }
    }

    // 收尾: --reopen 拉起的小程序抓完就关掉, 别把农场窗口挂在桌面上
    // (2026-11-26 用户反馈"打开小程序后不自动关闭"; 手动打开的窗口不动它, --keep-open 可保留)
    let closedAfter = false;
    if (reopen && !keepOpen) {
        try { closedAfter = await closeFarmAndWait(); } catch (_) { /* 关不掉不影响结果 */ }
        if (!jsonOnly) log(closedAfter ? '已关闭 QQ 农场小程序' : '⚠️  小程序没关掉(可手动 pkill -f QQEXMiniProgram)');
    }

    if (jsonOnly) {
        console.log(JSON.stringify({ ok: true, code: captured.code, file: captured.file, closedAfter, submit: submitResult }));
        process.exit(0);
    }

    console.log('');
    console.log('='.repeat(17) + ' 抓到了 ' + '='.repeat(17));
    console.log('code      : ' + captured.code);
    console.log('写入文件  : ' + captured.file);
    console.log('缓存目录  : ' + (patchInfo && patchInfo.patched[0] ? patchInfo.patched[0].folder : ''));
    console.log('说明      : 来自注入的 qq.login()，' + (closedAfter ? '抓完已自动关闭小程序；' : '小程序保持打开（加 --keep-open 或非 --reopen 模式）；') + 'QQ 复用未过期 code，重复抓同值属正常');
    if (submitResult) {
        console.log('提交接口  : ' + submitResult.url + '  (mode=' + submitResult.mode + ', 账号=' + submitResult.accountId + ')');
        console.log('提交结果  : ' + (submitResult.ok ? 'HTTP ' + submitResult.status + (submitResult.relogin ? '（token 过期已自动重登）' : '') + (submitResult.viaProxy ? '（直连失败，经代理 ' + submitResult.viaProxy + '）' : '')
            : '失败 ' + (submitResult.error || '') + (submitResult.status ? ' HTTP ' + submitResult.status : '') + (submitResult.proxyRetry ? '（代理重试也失败: ' + (submitResult.proxyRetry.error || 'HTTP ' + submitResult.proxyRetry.status) + '）' : '')));
        console.log('响应      : ' + String(submitResult.body || '').slice(0, 800));
        const er = submitResult.ensureRunning;
        if (er) {
            console.log('账号状态  : ' + (er.connected === true ? '在跑（无需启动）'
                : er.started ? '原本没在跑 → 已自动启动' + (er.note ? '（' + er.note + '）' : '')
                : er.skipped ? '跳过（' + er.skipped + '）'
                : '启动失败 ' + (er.error || '') + (er.status ? ' HTTP ' + er.status : '')));
        }
    }
    console.log('='.repeat(45));
    process.exit(0);
})();
