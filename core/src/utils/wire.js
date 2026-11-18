/**
 * 裸 protobuf wire 解析 —— 不依赖任何 .proto 定义
 *
 * 用途: 抓包/运行期协议观察器要知道"这一帧有哪些字段号、wire type、嵌套形状"。
 * 有 .proto 时当然用 .proto 解; 但新活动接口往往还没有 .proto,
 * 这时只能按 wire 规则走一遍, 靠"字段结构指纹"跨版本对比来自动发现新东西。
 *
 * 约定:
 *   - 数字一律 Number(不用 Long), 上限 2^53 足够覆盖游戏里的 id/时间戳
 *   - 解析失败不抛错, 返回 { fields, error }, 让上层决定记日志还是忽略
 */
const FIXED64 = 1;
const LEN = 2;
const FIXED32 = 5;

/** 读 varint; 超过 10 字节或越界抛错 */
function readVarint(buf, pos) {
    let result = 0;
    let shift = 0;
    let i = pos;
    while (i < buf.length) {
        const b = buf[i++];
        result += (b & 0x7F) * 2 ** shift;
        if ((b & 0x80) === 0) return { value: result, pos: i };
        shift += 7;
        if (shift > 63) throw new Error('varint too long');
    }
    throw new Error('varint truncated');
}

/** 能不能当 UTF-8 文本读(用于区分 string 与内嵌 message / bytes) */
function asText(bytes) {
    if (!bytes || bytes.length === 0) return null;
    let str;
    try {
        str = Buffer.from(bytes).toString('utf8');
    } catch {
        return null;
    }
    if (str.includes('�')) return null;
    // 控制字符(除 \t \n \r)视为二进制
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x09 || (c > 0x0D && c < 0x20)) return null;
    }
    return str;
}

/**
 * 解析一层 protobuf
 * @param {Buffer} buf
 * @returns {{ fields: Array<{no:number, wire:number, value?:number, bytes?:Buffer}>, error?: string }} 字段列表; 解析中途失败时带 error
 */
function parseFields(buf) {
    const fields = [];
    if (!buf || buf.length === 0) return { fields };
    let pos = 0;
    try {
        while (pos < buf.length) {
            const tag = readVarint(buf, pos);
            pos = tag.pos;
            const no = Math.floor(tag.value / 8);
            const wire = tag.value % 8;
            if (no === 0) return { fields, error: 'field 0' };
            if (wire === 0) {
                const v = readVarint(buf, pos);
                pos = v.pos;
                fields.push({ no, wire, value: v.value });
            } else if (wire === LEN) {
                const len = readVarint(buf, pos);
                pos = len.pos;
                if (len.value < 0 || pos + len.value > buf.length) {
                    return { fields, error: 'length overflow' };
                }
                fields.push({ no, wire, bytes: Buffer.from(buf.subarray(pos, pos + len.value)) });
                pos += len.value;
            } else if (wire === FIXED32) {
                if (pos + 4 > buf.length) return { fields, error: 'fixed32 truncated' };
                fields.push({ no, wire, bytes: Buffer.from(buf.subarray(pos, pos + 4)) });
                pos += 4;
            } else if (wire === FIXED64) {
                if (pos + 8 > buf.length) return { fields, error: 'fixed64 truncated' };
                fields.push({ no, wire, bytes: Buffer.from(buf.subarray(pos, pos + 8)) });
                pos += 8;
            } else {
                return { fields, error: `unknown wire ${wire}` };
            }
        }
    } catch (e) {
        return { fields, error: e.message };
    }
    return { fields };
}

/** 该 bytes 能不能当一层 protobuf 继续拆(至少解出 1 个字段且无错误) */
function looksLikeMessage(bytes) {
    if (!bytes || bytes.length < 2) return false;
    const r = parseFields(bytes);
    return !r.error && r.fields.length > 0;
}

/**
 * 结构指纹: 递归把字段树走成 "1:0/2:2/2.1:0" 这样的路径集合。
 * 只记字段号和 wire type, 不记具体值 —— 这样跨账号、跨时间可比,
 * 出现新路径 = 服务端协议结构变了(新玩法 / 新字段), 正好是我们想自动发现的。
 *
 * @param {Buffer} buf
 * @param {{depth?:number, maxNodes?:number}} [opts]
 * @returns {{ paths: string[], truncated: boolean, error?: string }} 形如 `1.2:0` 的路径集合
 */
