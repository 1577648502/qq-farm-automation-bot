/**
 * 看广告礼包 —— 跳过广告直接领取（每日 1 次的化肥礼包）
 *
 * ════════ 抓包实证 (2026-09-29, 20260929-102536_商城看广告购买化肥) ════════
 * 客户端原本的流程(上行解密后逐帧确认):
 *   GetAdUnits(空)                    → [{ unit_id: 10001, unit_key: "adunit-1e518c6aa22122d3" }]
 *   RequestAd { unit_id: 10001 }      → { token: 32字节, ad_payload: 116B(base64 JSON), field4: 1 }
 *   （客户端播放广告 —— 服务端不校验这一步）
 *   ReportAd  { token, result: 0 }    → { result: 1 }        ← 服务端据此发奖
 *   → ItemNotify: 化肥(1小时) 80001 ×5
 *   → AdPurchasedNotify: { goods_id: 1052(看广告礼包), count: 1, item: {80001, 5} }
 *
 * ⚠ 2026-09-29 更正(实测踩到): ReportAd 离 RequestAd 太近会报
 *   `1044006 广告未观看完成，无法获得奖励` —— **服务端确实会校验"广告是否看完"**
 *   (要么看广告平台回调, 要么看时间间隔)。两次抓包里 RequestAd → ReportAd 分别是
 *   **33.4s / 32.7s**(就是一段 30 秒激励视频) → 本实现默认**等满 32s 再上报**, 失败再等一会重试。
 *   若这样仍报 1044006, 说明服务端等的是广告平台回调(S2S), 机器人无法伪造 → 该功能只能关闭。
 *
 * 每日次数以**接口为准**: 商城商品 1052 的限购信息(#7 = {周期, 已购, 上限}, 每日 1 次),
 * 已领过就不再请求(避免无谓的广告接口调用)。
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum, sleep } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');

/** 当前登录用的客户端版本(服务端会按它限制功能; 版本过旧会得到各种奇怪错误码) */
function currentClientVersion() {
    try {
        // ⚠ 模块导出的是 { CONFIG, ... } 对象, 必须解构(直接 require 出来的是模块本身)
        const { CONFIG } = require('../config/config');
        return String((CONFIG && CONFIG.clientVersion) || '');
    } catch (e) { return ''; }
}

const AD_SERVICE = 'gamepb.iaapb.IaaService';
const DEFAULT_UNIT_ID = 10001;      // 实测: 看广告礼包用的广告位
/** 请求广告之后等多久再上报完成: 实测客户端 32.7~33.4s(30 秒激励视频), 可用 FARM_AD_WATCH_MS 覆盖 */
const AD_WATCH_MS = Math.max(0, Number(process.env.FARM_AD_WATCH_MS || 32000));
const AD_REPORT_RETRY = 2;              // 1044006(未看完) 时再等一会重试几次
const AD_REPORT_RETRY_WAIT_MS = 8000;
const AD_GOODS_ID = 1052;           // 商城里的「看广告礼包」(每日 1 次)
const AD_GIFT_ITEM_ID = 80001;      // 奖励: 化肥(1小时) ×5

/**
 * 当前账号是不是 QQ 端
 * QQ 小程序**没有广告能力**(广告只在微信侧), 所以 QQ 账号不该走这个流程
 * 判定顺序: 账号记录里的 platform(权威) → 退回 CONFIG.platform(与 friend.js 的 isQQ 一致)
 */
function isQQPlatform() {
    try {
        const store = require('../models/store');
        const id = String(process.env.FARM_ACCOUNT_ID || '').trim();
        const accounts = typeof store.getAccounts === 'function' ? (store.getAccounts() || []) : [];
        const acc = accounts.find(a => String((a && a.id) || '') === id);
        if (acc) {
            const p = String(acc.platform || '').trim();
            if (p) return p === 'qq';
        }
    } catch (e) { /* 忽略, 走下面的 CONFIG 兜底 */ }
    try {
        const { CONFIG } = require('../config/config');
        return String((CONFIG && CONFIG.platform) || '').trim() === 'qq';
    } catch (e) { return false; }
}

