/**
 * 图鉴系统 - 查询图鉴列表 + 领取图鉴奖励
 *
 * 注: 自动领取奖励的定时逻辑在 task.js 的 checkAndClaimIllustratedRewards() 中,
 * 本模块提供独立的查询与手动领取能力, 供后续调度或前端调用。
 */

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log } = require('../utils/utils');

const SERVICE = 'gamepb.illustratedpb.IllustratedService';

/**
 * 图鉴类别(GetIllustratedListV2 的 #2) —— 2026-11-20 抓包定案:
 *   1   = 农场植物/花卉图鉴(222 条, 请求 08001001)
 *   101 = **牧场动物图鉴**(28 条, id 2060001~2070012; 请求 1065)
 * 牧场图鉴页的「普通 / 巨大」两个页签对应的就是这两类。
 */
const LIST_TYPE = {
    PLANT: 1,
    RANCH_ANIMAL: 101,
};

/**
 * 查询图鉴列表
 * @param {object} opts { refresh=false, listType=1 }  listType: 1=植物, 101=牧场动物
 * @returns {Promise<object>} GetIllustratedListV2Reply 明文对象
 */
async function getIllustratedList({ refresh = false, listType = LIST_TYPE.PLANT, full } = {}) {
    // 兼容旧调用: 传入 full=true 且没给 listType 时按植物图鉴(历史行为)
    const type = Number(listType) || (full === false ? 0 : LIST_TYPE.PLANT);
    const body = types.GetIllustratedListV2Request.encode(
        types.GetIllustratedListV2Request.create({ refresh: !!refresh, list_type: type }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetIllustratedListV2', body);
    return types.GetIllustratedListV2Reply.decode(replyBody);
}

/**
 * 领取全部图鉴奖励
 * @param {boolean} onlyClaimable 只领取可领取的, 默认 true
 * @returns {Promise<object>} ClaimAllRewardsV2Reply 明文对象
 */
async function claimAllRewards(onlyClaimable = true) {
    const body = types.ClaimAllRewardsV2Request.encode(
        types.ClaimAllRewardsV2Request.create({ only_claimable: !!onlyClaimable }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'ClaimAllRewardsV2', body);
    return types.ClaimAllRewardsV2Reply.decode(replyBody);
}

/**
 * 把图鉴条目转成简洁结构, 便于展示/统计
 *
 * 字段语义(实测):
 *   planted      已解锁(种植过)
 *   plantedCount 领奖所需收获数(按品质 10/40/80/200, 未解锁为 0)
 *   hasReward    奖励已领取
 *   canClaim     当前可领奖 = 已解锁 且 未领取 且 收获数达到阈值
 */
function formatItem(item) {
    const reward = item && item.reward
        ? { itemId: toNum(item.reward.item_id), count: toNum(item.reward.count) }
        : null;
    const planted = !!(item && item.planted);
    const plantedCount = toNum(item && item.planted_count);
    const harvestCount = toNum(item && item.harvest_count);
    const rewardClaimed = !!(item && item.has_reward);
    return {
        seedId: toNum(item && item.seed_id),
        unlockStatus: toNum(item && item.unlock_status),
        planted,
        plantedCount,
        harvestCount,
        hasReward: rewardClaimed,
        rewardClaimed,
        canClaim: planted && !rewardClaimed && plantedCount > 0 && harvestCount >= plantedCount,
        reward,
    };
}

/**
 * 查询图鉴概览: 总数 / 已解锁 / 可领奖数
 * @param {object} [opts] { listType } 不传则返回**两类合并**(植物 + 牧场动物),
 *   并额外给出 plant / ranchAnimal 两个分类小计。
 */
async function getIllustratedOverview(opts = {}) {
    const wantType = opts && opts.listType !== undefined ? Number(opts.listType) : null;
    const typesToFetch = wantType !== null ? [wantType] : [LIST_TYPE.PLANT, LIST_TYPE.RANCH_ANIMAL];
    const all = [];
    const byType = {};
    for (const listType of typesToFetch) {
        try {
            const reply = await getIllustratedList({ listType });
            const formatted = ((reply && reply.items) || []).map(formatItem)
                .map(it => ({ ...it, listType }));
            byType[listType] = {
                total: formatted.length,
                unlocked: formatted.filter(x => x.planted).length,
                claimable: formatted.filter(x => x.canClaim).length,
            };
            all.push(...formatted);
        } catch { /* 单类失败不影响另一类 */ }
    }
    return {
        total: all.length,
        unlocked: all.filter(x => x.planted).length,
        claimable: all.filter(x => x.canClaim).length,
        items: all,
        byType,
    };
}

/**
 * 手动领取图鉴奖励并打印结果
 */
async function claimIllustratedRewards() {
    // ⚠ 领奖接口本身没有"类别"参数, 但服务端会按当前**场景**结算:
    //   农场场景领植物图鉴, 牧场场景领牧场动物图鉴。
    //   所以这里必须两类都尝试一次, 否则「巨大」页签的奖励永远领不到。
    const all = [];
    for (const listType of [LIST_TYPE.PLANT, LIST_TYPE.RANCH_ANIMAL]) {
        try {
            // 先查一次该类图鉴, 没有可领的就不发领奖请求(避免无谓请求)
            const list = await getIllustratedList({ refresh: false, listType });
            const arr = (list && list.items) || [];
            const claimable = arr.filter((it) => it && it.planted && !it.has_reward
                && Number(it.planted_count) > 0
                && Number(it.harvest_count) >= Number(it.planted_count));
            if (claimable.length === 0) continue;
            const reply = await claimAllRewards(true);
            all.push(
                ...(Array.isArray(reply && reply.items) ? reply.items : []),
                ...(Array.isArray(reply && reply.bonus_items) ? reply.bonus_items : []),
            );
        } catch { /* 单类失败不影响另一类 */ }
    }
    if (all.length > 0) {
        log('图鉴', `领取成功, 共 ${all.length} 项奖励`, {
            module: 'task', event: 'illustrated_claim', result: 'ok', count: all.length,
        });
    }
    return { claimed: all.length, items: all };
}

module.exports = {
    LIST_TYPE,
    getIllustratedList,
    claimAllRewards,
    getIllustratedOverview,
    claimIllustratedRewards,
    formatItem,
};
