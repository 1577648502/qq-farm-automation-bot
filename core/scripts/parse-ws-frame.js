/**
 * WS 帧解析工具 - 逆向抓包辅助
 *
 * 把捕获到的 WebSocket 帧(gatepb.Message)解成:
 *   service_name.method_name + 解密后的 body 结构
 *
 * 用法:
 *   node scripts/parse-ws-frame.js --hex <hexstring>
 *   node scripts/parse-ws-frame.js --b64 <base64string>
 *   node scripts/parse-ws-frame.js --file <path/to/frame.bin>
 *   echo <hexstring> | node scripts/parse-ws-frame.js        # 从 stdin 读 hex
 *
 * 可选:
 *   --type <TypeName>   用 proto.js 里已注册的类型精确解码 body(如 GetEmailListReply)
 *   --raw               只做通用字段 dump, 不尝试已知类型
 *   --no-decrypt        body 不走 WASM 解密(用于本身就是明文的场景)
 */

const fs = require('node:fs');
const { Buffer } = require('node:buffer');
const process = require('node:process');

const { loadProto } = require('../src/utils/proto');
const { decodeFrame } = require('./ws-frame-lib');

function parseArgs(argv) {
    const args = { flags: {} };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--raw' || a === '--no-decrypt') {
            args.flags[a.slice(2)] = true;
        } else if (a.startsWith('--')) {
            args[a.slice(2)] = argv[++i];
        }
    }
    return args;
}

function readInput(args) {
    if (args.hex) return Buffer.from(args.hex.replace(/\s+/g, ''), 'hex');
    if (args.b64) return Buffer.from(args.b64, 'base64');
    if (args.file) return fs.readFileSync(args.file);
    // stdin
    const data = fs.readFileSync(0);
    const text = data.toString('utf8').trim();
    if (/^[0-9a-fA-F\s]+$/.test(text)) return Buffer.from(text.replace(/\s+/g, ''), 'hex');
    return data;
}

async function main() {
    const args = parseArgs(process.argv);
    await loadProto();

    const frame = readInput(args);
    if (!frame || frame.length === 0) {
        console.error('未读取到帧数据。用 --hex/--b64/--file 或从 stdin 传入。');
        process.exit(1);
    }

    const res = await decodeFrame(frame, {
        decrypt: !args.flags['no-decrypt'],
        typeName: args.type,
        raw: !!args.flags.raw,
    });

    if (!res.ok) {
        console.error(res.error);
        if (res.rawHex) console.error('原始 hex:', res.rawHex);
        process.exit(1);
    }

    const meta = res.meta;
    console.log('===== Meta (路由信息, 明文) =====');
    console.log(`service_name : ${meta.service_name}`);
    console.log(`method_name  : ${meta.method_name}`);
    console.log(`message_type : ${meta.message_type} (${meta.message_type_name})`);
    console.log(`client_seq   : ${meta.client_seq}`);
    console.log(`server_seq   : ${meta.server_seq}`);
    if (meta.error_code !== 0) {
        console.log(`error_code   : ${meta.error_code}`);
        console.log(`error_message: ${meta.error_message}`);
    }

    console.log(`\n===== Body =====`);
    if (!res.bodyHex) {
        console.log('(空)');
        return;
    }
    if (res.decrypted) console.log('(已用 WASM 解密)');
    else if (res.decryptError) console.log(`(解密失败, 按原始字节处理: ${res.decryptError})`);
    console.log('hex:', res.bodyHex);

    if (res.typeNotFound) {
        console.log(`\n[!] proto.js 未注册类型 "${res.typeNotFound}", 已回退到通用 dump。`);
    }
    if (res.typeDecodeError) {
        console.log(`\n[!] 用 ${args.type} 解码失败: ${res.typeDecodeError}, 已回退到通用 dump。`);
    }

    if (res.decodedByType) {
        console.log(`\n===== 精确解码 (${res.typeName}) =====`);
        console.log(JSON.stringify(res.decodedByType, null, 2));
        return;
    }

    console.log('\n===== 通用字段结构 (无需 .proto) =====');
    console.log(res.fields && res.fields.length ? res.fields.join('\n') : '(无法按 protobuf 解析)');
}

main().catch((e) => {
    console.error('执行出错:', e);
    process.exit(1);
});
