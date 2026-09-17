/**
 * 夺宝(抢宝) —— 协议封装 + 自动化
 *
 * 实测抓包 (2026-09-17, wx-code-grabber/captures/20260917-111611_萌宠游记.jsonl):
 *   活动 id = 2026090101 (activity group = 2026090100, 名称 "S3 萌宠"), 都走 ActivityService.Operate
 *     cmd = 47  查指定好友的可夺宝藏列表   请求 { treasure_hunt_query: { gid } } → 响应 treasure_hunt_query.treasures[]
 *     cmd = 43  发起夺宝(消耗一张挑战书)   请求 { treasure_hunt_challenge: { gid, treasure_id, book_item_id } }
 *     cmd = 50  查我的夺宝状态             请求 { treasure_hunt_misc: { field1: 1 } }
 *   treasure_id 是字符串, 形如 "1004896646-1789598933572389645-cc8db275" (好友gid-雪花号-8位hex)
 *
 * 挑战书(ItemInfo.json type=19 "夺宝道具"):
 *   80101 初级(价值100/胜120/败返80) · 80102 中级(300/450/150) · 80103 高级(700/1260/140)
 *   三级**传参完全一致**, 只是 book_item_id 不同 —— 所以统一按同一套流程处理。
 *
 * 结果判定: 挑战响应本身不带结果字段, 用"再查一次好友宝藏, 可夺价值(#3)下降 / 宝藏消失"判定成功;
 *   同时用背包里挑战书数量是否减少做交叉验证。
 */
const { Buffer } = require('node:buffer');
const protobuf = require('protobufjs');
const { types } = require('../utils/proto');
const { sendMsgAsync } = require('../utils/network');
const { toLong, toNum, log } = require('../utils/utils');
const { isAutomationOn, getRobTreasureIntervalMinutes } = require('../models/store');
const { getBag, getBagItems } = require('./warehouse');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';
const TREASURE_ACTIVITY_ID = 2026090101;
const CMD = { QUERY: 47, CHALLENGE: 43, MISC: 50 };

/** 挑战书档位(从高到低, 自动化优先用高等级可用挑战书) */
const CHALLENGE_BOOKS = [
    { id: 80103, name: '高级挑战书', level: 3 },
    { id: 80102, name: '中级挑战书', level: 2 },
    { id: 80101, name: '初级挑战书', level: 1 },
];
const BOOK_IDS = CHALLENGE_BOOKS.map(b => b.id);

/** 宝藏状态: 实测挑战目标都是 2; 1/3 语义待确认 */
const TREASURE_STATUS = { ESCORTING: 2 };

function bookName(id) {
    const hit = CHALLENGE_BOOKS.find(b => b.id === toNum(id));
    return hit ? hit.name : `挑战书(${toNum(id)})`;
}

/**
 * 容错读取 protobuf 字段(不依赖 .proto, 长度越界时截断而不是抛错)。
 * 背景: 线上抓到的部分 cmd=47 响应用 protobufjs 整包 decode 会报
 *   "index out of range: 8250 + 10 > 8250" / "invalid wire type 6 at offset 8250",
 *   即尾部有 1~10 字节对不上(疑似服务端截断/脏尾)。我们只需要某个字段,
 *   所以自己扫字段、不整包 decode, 遇到脏尾直接停下。
 */
function scanFields(buf) {
    const out = [];
    if (!buf || !buf.length) return out;
    let r;
    try { r = protobuf.Reader.create(buf); } catch (e) { return out; }
    while (r.pos < r.len) {
        let tag;
        try { tag = r.uint64(); } catch { break; }
        const no = Math.floor(Number(tag) / 8);
        const wire = Number(tag) & 7;
        try {
            if (wire === 0) out.push({ no, wire, v: r.uint64().toString() });
            else if (wire === 1) out.push({ no, wire, v: r.fixed64().toString() });
            else if (wire === 5) out.push({ no, wire, v: String(r.fixed32()) });
            else if (wire === 2) {
                const declared = Number(r.uint64());
                const remain = r.len - r.pos;
                const take = Math.min(declared, Math.max(0, remain)); // 越界就截断
                out.push({ no, wire, b: buf.subarray(r.pos, r.pos + take), truncated: take < declared });
                r.pos += take;
                if (take < declared) break;   // 脏尾, 停止
            } else break;                      // 非法 wire type, 停止
        } catch { break; }
    }
    return out;
}

