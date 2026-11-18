/**
 * 红包每日领取
 *
 * 为什么单独做一个:
 *   红包协议(redpacketpb)早在仓库里就有完整 .proto 和类型导出, 但**从来没有调用点** ——
 *   `GetTodayClaimStatus` / `ClaimRedPacket` 一次都没发过, 等于白送的红包一直没领。
 *   2026-11-17 的牧场抓包里客户端确实在查这个状态, 说明它是每日可领的常驻福利。
 *
 * 数据形态(抓包实测 2026-11-17):
 *   GetTodayClaimStatus  请求空 body
 *                        响应 { infos: [{ id, can_claim }] }  ← 每个红包独立 can_claim
 *   ClaimRedPacket       请求 { id }
 *                        响应 { status, item }            ← item 是实际到账的物品
 *
 * 注意: 有的红包是"现金奖励"(101406/101407), 领了不进游戏背包, 所以不能只看 item 判断成功,
 *       status 才是结果字段。拿不到 item 时按 status 记日志, 不要谎报"领到 0 个"。
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');

const DAILY_KEY = 'red_packet_daily';
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const SERVICE = 'gamepb.redpacketpb.RedPacketService';

let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let lastResult = '';
let lastClaimableCount = 0;

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

function describeItem(item) {
    if (!item) return '';
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (!id) return '';
    const maps = [
        [1, '金币'],
        [1001, '金币'],
        [1002, '点券'],
        [1005, '金豆豆'],
        [1004, '钻石'],
    ];
    for (const [itemId, name] of maps) {
        if (id === itemId) return `${name}${count}`;
    }
    return `物品#${id}x${count}`;
}

async function getTodayClaimStatus() {
    const body = types.GetTodayClaimStatusRequest.encode(types.GetTodayClaimStatusRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetTodayClaimStatus', body);
    return types.GetTodayClaimStatusReply.decode(replyBody);
}

async function claimRedPacket(id) {
    const body = types.ClaimRedPacketRequest.encode(types.ClaimRedPacketRequest.create({
        id: toNum(id),
    })).finish();
    const { body: replyBody } = await sendMsgAsync(SERVICE, 'ClaimRedPacket', body);
    return types.ClaimRedPacketReply.decode(replyBody);
}

function isAlreadyClaimedError(err) {
    const msg = String((err && err.message) || '');
    return msg.includes('今日已领取') || msg.includes('已领取') || msg.includes('已过期');
}

/**
 * 领取今日所有可领红包
 * @param {boolean} force 忽略当日已做标记与冷却
 * @returns {Promise<boolean>} 是否真的领到了东西
 */
async function performDailyRedPacket(force = false) {
    const now = Date.now();
    if (!force && isDoneToday()) return false;
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;
    lastCheckAt = now;

    let status;
    try {
        status = await getTodayClaimStatus();
    } catch (e) {
        lastResult = 'error';
        log('红包', `查询红包状态失败: ${e.message}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return false;
    }

    const infos = Array.isArray(status && status.infos) ? status.infos : [];
    const claimable = infos.filter(it => it && it.can_claim);
    lastClaimableCount = claimable.length;

    if (!claimable.length) {
        markDoneToday();
        lastResult = 'none';
        // 没有可领的是正常状态, 不写日志(每天都会走一次, 刷屏没意义)
        return false;
    }

    let claimed = 0;
    let alreadyDone = 0;
    const rewards = [];
    for (const info of claimable) {
        const id = toNum(info.id);
        try {
            const rep = await claimRedPacket(id);
            const st = toNum(rep && rep.status);
            const text = describeItem(rep && rep.item);
            if (text) rewards.push(text);
            claimed += 1;
            log('红包', text ? `领取成功 → ${text}` : `领取成功 (status=${st})`, {
                module: 'task',
                event: DAILY_KEY,
                result: 'ok',
                redPacketId: id,
                status: st,
            });
        } catch (e) {
            // 单个失败不影响其余红包
            if (isAlreadyClaimedError(e)) {
                alreadyDone += 1;
                log('红包', `红包 #${id} 今日已领取`, {
                    module: 'task',
                    event: DAILY_KEY,
                    result: 'ok',
                    redPacketId: id,
                });
            } else {
                log('红包', `领取红包 #${id} 失败: ${e.message}`, {
                    module: 'task',
                    event: DAILY_KEY,
                    result: 'error',
                    redPacketId: id,
                });
            }
        }
    }

    if (claimed > 0) {
        lastClaimAt = Date.now();
        markDoneToday();
        lastResult = 'ok';
        return true;
    }
    // 全部都是"已领取": 这是正常终态(服务端状态还没刷新, 或另一个进程刚领过),
    // 必须标记完成, 否则会每 20 分钟重试一次并一直报 error。
    if (alreadyDone > 0) {
        markDoneToday();
        lastResult = 'ok';
        return false;
    }
    lastResult = 'error';
    return false;
}

function getRedPacketDailyState() {
    return {
        key: DAILY_KEY,
        doneToday: isDoneToday(),
        lastCheckAt,
        lastClaimAt,
        result: lastResult,
        claimableCount: lastClaimableCount,
    };
}

module.exports = {
    performDailyRedPacket,
    getTodayClaimStatus,
    claimRedPacket,
    getRedPacketDailyState,
};
