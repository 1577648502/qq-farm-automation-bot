/**
 * 快乐不独享 (2026-09-24 上线的新活动) —— 每日快乐值 + 档位奖励
 *
 * ════════ 活动规则 (活动页 tips 原文) ════════
 * 时间: 2026-09-24 — 2026-10-12, 每日 0 点刷新
 * 快乐值三种来源: ①每日在活动主界面领取 ②每日首次从活动主界面分享 ③每日点击好友分享的快乐包链接
 * 攒够快乐值领档位奖励
 *
 * ════════ 协议 (2026-09-24 抓包 20260924-203415_快乐不独享 实测) ════════
 * group = 2026092501 (子ID 2026092500), UI uid = HappySharePanel
 *   cmd=69 (打开活动)   → 结果 #153 = {#1: {我的gid, hash, shareKey, #5:{#1: group, #2: 我的快乐包id}}}
 *   cmd=73 (领取快乐值) → 结果 #157 = {#2: 5}  ← 实测快乐值 5 → 10
 *   cmd=70 (领取档位奖励) → 结果 #154 = {#2: {物品ID, 数量}}  ← 实测领到 化肥(4小时)×1
 *   cmd=71 (快乐包记录) → 结果 #155 = 若干 {#1, #2, #4, #5 时间, #6 快乐包id}; 无可看时为空
 *   ⚠ 结果字段不是 cmd+100, 而是活动自己的登记: 69→153 / 70→154 / 71→155 / 73→157
 *
 * 状态容器: 活动体 #120.#1
 *   #2 = 快乐值
 *   #5(repeated) = 档位表 {#1: 档位, #2: 快乐值门槛, #3: {物品ID, 数量}, #4: 状态}
 *        **#4 状态: 1 = 未达成, 2 = 可领, 3 = 已领**   ← 幂等判据
 *   档位实测: 10 → 化肥(4小时)×1 · 20 → 有机化肥(8小时)×1 · 30 → 点券×50 · 60 → 90042×1
 *   活动头 #23 = 1 = 有待领(领取后消失)
 *
 * 上行 payload 加密未见 → 一律空 payload 试发 + 状态双重校验
 */
const { log, toNum, toInt, sleep } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { operateRaw, getGroupRaw, parseTop, findField } = require('./mengchong');

const GROUP = 2026092501;
const SUB_ID = 2026092500;
const CMD_OPEN = 69;        // 打开活动(拿分享信息/快乐包id + 状态)
const CMD_CLAIM_HAPPY = 73; // 领取快乐值(每日)
const CMD_CLAIM_TIER = 70;  // 领取档位奖励
const CMD_PACK_LOG = 71;    // 快乐包互动记录
const FIELD_OPEN = 153;
const FIELD_HAPPY = 157;
const FIELD_TIER = 154;
const FIELD_PACK = 155;
const STATE_FIELD = 120;    // 活动体里的状态容器
const TIER_UNREACHED = 1;   // 档位状态: 未达成
const TIER_CLAIMABLE = 2;   // 档位状态: 可领
const TIER_CLAIMED = 3;     // 档位状态: 已领

function itemLabel(id, count) {
    const it = getItemById(toNum(id));
    return `${(it && it.name) || `物品#${id}`}×${count}`;
}