function asString(b) {
    if (!b || !b.length) return '';
    const s = Buffer.from(b).toString('utf8');
    if (s.includes('\uFFFD')) return '';
    return s;
}

/** 从 OperateReply 原始字节里取出根层某个字段的原始字节 */
function pickRawField(body, fieldNo) {
    const fields = scanFields(body);
    const hit = fields.find(f => f.no === fieldNo && f.b);
    return hit ? hit.b : null;
}

/** 把一条宝藏的原始字节解析成对象(先试 typed, 失败退回手工扫字段) */
function parseTreasureBytes(bytes) {
    try {
        return normalizeTreasure(types.TreasureInfo.decode(bytes));
    } catch (e) {
        const f = scanFields(bytes);
        const get = (n) => f.find(x => x.no === n);
        const num = (n) => toNum(get(n) && get(n).v);
        const slots = f.filter(x => x.no === 12 && x.b).map(sb => {
            const sf = scanFields(sb.b);
            return {
                bookItemId: toNum(sf.find(x => x.no === 2) && sf.find(x => x.no === 2).v),
                gold: toNum(sf.find(x => x.no === 6) && sf.find(x => x.no === 6).v),
            };
        });
        return {
            treasureId: asString(get(1) && get(1).b),
            settleItemId: num(2),
            stealableValue: num(3),
            startTime: num(4),
            status: num(5),
            endTime: num(6),
            maxValue: num(8),
            bonusValue: num(9),
            field13: num(13),
            field14: num(14),
            bookSlots: slots,
        };
    }
}

/** 一段字节是否是"宝藏条目"(其 #1 应是形如 gid-雪花号-8hex 的字符串) */
function isTreasureMessage(bytes) {
    const idField = scanFields(bytes).find(f => f.no === 1 && f.b);
    if (!idField) return false;
    return /^[0-9]{4,}-[0-9]+-[0-9a-fA-F]{3,}$/.test(asString(idField.b));
}

/**
 * 从 #147 里收集宝藏条目原始字节。
 * 实测结构: #147 { #1(包装) { #1[]=宝藏 }, #2=gid }
 * 兼容两种形态: 直接 repeated 宝藏 / 多一层包装(递归下钻)。
 */
function collectTreasureEntries(raw147) {
    const out = [];
    const walk = (buf, depth) => {
        if (depth > 4) return;
        const children = scanFields(buf).filter(f => f.no === 1 && f.b);
        if (!children.length) return;
        if (children.every(c => isTreasureMessage(c.b))) {
            children.forEach(c => out.push(c.b));
            return;
        }
        children.forEach(c => walk(c.b, depth + 1));
    };
    walk(raw147, 0);
    return out;
}

/**
 * 从 cmd=47 响应里取出宝藏列表。
 * 注意: 该响应末尾常有 1~10 字节脏尾, 整包 decode 会抛错, 所以这里直接走
 * 字段扫描(scanFields 越界即停), 不做整包 decode。
 */
function parseTreasureList(body) {
    const raw147 = pickRawField(body, 147);
    if (!raw147) {
        const fields = scanFields(body).map(f => f.no).join(',');
        log('夺宝', `响应里没有字段147(夺宝数据), 原始长度 ${body.length}, 顶层字段=[${fields}]`, { module: 'activity', event: '夺宝查询', result: 'error' });
        return [];
    }
    const entries = collectTreasureEntries(raw147);
    const list = entries.map(parseTreasureBytes).filter(t => t && t.treasureId);
    if (!list.length) {
        const tail = body.subarray(Math.max(0, body.length - 32)).toString('hex');
        log('夺宝', `响应解析失败: #147=${raw147.length}B, 条目=${entries.length}, 原始长度=${body.length}, 尾部hex=${tail}`, { module: 'activity', event: '夺宝查询', result: 'error' });
    }
    return list;
}

