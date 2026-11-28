/**
 * 图鉴系统 - 查询图鉴列表 + 领取图鉴奖励
 *
 * 注: 自动领取奖励的定时逻辑在 task.js 的 checkAndClaimIllustratedRewards() 中,
 * 本模块提供独立的查询与手动领取能力, 供后续调度或前端调用。
 */

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, logWarn } = require('../utils/utils');

const SERVICE = 'gamepb.illustratedpb.IllustratedService';

/**
 * 图鉴类别(GetIllustratedListV2 的 #2) —— 2026-11-20 抓包定案:
 *   1   = 农场植物/花卉图鉴(222 条, 请求 08001001)
 *   101 = **牧场普通动物图鉴**(28 条, id 2060001~2070012 即鸡/鸭/…/羊驼; 请求 1065)
 *
 * ⚠ 2026-11-28 修正: 早期注释把 101 当成「巨大」页签 —— 错的。
 *   101 的条目 id 全是普通动物(2060001 鸡 / 2070012 羊驼), 对应牧场图鉴的
 *   **「普通」页签**; 「巨大」页签是重量分档总奖励(GetRanchWeightScoreV2),
 *   两者走完全不同的接口。
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
 *
 * ⭐ 2026-11-20 抓包定案: 请求 #1 是**图鉴类别**(list_type), 不是 only_claimable:
 *   官方客户端领牧场普通动物图鉴发 0865 = {1:101}。
 *   旧实现发 true → 编码 {1:1} = 植物图鉴 —— 能领但只领植物那类,
 *   牧场普通图鉴(以及它随附的总进度奖励)从来没领过。
 *
 * @param {number} [listType] 1=农场植物图鉴; 101=牧场普通动物图鉴
 * @returns {Promise<object>} ClaimAllRewardsV2Reply 明文对象
 */
async function claimAllRewards(listType = LIST_TYPE.PLANT) {
    const body = types.ClaimAllRewardsV2Request.encode(
        types.ClaimAllRewardsV2Request.create({ list_type: Number(listType) || LIST_TYPE.PLANT }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'ClaimAllRewardsV2', body);
    return types.ClaimAllRewardsV2Reply.decode(replyBody);
}

/**
 * 单条目是否可领奖
 *
 * ⭐ 2026-11-28 修正(线上: 普通图鉴的总奖励从来没自动领过):
 *   旧判定 = planted && !has_reward && harvest_count >= planted_count。
 *   但抓包实测(20261117-162604 / 20261120-232455 / 20261118-172140 等 616 条
 *   牧场动物条目)**field5(harvest_count) 从未下发过** → 解码为 undefined,
 *   比较恒为 false → 普通图鉴(101)既不领单条目, 也永远拿不到随之发放的
 *   总进度奖励(官方客户端仅凭 planted && !has_reward 就发 ClaimAllRewardsV2,
 *   回包里带 1002×200 的总奖励)。
 *
 *   植物图鉴(1)的 field5 正常下发(>0 时才编码), 基于收获数的节流保留 ——
 *   避免 plant 了但没收到阈值时每 60s 空发一次领奖请求。
 *
 * @param {object} item IllustratedItem(decode 后的明文对象)
 * @param {number} [listType] 1=植物; 101=牧场普通动物
 */
function isItemClaimable(item, listType) {
    if (!item || !item.planted || item.has_reward) return false;
    // 牧场动物图鉴: 协议不下发 harvest_count, 可领与否交给服务端判定
    if (Number(listType) === LIST_TYPE.RANCH_ANIMAL) return true;
    const need = toNum(item.planted_count);
    if (need <= 0) return false;
    return toNum(item.harvest_count) >= need;
}

/**
 * 把图鉴条目转成简洁结构, 便于展示/统计
 *
 * 字段语义(实测):
 *   planted      已解锁(种植/养殖过)
 *   plantedCount 领奖所需收获数(按品质 10/40/80/200, 未解锁为 0)
 *   hasReward    奖励已领取
 *   canClaim     当前可领奖(见 isItemClaimable)
 *
 * @param {object} item
 * @param {number} [listType] 不传按植物图鉴规则(兼容旧调用)
 */
function formatItem(item, listType) {
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
        canClaim: isItemClaimable(item, listType),
        reward,
    };
}

