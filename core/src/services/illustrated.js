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
 * 查询图鉴列表
 * @param {object} opts { refresh=false, full=true }
 * @returns {Promise<object>} GetIllustratedListV2Reply 明文对象
 */
async function getIllustratedList({ refresh = false, full = true } = {}) {
    const body = types.GetIllustratedListV2Request.encode(
        types.GetIllustratedListV2Request.create({ refresh: !!refresh, full: !!full }),
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
 */
async function getIllustratedOverview() {
    const reply = await getIllustratedList({ full: true });
    const items = (reply && Array.isArray(reply.items)) ? reply.items : [];
    const formatted = items.map(formatItem);
    const unlocked = formatted.filter((x) => x.planted).length;
    const claimable = formatted.filter((x) => x.canClaim).length;
    return {
        total: formatted.length,
        unlocked,
        claimable,
        items: formatted,
    };
}

/**
 * 手动领取图鉴奖励并打印结果
 */
async function claimIllustratedRewards() {
    const reply = await claimAllRewards(true);
    const items = [
        ...(Array.isArray(reply && reply.items) ? reply.items : []),
        ...(Array.isArray(reply && reply.bonus_items) ? reply.bonus_items : []),
    ];
    if (items.length > 0) {
        log('图鉴', `领取成功, 共 ${items.length} 项奖励`, {
            module: 'task', event: 'illustrated_claim', result: 'ok', count: items.length,
        });
    }
    return { claimed: items.length, items };
}

module.exports = {
    getIllustratedList,
    claimAllRewards,
    getIllustratedOverview,
    claimIllustratedRewards,
    formatItem,
};