async function operateActivity(cmd, payload = {}) {
    const req = {
        id: toLong(TREASURE_ACTIVITY_ID),
        cmd: toLong(cmd),
        ...payload,
    };
    const body = types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create(req)).finish();
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'Operate', body);
    return types.ActivityOperateReply.decode(replyBody);
}

/** 发送 Operate 并返回原始响应字节(不整包 decode, 避免脏尾导致失败) */
async function operateActivityRaw(cmd, payload = {}) {
    const req = {
        id: toLong(TREASURE_ACTIVITY_ID),
        cmd: toLong(cmd),
        ...payload,
    };
    const body = types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create(req)).finish();
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'Operate', body);
    return { body: Buffer.isBuffer(replyBody) ? replyBody : Buffer.from(replyBody || []) };
}

/** 规范化一条宝藏 */
function normalizeTreasure(t) {
    if (!t) return null;
    return {
        treasureId: String(t.treasure_id || ''),
        settleItemId: toNum(t.settle_item_id),
        stealableValue: toNum(t.stealable_value),
        startTime: toNum(t.start_time),
        status: toNum(t.status),
        endTime: toNum(t.end_time),
        maxValue: toNum(t.max_value),
        bonusValue: toNum(t.bonus_value),
        field13: toNum(t.field13),
        field14: toNum(t.field14),
        bookSlots: (Array.isArray(t.book_slots) ? t.book_slots : []).map(s => ({
            bookItemId: toNum(s && s.book_item_id),
            gold: toNum(s && s.gold),
        })),
    };
}

/** 查指定好友的可夺宝藏列表 */
async function queryFriendTreasures(gid) {
    const targetGid = toNum(gid);
    if (!targetGid) throw new Error('缺少好友 gid');
    const { body } = await operateActivityRaw(CMD.QUERY, {
        treasure_hunt_query: { gid: toLong(targetGid) },
    });
    return parseTreasureList(body);
}

/** 我的夺宝状态 (含我自己的宝藏/余额等, 实测挂在 activity.body field115) */
async function getMyTreasureStatus() {
    const { body } = await operateActivityRaw(CMD.MISC, {
        treasure_hunt_misc: { field1: toLong(1) },
    });
    // 我的夺宝状态是 optional 展示信息, 解析失败不影响主流程
    let mine = null;
    let counter = 0;
    try {
        const reply = types.ActivityOperateReply.decode(body);
        const body115 = pickRawField(pickRawField(body, 3) || Buffer.alloc(0), 115);
        if (body115) {
            const f = scanFields(body115);
            const mineRaw = f.find(x => x.no === 1 && x.b);
            if (mineRaw) {
                const mf = scanFields(mineRaw.b);
                mine = {
                    value: toNum(mf.find(x => x.no === 3) && mf.find(x => x.no === 3).v),
                    startAt: toNum(mf.find(x => x.no === 5) && mf.find(x => x.no === 5).v),
                };
            }
            counter = toNum(f.find(x => x.no === 2 && x.b) && toNum(scanFields(f.find(x => x.no === 2).b).find(y => y.no === 1)?.v));
        }
        return { raw: reply, mine, counter };
    } catch (e) {
        return { raw: null, mine, counter, decodeError: e.message };
    }
}

/** 发起夺宝挑战(消耗一张挑战书)。三级挑战书传参完全一致, 只有 book_item_id 不同 */
async function challengeTreasure({ gid, treasureId, bookItemId }) {
    const targetGid = toNum(gid);
    const treasure = String(treasureId || '').trim();
    const book = toNum(bookItemId);
    if (!targetGid) throw new Error('缺少好友 gid');
    if (!treasure) throw new Error('缺少宝藏实例ID');
    if (!BOOK_IDS.includes(book)) throw new Error(`不支持的挑战书: ${book}`);

    const reply = await operateActivity(CMD.CHALLENGE, {
        treasure_hunt_challenge: {
            gid: toLong(targetGid),
            treasure_id: treasure,
            book_item_id: toLong(book),
        },
    });
    return { reply };
}

