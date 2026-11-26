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

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { log } = require('../utils/utils');
const { toNum, toInt } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');
const { getDataFile } = require('../config/runtime-paths');
const { getUserState, sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { operateRaw, parseTop, findField } = require('./mengchong');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');
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

/**
 * 兑换槽位 → 商品 (客户端静态配置 MapleMarketGoodsConfig, 2026-11-25 解出)。
 * cmd97 兑换列表不带 itemId/名称, 官方客户端从这份配置渲染; 配置内容 XOR
 * NQF_SHANGXIANDAMAI_#2026_SECURE 后藏在 mainscene bundle 的 TextAsset 里(已还原)。
 * item_list "id:count" → 兑换得到的物品; 兑换成功还会动态学习(learnSlotGoods)兜底。
 */
const EXCHANGE_SLOT_GOODS = {
    1: { name: '七彩花弦', itemId: 204013, count: 1 },
    2: { name: '福气金豆礼包', itemId: 101627, count: 1 },
    3: { name: '金币果', itemId: 20522, count: 1 },
    4: { name: '经验蘑菇', itemId: 20523, count: 1 },
    5: { name: '有机化肥(1小时)', itemId: 80011, count: 1 },
    6: { name: '南瓜种子礼包', itemId: 101620, count: 1 },
    7: { name: '荷风种子礼包', itemId: 101621, count: 1 },
    8: { name: '千星种子礼包', itemId: 101622, count: 1 },
    9: { name: '萌宠种子礼包', itemId: 101623, count: 1 },
    10: { name: '化肥(1小时)', itemId: 80001, count: 1 },
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
        holding: 0,           // #6 摊上存量(⚠ 不是背包数量! 2026-11-26 实测 <背包 986~1467)
        totalIncome: 0,       // #7 累计收益
        raw130: '',           // 调试: #130 原始 hex
    };
    if (!activityBuf || !activityBuf.length) return out;
    try {
        // ⚠ 2026-11-26: Operate 的 activity 容器里装的是 **#130** 这个子消息,
        //   旧代码直接在顶层找 #1/#3/#5 所以永远读到 0(线上 1/3/4 号全 0 实证)。
        //   这里先下钻 #130, 找不到再退回顶层(兼容旧结构)。
        let f = parseTop(activityBuf);
        const inner = findField(f, 130);
        if (inner && inner.w === 2) {
            out.raw130 = inner.v.toString('hex');
            f = parseTop(inner.v);
        } else {
            out.raw130 = Buffer.from(activityBuf).toString('hex');
        }
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
        const slot = toInt((findField(s, 1) || {}).v) || 0;
        const goods = EXCHANGE_SLOT_GOODS[slot] || null;
        out.slots.push({
            slot,
            price: toInt((findField(s, 2) || {}).v) || 0,
            type: toInt((findField(s, 3) || {}).v) || 0,
            limit: toInt((findField(s, 4) || {}).v) || 0,
            extra5: toInt((findField(s, 5) || {}).v) || 0,
            extra6: toInt((findField(s, 6) || {}).v) || 0,
            visible: !!(toInt((findField(s, 7) || {}).v)),
            // 商品信息(cmd97 不带, 静态配置 + 兑换回执学习)
            goodsId: goods ? goods.itemId : 0,
            goodsName: goods ? goods.name : '',
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

/** 兑换槽位配置兜底: 静态表缺失时(配置变了), 用兑换回执学到的 itemId 补表 */
function learnSlotGoods(slot, itemId, count) {
    const s = toInt(slot);
    const id = toInt(itemId);
    if (!s || !id) return;
    const cur = EXCHANGE_SLOT_GOODS[s];
    if (!cur) {
        EXCHANGE_SLOT_GOODS[s] = { name: itemName(id), itemId: id, count: toInt(count) || 1 };
    } else if (cur.itemId !== id) {
        // 服务端配置变了: 物品 id 以实际回执为准, 名称尝试从 ItemInfo 拿
        cur.itemId = id;
        cur.count = toInt(count) || 1;
        cur.name = itemName(id) || cur.name;
    }
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
    // 2026-11-26 线上实测(1/3/4 号): #2=摊上存量(与 #192#1#2 一致), #3=**实卖单价**(=基础价+存量),
    //   #5=累计收益。例: 北栎 基础167+存量33=200 / 南桉 114+66=180 / 哈哈 90+33=123。
    return {
        ok: true,
        seedId,
        seedLeft,
        stallHolding: toInt((findField(f, 2) || {}).v) || 0,
        todayPrice: toInt((findField(f, 3) || {}).v) || 0,
        totalIncome: toInt((findField(f, 5) || {}).v) || 0,
        holding: toInt((findField(f, 2) || {}).v) || 0,
    };
}

// ===== 分享暴击 (ShareService.ReportShare) =====
// 2026-11-26 从抓包 20261125-105437 / 20261125-115051「新活动」定案:
//   分享收购价 → ReportShare { #1 share_type=28, #4 scene=2017 }
//   回包 result: { code=28, reward{#1=2} } + { code=1, reward{#1=8,#2=1} } + { code=102, reward{} }
//   每日首次成功分享触发一次暴击涨价(0 点清零), 服务端直接改当日收购价, 无需领奖。
//   参考其它活动 scene: 每日分享任务 42 / 微信礼包 0 / 奶茶 2009 / 快乐不独享 2004 / 牧场 2101、2201。
const SHARE_TYPE_MAPLE = 28;
const SHARE_SCENE_MAPLE = 2017;

/** 每个 worker 进程只服务一个账号 → 模块级变量即"本账号"状态 */
let lastShareDay = '';
function dayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 上报「分享收购价」→ 触发当日分享暴击。
 * 幂等: 当天重复调用服务端只累加分享次数, 不会重复加价(实测 f1 1→2 价格不变),
 * 所以进程内按天去重, 别每 20 分钟的自动流程都发一次; 手动按钮传 force=true 强制重发。
 *
 * 回包 code=28 的 reward#1 是**今日分享次数**(不是暴击值), 所以暴击效果只能靠
 * 分享前后 #130#5(今日基础价) 的差值来判定 —— 抓包两天(1/3 号)分享前后 #5 都没变,
 * 说明当日暴击此前已生效; 真·首分享日的对照由本函数自己打点。
 * @param {{force?:boolean}} [opt] force=true 忽略当天去重
 * @returns {object} {ok, crit, shareCount, basePriceBefore, basePriceAfter, skipped?, results?, reason?}
 */
async function reportShareCrit(opt = {}) {
    if (!opt.force && lastShareDay === dayKey()) {
        return { ok: true, skipped: true, crit: 0, shareCount: 0, basePriceBefore: 0, basePriceAfter: 0, reason: '今天已分享过' };
    }
    let before = null;
    try {
        before = await getState();
    } catch { /* 打点失败不影响上报 */ }
    const basePriceBefore = before && before.ok ? toInt(before.state.basePrice) : 0;

    const req = types.ReportShareRequest.create({
        share_type: SHARE_TYPE_MAPLE,
        scene: SHARE_SCENE_MAPLE,
    });
    const body = types.ReportShareRequest.encode(req).finish();
    let reply;
    try {
        const r = await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', body);
        reply = types.ReportShareReply.decode(r.body);
    } catch (e) {
        return { ok: false, crit: 0, shareCount: 0, basePriceBefore, basePriceAfter: basePriceBefore, reason: `分享上报失败: ${String((e && e.message) || e).slice(0, 80)}` };
    }
    const results = (reply.result || []).map((x) => ({
        code: Number(x.code) || 0,
        reward: x.reward ? { f1: Number(x.reward.field1) || 0, f2: Number(x.reward.field2) || 0 } : null,
    }));
    // 本活动的 result code=28; reward#1 = 今日分享次数
    const mine = results.find((x) => x.code === SHARE_TYPE_MAPLE) || null;
    const shareCount = mine && mine.reward ? mine.reward.f1 : 0;

    // 分享后重读基础价: 暴击生效 → #130#5 上涨, 差值就是暴击量
    let basePriceAfter = basePriceBefore;
    try {
        const after = await getState();
        if (after && after.ok) basePriceAfter = toInt(after.state.basePrice) || 0;
    } catch { /* 忽略 */ }
    const crit = basePriceAfter > basePriceBefore ? basePriceAfter - basePriceBefore : 0;
    if (mine) lastShareDay = dayKey();

    log('活动', `以薯换福: 分享收购价上报 → 今日第${shareCount}次, 基础价 ${basePriceBefore}→${basePriceAfter}${crit > 0 ? ` (暴击+${crit})` : ''}`, {
        module: 'activity', event: '以薯换福', result: mine ? 'ok' : 'skip',
    });
    return { ok: !!mine, crit, shareCount, basePriceBefore, basePriceAfter, results };
}

/** 背包蜜薯(1032)/红薯种子(20307)数量 —— 游戏 UI「拥有蜜薯」同源; 读不到时 potato=-1 */
async function getBagCounts() {
    try {
        const wh = require('./warehouse');
        const bag = await wh.getBag();
        const items = wh.getBagItems(bag) || [];
        let potato = 0;
        let seed = 0;
        for (const it of items) {
            const id = toInt(it && it.id);
            const n = toInt(it && it.count) || 0;
            if (id === ITEM_POTATO) potato += n;
            else if (id === ITEM_SEED) seed += n;
        }
        return { potato, seed };
    } catch {
        return { potato: -1, seed: -1 };
    }
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

// ===== 出售记录 (2026-11-26: 卖了多少钱 / 单价多少 / 卖给谁) =====
// 持久化: data/maple-sell-records/<账号id>.json —— worker 一账号一进程(FARM_ACCOUNT_ID 区分),
// 只记**真卖出去**的批次(soldCount>0); 失败/空仓/跳过不落盘, 免得刷屏。
const SELL_RECORD_LIMIT = 500;
/** 一次卖薯最多补几刀(服务端单次上限未知, 回执 #1 是实卖数, 按差额续卖) */
const MAX_SELL_ROUNDS = 8;
let sellRecordsCache = null;

function sellRecordsFile() {
    const accountId = String(process.env.FARM_ACCOUNT_ID || 'default').replace(/[^\w-]/g, '_');
    return getDataFile(path.join('maple-sell-records', `${accountId}.json`));
}

function loadSellRecords() {
    if (sellRecordsCache) return sellRecordsCache;
    sellRecordsCache = [];
    try {
        const file = sellRecordsFile();
        if (fs.existsSync(file)) {
            const j = readJsonFile(file, () => ({ records: [] }));
            if (j && Array.isArray(j.records)) sellRecordsCache = j.records;
        }
    } catch {
        sellRecordsCache = [];
    }
    return sellRecordsCache;
}

function saveSellRecords() {
    try {
        writeJsonFileAtomic(sellRecordsFile(), {
            records: loadSellRecords().slice(-SELL_RECORD_LIMIT),
            updatedAt: Date.now(),
        });
    } catch (e) {
        log('活动', `以薯换福: 保存出售记录失败: ${e.message}`, { module: 'activity', event: '以薯换福', result: 'error' });
    }
}

/** gid → 昵称: 自己的号用登录昵称, 其余查固定目标表, 都没有就留 gid */
function nameOfGid(gid, myGid) {
    const g = toNum(gid);
    if (!g) return '未知';
    if (g === toNum(myGid)) return getUserState().name || '自己';
    const hit = SELL_TARGET_GIDS.find((t) => t.gid === g);
    return hit ? hit.name : `gid:${g}`;
}

/**
 * 追加一条出售记录。
 * @param {object} entry soldCount/unitPrice/income/targetGid/stallBasePrice/stallHolding/quotaLeft/coin/source
 * @returns {object} 落盘的记录
 */
function addSellRecord(entry = {}) {
    const myGid = toNum(getUserState().gid);
    const list = loadSellRecords();
    const rec = {
        at: Date.now(),
        soldCount: toInt(entry.soldCount) || 0,
        unitPrice: toInt(entry.unitPrice) || 0,
        income: toInt(entry.income) || 0,
        targetGid: toNum(entry.targetGid) || 0,
        targetName: '',
        selfStall: false,
        stallBasePrice: entry.stallBasePrice == null ? null : toInt(entry.stallBasePrice),
        stallHolding: entry.stallHolding == null ? null : toInt(entry.stallHolding),
        quotaLeft: toInt(entry.quotaLeft) || 0,
        coinAfter: toInt(entry.coin) || 0,
        source: entry.source === 'auto' ? 'auto' : 'manual',
    };
    rec.selfStall = !rec.targetGid || rec.targetGid === myGid;
    rec.targetName = entry.targetName || nameOfGid(rec.targetGid || myGid, myGid);
    list.push(rec);
    if (list.length > SELL_RECORD_LIMIT) list.splice(0, list.length - SELL_RECORD_LIMIT);
    saveSellRecords();
    return rec;
}

function dayKeyOf(ts) {
    const d = new Date(ts || Date.now());
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 出售记录列表(最新在前) + 汇总
 * @param {{limit?:number, offset?:number}} [options]
 * @returns {object} {records, total, summary:{todayCount,todayIncome,todayBatches,count,income,targets}}
 */
function listSellRecords(options = {}) {
    const limit = Math.min(Math.max(toInt(options.limit) || 50, 1), SELL_RECORD_LIMIT);
    const offset = Math.max(toInt(options.offset) || 0, 0);
    const all = loadSellRecords()
        .map((r, i) => ({ r, i }))
        .sort((a, b) => ((b.r.at || 0) - (a.r.at || 0)) || (b.i - a.i))
        .map((x) => x.r);
    const today = dayKeyOf();
    const todayRows = all.filter((r) => dayKeyOf(r.at) === today);
    const sum = (rows, key) => rows.reduce((n, r) => n + (toInt(r[key]) || 0), 0);
    // 按摊位汇总(卖给谁的分布)
    const targets = {};
    for (const r of all) {
        const k = r.targetName || `gid:${r.targetGid}`;
        if (!targets[k]) targets[k] = { name: k, count: 0, income: 0 };
        targets[k].count += toInt(r.soldCount) || 0;
        targets[k].income += toInt(r.income) || 0;
    }
    return {
        records: all.slice(offset, offset + limit),
        total: all.length,
        summary: {
            todayCount: sum(todayRows, 'soldCount'),
            todayIncome: sum(todayRows, 'income'),
            todayBatches: todayRows.length,
            count: sum(all, 'soldCount'),
            income: sum(all, 'income'),
            targets: Object.values(targets).sort((a, b) => b.income - a.income),
        },
    };
}

function clearSellRecords() {
    sellRecordsCache = [];
    saveSellRecords();
    return { ok: true };
}

/**
 * 卖蜜薯(93): count<=0 卖全部; targetGid 缺省=卖自己摊位, 传好友 gid = 卖到好友摊位
 * (2026-11-25 实测: cmd92 传好友 gid 可查好友摊位, cmd93 同理待实测)
 * 卖价 = 摊位基础价 + 卖家当前持有量(服务端算), 整批同价(抓包 30×264=7920 实证)
 * 响应 #193: {#1 实卖数, #2 单价, #3 总收入, #4 剩余接收额度, #5 福币余额}
 *
 * ⚠ 2026-11-26 修: 可卖数量必须取**背包 1032 总数**, 不能用 `#130#6` ——
 *   #6 是**摊上存量**(实测四个号 33/66), 而背包有 986~1467 个, 旧代码每次只卖 33 个,
 *   账号1 1290 个卖完只剩 1257(=1290-33) 就是铁证。服务端若一次卖不完(回执 #1 < 请求数),
 *   本函数按剩余量继续补刀, 最多 MAX_SELL_ROUNDS 轮, 每轮单独记一条出售记录(单价会随存量涨)。
 *
 * @param {number} [count] 数量, <=0 卖全部
 * @param {number} [targetGid] 卖到哪个摊, 0=自己摊
 * @param {{source?:string, targetName?:string, stallBasePrice?:number, stallHolding?:number}} [ctx]
 *        source = auto/manual; 摊位快照由调用方(比价探测)带进来, 缺省用自己摊的 #130 值
 * @returns {Promise<object>} {ok, soldCount, unitPrice, income, quotaLeft, coin, targetGid, selfStall, records}
 */
async function sellPotato(count = 0, targetGid = 0, ctx = {}) {
    const myGid = toNum(getUserState().gid);
    if (!myGid) return { ok: false, reason: '未登录, 拿不到 gid' };
    const gid = targetGid ? toNum(targetGid) : myGid;
    if (!gid) return { ok: false, reason: '目标 gid 无效' };
    const cur = await getState();
    if (!cur.ok) return { ok: false, reason: cur.reason || '查状态失败' };
    // 背包蜜薯(1032) = 游戏 UI「拥有蜜薯」同源; 读不到背包时退回 #130#6(至少别不动)
    const bag = await getBagCounts();
    const available = bag.potato > 0 ? bag.potato : cur.state.holding;
    if (available <= 0) return { ok: true, skipped: true, reason: '没有蜜薯可卖' };
    const want = toInt(count) > 0 ? Math.min(toInt(count), available) : available;

    const selfStall = gid === myGid;
    // 卖到别人摊且调用方没带摊位快照(手动卖): 补一次探测, 记录里才有基础价/存量和摊主昵称
    if (!selfStall && ctx.stallBasePrice == null) {
        try {
            const fs2 = await getFriendStall(gid);
            if (fs2.ok && fs2.stall && !fs2.redirected) {
                ctx.stallBasePrice = ctx.stallBasePrice != null ? ctx.stallBasePrice : fs2.stall.price;
                ctx.stallHolding = ctx.stallHolding != null ? ctx.stallHolding : fs2.stall.holding;
                if (!ctx.targetName && fs2.stall.ownerName) ctx.targetName = fs2.stall.ownerName;
            }
        } catch { /* 探测失败不影响卖 */ }
    }
    const targetName = ctx.targetName || nameOfGid(gid, myGid);
    const records = [];
    let remaining = want;
    let rounds = 0;
    let soldTotal = 0;
    let incomeTotal = 0;
    let unitPrice = 0;
    let quotaLeft = 0;
    let coin = 0;

    while (remaining > 0 && rounds < MAX_SELL_ROUNDS) {
        rounds += 1;
        const payloadBytes = Buffer.concat([encodeVarintField(1, gid), encodeVarintField(2, remaining)]);
        const r = await op(CMD_SELL, CMD_SELL + FIELD_OFFSET, payloadBytes);
        if (!r.ok) {
            if (soldTotal > 0) break; // 已卖掉一部分, 剩下的下轮再说
            return { ok: false, reason: `卖蜜薯失败 ${r.reason}`, targetGid: gid };
        }
        const f = parseTop(Buffer.from(r.resultHex, 'hex'));
        const soldCount = toInt((findField(f, 1) || {}).v) || 0;
        unitPrice = toInt((findField(f, 2) || {}).v) || 0;
        const income = toInt((findField(f, 3) || {}).v) || 0;
        quotaLeft = toInt((findField(f, 4) || {}).v) || 0;
        coin = toInt((findField(f, 5) || {}).v) || 0;
        if (soldCount <= 0) break; // 服务端不给卖了(额度满/没货), 别死循环

        soldTotal += soldCount;
        incomeTotal += income;
        remaining -= soldCount;
        // 出售记录: 数量/单价/收入/卖给谁 + 当时的摊位价构成(基础价+存量)
        records.push(addSellRecord({
            soldCount,
            unitPrice,
            income,
            targetGid: gid,
            targetName,
            stallBasePrice: ctx.stallBasePrice != null ? ctx.stallBasePrice : (selfStall ? cur.state.basePrice : null),
            stallHolding: ctx.stallHolding != null ? ctx.stallHolding : (selfStall ? cur.state.holding : null),
            quotaLeft,
            coin,
            source: ctx.source,
        }));
        log('活动', `以薯换福: 卖出蜜薯 ×${soldCount} @${unitPrice} = +${income} 福气币 (余额 ${coin}, 卖给=${targetName}${selfStall ? '(自己摊)' : ''}${remaining > 0 ? `, 还剩 ${remaining}` : ''})`, {
            module: 'activity', event: '以薯换福', result: 'ok', income,
        });
    }

    return {
        ok: true,
        soldCount: soldTotal,
        unitPrice,
        income: incomeTotal,
        quotaLeft,
        coin,
        targetGid: gid,
        targetName,
        selfStall,
        remaining,
        records,
        record: records[0] || null,
    };
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
    // 静态商品表兜底: 回执里的 itemId 与表不一致(或表缺槽位)时动态修正
    if (got[0]) learnSlotGoods(slot, got[0].id, got[0].count);
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
    const today = await getTodayInfo().catch(() => ({ ok: false }));
    const bag = await getBagCounts();

    // ⭐ 2026-11-26 线上校准(#130 三个字段全 0, 面板数据全错):
    //   持有蜜薯 = 背包 1032 总量(游戏 UI「拥有蜜薯」同源, 实测北栎 1290)
    //   今日基础价 = #192#1#1 摊位基础价(游戏 UI「今日蜜薯收购价 普通 167」)
    //   实卖单价 = cmd98#3(= 基础价 + 摊上存量, 实测 167+33=200)
    //   累计收益 = cmd98#5(实测 11976/15789/13666)
    const state = { ...st.state };
    const stallPrice = Number(st.stall && st.stall.price) || 0;
    const stallHolding = Number(st.stall && st.stall.holding) || 0;
    if (bag.potato >= 0) state.holding = bag.potato;
    state.bagSeedCount = bag.seed >= 0 ? bag.seed : null;
    state.stallHolding = today.ok && today.stallHolding ? today.stallHolding : stallHolding;
    if (stallPrice > 0) state.basePrice = stallPrice;
    state.sellPrice = (today.ok && today.todayPrice) || (state.basePrice + state.stallHolding) || 0;
    if (today.ok && today.totalIncome) state.totalIncome = today.totalIncome;
    if (today.ok) {
        state.seedLeft = today.seedLeft;
        state.seedId = today.seedId;
    }
    return {
        ok: true,
        state,
        stall: st.stall,
        exchangeSlots: list.slots || [],
        coin: (list.coin || 0) || (st.state.coin || 0),
        // 本账号出售记录汇总(今日/累计), 来自 data/maple-sell-records/<id>.json
        sellSummary: listSellRecords({ limit: 1 }).summary,
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
    const out = { claimed: 0, planted: 0, soldCount: 0, income: 0, exchanged: [], shareCrit: 0 };
    try {
        if (cfg.claimSeed !== false) {
            const r = await claimSeeds();
            if (!r.ok) {
                if (breaker) breaker.failure();
                return { ok: false, reason: r.reason };
            }
            if (!r.skipped) {
                out.claimed = r.seedCount || 0;
            }
        }
        // 种红薯: 每轮都尝试(内部幂等: 背包没 20307 或没空地直接 skip),
        // 存货+空地释放后下一轮自动补种
        if (cfg.plant !== false) {
            const r = await plantMapleSeeds();
            if (r.ok && !r.skipped) out.planted = r.planted || 0;
        }
        // 分享暴击(2026-11-26): 每日首次上报即涨价, 幂等; 放在卖之前, 当轮就吃到暴击价
        if (cfg.share !== false) {
            try {
                const r = await reportShareCrit();
                if (r.ok) out.shareCrit = r.crit || 0;
            } catch { /* 分享失败不挡卖 */ }
        }
        if (cfg.sell !== false) {
            // 找最高价的卖(2026-11-25): 探测自己几个号的摊位, 谁价高卖谁;
            // 没有比价结果(全离线/额度0)兜底卖自己摊。
            let targetGid = 0;
            let targetNote = '';
            const sellCtx = { source: 'auto' };
            try {
                const p = await probeSellTargets();
                if (p.best) {
                    targetGid = p.best.gid;
                    targetNote = `→${p.best.name}(现价${p.best.effPrice}=${p.best.basePrice}基础+${p.best.holding}存量)`;
                    sellCtx.targetName = p.best.name;
                    sellCtx.stallBasePrice = p.best.basePrice;
                    sellCtx.stallHolding = p.best.holding;
                }
            } catch { /* 探测失败不挡卖, 走自己摊 */ }
            const r = await sellPotato(0, targetGid, sellCtx);
            if (!r.ok) {
                if (breaker) breaker.failure();
                return { ok: false, reason: r.reason };
            }
            if (!r.skipped) {
                out.soldCount = r.soldCount || 0;
                out.income = r.income || 0;
                out.sellTarget = targetNote || `自己摊(${r.targetName || ''})`;
                out.unitPrice = r.unitPrice || 0;
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
 * 自动卖目标 = 自己登录的几个号(2026-11-25 定案基础价):
 *   哈哈200 / 润出去142 / 南桕110 / 北栕99 / 你玩得像蔡徐坤一样88
 * QQ/微信好友列表不互通, 但 cmd92/93 传任意 gid 都通(跨平台实测), 不需要好友关系。
 */
const SELL_TARGET_GIDS = [
    { gid: 1253397809, name: '哈哈' },
    { gid: 1097422979, name: '润出去' },
    { gid: 1244632861, name: '南桕' },
    { gid: 1229231763, name: '北栕' },
    { gid: 1226530474, name: '你玩得像蔡徐坤一样' },
];

/**
 * 探测固定目标摊位(SELL_TARGET_GIDS, 排除自己) → 最高价可卖目标。
 * 实卖单价 = 摊主基础价 + 摊上当前总量(effPrice), 2026-11-25 定案; 只比基础价会选错目标
 * (例: 北栕 99+165=264 > 哈哈 200)。
 * best null = 别的摊都不可卖(离线/额度0/重定向), 兜底卖自己摊。
 */
async function probeSellTargets() {
    const myGid = toNum(getUserState().gid);
    const rows = [];
    for (const t of SELL_TARGET_GIDS) {
        if (t.gid === myGid) continue; // 自己摊做兜底, 不参与比价
        const r = await getFriendStall(t.gid);
        const base = r.ok ? ((r.stall && r.stall.price) || 0) : 0;
        const hold = r.ok ? ((r.stall && r.stall.holding) || 0) : 0;
        rows.push({
            gid: t.gid,
            name: t.name,
            ok: r.ok,
            basePrice: base,
            holding: hold,
            effPrice: base + hold,
            quotaLeft: r.ok ? ((r.stall && r.stall.quotaLeft) || 0) : 0,
            redirected: !!r.redirected,
            reason: r.ok ? '' : (r.reason || ''),
        });
    }
    const sellable = rows.filter((x) => x.ok && !x.redirected && x.quotaLeft > 0);
    sellable.sort((a, b) => b.effPrice - a.effPrice);
    return { ok: true, rows, best: sellable[0] || null };
}

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
 * rows: [{gid, name, ok, basePrice, holding, effPrice, quotaLeft, redirected, reason}]
 * best: 实卖价(基础+摊上总量)最高的可卖目标(不重定向 + 额度>0), null = 没人能卖。
 */
async function probeFriendStalls(friends, { maxProbe = 50 } = {}) {
    const list = (Array.isArray(friends) ? friends : [])
        .map((f) => ({ gid: toNum(f && f.gid), name: String((f && f.name) || (f && f.nick) || '') }))
        .filter((f) => f.gid > 0)
        .slice(0, maxProbe);
    const rows = [];
    for (const f of list) {
        const r = await getFriendStall(f.gid);
        const base = r.ok ? (r.stall.price || 0) : 0;
        const hold = r.ok ? (r.stall.holding || 0) : 0;
        rows.push({
            gid: f.gid,
            name: f.name,
            ok: r.ok,
            basePrice: base,
            holding: hold,
            effPrice: base + hold,
            quotaLeft: r.ok ? (r.stall.quotaLeft || 0) : 0,
            redirected: !!r.redirected,
            reason: r.ok ? '' : (r.reason || ''),
        });
    }
    const sellable = rows.filter((x) => x.ok && !x.redirected && x.quotaLeft > 0);
    sellable.sort((a, b) => b.effPrice - a.effPrice);
    return { rows, best: sellable[0] || null };
}

// ===== 红薯种植(2026-11-25 加: 20307 不进通用种植优先级, 活动流程自己种) =====

/**
 * 把背包里的红薯种子(20307)种到空地。
 * 复用 farm 的 plantSeeds/analyzeLands; 只种 status=empty 的地, 不动牧草/其它策略的排程。
 * 空地不够时剩余种子留给下一轮(地块释放后再种)。
 */
async function plantMapleSeeds() {
    const farm = require('./farm');
    const { getBagSeeds } = require('./warehouse');
    let seeds;
    try {
        seeds = await getBagSeeds();
    } catch (e) {
        return { ok: false, reason: `读背包种子失败: ${e.message}` };
    }
    const potatoSeed = (seeds || []).find((s) => Number(s.seedId) === ITEM_SEED);
    const have = potatoSeed ? toInt(potatoSeed.count) : 0;
    if (have <= 0) return { ok: true, skipped: true, reason: '背包没有红薯种子' };

    const landsReply = await farm.getAllLands();
    const status = farm.analyzeLands ? farm.analyzeLands(landsReply.lands || []) : null;
    const emptyIds = status && Array.isArray(status.empty) ? status.empty : [];
    if (emptyIds.length === 0) return { ok: true, skipped: true, reason: `没有空地(种子 ${have} 个待种)` };

    const plantCount = Math.min(have, emptyIds.length);
    const r = await farm.plantSeeds(ITEM_SEED, emptyIds.slice(0, plantCount));
    if (r.planted > 0) {
        log('活动', `以薯换福: 种下红薯种子 ×${r.planted} (背包余 ${have - r.planted})`, {
            module: 'activity', event: '以薯换福', result: 'ok',
        });
    }
    return {
        ok: true,
        planted: r.planted || 0,
        remaining: Math.max(0, have - (r.planted || 0)),
        hadRealError: !!r.hadRealError,
    };
}

/**
 * 探测任意活动组的 Operate(cmd+100), 只读用途: 找回兑换商品 itemId 等静态配置外的东西。
 * 返回 [{cmd, errorCode, len, fieldsDump}]; 失败的 cmd 带原因。
 */
async function probeShopGroup(group, cmds = [1, 2, 3, 96, 97, 98], payload = null) {
    const { operateRaw, parseTop: pt } = require('./mengchong');
    // 可选 payload: {slot, count} → {#1 slot, #2 count}(兑换类 cmd 的请求结构)
    let payloadBytes = Buffer.alloc(0);
    if (payload && toNum(payload.slot) > 0) {
        payloadBytes = Buffer.concat([
            encodeVarintField(1, toNum(payload.slot)),
            encodeVarintField(2, Math.max(1, toNum(payload.count) || 1)),
        ]);
    }
    const out = [];
    for (const cmd of cmds) {
        try {
            const r = await enqueueActivityRequest(() => operateRaw(toNum(group), cmd, cmd + FIELD_OFFSET, payloadBytes));
            const hex = r.resultHex || '';
            let dump = '';
            try {
                const top = pt(Buffer.from(hex, 'hex'));
                dump = JSON.stringify(top.slice(0, 30).map((x) => ({
                    f: x.f,
                    w: x.w,
                    v: x.w === 0 ? toInt(x.v) : (x.v.length <= 64 ? x.v.toString('utf8').slice(0, 64) : `<${x.v.length}B>`),
                })));
            } catch { dump = ''; }
            out.push({ cmd, errorCode: toInt(r.errorCode), len: hex.length / 2, dump, activityHex: r.activity ? r.activity.toString('hex') : '' });
        } catch (e) {
            out.push({ cmd, error: String(e.message).slice(0, 80) });
        }
    }
    return { ok: true, group, results: out };
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
    probeSellTargets,
    plantMapleSeeds,
    getExchangeList,
    getTodayInfo,
    reportShareCrit,
    SHARE_TYPE_MAPLE,
    SHARE_SCENE_MAPLE,
    claimSeeds,
    sellPotato,
    exchange,
    getOverview,
    runAuto,
    probeShopGroup,
    listSellRecords,
    clearSellRecords,
    __testing: {
        parseMainState, parseStall, parseExchangeList, parseExchangeResult, op,
        addSellRecord, loadSellRecords, sellRecordsFile, nameOfGid,
    },
};
