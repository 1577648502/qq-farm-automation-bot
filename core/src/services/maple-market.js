/**
 * 以薯换福 (2026-11-25 上线, 2026-11-25 ~ 2026-12-09)
 * 种红薯 → 收蜜薯 → 卖自己摊位得福气币 → 兑换道具
 *
 * 协议来源: wx-code-grabber/captures/20261125-115051_新活动.decoded.jsonl
 *          wx-code-grabber/captures/20261125-115630_新活动.decoded.jsonl
 * 协议规律: 请求字段 = cmd + 100
 *   CMD 91 领种子     req #191 ""          rsp #191 {#1 {#1 seedId, #2 count}}
 *   CMD 92 查状态+摊位 req #192 {#1 gid}    rsp #130 主状态 + #192 我的摊位
 *   CMD 93 卖自己摊位  req #193 {#1 gid, #2 count} rsp #193 {#1 实卖, #2 单价, #3 总收入, #4 剩余额度, #5 福币余额}
 *   CMD 95 开活动页    req #195 ""          rsp #195 "" (空, 疑似开页上报/分享检查)
 *   CMD 96 兑换       req #196 {#1 slot, #2 count} rsp #196 {#1 price, #2 {#1 itemId, #2 count,...}, #3 福币余额}
 *   CMD 97 兑换列表    req #197 ""          rsp #197 {repeated #1 {#1 slot, #2 price, #3 类型(#3=2), #4 限购, #5 已购, #6/#7}, #2 福币余额}
 *   CMD 98 今日信息    req #198 ""          rsp #198 {#1 {#1 seedId, #2 剩余可领种子}, #2 持有蜜薯, #3 今日单价, #4 分享卡, #5 累计收益}
 *
 * #130 主状态 (reply activity #130):
 *   #1 {#1 done, #2 ?} 种子领取标记(1=已领)
 *   #2 {#1 持有蜜薯, #2 ?, #3 ts, #4 ?}
 *   #3 福气币余额
 *   #4 {#2 1} (?)
 *   #5 今日基础价  #6 持有蜜薯(同#2#1)  #7 累计收益
 *
 * 实测价格关系(北栎, 2026-11-25):
 *   #130 #5=99 基础价, #6=165 持有, 实卖 264/个 = 99+165; 卖30 收入 7920 = 30×264
 *   润出去(#5=142, #6=33): 142+33=175 也吻合 —— 卖价 = 基础价 + 持有量溢价, 服务端算
 *
 * 物品 id: 20307 红薯种子 / 40307 红薯(果实, 背包价 240 金) /
 *         1032 蜜薯(活动结算 80 金, 活动内必须卖摊位) / 1033 福气币 / 80001 化肥(1h)
 *
 * 机制(活动说明原文, 抓包 #5 UI meta):
 *   - 每日领红薯种子 → 种普通地 → 收红薯 + 额外蜜薯(每块地 30 蜜薯, ItemNotify 1032 delta=30/块实证)
 *   - 蜜薯卖自己摊位不限量; 好友卖给你占 8000 接收额度; 每日首分享暴击(0点清零)
 *   - 24:00 自动按最终价结算清仓(基础价 80 金, 不如卖摊位划算 → 应每天卖光)
 */

const { log } = require('../utils/utils');
const { toNum, toInt } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');
const { getUserState } = require('../utils/network');
const { operateRaw, parseTop, findField } = require('./mengchong');
const { sleep } = require('../utils/utils');

const ACTIVITY_GROUP = 2026111708;
const FIELD_OFFSET = 100; // 请求字段 = cmd + 100

const CMD_CLAIM_SEED = 91;
const CMD_GET_STATE = 92;
const CMD_SELL = 93;
const CMD_EXCHANGE = 96;
const CMD_EXCHANGE_LIST = 97;
const CMD_TODAY_INFO = 98;

const ITEM_SEED = 20307;      // 红薯种子
const ITEM_FRUIT = 40307;     // 红薯(果实)
const ITEM_POTATO = 1032;     // 蜜薯
const ITEM_COIN = 1033;       // 福气币