/** 总奖励档的奖励条目 {item_id,count} 转文本(日志用) */
function fmtReward(r) {
    return `${toNum(r && r.item_id)}x${toNum(r && r.count)}`;
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
            const formatted = ((reply && reply.items) || []).map(it => formatItem(it, listType))
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
    // 领奖请求带 list_type(抓包: 领牧场普通动物图鉴发 {1:101})
    // ⚠ 不预先用列表判断可领: 101 的总进度奖励与单条目 has_reward 无关,
    //   列表里也没有对应字段(见 task.js checkAndClaimIllustratedRewards 注释)。
    const all = [];
    for (const listType of [LIST_TYPE.PLANT, LIST_TYPE.RANCH_ANIMAL]) {
        try {
            const reply = await claimAllRewards(listType);
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

/**
 * ===== 巨大图鉴总奖励(牧场重量分档位) =====
 * 2026-11-22 抓包定案(20261120-232455_领奖励): 单条目奖励(claimAllRewards)之外,
 * 牧场图鉴还有**按重量分分档的总奖励** —— 收集动物的重量分达 20/40/60/... 各档
 * 各有一份奖励(点券+物品), 官方客户端在牧场场景用 GetRanchWeightScoreV2/Claim*
 * 领取。此前自动任务只领了单条目, 档位奖励一直没领。
 */

/** 查询牧场重量分与各档状态(空 body 请求) */
async function getRanchWeightScore() {
    const body = types.GetRanchWeightScoreV2Request.encode(
        types.GetRanchWeightScoreV2Request.create({}),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetRanchWeightScoreV2', body);
    return types.GetRanchWeightScoreV2Reply.decode(replyBody);
}

/** 领取指定档位的总奖励 {1:档号} */
async function claimRanchWeightScoreReward(tier) {
    const body = types.ClaimRanchWeightScoreRewardV2Request.encode(
        types.ClaimRanchWeightScoreRewardV2Request.create({ tier: Number(tier) }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'ClaimRanchWeightScoreRewardV2', body);
    return types.ClaimRanchWeightScoreRewardV2Reply.decode(replyBody);
}

/**
 * 领取全部已达标未领的档位总奖励。
 * ⭐ 必须先切牧场场景(官方客户端在 PlayerSceneLogin{1:2} 之后才发这两个请求)。
 * @returns {Promise<{score:number, claimedTiers:number[], items:object[]}>}
 */
async function claimAllRanchWeightScoreRewards() {
    const { enterRanchSceneForApi } = require('./ranch');
    if (!(await enterRanchSceneForApi())) {
        return { score: 0, claimedTiers: [], items: [], skipped: 'scene_locked' };
    }
    const rep = await getRanchWeightScore();
    const tiers = (rep && rep.tiers) || [];
    const claimable = tiers.filter(t => Number(t && t.claimable) === 1);
    const items = [];
    const claimedTiers = [];
    for (const t of claimable) {
        try {
            const r = await claimRanchWeightScoreReward(toNum(t.tier));
            const got = (r && r.rewards) || [];
            items.push(...got);
            claimedTiers.push(toNum(t.tier));
            log('图鉴', `巨大图鉴总奖励档${toNum(t.tier)}领取成功: ${got.map(fmtReward).join(', ') || `${got.length} 项`}`, {
                module: 'task', event: 'illustrated_weight_claim', result: 'ok', tier: toNum(t.tier),
            });
        } catch (e) {
            logWarn('图鉴', `巨大图鉴档${toNum(t.tier)}领取失败: ${e.message}`, {
                module: 'task', event: 'illustrated_weight_claim', result: 'error', tier: toNum(t.tier),
            });
        }
    }
    return { score: toNum(rep && rep.score), claimedTiers, items };
}

module.exports = {
    LIST_TYPE,
    getIllustratedList,
    claimAllRewards,
    getIllustratedOverview,
    claimIllustratedRewards,
    getRanchWeightScore,
    claimRanchWeightScoreReward,
    claimAllRanchWeightScoreRewards,
    isItemClaimable,
    formatItem,
};
