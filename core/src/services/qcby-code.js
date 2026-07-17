/**
 * qcby-vxcode 取 code 客户端
 *
 * 通过 qcby-vxcode（微信协议 API 服务）获取「经典农场」小程序登录 code：
 *   - mywc 协议（默认，公开无鉴权）：GET /mywc?wxid=<wxid>&appId=<appId>
 *   - vx   协议：POST /api/Wxapp/JSLogin   body { Appid, Wxid }
 *   - yyb  协议：POST /api/Yyb/GetCode     body { ref, app_id, tcp_proxy, payload }
 *
 * 返回统一信封 { Code, Success, Message, Data }，code 位于 Data 中；不同版本字段名
 * 可能不同，这里用可配置 codePath + 多字段/深度兜底提取，保证鲁棒。
 */
const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 20000;
const CODE_RE = /^[A-Za-z0-9_+/=%.-]{6,512}$/;
// 优先匹配这些字段名（小写比较）
const PREFERRED_CODE_KEYS = ['code', 'authcode', 'auth_code', 'jscode', 'js_code', 'logincode', 'login_code'];

function isLikelyCode(value) {
    const s = String(value == null ? '' : value).trim();
    return CODE_RE.test(s);
}

function joinUrl(baseUrl, pathname) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const suffix = String(pathname || '');
    return base + (suffix.startsWith('/') ? suffix : '/' + suffix);
}

function getByPath(obj, dottedPath) {
    if (!dottedPath) return undefined;
    return String(dottedPath).split('.').reduce((node, key) => {
        if (node == null) return undefined;
        return node[key];
    }, obj);
}

/**
 * 从响应中提取 code：
 *   1) 若指定 codePath（如 "Data.Code"）优先使用
 *   2) 否则在 Data（无则整个响应）中：优先命中 code 类字段名，再退化为深度搜索首个 code 形态字符串
 */
function extractCode(resp, codePath) {
    if (resp == null) return '';

    if (codePath) {
        const direct = getByPath(resp, codePath);
        if (isLikelyCode(direct)) return String(direct).trim();
    }

    const root = resp && Object.prototype.hasOwnProperty.call(resp, 'Data') ? resp.Data : resp;

    if (typeof root === 'string') {
        return isLikelyCode(root) ? root.trim() : '';
    }
    if (root == null || typeof root !== 'object') return '';

    // 1) 优先命中 code 类字段名（广度优先）
    const queue = [root];
    const seen = new Set();
    while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        for (const key of Object.keys(node)) {
            const val = node[key];
            if (typeof val === 'string' && PREFERRED_CODE_KEYS.includes(key.toLowerCase()) && isLikelyCode(val)) {
                return val.trim();
            }
            if (val && typeof val === 'object') queue.push(val);
        }
    }

    // 2) 深度搜索首个 code 形态字符串（排除明显的 url/host 值）
    const stack = [root];
    const seen2 = new Set();
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object' || seen2.has(node)) continue;
        seen2.add(node);
        for (const key of Object.keys(node)) {
            const val = node[key];
            if (typeof val === 'string' && isLikelyCode(val) && !/^https?:/i.test(val) && !val.includes('.')) {
                return val.trim();
            }
            if (val && typeof val === 'object') stack.push(val);
        }
    }

    return '';
}

function buildAuthHeaders(authHeader) {
    const headers = {};
    const raw = String(authHeader || '').trim();
    if (!raw) return headers;
    // 支持 "Header-Name: value" 形式；否则按 Cookie 处理
    const idx = raw.indexOf(':');
    if (idx > 0) {
        headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    } else {
        headers.Cookie = raw;
    }
    return headers;
}

/**
 * 拉取一次农场 code。
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, status?:number, raw?:any}>}
 */
async function fetchFarmCode(options = {}) {
    const {
        baseUrl,
        protocol = 'mywc',
        wxid = '',
        ref = '',
        appid = '',
        tcpProxy = '',
        payload = {},
        authHeader = '',
        codePath = '',
        timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;

    if (!baseUrl) return { ok: false, reason: 'missing_base_url' };
    if (!appid) return { ok: false, reason: 'missing_appid' };

    const proto = String(protocol).toLowerCase();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, buildAuthHeaders(authHeader));

    let reqConfig;
    if (proto === 'yyb') {
        const refId = String(ref || wxid || '').trim();
        if (!refId) return { ok: false, reason: 'missing_ref' };
        reqConfig = {
            method: 'post',
            url: joinUrl(baseUrl, '/api/Yyb/GetCode'),
            data: { ref: refId, app_id: appid, tcp_proxy: tcpProxy || '', payload: payload || {} },
        };
    } else if (proto === 'vx') {
        const id = String(wxid || '').trim();
        if (!id) return { ok: false, reason: 'missing_wxid' };
        reqConfig = {
            method: 'post',
            url: joinUrl(baseUrl, '/api/Wxapp/JSLogin'),
            data: { Appid: appid, Wxid: id },
        };
    } else {
        // 默认：公开无鉴权接口 GET /mywc?wxid=<wxid>&appId=<appId>
        const id = String(wxid || ref || '').trim();
        if (!id) return { ok: false, reason: 'missing_wxid' };
        reqConfig = {
            method: 'get',
            url: joinUrl(baseUrl, '/mywc'),
            params: { wxid: id, appId: appid },
        };
    }

    let res;
    try {
        res = await axios(Object.assign(reqConfig, { headers, timeout: timeoutMs, validateStatus: () => true }));
    } catch (err) {
        return { ok: false, reason: 'request_failed:' + (err && err.message ? err.message : String(err)) };
    }

    let data = res && res.data;
    // 若接口以文本返回 JSON 字符串，尝试解析以便统一提取
    if (typeof data === 'string') {
        const trimmed = data.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { data = JSON.parse(trimmed); } catch (_) { /* 保持原始字符串 */ }
        }
    }

    if (data && typeof data === 'object' && Number(data.Code) === -401) {
        return { ok: false, reason: 'not_activated', status: res.status, raw: data };
    }
    if (res && res.status >= 400) {
        return { ok: false, reason: 'http_' + res.status, status: res.status, raw: data };
    }

    const code = extractCode(data, codePath);
    if (!code) {
        return { ok: false, reason: 'no_code_in_response', status: res && res.status, raw: data };
    }
    return { ok: true, code, status: res && res.status, raw: data };
}

module.exports = {
    fetchFarmCode,
    extractCode,
    isLikelyCode,
    joinUrl,
};