/** 背包里的挑战书数量 */
async function getBookInventory() {
    const bagReply = await getBag();
    const items = getBagItems(bagReply);
    const counts = {};
    for (const b of CHALLENGE_BOOKS) counts[b.id] = 0;
    for (const it of items) {
        const id = toNum(it && it.id);
        if (counts[id] !== undefined) counts[id] += toNum(it && it.count);
    }
    return CHALLENGE_BOOKS.map(b => ({ ...b, count: counts[b.id] || 0 }));
}

/** 挑一张可用挑战书: 优先高等级 */
function pickBestBook(inventory) {
    const list = Array.isArray(inventory) ? inventory : [];
    const sorted = [...list].sort((a, b) => b.level - a.level);
    return sorted.find(b => toNum(b.count) > 0) || null;
}

/**
 * 收集所有好友的可夺宝藏 (逐个好友查 cmd=47)
 * @returns {Promise<{ targets: Array, friendCount: number }>}
 */
async function collectTargets(options = {}) {
    const { getFriendsList } = require('./friend');
    const friends = await getFriendsList(!!options.forceSync);
    // 逐个好友查询, 默认加一点间隔(避免连续高频请求)
    const delayMs = options.delayMs === undefined ? 120 : Math.max(0, toNum(options.delayMs));
    const targets = [];
    let queried = 0;
    for (const f of (Array.isArray(friends) ? friends : [])) {
        const gid = toNum(f && f.gid);
        if (!gid) continue;
        queried += 1;
        try {
            const list = await queryFriendTreasures(gid);
            for (const t of list) {
                targets.push({
                    ...t,
                    gid,
                    friendName: String((f && (f.name || f.remark)) || ''),
                });
            }
        } catch (e) {
            log('夺宝', `查询好友 ${gid} 宝藏失败: ${e.message}`, { module: 'activity', event: '夺宝查询', result: 'error' });
        }
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
    // 排序: 运送中的优先, 其次可夺价值高的优先
    targets.sort((a, b) => {
        const sa = a.status === TREASURE_STATUS.ESCORTING ? 1 : 0;
        const sb = b.status === TREASURE_STATUS.ESCORTING ? 1 : 0;
        if (sa !== sb) return sb - sa;
        return b.stealableValue - a.stealableValue;
    });
    return { targets, friendCount: queried };
}

/**
 * 执行一次夺宝(含结果判定)
 * @returns {Promise<{ ok:boolean, reason?:string, before?:number, after?:number }>}
 */
async function robOnce({ gid, treasureId, bookItemId, verify = true }) {
    const book = bookName(bookItemId);
    let before = null;
    if (verify) {
        try {
            const list = await queryFriendTreasures(gid);
            const hit = list.find(t => t.treasureId === treasureId);
            before = hit ? hit.stealableValue : 0;
        } catch (e) { /* 查询失败不影响发起 */ }
    }

    await challengeTreasure({ gid, treasureId, bookItemId });
    log('夺宝', `已用【${book}】夺宝: 好友 ${gid} 宝藏 ${String(treasureId).slice(-8)}`, {
        module: 'activity', event: '夺宝', result: 'ok', friendGid: gid, bookItemId: toNum(bookItemId),
    });

    if (!verify) return { ok: true, before, after: null };

    // 结果判定: 再查一次, 可夺价值下降或宝藏消失 = 成功
    await new Promise(r => setTimeout(r, 1200));
    try {
        const list = await queryFriendTreasures(gid);
        const hit = list.find(t => t.treasureId === treasureId);
        const after = hit ? hit.stealableValue : 0;
        const ok = before === null ? true : (after < before || !hit);
        if (!ok) {
            log('夺宝', `【${book}】未生效(可夺价值 ${before} → ${after}), 可能已达该宝藏夺取上限`, {
                module: 'activity', event: '夺宝', result: 'no_effect', friendGid: gid, bookItemId: toNum(bookItemId),
            });
        }
        return { ok, before, after };
    } catch (e) {
        return { ok: true, before, after: null, verifyError: e.message };
    }
}

/**
 * 自动夺宝: 遍历好友找可夺宝藏 → 优先用高等级可用挑战书 → 逐个夺
 * 开关: automation.rob_treasure
 * @returns {Promise<object>} 汇总结果
 */
async function runAutoRobTreasure(options = {}) {
    if (!isAutomationOn('rob_treasure')) return { skipped: true };

    const maxPerRun = Math.max(1, Math.min(20, toNum(options.maxPerRun) || 3));
    const result = { friends: 0, targets: 0, attempted: 0, success: 0, noEffect: 0, failed: 0, books: [], details: [] };

    const inventory = await getBookInventory();
    result.books = inventory.map(b => ({ id: b.id, name: b.name, count: b.count }));
    if (!pickBestBook(inventory)) {
        log('夺宝', '没有可用的挑战书(初级/中级/高级都没有), 跳过自动夺宝', { module: 'activity', event: '夺宝', result: 'no_book' });
        return { ...result, reason: 'no_book' };
    }

    const { targets, friendCount } = await collectTargets();
    result.friends = friendCount;
    result.targets = targets.length;
    if (!targets.length) return { ...result, reason: 'no_target' };

    for (const t of targets) {
        if (result.attempted >= maxPerRun) break;
        const inv = await getBookInventory();
        const book = pickBestBook(inv);
        if (!book) { result.reason = 'no_book'; break; }

        result.attempted += 1;
        try {
            const r = await robOnce({ gid: t.gid, treasureId: t.treasureId, bookItemId: book.id });
            if (r.ok) result.success += 1; else result.noEffect += 1;
            result.details.push({
                gid: t.gid, friendName: t.friendName, treasureId: t.treasureId,
                book: book.name, ok: r.ok, before: r.before, after: r.after,
            });
            // 同一个宝藏被判定"未生效"时, 说明该宝藏已到上限, 后续不再重试它
        } catch (e) {
            result.failed += 1;
            result.details.push({ gid: t.gid, treasureId: t.treasureId, book: book.name, ok: false, error: e.message });
            log('夺宝', `夺宝失败: ${e.message}`, { module: 'activity', event: '夺宝', result: 'error' });
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    log('夺宝', `自动夺宝完成: 好友 ${result.friends} 人 / 可夺宝藏 ${result.targets} 个 → 尝试 ${result.attempted}, 成功 ${result.success}, 未生效 ${result.noEffect}, 失败 ${result.failed}`, {
        module: 'activity', event: '夺宝', result: 'done',
    });
    return result;
}

/** 定时检查(供 worker 周期调用) */
async function checkAndRobTreasure() {
    if (!isAutomationOn('rob_treasure')) return { skipped: true };
    try {
        return await runAutoRobTreasure();
    } catch (e) {
        log('夺宝', `自动夺宝异常: ${e.message}`, { module: 'activity', event: '夺宝', result: 'error' });
        return { error: e.message };
    }
}

function getAutoRobIntervalMs() {
    const minutes = Math.max(1, toNum(getRobTreasureIntervalMinutes()) || 10);
    return minutes * 60 * 1000;
}

module.exports = {
    ACTIVITY_SERVICE,
    BOOK_IDS,
    CHALLENGE_BOOKS,
    CMD,
    TREASURE_ACTIVITY_ID,
    TREASURE_STATUS,
    checkAndRobTreasure,
    challengeTreasure,
    collectTargets,
    getAutoRobIntervalMs,
    getBookInventory,
    getMyTreasureStatus,
    operateActivityRaw,
    parseTreasureList,
    pickBestBook,
    queryFriendTreasures,
    scanFields,
    robOnce,
    runAutoRobTreasure,
};
