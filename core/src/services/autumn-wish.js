/**
 * 秋祈良愿 (2026-09-24 上线的新活动) —— 每日祈愿 + 烟花互动
 *
 * ════════ 活动规则 (活动页 tips 原文) ════════
 * 时间: 2026-09-24 — 2026-10-07, 每日 0 点刷新
 * 玩法: 主界面祈愿 → 领当日好运奖励(2 种限定种子 + 烟花互动道具 + 盆栽装扮)
 *       错过可存 5 日(含当天); 没领到的次日/活动结束后通过邮件补发
 *       (邮件补发不用另做: 现有 checkAndClaimEmails 每天在领邮件)
 *
 * ════════ 协议 (2026-09-24 两份抓包实测) ════════
 * group = 2026092401 (子ID 2026092400), UI uid = WishSignMainUI
 *   活动头(#3.#1): #1 group / #2 子ID / #3 状态(21) / #4 名称 / #5 规则JSON
 *                  #6 开始 / #7 结束 / #8 141 / #20 1 / #21 20 / #22 1 / #23 = 1(待领标记)
 *   **#119 = 可领奖励红点**(有奖时存在; 领完与 #23 一起消失 —— 这是幂等判据)
 *   cmd=51 (祈愿/签文) → 结果 #151 = {#1: 14(签文号), #2: 1, #3: {物品, 数量}}
 *   cmd=52 (领取奖励)   → 结果 #152 = {#1: {物品, 数量, ...}}  → 紧跟 ItemNotify 实际到账
 *   ⚠ **请求必须带参数**: 2026-09-25 把上行解开确认(core/scripts/ws-frame-lib 的 decodeFrame
 *     能解密 message_type=1 的请求) → {#151: {#1: 4}} / {#152: {#1: 4}} 都要带 #1
 *     发空 payload 会直接报"参数错误"。#1 疑似"选择的愿望/签位"编号(服务端会回显到 #119.#3.#1),
 *     实测 4 可用; 这里做成候选序列自动试探(4 → 1,2,3,5,6), 成功的记在内存里
 *
 * ════════ 烟花 (两处抓包已确认, 同一个接口) ════════
 *   自己家:  ItemService.Use(6001 烟花桶)
 *   好友家:  VisitService.Enter(好友gid) → ItemService.Use(6001) → VisitService.Leave
 *   效果: 消耗自己 1 个 → 自己 经验+30 → FarmSocialEventsNotify 推送给好友(社交可见)
 *   商城另有 goodsId 1033「烟花·花好月圆」= 物品 6002 (6 钻石, 总限购 50)
 */
const { sendMsgAsync } = require('../utils/network');
const { log, toNum, toInt, sleep } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { operateRaw, getGroupRaw, parseTop, findField } = require('./mengchong');

const GROUP = 2026092401;          // 秋祈良愿
const SUB_ID = 2026092400;
const CMD_WISH = 51;               // 祈愿(签文)
const CMD_CLAIM = 52;              // 领取奖励(真正发放)
const FIELD_WISH = 151;            // 结果字段 = cmd + 100 (实测)
const FIELD_CLAIM = 152;
const PENDING_RED_DOT = 119;       // 活动体里的"可领奖励"红点
const PENDING_FLAG = 23;           // 活动头里的待领标记

const FIREWORK_ITEM_ID = 6001;     // 烟花桶(祈愿奖励)
const FIREWORK_FRIEND_ITEM_ID = 6002; // 烟花·花好月圆(商城 6 钻石)

function itemLabel(id, count) {
    const it = getItemById(toNum(id));
    const name = (it && it.name) || `物品#${id}`;
    return `${name}×${count}`;
}

/**
 * 从活动回复里抠出 {活动名, 状态, 是否有待领奖励, 回显的愿望编号}
 * 兼容两种回复:
 *   · GetGroup 回复: 活动体在 #1.#2 里(children = [#1 活动头, #119 红点...])
 *   · Operate 回复 : 活动体在 #3 里(结构同上)
 * ⚠ #1 在 Operate 回复里是 varint(group), 不能直接当 message 解析 —— 只看 w===2 的
 */
