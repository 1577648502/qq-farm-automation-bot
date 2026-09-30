/**
 * 实时 WS 抓包代理 - 逆向新接口用
 *
 * 客户端(小程序/机器人)连本地代理, 代理把流量原样转发到真实网关,
 * 同时把每一帧解成 service.method + 解密后的 body 落盘, 方便逆向新接口。
 *
 *   客户端  ──►  ws://localhost:9012/prod/ws  ──►  wss://gate-obt.nqf.qq.com/prod/ws
 *                     (本代理: 透明转发 + 逐帧解析落盘)
 *
 * 用法:
 *   node scripts/ws-proxy.js                       # 默认监听 9012, 转发到 config 里的 serverUrl
 *   node scripts/ws-proxy.js --port 9012
 *   node scripts/ws-proxy.js --upstream wss://gate-obt.nqf.qq.com/prod/ws
 *   node scripts/ws-proxy.js --out data/ws-capture.jsonl
 *
 * 让客户端连过来:
 *   小程序端把 wss://gate-obt.nqf.qq.com/prod/ws 改成 ws://<本机IP>:9012/prod/ws
 *   (代理会把客户端 URL 上的 query: platform/os/ver/code/openID 原样带给上游)
 *
 * 落盘: 每帧一行 JSON(JSONL), 含方向/meta/body结构, 可直接 grep service_name。
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { Buffer } = require('node:buffer');
const WebSocket = require('ws');
const http = require('node:http');
const { URL } = require('node:url');

const { loadProto } = require('../src/utils/proto');
const { CONFIG } = require('../src/config/config');
const { decodeFrame } = require('./ws-frame-lib');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    }
    return args;
}

function ts() {
    return new Date().toISOString();
}

async function logFrame(direction, raw, outStream) {
    const res = await decodeFrame(raw, { decrypt: true });
    const line = {
        t: ts(),
        dir: direction, // 'C->S' | 'S->C'
        len: raw.length,
    };
    if (!res.ok) {
        line.error = res.error;
        line.rawHex = res.rawHex;
    } else {
        line.meta = res.meta;
        line.decrypted = res.decrypted;
        line.bodyHex = res.bodyHex;
        if (res.fields) line.fields = res.fields;
    }
    outStream.write(`${JSON.stringify(line)}\n`);

    // 控制台简报
    if (res.ok) {
        const m = res.meta;
        const errTag = m.error_code ? ` ERR=${m.error_code}${m.error_message ? '(' + m.error_message + ')' : ''}` : '';
        console.log(`[${direction}] ${m.service_name}.${m.method_name} type=${m.message_type_name} seq=${m.client_seq || m.server_seq}${errTag}`);
    } else {
        console.log(`[${direction}] <解析失败> ${res.error}`);
    }
}

async function main() {
    const args = parseArgs(process.argv);
    const port = Number(args.port) || 9012;
    const upstreamBase = args.upstream || CONFIG.serverUrl; // wss://gate-obt.nqf.qq.com/prod/ws
    const outPath = args.out || path.join(__dirname, '..', 'data', 'ws-capture.jsonl');

    await loadProto();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const outStream = fs.createWriteStream(outPath, { flags: 'a' });

    const server = http.createServer();
    const wss = new WebSocket.Server({ server });

    console.log('==============================================');
    console.log(` WS 抓包代理已启动`);
    console.log(` 监听:   ws://0.0.0.0:${port}`);
    console.log(` 上游:   ${upstreamBase}`);
    console.log(` 落盘:   ${outPath}`);
    console.log(` 客户端把网关地址改为 ws://<本机IP>:${port}<原path> 即可`);
    console.log('==============================================');

    wss.on('connection', (client, req) => {
        // 把客户端请求的 path+query 拼到上游 host 上, 保留 code/platform/os/ver 等参数
        const upstreamUrl = new URL(upstreamBase);
        const incoming = new URL(req.url, 'http://placeholder');
        // 若客户端带了 query 就用客户端的, 否则保留上游默认
        if (incoming.search) upstreamUrl.search = incoming.search;
        // 若客户端 path 与上游不同, 以客户端 path 为准(通常都是 /prod/ws)
        if (incoming.pathname && incoming.pathname !== '/') upstreamUrl.pathname = incoming.pathname;

        console.log(`\n[+] 客户端接入: ${req.socket.remoteAddress}  ->  ${upstreamUrl.toString()}`);

        const upstream = new WebSocket(upstreamUrl.toString(), {
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
                'Origin': 'https://gate-obt.nqf.qq.com',
            },
        });
        upstream.binaryType = 'arraybuffer';

        const clientQueue = [];
        let upstreamOpen = false;

        upstream.on('open', () => {
            upstreamOpen = true;
            for (const buf of clientQueue) upstream.send(buf);
            clientQueue.length = 0;
        });

        // 客户端 -> 上游
        client.on('message', (data) => {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            logFrame('C->S', buf, outStream).catch(() => {});
            if (upstreamOpen) upstream.send(buf);
            else clientQueue.push(buf);
        });

        // 上游 -> 客户端
        upstream.on('message', (data) => {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            logFrame('S->C', buf, outStream).catch(() => {});
            if (client.readyState === WebSocket.OPEN) client.send(buf);
        });

        const closeBoth = (who, code, reason) => {
            console.log(`[-] ${who} 关闭 (code=${code}) ${reason || ''}`);
            try { client.close(); } catch {}
            try { upstream.close(); } catch {}
        };
        client.on('close', (c, r) => closeBoth('客户端', c, r));
        upstream.on('close', (c, r) => closeBoth('上游', c, r));
        client.on('error', (e) => console.log(`[!] 客户端错误: ${e.message}`));
        upstream.on('error', (e) => console.log(`[!] 上游错误: ${e.message}`));
    });

    server.listen(port);
    process.on('SIGINT', () => {
        console.log('\n正在关闭代理...');
        outStream.end();
        server.close(() => process.exit(0));
    });
}

main().catch((e) => {
    console.error('代理启动失败:', e);
    process.exit(1);
});