/** 拉广告位列表 */
async function getAdUnits() {
    const body = types.GetAdUnitsRequest.encode(types.GetAdUnitsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync(AD_SERVICE, 'GetAdUnits', body);
    const reply = types.GetAdUnitsReply.decode(replyBody);
    return (reply.units || []).map(u => ({
        unitId: toNum(u.unit_id),
        unitKey: u.unit_key ? Buffer.from(u.unit_key).toString() : '',
    })).filter(u => u.unitId > 0);
}

/** 请求广告(服务端返回 token + 广告物料) —— 不需要真的播放 */
async function requestAd(unitId) {
    const body = types.RequestAdRequest.encode(types.RequestAdRequest.create({ unit_id: unitId })).finish();
    const { body: replyBody } = await sendMsgAsync(AD_SERVICE, 'RequestAd', body);
    const reply = types.RequestAdReply.decode(replyBody);
    const token = reply.token ? Buffer.from(reply.token) : null;
    if (!token || !token.length) throw new Error('RequestAd 没有返回 token');
    return {
        token,
        tokenText: token.toString('utf8').replace(/[^\x20-\x7e]/g, ''),
        payloadLen: reply.ad_payload ? Buffer.from(reply.ad_payload).length : 0,
        field4: toNum(reply.field4),
    };
}

/** 上报"广告完成" → 服务端发奖 */
async function reportAd(token, result = 0) {
    const body = types.ReportAdRequest.encode(types.ReportAdRequest.create({ token, result })).finish();
    const { body: replyBody } = await sendMsgAsync(AD_SERVICE, 'ReportAd', body);
    const reply = types.ReportAdReply.decode(replyBody);
    return { ok: toNum(reply.result) === 1, result: toNum(reply.result) };
}

/** 读背包里化肥(1小时)的数量, 用于校验奖励真的到账 */
async function getFertilizerCount(itemId = AD_GIFT_ITEM_ID) {
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const bag = await getBag();
        for (const it of getBagItems(bag)) {
            if (toNum(it && it.id) === toNum(itemId)) return toNum(it.count) || 0;
        }
    } catch (e) { /* 读不到就按 0 处理(不阻断) */ }
    return 0;
}

/**
 * 今天的看广告礼包还能不能领(以商城接口的限购信息为准)
 * ⚠ 只看 slotType=1 的那条(客户端也是查 slot 1):
 *   getMallCatalog 会把 slot 1..5 + 商店合并, 同 id 可能有多条, 取错就可能误判"已领过"
 *   (2026-09-29: 新账号明明可领, 面板却提示已领过)
 */
