/**
 * 神秘商店系统 (骨架)
 *
 * 逆向状态: 抓包时无激活 NPC, GetActiveNPC 请求/响应 body 均为空。
 * 本模块提供 GetActiveNPC 查询骨架, 响应字段布局待抓到有激活 NPC 时,
 * 在 mysteryshoppb.proto 里补全后即可正常解析。
 *
 * 后续可能补充的方法(待抓包确认): 购买(Buy/Purchase)、刷新(Refresh)。
 */

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log } = require('../utils/utils');

const SERVICE = 'gamepb.mysteryshoppb.MysteryShopService';

/**
 * 查询当前激活的神秘商店 NPC
 * @returns {Promise<object>} GetActiveNPCReply 明文对象 (无 NPC 时为空对象)
 */
async function getActiveNPC() {
    const body = types.GetActiveNPCRequest.encode(
        types.GetActiveNPCRequest.create({}),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetActiveNPC', body);
    // 无激活 NPC 时 replyBody 为空, decode 得到空对象
    return types.GetActiveNPCReply.decode(replyBody || Buffer.alloc(0));
}

/**
 * 是否当前有激活的神秘商店 NPC
 */
async function hasActiveNPC() {
    try {
        const reply = await getActiveNPC();
        const npc = reply && reply.npc;
        return !!(npc && toNum(npc.npc_id) > 0);
    } catch (e) {
        log('神秘商店', `查询激活 NPC 失败: ${e.message}`, {
            module: 'mysteryshop', event: 'get_active_npc', result: 'error',
        });
        return false;
    }
}

/**
 * 查询并打印神秘商店概览 (骨架, 有 NPC 时可扩展商品处理)
 */
async function getMysteryShopOverview() {
    const reply = await getActiveNPC();
    const npc = reply && reply.npc;
    if (!npc || toNum(npc.npc_id) <= 0) {
        log('神秘商店', '当前无激活 NPC', {
            module: 'mysteryshop', event: 'overview', result: 'none',
        });
        return { active: false, npcId: 0, goods: [] };
    }
    const goods = Array.isArray(npc.goods) ? npc.goods : [];
    return {
        active: true,
        npcId: toNum(npc.npc_id),
        expireTime: toNum(npc.expire_time),
        goods: goods.map((g) => ({
            goodsId: toNum(g.goods_id),
            itemId: toNum(g.item_id),
            count: toNum(g.count),
            price: toNum(g.price),
            currencyId: toNum(g.currency_id),
            soldOut: !!g.sold_out,
        })),
    };
}

module.exports = {
    getActiveNPC,
    hasActiveNPC,
    getMysteryShopOverview,
};