function footprint(buf, opts = {}) {
    const maxDepth = Number.isFinite(opts.depth) ? opts.depth : 6;
    const maxNodes = Number.isFinite(opts.maxNodes) ? opts.maxNodes : 400;
    const paths = new Set();
    let truncated = false;
    let firstError = '';

    function walk(bytes, prefix, depth) {
        if (depth > maxDepth) { truncated = true; return; }
        const r = parseFields(bytes);
        if (r.error && !firstError) firstError = r.error;
        for (const f of r.fields) {
            const key = `${prefix}${prefix ? '.' : ''}${f.no}`;
            paths.add(`${key}:${f.wire}`);
            if (paths.size > maxNodes) { truncated = true; return; }
            if (f.wire === LEN && f.bytes && asText(f.bytes) === null && looksLikeMessage(f.bytes)) {
                walk(f.bytes, key, depth + 1);
            }
        }
    }

    walk(buf, '', 0);
    return {
        paths: [...paths].sort(),
        truncated,
        error: firstError || undefined,
    };
}

/**
 * 字段树 → 可读文本(给面板/命令行看, 类似 ws-capture-decode 的 fields)
 * @param {Buffer} buf
 * @param {{depth?:number, indent?:string}} [opts]
 * @returns {string[]} 逐行可读的字段树
 */
function describe(buf, opts = {}) {
    const maxDepth = Number.isFinite(opts.depth) ? opts.depth : 4;
    const out = [];
    const baseIndent = opts.indent || '';

    function walk(bytes, depth) {
        const r = parseFields(bytes);
        const pad = `${baseIndent}${'  '.repeat(depth + 1)}`;
        for (const f of r.fields) {
            if (f.wire === 0) {
                out.push(`${pad}#${f.no} = ${f.value}`);
                continue;
            }
            if (f.wire === FIXED32) { out.push(`${pad}#${f.no} (fixed32) = ${f.bytes.readFloatLE(0)}`); continue; }
            if (f.wire === FIXED64) { out.push(`${pad}#${f.no} (fixed64) = ${f.bytes.readDoubleLE(0)}`); continue; }
            const txt = asText(f.bytes);
            if (txt !== null && txt.length <= 400) {
                out.push(`${pad}#${f.no} = ${JSON.stringify(txt)}`);
            } else if (depth < maxDepth && looksLikeMessage(f.bytes)) {
                out.push(`${pad}#${f.no} (${f.bytes.length}B):`);
                walk(f.bytes, depth + 1);
            } else if (txt !== null) {
                out.push(`${pad}#${f.no} (${f.bytes.length}B text) = ${JSON.stringify(txt.slice(0, 200))}…`);
            } else {
                out.push(`${pad}#${f.no} (${f.bytes.length}B) = ${f.bytes.subarray(0, 32).toString('hex')}${f.bytes.length > 32 ? '…' : ''}`);
            }
        }
        if (r.error) out.push(`${pad}<${r.error}>`);
    }

    walk(buf, 0);
    return out;
}

/** 递归抽所有可读字符串(活动规则文案、JSON 配置常藏在这里) */
function collectStrings(buf, opts = {}) {
    const maxDepth = Number.isFinite(opts.depth) ? opts.depth : 8;
    const minLen = Number.isFinite(opts.minLen) ? opts.minLen : 2;
    const found = new Set();

    function walk(bytes, depth) {
        if (depth > maxDepth) return;
        for (const f of parseFields(bytes).fields) {
            if (f.wire !== LEN || !f.bytes) continue;
            const txt = asText(f.bytes);
            if (txt !== null) {
                if (txt.length >= minLen) found.add(txt);
                // 文本块里可能内嵌 JSON, 整串已经收进来了
            } else if (looksLikeMessage(f.bytes)) {
                walk(f.bytes, depth + 1);
            }
        }
    }

    walk(buf, 0);
    return [...found];
}

module.exports = {
    parseFields,
    footprint,
    describe,
    collectStrings,
    asText,
    looksLikeMessage,
};
