/**
 * 神秘商店 (mysteryshoppb) - 查询激活 NPC + 购买 + 自动购买
 *
 * 复用现有 sendMsgAsync 调用 gamepb.mysteryshoppb.MysteryShopService:
 *   GetActiveNPC  查询当前激活的神秘商店 NPC 及在售商品 (无 NPC 时 body 为空)
 *   Buy           按 goods_id 购买 (每次固定获得 goods.count 个)
 */

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, toLong, log, logWarn, sleep } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');

const SERVICE = 'gamepb.mysteryshoppb.MysteryShopService';

function formatGoods(g) {
    let name = '';
    let image = '';
    let currencyName = '';
    const itemId = toNum(g && g.item_id);
    const currencyId = toNum(g && g.currency_id);
    try {
        const { getItemById, getItemImageById } = require('../config/gameConfig');
        const item = getItemById(itemId);
        name = (item && item.name) ? item.name : `物品${itemId}`;
        image = getItemImageById(itemId) || '';
        const cur = getItemById(currencyId);
        currencyName = (cur && cur.name) ? cur.name : '';
    } catch {
        name = `物品${itemId}`;
    }
    return {
        goodsId: toNum(g && g.goods_id),
        itemId,
        name,
        image,
        count: toNum(g && g.count),
        currencyId,
        currencyName,
        price: toNum(g && g.price),
        originPrice: toNum(g && g.origin_price),
        discount: toNum(g && g.discount),
        soldOut: !!(g && g.sold_out),
    };
}

async function getActiveMysteryShop() {
    const body = types.GetActiveNPCRequest.encode(types.GetActiveNPCRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetActiveNPC', body);
    // 无激活 NPC 时响应 body 为空
    if (!replyBody || replyBody.length === 0) {
        return { active: false, npcId: 0, goods: [], startTime: 0, expireTime: 0 };
    }
    const reply = types.GetActiveNPCReply.decode(replyBody);
    const goods = (Array.isArray(reply.goods) ? reply.goods : []).map(formatGoods);
    return {
        active: goods.length > 0 || toNum(reply.npc_id) > 0,
        npcId: toNum(reply.npc_id),
        goods,
        startTime: toNum(reply.start_time),
        expireTime: toNum(reply.expire_time),
    };
}

async function buyMysteryGoods(goodsId) {
    const body = types.MysteryBuyRequest.encode(types.MysteryBuyRequest.create({
        goods_id: toLong(goodsId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'Buy', body);
    const reply = types.MysteryBuyReply.decode(replyBody);
    const getItem = reply.get_item
        ? { id: toNum(reply.get_item.id), count: toNum(reply.get_item.count) }
        : null;
    const goods = reply.goods ? formatGoods(reply.goods) : null;
    return { ok: true, getItem, goods };
}

// ============ 自动购买 ============
async function checkAndBuyMysteryShop() {
    if (!isAutomationOn('mystery_shop')) return { bought: 0 };
    let bought = 0;
    try {
        const info = await getActiveMysteryShop();
        if (!info.active || !info.goods.length) return { bought: 0 };
        const buyable = info.goods.filter((g) => !g.soldOut && g.goodsId > 0);
        if (!buyable.length) return { bought: 0 };
        log('神秘商店', `发现 ${buyable.length} 个可购买商品，尝试自动购买...`, {
            module: 'mystery_shop', event: '扫描神秘商店', result: 'ok', count: buyable.length,
        });
        for (const g of buyable) {
            try {
                const res = await buyMysteryGoods(g.goodsId);
                if (res.ok) {
                    bought += 1;
                    log('神秘商店', `购买成功: ${g.name} x${g.count} (花费 ${g.price}${g.currencyName})`, {
                        module: 'mystery_shop', event: '购买神秘商店', result: 'ok', goodsId: g.goodsId,
                    });
                }
                await sleep(400);
            } catch (e) {
                logWarn('神秘商店', `购买失败(${g.name}): ${e.message}`, {
                    module: 'mystery_shop', event: '购买神秘商店', result: 'error', goodsId: g.goodsId,
                });
            }
        }
    } catch (e) {
        logWarn('神秘商店', `自动购买检测失败: ${e.message}`, {
            module: 'mystery_shop', event: '扫描神秘商店', result: 'error',
        });
    }
    return { bought };
}

module.exports = {
    getActiveMysteryShop,
    buyMysteryGoods,
    checkAndBuyMysteryShop,
};