function parseWishGroup(replyBuf) {
    const out = { ok: false, name: '', state: 0, hasPending: false, group: 0 };
    if (!replyBuf || !replyBuf.length) return out;
    try {
        const top = parseTop(replyBuf);
        const containers = [];
        const pushIfMsg = (f) => { if (f && f.w === 2) containers.push(f); };
        pushIfMsg(findField(top, 3));                    // Operate 回复
        const lvl1 = findField(top, 1);                  // GetGroup 回复
        if (lvl1 && lvl1.w === 2) {
            const lvl1Fields = parseTop(lvl1.v);
            pushIfMsg(findField(lvl1Fields, 2));         // 组容器
            containers.push(lvl1);
        }
        containers.push({ v: replyBuf });                // 兜底: 直接当容器找

        for (const box of containers) {
            const items = parseTop(box.v);
            const headField = findField(items, 1);
            const head = (headField && headField.w === 2) ? parseTop(headField.v) : null;
            if (head) {
                const gid = toInt((findField(head, 1) || {}).v);
                const sub = toInt((findField(head, 2) || {}).v);
                if (gid === GROUP || sub === SUB_ID) {
                    const nameField = findField(head, 4);
                    out.group = gid;
                    out.name = nameField && nameField.w === 2 ? nameField.v.toString('utf8') : '';
                    out.state = toInt((findField(head, 3) || {}).v);
                    out.pendingFlag = toInt((findField(head, 23) || {}).v);
                    const redDot = findField(items, PENDING_RED_DOT);
                    if (redDot && redDot.w === 2) {
                        out.redDot = Buffer.from(redDot.v).toString('hex');
                        // ⚠ 领完之后 #119 仍在(内容变成 {#2: 1}) → 判据是"内部有没有 #1"
                        const inner = parseTop(redDot.v);
                        out.redDotInner = inner.map(x => x.f);
                        // #119.#3 = { #1: 愿望编号, #2: 签文号, ... } → 回读上次用的编号
                        const pick = inner.find(x => x.f === 3 && x.w === 2);
                        if (pick) {
                            const idx = toInt((findField(parseTop(pick.v), 1) || {}).v);
                            if (idx > 0) out.echoWishIndex = idx;
                        }
                    }
                }
            }
        }
    } catch (e) { /* 解析失败按"读不到状态"处理, 由调用方决定 */ }
    out.hasPending = (out.redDotInner || []).includes(1) || (out.pendingFlag || 0) > 0;
    out.ok = !!out.name;
    return out;
}

/** 读活动状态: 是否有可领的祈愿奖励 */
async function getWishStatus() {
    const reply = await getGroupRaw(GROUP);
    const st = parseWishGroup(reply);
    return {
        ok: st.ok, name: st.name || '秋祈良愿', state: st.state,
        hasPending: st.hasPending, redDot: st.redDot || '',
        echoWishIndex: st.echoWishIndex || 0,        // 上次用过的愿望编号(可直接复用, 省去试探)
    };
}

/** 从结果字段里读出奖励(#{#1: 物品ID, #2: 数量}) */
function parseRewardFromResult(resultHex) {
    const out = [];
    if (!resultHex) return out;
    const fields = parseTop(Buffer.from(resultHex, 'hex'));
    for (const f of fields) {
        if (f.w !== 2) continue;
        const inner = parseTop(f.v);
        const id = toInt((findField(inner, 1) || {}).v);
        const count = toInt((findField(inner, 2) || {}).v);
        if (id > 0 && count > 0) out.push({ id, count, name: itemLabel(id, count), image: getItemImageById(id) });
    }
    return out;
}

/** 本进程内试出来的可用愿望编号(省得每次都试一遍) */
let workingWishIndex = 0;
/** 候选编号: 实测 4 可用; 其它作为兜底(游戏改版/编号变化时自动适应) */
const WISH_INDEX_CANDIDATES = [4, 1, 2, 3, 5, 6];

/** 把愿望编号编成 payload: {#1: idx} (wire: 字段1 varint) */
function encodeWishPayload(index) {
    const idx = Math.max(0, Math.min(999, toInt(index)));
    return Buffer.from([0x08, idx & 0x7f]);      // 0x08 = (1<<3)|0
}

