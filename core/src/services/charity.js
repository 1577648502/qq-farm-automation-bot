/**
 * 公益小红花 (group_id=2026090901, head.type=19)
 *
 * 抓包(2026-09-01 / 2026-09-08)确认协议:
 *   活动名 "公益小红花", uid="CharityRedFlower", 2026/9/1 ~ 2026/9/9
 *   概览:   ActivityService.GetGroup(2026090901) → CharityGroupReply, body 在 ActivityData.field116
 *           (2026-09-08 实测客户端改走 Operate 响应内嵌 activity, GetGroup 仍有效)
 *   领礼包: Operate(2026090901, cmd=38, field137="")  每日公益礼包(化肥 80001×2)
 *   送爱心: Operate(2026090901, cmd=36, field135="")  送出爱心/公益金(活动结束后结算)
 *   领档位: Operate(2026090901, cmd=37, field136=message{threshold})  个人爱心档位奖励(30/60/90/120/150)
 *   分享:   ShareService.CheckCanShare → ShareService.ReportShare{share_type=15, scene=1506}
 *
 * 备注: 本活动为腾讯公益真实项目, 涉及真实善款, 操作均按活动内既定按钮语义发起,
 *       自动化仅在"今日未领/未送/可分享"时触发一次, 不做任何超出活动规则的重复请求。
 */

const protobuf = require('protobufjs');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, randomDelay } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');
const { getBag, getBagItems } = require('./warehouse');
const { getItemImageById, getItemById } = require('../config/gameConfig');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';
const SHARE_SERVICE = 'gamepb.sharepb.ShareService';

const CHARITY_GROUP_ID = 2026090901;

// Operate 命令与其 payload 字段号 (规律: 字段号 = cmd + 99)
const CMD_SEND_LOVE = 36;      // 送出爱心/公益金
const FIELD_SEND_LOVE = 135;
const CMD_CLAIM_TIER = 37;     // 领取个人爱心档位奖励 (payload=message{threshold})
const FIELD_CLAIM_TIER = 136;
const CMD_CLAIM_GIFT = 38;     // 领取每日公益礼包
const FIELD_CLAIM_GIFT = 137;

// 分享场景码 (2026-09-09 抓包更新: 旧 15/1506 已失效, 服务端报 1000020 参数错误)
const SHARE_TYPE = 1;
const SHARE_SCENE = 42;

// 相关物品 ID
const ITEM_ID_LOVE = 1040;      // 爱心值
const ITEM_ID_SEED = 20883;     // 小红花种子
const ITEM_ID_FRUIT = 40883;    // 小红花(果实)

// 公益活动专属道具名称 (ItemInfo.json 未必收录, 此处兜底硬编码)
const CHARITY_ITEM_NAMES = {
    1040: '爱心值',
    20883: '小红花种子',
    40883: '小红花',
    101604: '公益小红花结算礼包',
    2158: '小红花做好事头像框',
    80001: '化肥(1小时)',
    80013: '有机化肥(8小时)',
    1002: '点券',
    1005: '金豆豆',
};

function getCharityItemName(id) {
    const nid = Number(id) || 0;
    if (!nid) return '';
    const cfg = getItemById(nid);
    if (cfg && cfg.name) return String(cfg.name);
    return CHARITY_ITEM_NAMES[nid] || `物品#${nid}`;
}

// ============ 底层 RPC ============

async function getCharityGroupRaw() {
    // GetGroupRequest { group_id = 1 }; 手写等价编码
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 0).int64(toLong(CHARITY_GROUP_ID));
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'GetGroup', w.finish());
    return types.CharityGroupReply.decode(replyBody);
}

// 手动构造 Operate 请求 (payload 缺省为空串; cmd=37 传 message{threshold})
function encodeCharityOperateRaw(cmd, payloadFieldNumber, payloadBytes) {
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 0).int64(toLong(CHARITY_GROUP_ID));
    w.uint32((2 << 3) | 0).int64(toLong(cmd));
    w.uint32((payloadFieldNumber << 3) | 2).bytes(payloadBytes || Buffer.alloc(0));
    return w.finish();
}