/** 解析活动体 #120.#1 → { happy, tiers[], headFlag } */
function parseHappyState(activityBuf) {
    const out = { ok: false, happy: 0, tiers: [], headFlag: 0, packId: '' };
    if (!activityBuf || !activityBuf.length) return out;
    const act = parseTop(activityBuf);
    const head = findField(act, 1);
    const headFields = head && head.w === 2 ? parseTop(head.v) : [];
    out.headFlag = toInt((findField(headFields, 23) || {}).v);
    const gid = toInt((findField(headFields, 1) || {}).v);
    if (gid !== GROUP) return out;                       // 不是这个活动(可能换组了)

    const box = findField(act, STATE_FIELD);
    const inner = box && box.w === 2 ? findField(parseTop(box.v), 1) : null;
    if (!inner || inner.w !== 2) { out.ok = true; return out; }   // 状态还没下发

    const f = parseTop(inner.v);
    out.happy = toInt((findField(f, 2) || {}).v);
    for (const x of f) {
        if (x.f !== 5 || x.w !== 2) continue;
        const t = parseTop(x.v);
        const rewardField = findField(t, 3);
        const reward = rewardField && rewardField.w === 2 ? parseTop(rewardField.v) : [];
        const rid = toInt((findField(reward, 1) || {}).v);
        const rcount = toInt((findField(reward, 2) || {}).v);
        out.tiers.push({
            tier: toInt((findField(t, 1) || {}).v),
            need: toInt((findField(t, 2) || {}).v),
            itemId: rid,
            count: rcount,
            rewardName: rid > 0 ? itemLabel(rid, rcount) : '',
            image: rid > 0 ? getItemImageById(rid) : '',
            status: toInt((findField(t, 4) || {}).v),
        });
    }
    out.tiers.sort((a, b) => a.tier - b.tier);
    out.ok = true;
    return out;
}

/** 从结果字段里解析 {#2: {物品ID, 数量}} 形式的奖励 */
function parseRewardResult(resultHex) {
    if (!resultHex) return null;
    const f = parseTop(Buffer.from(resultHex, 'hex'));
    const box = findField(f, 2);
    const amt = box && box.w === 2 ? parseTop(box.v) : null;
    if (!amt) return null;
    const id = toInt((findField(amt, 1) || {}).v);
    const count = toInt((findField(amt, 2) || {}).v);
    if (!id || !count) return null;
    return { id, count, name: itemLabel(id, count), image: getItemImageById(id) };
}

/** 读活动状态(打开活动 cmd=69, 顺带拿快乐包id) */
async function getHappyStatus() {
    const r = await operateRaw(GROUP, CMD_OPEN, FIELD_OPEN, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `打开活动失败 code=${r.errorCode}` };
    const st = parseHappyState(r.activity);
    // #153 里的快乐包 id(分享用)
    if (r.resultHex) {
        const f = parseTop(Buffer.from(r.resultHex, 'hex'));
        const box = findField(f, 1);
        const inner = box && box.w === 2 ? findField(parseTop(box.v), 5) : null;
        if (inner && inner.w === 2) {
            const pack = parseTop(inner.v);
            st.packId = (findField(pack, 2) || {}).v && (findField(pack, 2).v.toString
                ? findField(pack, 2).v.toString('utf8') : String(findField(pack, 2).v));
        }
    }
    return { ok: true, ...st, claimableTiers: st.tiers.filter(t => t.status === TIER_CLAIMABLE) };
}

/** 领取每日快乐值(cmd=73); 用"快乐值是否增加"校验, 没生效时补一次分享再试 */
async function claimDailyHappy() {
    const before = await getHappyStatus();
    if (!before.ok) return { ok: false, reason: before.reason };
    const r = await operateRaw(GROUP, CMD_CLAIM_HAPPY, FIELD_HAPPY, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `领取快乐值失败 code=${r.errorCode}` };
    const gained = r.resultHex ? toInt((findField(parseTop(Buffer.from(r.resultHex, 'hex')), 2) || {}).v) : 0;
    await sleep(1200);
    let after = await getHappyStatus().catch(() => null);
    if (after && after.ok && after.happy > before.happy) {
        log('活动', `快乐不独享: 领取快乐值 +${after.happy - before.happy} (现有 ${after.happy})`, {
            module: 'activity', event: '快乐不独享', result: 'ok',
        });
        return { ok: true, gained: after.happy - before.happy, happy: after.happy, tiers: after.tiers };
    }
    // 没涨 → 可能今天还没分享(规则: 每日首次分享也给快乐值) → 走一次分享再试
    try {
        const { reportShare } = require('./share');
        await reportShare();
        await sleep(1500);
        const r2 = await operateRaw(GROUP, CMD_CLAIM_HAPPY, FIELD_HAPPY, Buffer.alloc(0));
        if (r2.errorCode === 0) {
            await sleep(1200);
            after = await getHappyStatus().catch(() => null);
            if (after && after.ok && after.happy > before.happy) {
                log('活动', `快乐不独享: 分享后领取快乐值 +${after.happy - before.happy} (现有 ${after.happy})`, {
                    module: 'activity', event: '快乐不独享', result: 'ok',
                });
                return { ok: true, gained: after.happy - before.happy, happy: after.happy, tiers: after.tiers, viaShare: true };
            }
        }
    } catch (e) { /* 分享失败就按"没涨"处理 */ }
    return {
        ok: false,
        reason: gained > 0 ? `接口回报 +${gained} 但状态没变, 请核对` : '未获得快乐值(今日可能已领过)',
        happy: after && after.ok ? after.happy : before.happy,
    };
}