// ItemInfo.json 滞后未收录的物品名 (静态配置只有 80001)
const LOCAL_ITEM_NAMES = {
    [ITEM_SEED]: '红薯种子',
    [ITEM_FRUIT]: '红薯',
    [ITEM_POTATO]: '蜜薯',
    [ITEM_COIN]: '福气币',
};

function itemName(id) {
    const nid = toNum(id);
    if (!nid) return '';
    const cfg = getItemById(nid);
    if (cfg && cfg.name) return String(cfg.name);
    return LOCAL_ITEM_NAMES[nid] || `物品#${nid}`;
}

// ===== 请求队列/节流 (踩过: 并发把游戏消息队列打满 → 掉线, 与 milk-tea 相同模板) =====
let lastCallAt = 0;
async function throttleGap() {
    const gap = 300 - (Date.now() - lastCallAt);
    if (gap > 0) await sleep(gap);
    lastCallAt = Date.now();
}

let reqQueue = Promise.resolve();
function enqueueActivityRequest(task) {
    const run = reqQueue.catch(() => {}).then(async () => {
        await throttleGap();
        return task();
    });
    reqQueue = run.then(() => {}, () => {});
    return run;
}

// 统一 try/catch (network 层遇业务错误是 throw, 直接 await operateRaw 后看 r.errorCode
// **永远不成立**(异常穿透) —— milk-tea 踩过)
async function op(cmd, payloadField, payloadBytes) {
    try {
        const r = await enqueueActivityRequest(() => operateRaw(ACTIVITY_GROUP, cmd, payloadField, payloadBytes));
        const code = toInt(r.errorCode); // ⚠ 必须 toInt: toNum 对字符串原样返回
        return { ...r, errorCode: code, ok: code === 0, reason: code === 0 ? '' : `code=${code}` };
    } catch (e) {
        const m = String((e && e.message) || '');
        const code = toInt((m.match(/code=(\d+)/) || [])[1]) || 0;
        return {
            errorCode: code, resultFieldNo: 0, resultHex: '', activity: null,
            ok: false, reason: m.slice(0, 80), thrown: !code,
        };
    }
}

function resultFields(r) {
    if (!r || !r.resultHex) return [];
    return parseTop(Buffer.from(r.resultHex, 'hex'));
}

// ===== 编码 (请求 #1xx: {#1: a, #2: b} 这类小结构, 手拼足够) =====

function encodeVarint(v) {
    let n = typeof v === 'bigint' ? v : BigInt(Math.max(0, Math.trunc(Number(v) || 0)));
    const out = [];
    do {
        let b = Number(n & 0x7Fn);
        n >>= 7n;
        if (n > 0n) b |= 0x80;
        out.push(b);
    } while (n > 0n);
    return Buffer.from(out);
}