async function operateCharityRaw(cmd, payloadFieldNumber, payloadBytes) {
    const body = encodeCharityOperateRaw(cmd, payloadFieldNumber, payloadBytes);
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'Operate', body);
    return replyBody;
}

// ============ 规范化 ============

function normalizeItem(item) {
    const id = toNum(item && item.id);
    return {
        id,
        name: id ? getCharityItemName(id) : '',
        count: toNum(item && item.count),
        image: id ? getItemImageById(id) : '',
    };
}

function normalizeTier(t) {
    if (!t) return null;
    return {
        threshold: toNum(t.threshold),
        reward: normalizeItem(t.reward),
    };
}

function normalizeCharity(groupReply) {
    const g = groupReply && groupReply.group;
    if (!g) return null;
    const children = Array.isArray(g.children) ? g.children : [];
    const entry = children.find(c => c && c.charity);
    const head = g.head || (entry && entry.head) || {};
    const base = {
        groupId: toNum(head.id) || CHARITY_GROUP_ID,
        name: String(head.name || '公益小红花'),
        startTime: toNum(head.start_time),
        endTime: toNum(head.end_time),
    };
    const body = entry && entry.charity;
    if (!body) return { ...base, hasBody: false };

    return {
        ...base,
        hasBody: true,
        loveItemId: toNum(body.love_item_id) || ITEM_ID_LOVE,
        // 2026-09-08 抓包修正: field2=今日可送爱心数(0=已送), field3=个人累计爱心值
        loveCanSend: toNum(body.love_can_send),
        loveSent: toNum(body.love_can_send) <= 0,
        personalLoveTotal: toNum(body.personal_love_total),
        serverLoveTotal: toNum(body.server_love_total),
        serverTarget: toNum(body.server_target),
        seedReward: normalizeItem(body.seed_reward),
        dailyGift: normalizeItem(body.daily_gift),
        tiers: (Array.isArray(body.tiers) ? body.tiers : []).map(normalizeTier).filter(Boolean),
        serverReward: normalizeTier(body.server_reward),
        settlePack: normalizeItem(body.settle_pack),
        redDot: toNum(body.red_dot),
    };
}

// ============ 对外 API ============

/**
 * 获取公益小红花完整概览: 活动数据 + 相关背包数量(爱心值/种子/果实)
 */
async function getCharityOverview() {
    const groupReply = await getCharityGroupRaw().catch(e => {
        logWarn('活动', `获取公益小红花活动失败: ${e.message}`);
        return null;
    });
    const bagReply = await getBag().catch(() => null);

    const bagItems = bagReply ? getBagItems(bagReply) : [];
    const bagCounts = new Map();
    for (const it of bagItems) {
        const id = toNum(it && it.id);
        if (id > 0) bagCounts.set(id, (bagCounts.get(id) || 0) + toNum(it.count));
    }

    return {
        updatedAt: Date.now(),
        activity: normalizeCharity(groupReply),
        bag: {
            love: bagCounts.get(ITEM_ID_LOVE) || 0,
            seed: bagCounts.get(ITEM_ID_SEED) || 0,
            fruit: bagCounts.get(ITEM_ID_FRUIT) || 0,
        },
    };
}

/**
 * 领取每日公益礼包 (cmd=38)
 * 服务端在今日已领时会返回错误, 调用方需捕获
 */
async function claimCharityGift() {
    const replyBody = await operateCharityRaw(CMD_CLAIM_GIFT, FIELD_CLAIM_GIFT);
    let awards = [];
    try {
        const rep = types.CharityOperateReply.decode(replyBody);
        if (rep && rep.claim_gift && rep.claim_gift.award) {
            awards = [normalizeItem(rep.claim_gift.award)];
        }
    } catch (_) { /* 忽略解析失败 */ }
    return { awards, replyLen: replyBody.length };
}

