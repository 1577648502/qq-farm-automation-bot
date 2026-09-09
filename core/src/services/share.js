/**
 * 分享奖励
 */

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum, toLong } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');

// 分享参数 (2026-09-09 抓包 + 用户确认入口语义):
//   share_type 固定=1; scene 区分入口:
//     scene=42  游戏内【每日分享任务】(本模块用这个, 领奖走 ClaimShareReward)
//     scene=0   微信游戏礼包入口 (每日可领, 另有周末档), 上报即得、无需 ClaimShareReward
//   旧抓包(2026-09-01)的 15/1506 与"空请求体"均已失效, 服务端报 1000020 参数错误
const SHARE_TYPE = 1;
const SHARE_SCENE = 42;

const DAILY_KEY = 'daily_share';
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;

function getDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function markDoneToday() {
    doneDateKey = getDateKey();
}

function isDoneToday() {
    return doneDateKey === getDateKey();
}

function isAlreadyClaimedError(err) {
    const msg = String((err && err.message) || '');
    return msg.includes('code=1009001') || msg.includes('已经领取');
}

function getRewardName(id) {
    const cfg = getItemById(id);
    return cfg && cfg.name ? String(cfg.name) : `物品#${id}`;
}

async function checkCanShare() {
    const body = types.CheckCanShareRequest.encode(types.CheckCanShareRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', body);
    return types.CheckCanShareReply.decode(replyBody);
}

async function reportShare() {
    const body = types.ReportShareRequest.encode(types.ReportShareRequest.create({
        share_type: toLong(SHARE_TYPE),
        scene: toLong(SHARE_SCENE),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', body);
    return types.ReportShareReply.decode(replyBody);
}

async function claimShareReward() {
    const body = types.ClaimShareRewardRequest.encode(
        types.ClaimShareRewardRequest.create({ share_type: toLong(SHARE_TYPE) }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ClaimShareReward', body);
    return types.ClaimShareRewardReply.decode(replyBody);
}

async function performDailyShare(force = false) {
    const now = Date.now();
    if (!force && isDoneToday()) return false;
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;
    lastCheckAt = now;
    try {
        const can = await checkCanShare();
        if (!can || !can.can_share) {
            markDoneToday();
            log('分享', '今日暂无可领取分享礼包', {
                module: 'task',
                event: DAILY_KEY,
                result: 'none',
            });
            return false;
        }
        // 1) 上报分享 (result.code=1 才算成功)
        const report = await reportShare();
        const reportCode = report && report.result ? toNum(report.result.code) : 0;
        if (reportCode !== 1) {
            log('分享', `上报分享状态失败 (code=${reportCode})`, {
                module: 'task',
                event: DAILY_KEY,
                result: 'error',
            });
            return false;
        }
        // 2) 领取分享奖励 (ClaimShareReward, 失败容忍: 可能已领过)
        let rewardSummary = '';
        try {
            const rep = await claimShareReward();
            const info = rep && rep.reward;
            if (info && toNum(info.field1) > 0) {
                const itemId = toNum(info.field1);
                const count = toNum(info.field7) || 1;
                rewardSummary = `${getRewardName(itemId)}×${count}`;
            }
        } catch (e) {
            if (isAlreadyClaimedError(e)) {
                markDoneToday();
                log('分享', '今日分享奖励已领取', {
                    module: 'task',
                    event: DAILY_KEY,
                    result: 'none',
                });
                return false;
            }
            log('分享', `ClaimShareReward 失败(继续按已分享处理): ${e.message}`, {
                module: 'task',
                event: DAILY_KEY,
                result: 'error',
            });
        }
        log('分享', rewardSummary ? `领取成功 → ${rewardSummary}` : '分享上报成功', {
            module: 'task',
            event: DAILY_KEY,
            result: 'ok',
        });
        lastClaimAt = Date.now();
        markDoneToday();
        return true;
    } catch (e) {
        log('分享', `领取失败: ${e.message}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return false;
    }
}

module.exports = {
    performDailyShare,
    getShareDailyState: () => ({
        key: DAILY_KEY,
        doneToday: isDoneToday(),
        lastCheckAt,
        lastClaimAt,
    }),
};
