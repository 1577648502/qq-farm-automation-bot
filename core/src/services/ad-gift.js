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
 * ⇒ **跳过广告的做法**: 只发 RequestAd + ReportAd(带 RequestAd 返回的 token) 即可,
 *   全过程没有 MallService.Purchase, 也没有任何"广告播放完成"的校验参数。
 *
 * 每日次数以**接口为准**: 商城商品 1052 的限购信息(#7 = {周期, 已购, 上限}, 每日 1 次),
 * 已领过就不再请求(避免无谓的广告接口调用)。
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum, sleep } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');

const AD_SERVICE = 'gamepb.iaapb.IaaService';
const DEFAULT_UNIT_ID = 10001;      // 实测: 看广告礼包用的广告位
const AD_GOODS_ID = 1052;           // 商城里的「看广告礼包」(每日 1 次)
const AD_GIFT_ITEM_ID = 80001;      // 奖励: 化肥(1小时) ×5

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

/** 今天的看广告礼包还能不能领(以商城接口的限购信息为准) */
async function getAdGiftQuota() {
    try {
        const mall = require('./mall');
        const catalog = await mall.getMallCatalog(1);
        const goods = (catalog || []).find(g => Number(g.goodsId) === AD_GOODS_ID);
        if (!goods) return { ok: false, reason: `商城没找到看广告礼包(goodsId=${AD_GOODS_ID})` };
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
        };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

/**
 * 跳过广告直接领取每日看广告礼包
 * @param force true = 忽略"接口说已领过"的限制(手动按钮用), 仍然会发请求(失败则原样报错)
 */
async function claimDailyAdGift(force = false) {
    const result = { ok: false, steps: [] };

    // ① 先看接口: 今天还有没有额度
    const quota = await getAdGiftQuota();
    result.quota = quota;
    if (quota.ok && !quota.claimable && !force) {
        result.skipped = true;
        result.reason = `今日已领过(${quota.boughtNum}/${quota.limitCount})`;
        return result;
    }
    if (quota.ok === false) {
        // 商城读不到也不阻断(直接试广告接口), 只记下来
        result.quotaError = quota.reason;
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
        result.reason = `请求广告失败: ${e.message}`;
        result.steps.push({ step: 'RequestAd', unitId, error: e.message });
        return result;
    }
    result.unitId = unitId;

    await sleep(600);   // 与抓包节奏一致(客户端在这中间播广告)

    // ④ 上报完成 → 服务端发奖
    try {
        const rep = await reportAd(ad.token, 0);
        result.steps.push({ step: 'ReportAd', result: rep.result });
        if (!rep.ok) {
            result.reason = `上报广告失败(result=${rep.result})`;
            return result;
        }
    } catch (e) {
        result.reason = `上报广告失败: ${e.message}`;
        result.steps.push({ step: 'ReportAd', error: e.message });
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

    log('商城', `看广告礼包: 已跳过广告直接领取 → ${result.itemName}${result.gained ? ` +${result.gained}` : '(背包未变化, 今日可能已领)'}`, {
        module: 'mall', event: '看广告礼包', result: 'ok', unitId, tokenLen: ad.token.length, gained: result.gained,
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
};