/**
 * 送出爱心/公益金 (cmd=36)
 */
async function sendCharityLove() {
    const replyBody = await operateCharityRaw(CMD_SEND_LOVE, FIELD_SEND_LOVE);
    let loveTotal = 0;
    try {
        const rep = types.CharityOperateReply.decode(replyBody);
        if (rep && rep.send_love) loveTotal = toNum(rep.send_love.love_total);
    } catch (_) { /* 忽略解析失败 */ }
    return { loveTotal, replyLen: replyBody.length };
}

/**
 * 领取个人爱心档位奖励 (cmd=37, 2026-09-08 抓包确认)
 * payload = message{ #1: threshold } (字段136), 响应无独立结果字段, 只回最新 activity
 * @param {number} threshold 档位阈值 (30/60/90/120/150)
 */
async function claimCharityTier(threshold) {
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 0).int64(toLong(threshold));
    const replyBody = await operateCharityRaw(CMD_CLAIM_TIER, FIELD_CLAIM_TIER, w.finish());
    let personalLoveTotal = 0;
    try {
        const rep = types.CharityOperateReply.decode(replyBody);
        const children = (rep && rep.activity && rep.activity.children) || [];
        const charity = children.find((c) => c && c.charity);
        if (charity && charity.charity) {
            personalLoveTotal = toNum(charity.charity.personal_love_total);
        }
    } catch (_) { /* 忽略解析失败 */ }
    return { threshold, personalLoveTotal, replyLen: replyBody.length };
}

/**
 * 每日分享 (2026-09-09 抓包更新):
 *   CheckCanShare → 可分享时 ReportShare{share_type=1, scene=42} → 成功后 ClaimShareReward{share_type=1} 领奖
 *   旧流程 (15/1506, 不领奖) 已失效: 服务端报 1000020 请求参数错误
 */
async function shareCharity() {
    const canBody = types.CheckCanShareRequest.encode(types.CheckCanShareRequest.create({})).finish();
    const { body: canReplyBody } = await sendMsgAsync(SHARE_SERVICE, 'CheckCanShare', canBody);
    const canReply = types.CheckCanShareReply.decode(canReplyBody);
    if (!canReply.can_share) {
        return { shared: false, reason: '当前不可分享(今日已分享或未开放)' };
    }
    const repBody = types.ReportShareRequest.encode(types.ReportShareRequest.create({
        share_type: toLong(SHARE_TYPE),
        scene: toLong(SHARE_SCENE),
    })).finish();
    const { body: repReplyBody } = await sendMsgAsync(SHARE_SERVICE, 'ReportShare', repBody);
    let code = 0;
    try {
        const rep = types.ReportShareReply.decode(repReplyBody);
        code = toNum(rep && rep.result && rep.result.code);
    } catch (_) { /* 忽略 */ }
    if (code !== 1) {
        return { shared: false, reason: `ReportShare 未成功 (code=${code})` };
    }
    // 领取分享奖励 (上报成功后客户端会立刻调用)
    let reward = null;
    try {
        const claimBody = types.ClaimShareRewardRequest.encode(
            types.ClaimShareRewardRequest.create({ share_type: toLong(SHARE_TYPE) }),
        ).finish();
        const { body: claimReplyBody } = await sendMsgAsync(SHARE_SERVICE, 'ClaimShareReward', claimBody);
        const claimRep = types.ClaimShareRewardReply.decode(claimReplyBody);
        const info = claimRep && claimRep.reward;
        if (info) {
            reward = {
                field1: toNum(info.field1),
                field6: toNum(info.field6),
                field7: toNum(info.field7),
            };
        }
    } catch (e) {
        // 领奖失败不视为分享失败 (可能已领过)
        logWarn('活动', `公益小红花: ClaimShareReward 失败(可能已领): ${e.message}`);
    }
    return { shared: true, code, reward };
}

// ============ 自动化 ============

/**
 * 每日公益任务: 领公益礼包 + 送爱心 + 领档位奖励 + 分享 (各自仅在未完成时触发一次)
 */
