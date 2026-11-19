#!/usr/bin/env node
/**
 * 同步牧场动物配置(MCAnimalConfig) —— 官方 mcRes bundle 里的 mcconfig/MCAnimalConfig
 *
 * 为什么需要它:
 *   牧场分析页的四项指标(经验/时、普通肥经验/时、净利/时、普通肥净利/时)
 *   全都要"完整周期", 而 ItemInfo/Plant.json 里**没有**任何牧场的时长字段。
 *   唯一的一手来源是客户端 mcRes bundle 的 MCAnimalConfig(28 种动物,
 *   带 infant_sec / grow_sec / mature_sec / product_round_sec / harvest_exp …)。
 *
 * 它不在 delayRes 里, 所以原来的 sync-game-config(只同步 ItemInfo/Plant)拿不到。
 *
 * 用法:
 *   node core/scripts/sync-animal-config.js                 # 自动探测 CDN 上的 config 地址
 *   node core/scripts/sync-animal-config.js <config.json URL>  # 指定 bundle config
 *
 * 输出: core/src/gameConfig/MCAnimalConfig.json (+ data/gameConfig/ 副本)
 *
 * 结构(Cocos bundle):
 *   config.<hash>.json  → { uuids:[], paths:{ "<idx>": ["mcconfig/MCAnimalConfig", ...] },
 *                            versions:{ import:[idx, ver, ...] } }
 *   资产地址 = <bundle>/import/<uuid前2位>/<uuid>.<ver>.json
 *   JSON 是 Cocos JsonAsset 的序列化格式: [..., [[0,"MCAnimalConfig",[rows]]], ...]
 */
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX_KEYS = '0123456789abcdef';

const CDN_ROOT = 'https://cdn-resource.nqf.qq.com/release/remote/mcRes/';
// 抓包见过的两个 config 版本(20261119); 探测不到就用最新的这个
const KNOWN_CONFIGS = ['config.a93d7.json', 'config.7725a.json'];

const OUT_BUNDLED = path.join(__dirname, '..', 'src', 'gameConfig', 'MCAnimalConfig.json');
const OUT_DATA = path.join(__dirname, '..', 'data', 'gameConfig', 'MCAnimalConfig.json');

function get(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 20000 }, (res) => {
            const status = Number(res.statusCode) || 0;
            if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
                res.resume();
                resolve(get(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
                return;
            }
            if (status !== 200) {
                res.resume();
                reject(new Error(`HTTP ${status}: ${url}`));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('timeout', () => req.destroy(new Error(`超时: ${url}`)));
        req.on('error', reject);
    });
}

function decompressUuid(compressed) {
    const text = String(compressed || '');
    if (text.length !== 22) return text.split('@')[0];
    let hex = text.slice(0, 2);
    for (let i = 2; i < 22; i += 2) {
        const left = BASE64_KEYS.indexOf(text[i]);
        const right = BASE64_KEYS.indexOf(text[i + 1]);
        if (left < 0 || right < 0) return text;
        hex += HEX_KEYS[left >> 2];
        hex += HEX_KEYS[((left & 3) << 2) | (right >> 4)];
        hex += HEX_KEYS[right & 15];
    }
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function importUrl(config, configUrl, assetPath) {
    const entry = Object.entries(config.paths || {}).find(([, v]) => Array.isArray(v) && v[0] === assetPath);
    if (!entry) throw new Error(`bundle 里没有 ${assetPath}`);
    const idx = Number(entry[0]);
    const uuid = decompressUuid(config.uuids && config.uuids[idx]);
    const versions = (config.versions && config.versions.import) || [];
    let ver = '';
    for (let i = 0; i < versions.length; i += 2) {
        if (Number(versions[i]) === idx) ver = String(versions[i + 1] || '');
    }
    const url = new URL(configUrl);
    url.pathname = url.pathname.replace(/config\.[^/]+\.json$/, '');
    return new URL(`import/${uuid.slice(0, 2)}/${uuid}.${ver}.json`, url).toString();
}

/** Cocos JsonAsset 序列化格式 → rows */
function decodeRows(serialized, expectedName) {
    const candidates = Array.isArray(serialized) ? serialized : [];
    for (const block of candidates) {
        if (!Array.isArray(block)) continue;
        for (const row of block) {
            if (Array.isArray(row) && row[1] === expectedName && Array.isArray(row[2])) return row[2];
        }
    }
    throw new Error(`${expectedName} JsonAsset 里没找到配置数组`);
}

async function findConfigUrl() {
    for (const name of KNOWN_CONFIGS) {
        const url = new URL(name, CDN_ROOT).toString();
        try {
            const body = await get(url);
            const cfg = JSON.parse(body);
            if (Array.isArray(cfg.paths) || cfg.paths) return { url, config: cfg };
        } catch { /* 换下一个 */ }
    }
    throw new Error('无法获取 mcRes bundle config(网络不通或版本号变了)');
}

async function main() {
    const argUrl = process.argv[2];
    let configUrl = '';
    let config = null;
    if (argUrl) {
        configUrl = argUrl;
        config = JSON.parse(await get(argUrl));
    } else {
        const found = await findConfigUrl();
        configUrl = found.url;
        config = found.config;
    }

    const assetUrl = importUrl(config, configUrl, 'mcconfig/MCAnimalConfig');
    const serialized = JSON.parse(await get(assetUrl));
    const rows = decodeRows(serialized, 'MCAnimalConfig');
    if (!Array.isArray(rows) || rows.length < 10) {
        throw new Error(`MCAnimalConfig 行数异常: ${Array.isArray(rows) ? rows.length : 'not-array'}`);
    }

    const payload = `${JSON.stringify(rows, null, 4)}\n`;
    for (const out of [OUT_BUNDLED, OUT_DATA]) {
        try {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, payload);
            console.log(`已写入 ${out} (${rows.length} 种动物)`);
        } catch (e) {
            console.warn(`写入 ${out} 失败: ${e.message}`);
        }
    }
    const sample = rows.find(r => Number(r.id) === 60001) || rows[0];
    console.log(`来源: ${assetUrl}`);
    console.log(`示例: ${sample.name} 幼崽${sample.infant_sec}s + 成长${sample.grow_sec}s + 成熟${sample.mature_sec}s`);
}

main().catch((e) => {
    console.error(`同步失败: ${e.message}`);
    process.exit(1);
});