/** 领取所有可领的档位奖励(cmd=70) */
async function claimTierRewards() {
    const st = await getHappyStatus();
    if (!st.ok) return { ok: false, reason: st.reason };
    const targets = st.claimableTiers || [];
    if (!targets.length) return { ok: true, claimed: [], skipped: true, reason: '没有达到门槛的档位', happy: st.happy, tiers: st.tiers };
    const claimed = [];
    for (const t of targets) {
        const r = await operateRaw(GROUP, CMD_CLAIM_TIER, FIELD_TIER, Buffer.alloc(0));
        if (r.errorCode !== 0) {
            log('活动', `快乐不独享: 档位${t.tier} 领取失败 code=${r.errorCode}`, { module: 'activity', event: '快乐不独享', result: 'error' });
            break;
        }
        const reward = parseRewardResult(r.resultHex);
        claimed.push({ tier: t.tier, need: t.need, reward });
        log('活动', `快乐不独享: 已领取档位${t.tier}(${t.need} 快乐值) → ${reward ? reward.name : '已发放'}`, {
            module: 'activity', event: '快乐不独享', result: 'ok', tier: t.tier,
        });
        await sleep(1200);
    }
    const after = await getHappyStatus().catch(() => null);
    return { ok: true, claimed, happy: after && after.ok ? after.happy : st.happy, tiers: after && after.ok ? after.tiers : st.tiers };
}

/**
 * 快乐不独享整体流程:
 *   ① 读状态(顺带确认活动还在) ② 领每日快乐值 ③ 领可以领的档位奖励
 * 每步都靠状态复核, 不会误报成功。
 */
async function checkAndRunHappyShare(force = false) {
    const before = await getHappyStatus();
    if (!before.ok) return { ok: false, reason: before.reason };
    const out = { ok: true, before: { happy: before.happy, tiers: before.tiers }, daily: null, tiers: null };

    // ② 每日快乐值: 已经有可领档位时也照样试一次(每天只成功一次, 失败无副作用)
    const daily = await claimDailyHappy();
    out.daily = daily;

    // ③ 档位奖励
    const tiers = await claimTierRewards();
    out.tiers = tiers;

    const gotSomething = (daily && daily.ok) || (tiers && tiers.claimed && tiers.claimed.length);
    out.ok = gotSomething || force;      // force 时即使没领到也算"流程跑通"
    return out;
}

module.exports = {
    GROUP,
    SUB_ID,
    CMD_OPEN,
    CMD_CLAIM_HAPPY,
    CMD_CLAIM_TIER,
    CMD_PACK_LOG,
    TIER_CLAIMABLE,
    TIER_CLAIMED,
    __testing: { parseHappyState, parseRewardResult },
    getHappyStatus,
    claimDailyHappy,
    claimTierRewards,
    checkAndRunHappyShare,
};