async function autoRunCharityTasks() {
    const summary = { claimed: false, loved: false, tierClaims: 0, shared: false, skipped: [], errors: [] };
    let overview;
    try {
        overview = await getCharityOverview();
    } catch (e) {
        return { skipped: true, reason: 'overview_failed', error: e.message };
    }
    if (!overview.activity || !overview.activity.hasBody) {
        return { skipped: true, reason: 'activity_not_active' };
    }

    // 1) 领取公益礼包 (body 里无可靠"已领"标志, 直接尝试, 已领时服务端报错按跳过处理)
    try {
        await claimCharityGift();
        summary.claimed = true;
        log('活动', '公益小红花: 领取公益礼包成功', { module: 'activity', event: '公益小红花', result: 'claim_ok' });
        await randomDelay(800, 1500);
    } catch (e) {
        summary.skipped.push('公益礼包(已领或不可领)');
    }

    // 2) 送出爱心 (今日可送数为 0/缺省 时视为已送)
    if (!overview.activity.loveSent) {
        try {
            await sendCharityLove();
            summary.loved = true;
            log('活动', '公益小红花: 送出爱心成功', { module: 'activity', event: '公益小红花', result: 'love_ok' });
            await randomDelay(800, 1500);
        } catch (e) {
            summary.errors.push(`送出爱心失败: ${e.message}`);
            logWarn('活动', `公益小红花送爱心失败: ${e.message}`, { module: 'activity', event: '公益小红花', result: 'love_error' });
        }
    } else {
        summary.skipped.push('今日已送出爱心');
    }

    // 3) 领取个人爱心档位奖励 (cmd=37): 档位阈值 <= 个人累计爱心 的逐一尝试, 已领过的由服务端报错跳过
    const act = overview.activity;
    if (Array.isArray(act.tiers) && act.tiers.length) {
        for (const tier of act.tiers) {
            if (!tier || !tier.threshold || tier.threshold > act.personalLoveTotal) continue;
            try {
                await claimCharityTier(tier.threshold);
                summary.tierClaims += 1;
                log('活动', `公益小红花: 领取 ${tier.threshold} 爱心档位奖励成功`, { module: 'activity', event: '公益小红花', result: 'tier_ok' });
                await randomDelay(800, 1500);
            } catch (e) {
                summary.skipped.push(`${tier.threshold} 档(已领或未达标)`);
            }
        }
    }

    // 4) 每日分享
    try {
        const r = await shareCharity();
        summary.shared = r.shared;
        if (r.shared) {
            log('活动', '公益小红花: 每日分享成功', { module: 'activity', event: '公益小红花', result: 'share_ok' });
        } else {
            summary.skipped.push(r.reason || '分享跳过');
        }
    } catch (e) {
        summary.errors.push(`分享失败: ${e.message}`);
    }

    return summary;
}

/**
 * 顶层自动化入口 (受 charity_task 开关控制)
 */
async function checkAndRunCharityTasks() {
    if (!isAutomationOn('charity_task')) return { skipped: true };
    try {
        const result = await autoRunCharityTasks();
        log('活动', `公益小红花每日自动化: 领礼包 ${result.claimed ? '是' : '否'}, 送爱心 ${result.loved ? '是' : '否'}, 分享 ${result.shared ? '是' : '否'}`, {
            module: 'activity', event: '公益小红花', result: 'auto_done',
        });
        return result;
    } catch (e) {
        logWarn('活动', `公益小红花每日自动化失败: ${e.message}`, { module: 'activity', event: '公益小红花', result: 'auto_error' });
        return { error: e.message };
    }
}

module.exports = {
    // 常量
    CHARITY_GROUP_ID,
    // 查询
    getCharityGroupRaw,
    getCharityOverview,
    // 写操作
    claimCharityGift,
    sendCharityLove,
    claimCharityTier,
    shareCharity,
    // 自动化
    autoRunCharityTasks,
    checkAndRunCharityTasks,
};
