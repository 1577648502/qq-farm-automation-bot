/**
 * WS 帧解析共享库 - 被 parse-ws-frame.js 与 ws-proxy.js 复用
 *
 * 职责: 把 gatepb.Message 帧解成 { meta, body(解密后), fields(通用结构) }
 */

const { Buffer } = require('node:buffer');
const protobuf = require('protobufjs');

const { types } = require('../src/utils/proto');
const cryptoWasm = require('../src/utils/crypto-wasm');

const TYPE_NAMES = { 0: 'None', 1: 'Request', 2: 'Response', 3: 'Notify' };
const WIRE_NAMES = { 0: 'varint', 1: 'fixed64', 2: 'len', 5: 'fixed32' };

function tryUtf8(bytes) {
    if (bytes.length === 0) return '';
    const str = Buffer.from(bytes).toString('utf8');
    if (/^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(str) && !str.includes('\uFFFD')) {
        return str;
    }
    return null;
}

/** 通用 protobuf 结构 dump: 无需 .proto 定义, 只按 wire type 拆字段 */
function rawDecode(buf, depth = 0) {
    const reader = protobuf.Reader.create(buf);
    const out = [];
    const indent = '  '.repeat(depth + 1);
    while (reader.pos < reader.len) {
        let tag;
        try {
            tag = reader.uint64();
        } catch {
            break;
        }
        const fieldNo = Math.floor(Number(tag) / 8);
        const wire = Number(tag) & 7;
        try {
            if (wire === 0) {
                out.push(`${indent}#${fieldNo} (varint): ${reader.uint64().toString()}`);
            } else if (wire === 1) {
                out.push(`${indent}#${fieldNo} (fixed64): ${reader.fixed64().toString()}`);
            } else if (wire === 5) {
                out.push(`${indent}#${fieldNo} (fixed32): ${reader.fixed32()}`);
            } else if (wire === 2) {
                const bytes = reader.bytes();
                const asStr = tryUtf8(bytes);
                let nested = null;
                if (bytes.length > 0 && depth < 6) {
                    try {
                        const inner = rawDecode(Buffer.from(bytes), depth + 1);
                        if (inner.length) nested = inner.join('\n');
                    } catch { /* not a message */ }
                }
                if (nested) {
                    out.push(`${indent}#${fieldNo} (message, ${bytes.length}B):\n${nested}`);
                } else if (asStr !== null) {
                    out.push(`${indent}#${fieldNo} (string): "${asStr}"`);
                } else {
                    out.push(`${indent}#${fieldNo} (bytes, ${bytes.length}B): ${Buffer.from(bytes).toString('hex')}`);
                }
            } else {
                out.push(`${indent}#${fieldNo} (unknown wire=${wire})`);
                break;
            }
        } catch (e) {
            out.push(`${indent}#${fieldNo} (${WIRE_NAMES[wire] || wire}) <解析失败: ${e.message}>`);
            break;
        }
    }
    return out;
}

/**
 * 解析一帧 gatepb.Message
 * @param {Buffer} frame 原始帧字节
 * @param {object} opts { decrypt=true, typeName?, raw=false }
 * @returns {Promise<object>} { ok, meta, bodyHex, decrypted, decodedByType?, fields?, error? }
 */
async function decodeFrame(frame, opts = {}) {
    const { decrypt = true, typeName = null, raw = false } = opts;
    let msg;
    try {
        msg = types.GateMessage.decode(frame);
    } catch (e) {
        return { ok: false, error: `GateMessage 解码失败: ${e.message}`, rawHex: Buffer.from(frame).toString('hex') };
    }

    const m = msg.meta || {};
    const meta = {
        service_name: m.service_name || '',
        method_name: m.method_name || '',
        message_type: m.message_type,
        message_type_name: TYPE_NAMES[m.message_type] || '?',
        client_seq: m.client_seq != null ? m.client_seq.toString() : '',
        server_seq: m.server_seq != null ? m.server_seq.toString() : '',
        error_code: m.error_code != null ? Number(m.error_code.toString()) : 0,
        error_message: m.error_message || '',
    };

    const result = { ok: true, meta };

    let body = msg.body && msg.body.length ? Buffer.from(msg.body) : Buffer.alloc(0);
    if (body.length === 0) {
        result.bodyHex = '';
        result.decrypted = false;
        return result;
    }

    // Notify(message_type=3) 的 body 不加密, 是 gatepb.EventMessage 外壳(message_type 字符串 + 内层 body)
    if (m.message_type === 3) {
        result.decrypted = false;
        try {
            const event = types.EventMessage.decode(body);
            result.notifyType = event.message_type || '';
            const inner = event.body && event.body.length ? Buffer.from(event.body) : Buffer.alloc(0);
            result.bodyHex = inner.toString('hex');
            result.fields = inner.length ? rawDecode(inner) : [];
        } catch (e) {
            result.notifyDecodeError = e.message;
            result.bodyHex = body.toString('hex');
            result.fields = rawDecode(body);
        }
        return result;
    }

    // 只有请求(message_type=1)的 body 是加密的; 响应(2)是明文, 直接解析。
    // (依据: network.js encodeMsg 对请求 body 做 encryptBuffer, 而 handleMessage 对响应 body 不解密直接 decode)
    result.decrypted = false;
    if (decrypt && m.message_type === 1) {
        try {
            body = await cryptoWasm.decryptBuffer(body);
            result.decrypted = true;
        } catch (e) {
            result.decryptError = e.message;
        }
    }
    result.bodyHex = body.toString('hex');

    if (typeName && !raw) {
        const T = types[typeName];
        if (T) {
            try {
                result.decodedByType = T.toObject(T.decode(body), { longs: String, defaults: true });
                result.typeName = typeName;
                return result;
            } catch (e) {
                result.typeDecodeError = e.message;
            }
        } else {
            result.typeNotFound = typeName;
        }
    }

    result.fields = rawDecode(body);
    return result;
}

module.exports = { decodeFrame, rawDecode, TYPE_NAMES };