/**
 * 领取今日祈愿奖励
 * 客户端实测顺序: cmd=51(祈愿) → 隔几秒 cmd=52(领取) → ItemNotify 到账
 * 两个请求都必须带 {#1: 愿望编号}, 否则服务端报"参数错误"(2026-09-25 实测)
 * @param wishIndex 指定愿望编号; 不传则用"上次成功的", 再不行按候选序列试探
 */
async function claimWishReward(wishIndex) {
    const result = { ok: false, rewards: [], steps: [] };
    const candidates = [];
    const push = (v) => { const n = toInt(v); if (n > 0 && !candidates.includes(n)) candidates.push(n); };
    push(wishIndex);
    push(workingWishIndex);
    WISH_INDEX_CANDIDATES.forEach(push);

    let r51 = null;
    for (const idx of candidates) {
        let r = null;
        try {
            r = await operateRaw(GROUP, CMD_WISH, FIELD_WISH, encodeWishPayload(idx));
        } catch (e) {
            // ⚠ 服务端拒绝时 sendMsgAsync 是**抛异常**的(不是 err!=0), 必须逐个捕获才能换编号重试
            result.steps.push({ cmd: CMD_WISH, wishIndex: idx, error: e.message });
            result.reason = `祈愿失败: ${e.message}(愿望编号 ${idx})`;
            continue;
        }
        result.steps.push({ cmd: CMD_WISH, wishIndex: idx, errorCode: r.errorCode, field: r.resultFieldNo, hex: r.resultHex });
        if (r.errorCode === 0) { r51 = r; workingWishIndex = idx; break; }
        result.reason = `祈愿失败 code=${r.errorCode}(愿望编号 ${idx})`;
    }
    if (!r51) return result;
    result.wishIndex = workingWishIndex;

    const wishRewards = parseRewardFromResult(r51.resultHex);
    await sleep(1500);
    let r52 = null;
    for (const idx of candidates) {
        let r = null;
        try {
            r = await operateRaw(GROUP, CMD_CLAIM, FIELD_CLAIM, encodeWishPayload(idx));
        } catch (e) {
            result.steps.push({ cmd: CMD_CLAIM, wishIndex: idx, error: e.message });
            result.reason = `领取失败: ${e.message}(愿望编号 ${idx})`;
            continue;
        }
        result.steps.push({ cmd: CMD_CLAIM, wishIndex: idx, errorCode: r.errorCode, field: r.resultFieldNo, hex: r.resultHex });
        if (r.errorCode === 0) { r52 = r; workingWishIndex = idx; break; }
        result.reason = `领取失败 code=${r.errorCode}(愿望编号 ${idx})`;
    }
    if (!r52) { result.rewards = wishRewards; return result; }

    result.rewards = parseRewardFromResult(r52.resultHex);
    if (!result.rewards.length) result.rewards = wishRewards;
    result.ok = true;
    return result;
}

/**
 * 检查并领取祈愿奖励
 * · 先看活动状态的红点(#119 / #23), 没有可领的直接跳过 —— 每天只会有一次
 * · 领完再查一次状态校验(红点消失), 避免"以为领了其实没领"
 */
async function checkAndClaimAutumnWish(force = false) {
    const before = await getWishStatus();
    if (!before.ok) return { ok: false, reason: '读不到秋祈良愿状态(活动可能已下线)' };
    if (!force && !before.hasPending) {
        return { ok: true, skipped: true, reason: '今日无可领奖励(已祈愿)', hasPending: false };
    }
    // 优先用状态里回显的编号(上次成功过的), 再退回试探
    const claim = await claimWishReward(before.echoWishIndex);
    if (!claim.ok) {
        // 服务端可能已经把奖励发了(51 成功 52 报错), 用状态复核一次
        const after = await getWishStatus().catch(() => null);
        if (after && !after.hasPending) {
            log('活动', `秋祈良愿: 已领取 ${claim.rewards.map(r => r.name).join('、') || '(无奖励回包)'}`, {
                module: 'activity', event: '秋祈良愿', result: 'ok',
            });
            return { ok: true, rewards: claim.rewards, claim, verified: true };
        }
        log('活动', `秋祈良愿领取失败: ${claim.reason || '未知'}`, { module: 'activity', event: '秋祈良愿', result: 'error' });
        return { ok: false, reason: claim.reason, claim };
    }
    const after = await getWishStatus().catch(() => null);
    const cleared = after ? !after.hasPending : null;
    const rewardText = claim.rewards.map(r => r.name).join('、') || '(无奖励回包)';
    log('活动', `秋祈良愿: 已祈愿并领取 ${rewardText}${cleared === false ? ' ⚠红点未消失, 请核对' : ''}`, {
        module: 'activity', event: '秋祈良愿', result: 'ok', rewards: claim.rewards.map(r => ({ id: r.id, count: r.count })),
    });
    return { ok: true, rewards: claim.rewards, cleared, claim };
}

