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
 * ════════ 2026-11-04 更新公告后 (抓包 20261105-010541_快乐不独享新) ════════
 * 公告: 「快乐不独享」新增奖励档位, 累计快乐值达标可领**奶茶券惊喜礼包**(101616);
 *       礼包开启概率给化肥/有机化肥/点券100/蜜雪奶茶券, 奶茶券奖池限量、每人最多中一次。
 * - 档位表从 4 档扩到 **8 档**: 同 group 2026110104、同状态容器 #120.#1、同 #5 结构, 无需改协议
 *   10/20/30/60/80/110/130/150 →
 *   化肥(4h)×1 / 有机化肥(8h)×1 / 宣传喇叭×5 / 人气装饰×1 /
 *   奶茶券惊喜礼包×1 / ×1 / ×1 / ×1
 *   ⚠ 旧抓包在 30 档给的是"点券×50", 新版换成了宣传喇叭×5 → **档位奖励一律以服务端状态为准**,
 *     代码里不写死任何档位, 只认 #4 状态 == 2 的条目(本次改动的核心约束)。
 * - #154(领档位结果) 从单条扩展到多条: **#2(repeated) = 奖励条目 {#1 物品ID, #2 数量, ...}**
 *   (开头的 #1 是个 1~2 字节的标志位, 新旧抓包都一样, 语义未解出, 忽略即可)
 *   2026-11-05 实测一次领 2 档 → #154 = {#1: ~, #2: 80013×1, #2: 80014×1}。旧解析只取第一条, 会漏报。
 * - 福利: 领取到的 101616 属于背包 type=11/can_use=1, 仓库的"礼包自动开启"会顺手开掉,
 *   不需要活动侧再发 Use 请求(活动结束后未领的档位就没了, 所以档位必须尽早领)。
 *
 * 上行 payload 加密未见 → 一律空 payload 试发 + 状态双重校验
 *
 * ════════ 2026-11-07 抓包纠正: 请求体必须"只有 group + cmd" ════════
 * 实测真实客户端三次(20261015 / 20261105 / 20261107)发的 Operate 请求都是 **8 字节**:
 *   `08 <group varint> 10 <cmd varint>` —— 不带任何 payload 字段。
 * 旧代码传 FIELD_OPEN/FIELD_HAPPY/FIELD_TIER 当 payload 字段号, 会多发一个空 bytes 字段
 * (`82 0a 00` / `9a 09 00` ...), 请求变成 10~11 字节, 服务端按"参数错误"拒绝 →
 * 表现为"快乐不独享永远不会自动领"(定时器在跑、状态能读、领取就是不动)。
 * 现在统一传 payloadField=0(encodeOperateRaw 里 `if (payloadField)` 直接跳过)。
 */
const { log, toNum, toInt, sleep } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { operateRaw, getGroupRaw, parseTop, findField } = require('./mengchong');

const GROUP_S3 = 2026092501;   // 上一期(9/24-10/12)
const GROUP_S4 = 2026110104;   // S4 版(2026-10-15 上线, 机制相同)
/** 当前活动组: 优先 S4, 不在则回退 S3(实测 2026-10-15 换期后 group 变了) */
let activeGroup = GROUP_S4;
const SUB_ID = 2026092500;
/**
 * ⚠ 换期时 **命令号会轮换**(结果字段号是稳定的, 所以按字段号对齐来认):
 *   语义         字段    S3 cmd   S4 cmd
 *   打开/查询    #153     69       70
 *   领快乐值     #157     73       74
 *   领档位       #154     70       71
 *   快乐包记录   #155     71       72
 * S4 实测(2026-10-15 抓包): cmd=74 返回 #157={#2:5}(快乐值 5)、cmd=71 把档位1 置为"已领"。
 * 拿 S3 的 cmd 去打 S4 会报 **1034004 活动参数错误** → 必须按活动期传命令号。
 */
const SEASONS = [
    { group: 2026110104, open: 70, claimHappy: 74, claimTier: 71, pack: 72 },   // S4 版
    { group: 2026092501, open: 69, claimHappy: 73, claimTier: 70, pack: 71 },   // S3 版(上期)
];
let activeSeason = SEASONS[0];
/** 指定活动期(测试/兜底用) */
function setSeason(group) {
    const hit = SEASONS.find((x) => x.group === toNum(group));
    if (!hit) return false;
    activeSeason = hit;
    activeGroup = hit.group;
    return true;
}
/** 结果字段号(只用于读回包, 不用于构造请求 —— 请求体只有 group+cmd) */
const FIELD_OPEN = 153;
const FIELD_HAPPY = 157;
const FIELD_TIER = 154;
const FIELD_PACK = 155;
const STATE_FIELD = 120;    // 活动体里的状态容器
const TIER_UNREACHED = 1;   // 档位状态: 未达成
const TIER_CLAIMABLE = 2;   // 档位状态: 可领
const TIER_CLAIMED = 3;     // 档位状态: 已领
const GIFT_PACK_ID = 101616; // 奶茶券惊喜礼包(2026-11-04 新增档位奖励; type=11/can_use=1, 由仓库负责开启)

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
    // 换期时 group 会变(S3 2026092501 / S4 2026110104): 两个都认, 只排除别的活动
    if (gid !== GROUP_S3 && gid !== GROUP_S4) return out;

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

/**
 * 解析领取档位结果 #154 → 奖励清单 [{id, count, name, image}]
 *   结构: {#1: 标志位, #2(repeated): {#1 物品ID, #2 数量, ...}}
 * 2026-11-05 起一次可领多档 → 多条 #2; 拿不到时返回 []
 */
function parseRewardResults(resultHex) {
    if (!resultHex) return [];
    const f = parseTop(Buffer.from(resultHex, 'hex'));
    const out = [];
    for (const box of f) {
        if (box.f !== 2 || box.w !== 2) continue;
        const amt = parseTop(box.v);
        const id = toInt((findField(amt, 1) || {}).v);
        const count = toInt((findField(amt, 2) || {}).v);
        if (!id || !count) continue;
        out.push({ id, count, name: itemLabel(id, count), image: getItemImageById(id) });
    }
    return out;
}

/** 旧接口: 只取第一条奖励(#154 早期只有一条), 无奖励返回 null */
function parseRewardResult(resultHex) {
    return parseRewardResults(resultHex)[0] || null;
}

/** 读活动状态(打开活动 cmd=69, 顺带拿快乐包id) */
async function getHappyStatus() {
    let r = await operateRaw(activeGroup, activeSeason.open, 0);
    if (r.errorCode !== 0) {
        // 换期时 group 会变: 失败就换另一个组再试一次
        const other = activeGroup === GROUP_S4 ? GROUP_S3 : GROUP_S4;
        const otherSeason = SEASONS.find((x) => x.group === other) || activeSeason;
        const r2 = await operateRaw(other, otherSeason.open, 0).catch(() => null);
        if (r2 && r2.errorCode === 0) {
            setSeason(other);   // 组与命令号一起切换
            log('活动', `快乐不独享: 活动组已切换为 ${activeGroup}`, { module: 'activity', event: '快乐不独享', result: 'ok' });
            r = r2;
        } else {
            return { ok: false, reason: `打开活动失败 code=${r.errorCode}` };
        }
    }
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
    const r = await operateRaw(activeGroup, activeSeason.claimHappy, 0);
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
        const r2 = await operateRaw(activeGroup, activeSeason.claimHappy, 0);
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

/**
 * 领取所有可领的档位奖励(cmd=71)
 *
 * ⚠ 2026-11-05 抓包纠正了旧实现的假设: **一次 cmd=71 会把当前所有可领档位一起领掉**。
 *   实测: 档位5(80) 与档位6(110) 同为状态2 → 只发了一次 cmd=71, 两条都变成状态3。
 *   旧代码是"每个可领档位发一次", 第二次就是空打(可能报错) → 改成**只发一次**。
 *   奖励以 #154 的多条 #2 为准; 服务端会顺带把 101616 礼包开掉(实测直接回 80013/80014),
 *   所以这里只报告、不再自己发 Use。
 */
async function claimTierRewards() {
    const st = await getHappyStatus();
    if (!st.ok) return { ok: false, reason: st.reason };
    const targets = st.claimableTiers || [];
    if (!targets.length) return { ok: true, claimed: [], skipped: true, reason: '没有达到门槛的档位', happy: st.happy, tiers: st.tiers };

    // 一次领完(服务端会处理所有状态=2 的档位)
    const r = await operateRaw(activeGroup, activeSeason.claimTier, 0);
    if (r.errorCode !== 0) {
        return { ok: false, reason: `领取档位失败 code=${r.errorCode}`, claimed: [], happy: st.happy, tiers: st.tiers, targets };
    }
    const rewards = parseRewardResults(r.resultHex);
    await sleep(1200);

    // 以"领取后状态"为准核对, 不轻信接口回报
    const after = await getHappyStatus().catch(() => null);
    const afterTiers = (after && after.ok) ? after.tiers : st.tiers;
    const claimedTiers = afterTiers.filter(t => t.status === TIER_CLAIMED).map(t => t.tier);
    const newlyClaimed = (after && after.ok)
        ? targets.filter(t => claimedTiers.includes(t.tier))
        : targets;   // 复核失败时按"准备领的档位"报告, 但置 verified=false

    const claimed = newlyClaimed.map((t, i) => {
        // 只有"到账条目数 == 领取档位数"时才敢按顺序对齐; 否则不硬套(避免日志误报档位↔奖励)
        const aligned = rewards.length === newlyClaimed.length ? rewards[i] : null;
        return { tier: t.tier, need: t.need, reward: aligned, rewards: aligned ? [aligned] : [] };
    });
    const allNames = rewards.map(x => x.name).join('+');
    for (const c of claimed) {
        log('活动', `快乐不独享: 已领取档位${c.tier}(${c.need} 快乐值)${c.reward ? ` → ${c.reward.name}` : ''}`, {
            module: 'activity', event: '快乐不独享', result: 'ok', tier: c.tier,
        });
    }
    if (rewards.length) {
        log('活动', `快乐不独享: 本次到账 ${allNames}`, {
            module: 'activity', event: '快乐不独享', result: 'ok', count: rewards.length,
        });
    }
    return {
        ok: claimed.length > 0,
        verified: !!(after && after.ok),
        claimed,
        rewards,                       // 服务端实际到账(按返回顺序; 与档位的对应关系不保证)
        claimedTiers,
        happy: after && after.ok ? after.happy : st.happy,
        tiers: afterTiers,
        reason: claimed.length ? undefined : '接口成功但档位状态没变化, 请核对',
    };
}

/**
 * 快乐不独享整体流程:
 *   ① 读状态(顺带确认活动还在) ② 领每日快乐值 ③ 领可以领的档位奖励
 * 每步都靠状态复核, 不会误报成功。
 * 2026-11-04 更新后: 档位奖励里含「奶茶券惊喜礼包」(101616)。服务端在领取档位时可能直接开包,
 * 也可能把礼包发进背包 —— 后者靠仓库的"礼包自动开启"(type=11 & can_use=1)兜底, 这里不重复发 Use。
 */
async function checkAndRunHappyShare(force = false) {
    const before = await getHappyStatus();
    if (!before.ok) return { ok: false, reason: before.reason };
    const out = { ok: true, before: { happy: before.happy, tiers: before.tiers }, daily: null, tiers: null, pendingPacks: [] };

    // ② 每日快乐值: 已经有可领档位时也照样试一次(每天只成功一次, 失败无副作用)
    const daily = await claimDailyHappy();
    out.daily = daily;

    // ③ 档位奖励
    const tiers = await claimTierRewards();
    out.tiers = tiers;

    // ④ 档位里还有"礼包"没被服务端当场开掉 → 交给仓库的开包流程(它自带节流 + 幂等)
    //    实测(11-05): 服务端领档时直接把 101616 开成 80013/80014, #154 回的是开出来的东西;
    //    这里只兜底"礼包原样进了背包"的情况。
    out.pendingPacks = ((tiers && tiers.rewards) || []).filter(x => x.id === GIFT_PACK_ID);
    if (out.pendingPacks.length) {
        log('活动', `快乐不独享: 档位奖励含奶茶券惊喜礼包 x${out.pendingPacks.length}，交由仓库自动开启`, {
            module: 'activity', event: '快乐不独享', result: 'ok', count: out.pendingPacks.length,
        });
        try {
            // 懒加载: 避免服务层循环依赖(warehouse 不依赖 happy-share, 这里只是保险)
            const { openGiftPacksSilently } = require('./warehouse');
            out.openedPacks = await openGiftPacksSilently().catch(() => 0);
        } catch { /* 开包失败不影响本次领取结果 */ }
    }

    const gotSomething = (daily && daily.ok) || (tiers && tiers.claimed && tiers.claimed.length);
    out.ok = gotSomething || force;      // force 时即使没领到也算"流程跑通"
    return out;
}

module.exports = {
    GROUP: GROUP_S4,
    GROUP_S3,
    GROUP_S4,
    GIFT_PACK_ID,
    getActiveGroup: () => activeGroup,
    SUB_ID,
    SEASONS,
    setSeason,
    getActiveSeason: () => ({ ...activeSeason }),
    TIER_CLAIMABLE,
    TIER_CLAIMED,
    __testing: { parseHappyState, parseRewardResult, parseRewardResults },
    getHappyStatus,
    claimDailyHappy,
    claimTierRewards,
    checkAndRunHappyShare,
};