function encodeVarintField(field, value) {
    return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

// ===== 解析 =====

/** #130 主状态 */
function parseMainState(activityBuf) {
    const out = {
        ok: false,
        seedClaimed: false,   // #1 {#1: 1} 今天种子已领
        coin: 0,              // #3 福气币余额
        basePrice: 0,         // #5 今日基础价
        holding: 0,           // #6 持有蜜薯
        totalIncome: 0,       // #7 累计收益
    };
    if (!activityBuf || !activityBuf.length) return out;
    try {
        const f = parseTop(activityBuf);
        const claim = findField(f, 1);
        if (claim && claim.w === 2) {
            out.seedClaimed = toInt((findField(parseTop(claim.v), 1) || {}).v) === 1;
        }
        out.coin = toInt((findField(f, 3) || {}).v) || 0;
        out.basePrice = toInt((findField(f, 5) || {}).v) || 0;
        out.holding = toInt((findField(f, 6) || {}).v) || 0;
        out.totalIncome = toInt((findField(f, 7) || {}).v) || 0;
        out.ok = true;
    } catch { /* 解析失败按"读不到"处理 */ }
    return out;
}

/** #192 我的摊位: {#1 {#1 价格, #2 持有, #3 剩余接收额度, #4 {#1 gid, #2 昵称,...}}, #2 1}
 *  ⚠ resultHex 已经是 #192 的内容(operateRaw 返回顶层第一个 f>100 的字段值), 直接 parseTop, 别再找 192 */
function parseStall(resultHex) {
    const out = { price: 0, holding: 0, quotaLeft: 0, ownerGid: 0, ownerName: '' };
    if (!resultHex) return out;
    const f = parseTop(Buffer.from(resultHex, 'hex'));
    const info = findField(f, 1);
    if (!info || info.w !== 2) return out;
    const s = parseTop(info.v);
    out.price = toInt((findField(s, 1) || {}).v) || 0;
    out.holding = toInt((findField(s, 2) || {}).v) || 0;
    out.quotaLeft = toInt((findField(s, 3) || {}).v) || 0;
    const owner = findField(s, 4);
    if (owner && owner.w === 2) {
        const o = parseTop(owner.v);
        out.ownerGid = toInt((findField(o, 1) || {}).v) || 0;
        const nm = findField(o, 2);
        out.ownerName = nm && nm.w === 2 ? nm.v.toString('utf8') : '';
    }
    return out;
}

/** #197 兑换列表: repeated #1 {#1 slot, #2 price, #3 类型, #4 限购, #5 已购(?), #6 已购(?), #7 可见?}, #2 福币余额 */
function parseExchangeList(resultHex) {
    const out = { slots: [], coin: 0 };
    if (!resultHex) return out;
    const rf = parseTop(Buffer.from(resultHex, 'hex'));
    out.coin = toInt((findField(rf, 2) || {}).v) || 0;
    for (const x of rf) {
        if (x.f !== 1 || x.w !== 2) continue;
        const s = parseTop(x.v);
        out.slots.push({
            slot: toInt((findField(s, 1) || {}).v) || 0,
            price: toInt((findField(s, 2) || {}).v) || 0,
            type: toInt((findField(s, 3) || {}).v) || 0,
            limit: toInt((findField(s, 4) || {}).v) || 0,
            extra5: toInt((findField(s, 5) || {}).v) || 0,
            extra6: toInt((findField(s, 6) || {}).v) || 0,
            visible: !!(toInt((findField(s, 7) || {}).v)),
            // #7=1 的槽(实测槽5/槽10)是已解锁可兑换; 其余可见但 #7 缺失
        });
    }
    out.slots.sort((a, b) => a.slot - b.slot);
    return out;
}

/** #196 兑换结果: {#1 本次花费, #2 {#1 itemId, #2 count,...}, #3 福币余额, #4 ?, #5 ?} */
function parseExchangeResult(resultHex) {
    const got = [];
    let spend = 0;
    let coin = 0;
    const rf = resultFields({ resultHex });
    spend = toInt((findField(rf, 1) || {}).v) || 0;
    coin = toInt((findField(rf, 3) || {}).v) || 0;
    const gotMsg = findField(rf, 2);
    if (gotMsg && gotMsg.w === 2) {
        const g = parseTop(gotMsg.v);
        const itemId = toInt((findField(g, 1) || {}).v) || 0;
        const count = toInt((findField(g, 2) || {}).v) || 0;
        if (itemId) got.push({ id: itemId, count, name: itemName(itemId) });
    }
    return { spend, got, coin };
}

// ===== 只读 =====

/** 查状态(92): 传自己 gid = 查自己; **传好友 gid = 探测好友摊位价**(2026-11-25 假设, 待实测) */
async function getState(gidOverride = 0) {
    const gid = gidOverride ? toNum(gidOverride) : toNum(getUserState().gid);
    if (!gid) return { ok: false, reason: '未登录, 拿不到 gid' };
    const r = await op(CMD_GET_STATE, CMD_GET_STATE + FIELD_OFFSET, encodeVarintField(1, gid));
    if (!r.ok) return { ok: false, reason: `查状态失败 ${r.reason}`, gid };
    const state = parseMainState(r.activity);
    const stall = parseStall(r.resultHex);
    // 摊位 owner(#192#1#4#1) 服务端回显: 若 != 请求的 gid 说明查询被重定向(比如永远查自己)
    return { ok: state.ok, gid, state, stall, stallOwnerGid: stall.ownerGid || 0 };
}

/** 兑换列表(97) */
async function getExchangeList() {
    const r = await op(CMD_EXCHANGE_LIST, CMD_EXCHANGE_LIST + FIELD_OFFSET, Buffer.alloc(0));
    if (!r.ok) return { ok: false, reason: `兑换列表失败 ${r.reason}` };
    return { ok: true, ...parseExchangeList(r.resultHex) };
}

/** 今日信息(98): 剩余种子/持有/今日单价 */
async function getTodayInfo() {
    const r = await op(CMD_TODAY_INFO, CMD_TODAY_INFO + FIELD_OFFSET, Buffer.alloc(0));
    if (!r.ok) return { ok: false, reason: `今日信息失败 ${r.reason}` };
    const f = parseTop(Buffer.from(r.resultHex, 'hex'));
    const seedInfo = findField(f, 1);
    let seedId = ITEM_SEED;
    let seedLeft = 0;
    if (seedInfo && seedInfo.w === 2) {
        const s = parseTop(seedInfo.v);
        seedId = toInt((findField(s, 1) || {}).v) || ITEM_SEED;
        seedLeft = toInt((findField(s, 2) || {}).v) || 0;
    }
    return {
        ok: true,
        seedId,
        seedLeft,
        holding: toInt((findField(f, 2) || {}).v) || 0,
        todayPrice: toInt((findField(f, 3) || {}).v) || 0,
    };
}

// ===== 操作 =====

/** 领种子(91): 幂等 — #130#1 {#1:1}=已领则跳过 */
async function claimSeeds() {
    const before = await getState();
    if (!before.ok) return { ok: false, reason: before.reason || '查状态失败' };
    if (before.state.seedClaimed) return { ok: true, skipped: true, reason: '今天已领过种子' };

    const r = await op(CMD_CLAIM_SEED, CMD_CLAIM_SEED + FIELD_OFFSET, Buffer.alloc(0));
    if (!r.ok) {
        // code=1034177 "今日种子已领取" — 领取幂等: #130#1 标记滞后时以此兜底(实测 2026-11-25)
        if (r.errorCode === 1034177 || /今日种子已领取/.test(r.reason || '')) {
            return { ok: true, skipped: true, reason: '今天已领过种子' };
        }
        return { ok: false, reason: `领种子失败 ${r.reason}` };
    }
    // 结果 #191 = {#1 {#1: 20307, #2: 28}}
    let seedCount = 0;
    const f = findField(resultFields(r), 191);
    if (f && f.w === 2) {
        const inner = findField(parseTop(f.v), 1);
        if (inner && inner.w === 2) {
            seedCount = toInt((findField(parseTop(inner.v), 2) || {}).v) || 0;
        }
    }
    log('活动', `以薯换福: 领到红薯种子 ×${seedCount}`, {
        module: 'activity', event: '以薯换福', result: 'ok',
    });
    return { ok: true, seedCount };
}

/**
 * 卖蜜薯(93): count<=0 卖全部; targetGid 缺省=卖自己摊位, 传好友 gid = 卖到好友摊位
 * (2026-11-25 实测: cmd92 传好友 gid 可查好友摊位, cmd93 同理待实测)
 * 卖价 = 摊位基础价 + 卖家当前持有量(服务端算), 整批同价(抓包 30×264=7920 实证)
 * 响应 #193: {#1 实卖数, #2 单价, #3 总收入, #4 剩余接收额度, #5 福币余额}
 */
async function sellPotato(count = 0, targetGid = 0) {
    const myGid = toNum(getUserState().gid);
    if (!myGid) return { ok: false, reason: '未登录, 拿不到 gid' };
    const gid = targetGid ? toNum(targetGid) : myGid;
    if (!gid) return { ok: false, reason: '目标 gid 无效' };
    const cur = await getState();
    if (!cur.ok) return { ok: false, reason: cur.reason || '查状态失败' };
    const holding = cur.state.holding;
    if (holding <= 0) return { ok: true, skipped: true, reason: '没有蜜薯可卖' };
    const sellCount = toInt(count) > 0 ? Math.min(toInt(count), holding) : holding;

    const payloadBytes = Buffer.concat([encodeVarintField(1, gid), encodeVarintField(2, sellCount)]);
    const r = await op(CMD_SELL, CMD_SELL + FIELD_OFFSET, payloadBytes);
    if (!r.ok) return { ok: false, reason: `卖蜜薯失败 ${r.reason}`, targetGid: gid };
    const f = parseTop(Buffer.from(r.resultHex, 'hex'));
    const soldCount = toInt((findField(f, 1) || {}).v) || 0;
    const unitPrice = toInt((findField(f, 2) || {}).v) || 0;
    const income = toInt((findField(f, 3) || {}).v) || 0;
    const quotaLeft = toInt((findField(f, 4) || {}).v) || 0;
    const coin = toInt((findField(f, 5) || {}).v) || 0;
    if (soldCount > 0) {
        log('活动', `以薯换福: 卖出蜜薯 ×${soldCount} @${unitPrice} = +${income} 福气币 (余额 ${coin}, 摊位=${gid === myGid ? '自己' : `好友${gid}`})`, {
            module: 'activity', event: '以薯换福', result: 'ok', income,
        });
    }
    return { ok: true, soldCount, unitPrice, income, quotaLeft, coin, targetGid: gid, selfStall: gid === myGid };
}

/** 兑换(96): slot 来自 97 的 #1 slot (1..10); count 多数槽实测为 1 次 */
async function exchange(slot, count = 1) {
    const payloadBytes = Buffer.concat([
        encodeVarintField(1, toInt(slot)),
        encodeVarintField(2, Math.max(1, toInt(count) || 1)),
    ]);
    const r = await op(CMD_EXCHANGE, CMD_EXCHANGE + FIELD_OFFSET, payloadBytes);
    if (!r.ok) return { ok: false, reason: `兑换失败 ${r.reason}` };
    const { spend, got, coin } = parseExchangeResult(r.resultHex);
    const gotText = got.map((g) => `${g.name}×${g.count}`).join('、') || '空';
    log('活动', `以薯换福: 兑换成功 -${spend} 福气币 → ${gotText} (余额 ${coin})`, {
        module: 'activity', event: '以薯换福', result: 'ok',
    });
    return { ok: true, spend, got, coin };
}

// ===== 组合: 总览(页面) + 自动流程(interval) =====

/** 总览: 主状态 + 摊位 + 兑换列表 */
async function getOverview() {
    const st = await getState();
    if (!st.ok) return { ok: false, reason: st.reason || '查状态失败' };
    const list = await getExchangeList().catch(() => ({ ok: false, slots: [], coin: 0 }));
    return {
        ok: true,
        state: st.state,
        stall: st.stall,
        exchangeSlots: list.slots || [],
        coin: (list.coin || 0) || (st.state.coin || 0),
    };
}

/**
 * 自动流程(worker interval 调用):
 *   1. 领种子(幂等) — 领到后本轮直接结束, 种地交给下一轮 farm/手动
 *   2. 全卖蜜薯
 *   3. (可选)按 exchangeRules [{slot, count}] 兑换
 * 返回 { ok, claimed, soldCount, income, exchanged }
 */
async function runAuto(cfg = {}, breaker = null) {
    const out = { claimed: 0, soldCount: 0, income: 0, exchanged: [] };
    try {
        if (cfg.claimSeed !== false) {
            const r = await claimSeeds();
            if (!r.ok) {
                if (breaker) breaker.failure();
                return { ok: false, reason: r.reason };
            }
            if (!r.skipped) out.claimed = r.seedCount || 0;
        }
        if (cfg.sell !== false) {
            const r = await sellPotato(0);
            if (!r.ok) {
                if (breaker) breaker.failure();
                return { ok: false, reason: r.reason };
            }
            if (!r.skipped) {
                out.soldCount = r.soldCount || 0;
                out.income = r.income || 0;
            }
        }
        if (cfg.autoExchange && Array.isArray(cfg.exchangeRules) && cfg.exchangeRules.length > 0) {
            const list = await getExchangeList();
            if (list.ok) {
                for (const rule of cfg.exchangeRules) {
                    const slot = toInt(rule && rule.slot);
                    let remaining = toInt(rule && rule.count) || 1;
                    if (!slot || remaining <= 0) continue;
                    const s = list.slots.find((x) => x.slot === slot);
                    if (!s) continue;
                    while (remaining > 0) {
                        const r = await exchange(slot, 1);
                        if (!r.ok) {
                            out.exchanged.push({ slot, error: r.reason });
                            break;
                        }
                        out.exchanged.push({ slot, spend: r.spend, got: r.got });
                        remaining -= 1;
                        if (out.exchanged.filter((x) => x.slot === slot).length >= s.limit) break;
                    }
                }
            }
        }
        return { ok: true, ...out };
    } catch (e) {
        if (breaker) breaker.failure();
        return { ok: false, reason: e.message };
    }
}

// ===== 好友摊位探测(2026-11-25 加: 多账号互卖分析) =====

/**
 * cmd92 传好友 gid 探测好友摊位。
 * 假设: 请求 {#1: 好友gid} → #192 回好友的摊位(价格/持有/额度/owner回显)。
 * 失败可能性: 服务端强制按登录者处理(owner==自己) 或 errorCode 非零 → 按"不能查"处理。
 */
async function getFriendStall(friendGid) {
    const fg = toNum(friendGid);
    if (!fg) return { ok: false, reason: '好友 gid 无效' };
    const r = await getState(fg);
    if (!r.ok) return { ok: false, gid: fg, reason: r.reason };
    // #130 是请求 gid 对应的玩家状态(含摊位); owner 回显用于判断服务端是否照查
    return {
        ok: true,
        gid: fg,
        queryGid: r.gid,
        stallOwnerGid: r.stallOwnerGid,
        redirected: r.stallOwnerGid > 0 && r.stallOwnerGid !== fg, // true = 服务端无视了好友gid
        state: r.state,
        stall: r.stall,
    };
}

/**
 * 批量探测好友摊位价 → {best, rows}。
 * rows: [{gid, name, ok, price, holding, quotaLeft, redirected, reason}]
 * best: 价格最高的可卖目标(不重定向 + 额度>0), null = 没人能卖。
 */
async function probeFriendStalls(friends, { maxProbe = 50 } = {}) {
    const list = (Array.isArray(friends) ? friends : [])
        .map((f) => ({ gid: toNum(f && f.gid), name: String((f && f.name) || (f && f.nick) || '') }))
        .filter((f) => f.gid > 0)
        .slice(0, maxProbe);
    const rows = [];
    for (const f of list) {
        const r = await getFriendStall(f.gid);
        rows.push({
            gid: f.gid,
            name: f.name,
            ok: r.ok,
            price: r.ok ? (r.stall.price || 0) : 0,
            holding: r.ok ? (r.stall.holding || 0) : 0,
            quotaLeft: r.ok ? (r.stall.quotaLeft || 0) : 0,
            redirected: !!r.redirected,
            reason: r.ok ? '' : (r.reason || ''),
        });
    }
    const sellable = rows.filter((x) => x.ok && !x.redirected && x.quotaLeft > 0);
    sellable.sort((a, b) => b.price - a.price);
    return { rows, best: sellable[0] || null };
}

module.exports = {
    ACTIVITY_GROUP,
    FIELD_OFFSET,
    CMD_CLAIM_SEED,
    CMD_GET_STATE,
    CMD_SELL,
    CMD_EXCHANGE,
    CMD_EXCHANGE_LIST,
    CMD_TODAY_INFO,
    ITEM_SEED,
    ITEM_FRUIT,
    ITEM_POTATO,
    ITEM_COIN,
    LOCAL_ITEM_NAMES,
    itemName,
    getState,
    getFriendStall,
    probeFriendStalls,
    getExchangeList,
    getTodayInfo,
    claimSeeds,
    sellPotato,
    exchange,
    getOverview,
    runAuto,
    __testing: { parseMainState, parseStall, parseExchangeList, parseExchangeResult, op },
};