/**
 * 放烟花: 消耗 1 个烟花桶(6001) → 自己 经验+30 → 推送给好友
 * @param opts.mode 'self'(自己家, 默认) | 'friend'(去好友家放)
 * @param opts.friendGid 好友家模式指定去哪家; 不传则随机挑一个好友
 * @param opts.itemId 默认 6001(祈愿给的烟花桶); 也可传 6002(商城花好月圆)
 */
async function useFirework(opts = {}) {
    const mode = opts.mode === 'friend' ? 'friend' : 'self';
    const itemId = toNum(opts.itemId) || FIREWORK_ITEM_ID;
    const itemName = (getItemById(itemId) || {}).name || `物品#${itemId}`;
    let targetGid = toNum(opts.friendGid) || 0;

    if (mode === 'friend' && !targetGid) {
        // 只有没指定目标时才去拉好友列表挑一个
        const { getFriendsList } = require('./friend');
        const friends = await getFriendsList().catch(() => null);
        const list = Array.isArray(friends) ? friends : (friends && friends.friends) || [];
        const usable = list.filter(f => toNum(f && (f.gid || f.id)) > 0);
        if (!usable.length) return { ok: false, reason: '没有可访问的好友(可先指定 friendGid)' };
        const pick = usable[Math.floor(Math.random() * usable.length)];
        targetGid = toNum(pick.gid || pick.id);
    }

    const { enterFriendFarm, leaveFriendFarm } = require('./friend');
    const { useItem } = require('./warehouse');

    let entered = false;
    try {
        if (mode === 'friend' && targetGid > 0) {
            await enterFriendFarm(targetGid);
            entered = true;
            await sleep(800);
        }
        const reply = await useItem(itemId, 1);
        const rewards = (reply && Array.isArray(reply.items) ? reply.items : []).map(it => ({
            id: toNum(it.id), count: toNum(it.count), name: itemLabel(toNum(it.id), toNum(it.count)),
        }));
        const exp = reply && reply.items ? 0 : 0;   // UseReply 的经验在 #6, 由 ItemNotify 体现, 这里不强解析
        log('活动', `放烟花(${mode === 'friend' ? '好友家' : '自己家'}): ${itemName}×1${targetGid ? ` @${targetGid}` : ''} → ${rewards.map(r => r.name).join('、') || '已使用'}`, {
            module: 'activity', event: '放烟花', result: 'ok', mode, itemId, friendGid: targetGid,
        });
        return { ok: true, mode, itemId, itemName, friendGid: targetGid, rewards };
    } catch (e) {
        log('活动', `放烟花失败: ${e.message}`, { module: 'activity', event: '放烟花', result: 'error', mode });
        return { ok: false, reason: e.message, mode, itemId };
    } finally {
        if (entered) await leaveFriendFarm(targetGid).catch(() => null);
    }
}

/** 背包里还有几个烟花 */
async function getFireworkCount(itemId = FIREWORK_ITEM_ID) {
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const bag = await getBag();
        for (const it of getBagItems(bag)) {
            if (toNum(it && it.id) === toNum(itemId)) return toNum(it.count) || 0;
        }
    } catch (e) { /* 读背包失败按 0 处理 */ }
    return 0;
}

module.exports = {
    GROUP,
    SUB_ID,
    CMD_WISH,
    CMD_CLAIM,
    FIREWORK_ITEM_ID,
    FIREWORK_FRIEND_ITEM_ID,
    __testing: { parseWishGroup, parseRewardFromResult },
    getWishStatus,
    claimWishReward,
    checkAndClaimAutumnWish,
    useFirework,
    getFireworkCount,
    encodeWishPayload,
    getWorkingWishIndex: () => workingWishIndex,
};