async function getAdGiftQuota() {
    try {
        const mall = require('./mall');
        const catalog = await mall.getMallCatalog(1);
        const all = Array.isArray(catalog) ? catalog : [];
        const candidates = all.filter(g => Number(g.goodsId) === AD_GOODS_ID);
        const goods = candidates.find(g => g.source === 'mall' && Number(g.slotType) === 1) || candidates[0];
        const diag = {
            goodsCount: all.length,
            slotTypes: [...new Set(all.map(g => Number(g.slotType) || 0))].sort((a, b) => a - b),
            hasAdGoods: candidates.length > 0,
        };
        if (!goods) {
            // goodsCount>0 = 商城确实读到了, 只是没这个商品(端/账号没有该玩法);
            // goodsCount=0 = 读取异常(别据此下结论)
            return { ok: false, reason: `商城没找到看广告礼包(goodsId=${AD_GOODS_ID})`, ...diag };
        }
        const limit = goods.limitCount || 0;
        const remaining = typeof goods.remaining === 'number' ? goods.remaining : null;
        return {
            ok: true,
            limitType: goods.limitType,
            limitCount: limit,
            boughtNum: goods.boughtNum || 0,
            remaining,
            claimable: remaining === null ? true : remaining > 0,
            goodsName: goods.name || '看广告礼包',
            slotType: goods.slotType,
            source: goods.source,
            rawLimitHex: goods.limitRawHex || '',
            ...diag,
        };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

/**
 * 跳过广告直接领取每日看广告礼包
 * @param force 仅用于"额度读不到(接口异常)"时也硬试一次; **接口说已领过时无论 force 都跳过**
 */
async function claimDailyAdGift(force = false, opts = {}) {
    const watchMs = opts.watchMs === undefined ? AD_WATCH_MS : Math.max(0, Number(opts.watchMs) || 0);
    const result = { ok: false, steps: [], waitMs: watchMs };

    // ⓿ QQ 端没有广告能力 → 直接跳过(不请求任何广告接口)
    if (isQQPlatform()) {
        result.skipped = true;
        result.reason = 'QQ 端没有广告能力(看广告礼包仅微信端有), 跳过';
        return result;
    }

    // ① 先看接口: 今天还有没有额度
    const quota = await getAdGiftQuota();
    result.quota = quota;
    // 手动(force) = 用户明确要试 → **不预检, 直接真发一次让服务端判定**
    //   (2026-09-29 踩过两次: ①预检数据取错时把可领误判成"已领过"; ②服务端才是权威)
    // 自动路径才用预检省掉无谓请求
    if (!force && quota.ok && !quota.claimable) {
        result.skipped = true;
        result.reason = `今日已领过(${quota.boughtNum}/${quota.limitCount})`;
        return result;
    }
    if (quota.ok) {
        log('商城', `看广告礼包: 接口限购 周期=${quota.limitType} 已购=${quota.boughtNum} 上限=${quota.limitCount} 剩余=${quota.remaining}` +
            (quota.rawLimitHex ? ` (raw #7=${quota.rawLimitHex})` : ''), { module: 'mall', event: '看广告礼包', result: 'check' });
    }
    if (quota.ok === false) {
        result.quotaError = quota.reason;
        // 商城**读到了商品列表但没有这个礼包** → 这个账号/端没有该玩法(如 QQ 端没有广告), 直接跳过
        if (/没找到看广告礼包/.test(quota.reason || '') && (quota.goodsCount || 0) > 0) {
            result.skipped = true;
            result.reason = `本端商城没有「看广告礼包」(读到 ${quota.goodsCount} 个商品, 但没有 1052)` +
                ' —— 该账号/端不支持这个玩法(例如 QQ 端没有广告能力)';
            log('商城', `看广告礼包: 商城无此商品, 跳过 (读到 ${quota.goodsCount} 个商品, slot=${(quota.slotTypes || []).join('/')})`, {
                module: 'mall', event: '看广告礼包', result: 'skip',
            });
            return result;
        }
        // goodsCount=0(读取异常) 或其它情况: 不据此下结论, 继续试广告接口
    }

    const before = await getFertilizerCount();

    // ② 广告位
    let unitId = DEFAULT_UNIT_ID;
    try {
        const units = await getAdUnits();
        result.units = units;
        const hit = units.find(u => u.unitKey && /adunit/i.test(u.unitKey)) || units[0];
        if (hit) unitId = hit.unitId;
        result.steps.push({ step: 'GetAdUnits', unitId, unitKey: hit ? hit.unitKey : '' });
    } catch (e) {
        result.steps.push({ step: 'GetAdUnits', error: e.message });
        // 拿不到列表就用实测的默认广告位继续
    }

    // ③ 请求广告 → 拿 token(不播放)
    let ad = null;
    try {
        ad = await requestAd(unitId);
        result.steps.push({ step: 'RequestAd', unitId, tokenLen: ad.token.length, token: ad.tokenText, payloadLen: ad.payloadLen });
    } catch (e) {
        const msg = String((e && e.message) || '');
        result.steps.push({ step: 'RequestAd', unitId, error: msg });
        // 1031013 = 服务端说该广告礼包当前不可用(实测就是"今天已领过"), 按跳过处理而不是报错
        // 1031003 = 限购次数已用完(2026-09-29 实测: 已领过的账号就是这个码)
        if (/1031003|限购次数已用完/.test(msg)) {
            result.skipped = true;
            result.serverCode = '1031003';
            result.reason = quota && quota.ok
                ? `今日已领过(限购次数已用完; 接口 已购 ${quota.boughtNum}/上限 ${quota.limitCount})`
                : '今日已领过(限购次数已用完)';
            log('商城', `看广告礼包: ${result.reason}`, {
                module: 'mall', event: '看广告礼包', result: 'skip', serverCode: '1031003',
                clientVersion: currentClientVersion(),
            });
            return result;
        }
        if (/1031013|还不能使用|暂不可用/.test(msg)) {
            const code = (msg.match(/code=(\d+)/) || [])[1] || '';
            result.skipped = true;
            result.serverCode = code;
            if (quota && quota.ok && !quota.claimable) {
                // 接口说已领满 + 服务端也拒绝 → 就是"今日已领过"
                result.reason = `今日已领过(接口 已购 ${quota.boughtNum}/上限 ${quota.limitCount})`;
            } else if (quota && quota.ok) {
                // 接口说还能领, 服务端却拒绝 → 多半是账号/端不支持广告(QQ 端没有广告能力)
                result.reason = `该账号暂时领不了：服务端 code=${code || '不可用'}，但接口仍显示可领(已购 ${quota.boughtNum}/上限 ${quota.limitCount})` +
                    ' —— 常见原因: 该账号是 QQ 端(广告只在微信端) 或刚登录会话尚未就绪';
                result.hint = '可先用游戏本体试一次: 游戏里也领不到 = 与本逻辑一致; 游戏里能领 = 请把这条日志发我';
            } else {
                result.reason = `服务端拒绝(code=${code || '不可用'})：${quota ? quota.reason : '接口未读到'}`;
            }
            if (result.hint) result.hint += `；当前客户端版本 ${currentClientVersion()}（过旧会被服务端限制功能）`;
            log('商城', `看广告礼包: 服务端拒绝 code=${code || '?'} — ${result.reason}` +
                (quota && quota.rawLimitHex ? ` (raw #7=${quota.rawLimitHex})` : '') +
                ` [clientVersion=${currentClientVersion()}]`, {
                module: 'mall', event: '看广告礼包', result: 'skip', serverCode: code,
                clientVersion: currentClientVersion(),
                quota: quota ? { limitType: quota.limitType, boughtNum: quota.boughtNum, limitCount: quota.limitCount, claimable: quota.claimable } : null,
            });
            return result;
        }
        result.reason = `请求广告失败: ${msg}`;
        return result;
    }
    result.unitId = unitId;

    // 客户端在这段时间里真的播了广告(实测 32.7~33.4s), 服务端会校验"看完" → 等满再上报
    await sleep(watchMs);

    // ④ 上报完成 → 服务端发奖(1044006"未看完"时再等一会重试)
    let lastErr = null;
    for (let attempt = 0; attempt <= AD_REPORT_RETRY; attempt++) {
        try {
            const rep = await reportAd(ad.token, 0);
            result.steps.push({ step: 'ReportAd', attempt, result: rep.result });
            if (rep.ok) { lastErr = null; break; }
            lastErr = new Error(`上报广告失败(result=${rep.result})`);
        } catch (e) {
            lastErr = e;
            result.steps.push({ step: 'ReportAd', attempt, error: e.message });
        }
        const m = String((lastErr && lastErr.message) || '');
        if (!/1044006|未观看完成|未完成/.test(m) || attempt === AD_REPORT_RETRY) break;
        await sleep(AD_REPORT_RETRY_WAIT_MS);   // 时间间隔判定时这一步能救回来
    }
    if (lastErr) {
        const e = lastErr;
        const msg = String((e && e.message) || '');
        // 1044006 = 广告未观看完成: 已等满时长 + 重试仍失败 → 服务端等的是广告平台回调, 伪造不了
        if (/1044006|未观看完成/.test(msg)) {
            result.skipped = true;
            result.serverCode = '1044006';
            result.reason = `服务端判定"广告未观看完成"(已等 ${Math.round(watchMs / 1000)}s 并重试 ${AD_REPORT_RETRY} 次)` +
                ' —— 该玩法需要真的播放微信激励视频, 机器人无法伪造';
            log('商城', `看广告礼包: ${result.reason}`, {
                module: 'mall', event: '看广告礼包', result: 'skip', serverCode: '1044006',
                clientVersion: currentClientVersion(),
            });
            return result;
        }
        // 1031003 = 限购次数已用完(已领过的账号)
        if (/1031003|限购次数已用完/.test(msg)) {
            result.skipped = true;
            result.serverCode = '1031003';
            result.reason = quota && quota.ok
                ? `今日已领过(限购次数已用完; 接口 已购 ${quota.boughtNum}/上限 ${quota.limitCount})`
                : '今日已领过(限购次数已用完)';
            return result;
        }
        result.reason = `上报广告失败: ${msg}`;
        log('商城', `看广告礼包: ${result.reason} [clientVersion=${currentClientVersion()}]`, {
            module: 'mall', event: '看广告礼包', result: 'error', clientVersion: currentClientVersion(),
        });
        return result;
    }

    // ⑤ 校验: 背包化肥是否 +5
    await sleep(1200);
    const after = await getFertilizerCount();
    result.itemId = AD_GIFT_ITEM_ID;
    result.itemName = (getItemById(AD_GIFT_ITEM_ID) || {}).name || `物品#${AD_GIFT_ITEM_ID}`;
    result.image = getItemImageById(AD_GIFT_ITEM_ID);
    result.beforeCount = before;
    result.afterCount = after;
    result.gained = Math.max(0, after - before);
    result.ok = true;                       // ReportAd 成功即算成功(背包校验只作附加信息)
    result.verified = result.gained > 0;
    if (!result.verified && quota && quota.ok && !quota.claimable) {
        // 接口本来就说已领过 + 背包也没涨 → 说明这就是"重复领取", 标注清楚
        result.reason = `今日已领过(接口 已购 ${quota.boughtNum}/上限 ${quota.limitCount})`;
    }

    log('商城', `看广告礼包: 已跳过广告直接领取 → ${result.itemName}${result.gained ? ` +${result.gained}` : '(背包未变化, 今日可能已领)'}`, {
        module: 'mall', event: '看广告礼包', result: 'ok', unitId, tokenLen: ad.token.length, gained: result.gained,
        clientVersion: currentClientVersion(),
    });
    return result;
}

module.exports = {
    AD_SERVICE,
    AD_GOODS_ID,
    DEFAULT_UNIT_ID,
    AD_GIFT_ITEM_ID,
    getAdUnits,
    requestAd,
    reportAd,
    getAdGiftQuota,
    claimDailyAdGift,
    isQQPlatform,
    AD_WATCH_MS,
    AD_REPORT_RETRY,
};
