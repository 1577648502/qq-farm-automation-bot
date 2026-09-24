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
 *   ⚠ 上行 body 加密, 请求 payload 具体字段未知 → 用空 payload 试发 + 严格校验
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

/** 从 GetGroup 回复里抠出本活动的 {head字段, 是否有待领奖励} */
function parseWishGroup(replyBuf) {
    const out = { ok: false, name: '', state: 0, hasPending: false, group: 0 };
    if (!replyBuf || !replyBuf.length) return out;
    const top = parseTop(replyBuf);
    const lvl1 = findField(top, 1);
    const lvl1Fields = lvl1 ? parseTop(lvl1.v) : top;

    // 活动头可能在 #2 容器里, 也可能直接挂在 #1 下 → 两边都找一遍
    const containers = [];
    const c2 = findField(lvl1Fields, 2);
    if (c2) containers.push(c2);
    containers.push({ v: replyBuf });

    for (const box of containers) {
        const items = parseTop(box.v);
        const headField = findField(items, 1);
        const head = headField && headField.w === 2 ? parseTop(headField.v) : null;
        if (head) {
            const gid = toInt((findField(head, 1) || {}).v);
            const sub = toInt((findField(head, 2) || {}).v);
            if (gid === GROUP || sub === SUB_ID) {
                const nameField = findField(head, 4);
                out.group = gid;
                out.name = nameField && nameField.w === 2 ? nameField.v.toString('utf8') : '';
                out.state = toInt((findField(head, 3) || {}).v);
                out.pendingFlag = toInt((findField(head, 23) || {}).v);
            }
        }
        const redDot = findField(items, PENDING_RED_DOT);
        if (redDot && redDot.w === 2) {
            out.redDot = redDot.v.toString('hex');
            // ⚠ 实测: 领完之后 #119 **仍然存在**(只是内容变成 {#2: 1}), 内部 #1 消失
            //   → 不能用"#119 是否存在"当判据, 要看它内部有没有 #1
            out.redDotInner = parseTop(redDot.v).map(x => x.f);
        }
    }
    out.hasPending = (out.redDotInner || []).includes(1) || (out.pendingFlag || 0) > 0;
    out.ok = !!out.name;
    return out;
}

/** 读活动状态: 是否有可领的祈愿奖励 */
async function getWishStatus() {
    const reply = await getGroupRaw(GROUP);
    const st = parseWishGroup(reply);
    return { ok: st.ok, name: st.name || '秋祈良愿', state: st.state, hasPending: st.hasPending, redDot: st.redDot || '' };
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

/**
 * 领取今日祈愿奖励
 * 客户端实测顺序: cmd=51(祈愿) → 隔几秒 cmd=52(领取) → ItemNotify 到账
 * 两个响应都带奖励信息, 我们以"响应里有奖励 或 之后红点消失"作为成功判据
 */
async function claimWishReward() {
    const result = { ok: false, rewards: [], steps: [] };
    const r51 = await operateRaw(GROUP, CMD_WISH, FIELD_WISH, Buffer.alloc(0));
    result.steps.push({ cmd: CMD_WISH, errorCode: r51.errorCode, field: r51.resultFieldNo, hex: r51.resultHex });
    if (r51.errorCode !== 0) {
        result.reason = `祈愿失败 code=${r51.errorCode}`;
        return result;
    }
    const wishRewards = parseRewardFromResult(r51.resultHex);
    await sleep(1500);
    const r52 = await operateRaw(GROUP, CMD_CLAIM, FIELD_CLAIM, Buffer.alloc(0));
    result.steps.push({ cmd: CMD_CLAIM, errorCode: r52.errorCode, field: r52.resultFieldNo, hex: r52.resultHex });
    if (r52.errorCode !== 0) {
        result.reason = `领取失败 code=${r52.errorCode}`;
        result.rewards = wishRewards;
        return result;
    }
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
    const claim = await claimWishReward();
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
};
