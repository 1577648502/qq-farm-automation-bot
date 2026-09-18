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
 * 挑战书(ItemInfo.json type=19 "夺宝道具"): 80101 初级 · 80102 中级 · 80103 高级
 *   三级**传参完全一致**, 只是 book_item_id 不同 —— 所以统一按同一套流程处理。
 *
 * ⭐ 战报 = 挑战响应结果字段 #143 (2026-09-17/09-18 抓包定案, 共 7 帧: 4 胜 2 败 1 被拒):
 *   ✅ 夺得(实测 4 次): #143 {
 *          #1: 1                胜负标志(1 = 夺得)
 *          #2: { #1: 1029 幸运星, #2: 510 }   本次奖励(已与余额变化交叉验证)
 *          #3: "Kamiya Bunches" 对方昵称
 *          #6: { 同 #2 }        本次结算金额(见下)
 *          #7: 4, #8: 3         语义未确认
 *          #9: { #1: "e" 我方锦囊, #2: "g" 对方锦囊,
 *                #4: { #1: 我方争资, #2: 对方争资 },
 *                #5: { #1: 0.5, #2: 0.5 } 双方胜率(fixed64 double) } }
 *   ❌ 落败(2026-09-18 实测 2 帧, 关键差异!): **#1 和 #2 都不存在**, 只有
 *          #143 { #3: 对方昵称, #6: { #1: 1029, #2: 40/75 }(落败返还金额), #9: 对战详情 }
 *        ⇒ 判定规则: 有战报主体(#3/#6/#9)但没有 #1 ⇒ 就是落败;
 *           返还金额在 **#6**(已用 ItemNotify 交叉验证: +40/+75 与 #6 完全一致)
 *   ⛔ 被拒(战斗没打起来): #143 { #10: 1, #12: "当前宝藏资金不足，无法使用该挑战书" }
 *        —— err=0, 必须读 #12 文案才知道失败原因
 *   ✅ 奖励字段交叉验证: 夺宝前后 幸运星(#115.#3.#3) 2050 → 2560 → 2620 (09-17),
 *        09-18 四连夺: +40/+75/+60/+60, 与 #6 完全一致 ⇒ **#6 = 我方本次到账金额(胜=赢得/败=返还)**
 *   ✅ 实际结算金额(活动内官方说明「【夺宝博弈】」, 且 book_slots.#4/#5 服务端直接下发) 见 BOOK_SETTLE:
 *        初级 胜 60 / 败 40 · 中级 胜 225 / 败 75 · 高级 胜 510 / 败 90
 *      ⚠ ItemInfo 里描述写的 120/80 · 450/150 · 1260/140 是**旧数值**, 不要拿来判定
 *
 * 结果判定: 以 #143 为准(夺得/落败/被拒); 只有 #143 缺失时才回落到
 *   "再查一次好友宝藏, 可夺价值(#3)下降 / 宝藏消失"的老办法。
 * 每次抢夺(含被拒/异常)都会写入"抢夺记录"列表(见 listRobRecords)。
 *
 * ⭐ 护送结算领取 = cmd=45 (2026-09-18 抓包实测):
 *   护送结束(到期/被夺满 3 次/爆仓)后, 宝藏资金要**主动领取**, 不领就一直挂着!
 *   客户端打开活动页时会自动领一次: 响应 #145 = { #1: { #1: 1029, #2: 690 } }
 *   实测 +690 幸运星 = 两条已结束护送的宝藏价值(350 + 340)。
 */
const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const protobuf = require('protobufjs');
const { types } = require('../utils/proto');
const { sendMsgAsync } = require('../utils/network');
const { toLong, toNum, log } = require('../utils/utils');
const { isAutomationOn, getRobTreasureIntervalMinutes, getRobThrottleConfig } = require('../models/store');
const { getBag, getBagItems } = require('./warehouse');
const { getDataFile } = require('../config/runtime-paths');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';
const TREASURE_ACTIVITY_ID = 2026090101;
const CMD = { QUERY: 47, CHALLENGE: 43, MISC: 50, SETTLE_CLAIM: 45 };

/**
 * 挑战书档位(从高到低, 自动化优先用高等级可用挑战书)
 * value = 书的面值(幸运星): 用于判断"对方宝藏的博弈资金够不够用这一档" ——
 *   规则: 挑战书价值需与对方宝藏当前博弈资金匹配, 资金不足会被服务端拒绝
 *   (实测: 宝藏可博弈资金 = book_slots[].gold, 例如 350 价值的宝藏 = 350 - 50 保底 = 300)
 */
const CHALLENGE_BOOKS = [
    { id: 80103, name: '高级挑战书', level: 3, value: 300 },
    { id: 80102, name: '中级挑战书', level: 2, value: 150 },
    { id: 80101, name: '初级挑战书', level: 1, value: 50 },
];
const BOOK_IDS = CHALLENGE_BOOKS.map(b => b.id);

/**
 * 挑战书档位 → 实际结算金额(幸运星)
 * 来源: 活动内官方说明「【夺宝博弈（抢夺方）】」段落; 已由抓包实测的 60(#80101 胜) / 510(#80103 胜) 印证。
 * 用途: 与战报 #143 的奖励金额互相校验(见 parseChallengeResult 的 rewardGuess / mismatch)。
 */
const BOOK_SETTLE = {
    80101: { win: 60, lose: 40 },    // 初级
    80102: { win: 225, lose: 75 },   // 中级
    80103: { win: 510, lose: 90 },   // 高级
};

/**
 * 统一的"字符串/数字 → 整数"
 * ⚠ scanFields 扫出来的 varint 是**字符串**(protobufjs Long.toString()),
 *   而 utils 的 toNum 对字符串是原样返回 —— 直接拿来比较/相加会静默出错(如 '510' === 510 为 false),
 *   所以本文件里所有从字节里读出来的数字都必须过 toInt。
 */
function toInt(value) {
    const n = Number(toNum(value));
    return Number.isFinite(n) ? n : 0;
}

/** 道具 id → 名称(缺失时退化成 "道具#id", 不显示生硬内容给用户) */
function itemNameOf(id) {
    const nid = toNum(id);
    if (!nid) return '';
    try {
        const cfg = getItemById(nid);
        if (cfg && cfg.name) return String(cfg.name);
    } catch { /* 配置未加载时忽略 */ }
    return `道具#${nid}`;
}

/**
 * 锦囊 key(单字节 charm_id) → 名称
 * 依赖 mengchong 的锦囊配置表(懒加载避免循环依赖); 表里没有这个 id 就返回空串,
 * 不要用 charmInfo() 的兜底名("锦囊#122"), 那会把"解析错"伪装成"解析对了"。
 */
function charmLabel(key) {
    const b = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ''), 'latin1');
    if (!b.length) return '';
    try {
        const { loadCharmTable } = require('./mengchong');
        const table = loadCharmTable && loadCharmTable();
        const info = table && table[b[0]];
        if (info && info.name) return info.name;
    } catch { /* 锦囊表不可用时不展示名称 */ }
    return '';
}

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
        // ⚠ 这里必须用 toInt: scanFields 的 varint 是字符串, toNum 会原样返回,
        //   否则 stealableValue 等会变成 "350" 这样的字符串, 排序/比较全乱
        const num = (n) => toInt(get(n) && get(n).v);
        const slots = f.filter(x => x.no === 12 && x.b).map(sb => {
            const sf = scanFields(sb.b);
            const readAmt = (no) => {
                const b = (sf.find(x => x.no === no) || {}).b;
                if (!b) return 0;
                return toInt((scanFields(b).find(x => x.no === 2) || {}).v);
            };
            return {
                bookItemId: toInt((sf.find(x => x.no === 2) || {}).v),
                gold: toInt((sf.find(x => x.no === 6) || {}).v),
                winValue: readAmt(4),      // 该档胜利可获得(09-18)
                loseValue: readAmt(5),     // 该档失败可返还(09-18)
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
        // #147 缺失很少见(通常是响应异常), 只留一行简短提示, 不打 hex
        log('夺宝', `响应里没有夺宝数据(#147 缺失, 长度 ${body.length})`, { module: 'activity', event: '夺宝查询', result: 'warn' });
        return [];
    }
    const entries = collectTreasureEntries(raw147);
    const list = entries.map(parseTreasureBytes).filter(t => t && t.treasureId);
    // 注意: #147 存在但条目为空 = 该好友当前没有可夺宝藏, 属**正常情况**, 不打日志。
    // 只有"有条目却一个都没解析出来"才是异常, 且详细 hex 仅在 TREASURE_DEBUG=1 时输出。
    if (!list.length && entries.length && process.env.TREASURE_DEBUG === '1') {
        const tail = body.subarray(Math.max(0, body.length - 32)).toString('hex');
        log('夺宝', `响应解析异常: #147=${raw147.length}B, 条目=${entries.length}, 长度=${body.length}, 尾部hex=${tail}`,
            { module: 'activity', event: '夺宝查询', result: 'error' });
    }
    return list;
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

/** 宝藏是否"正在进行中"(运送中 + 未到结束时间) */
function isActiveTreasure(t) {
    if (!t) return false;
    if (t.status !== TREASURE_STATUS.ESCORTING) return false;
    if (t.endTime) {
        const endMs = t.endTime > 1e12 ? t.endTime : t.endTime * 1000;   // 兼容秒/毫秒
        if (endMs <= Date.now()) return false;
    }
    return true;
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
        bookSlots: (Array.isArray(t.book_slots) ? t.book_slots : []).map(sl => ({
            bookItemId: toInt(sl && sl.book_item_id),
            gold: toInt(sl && sl.gold),                     // 该宝藏当前可博弈资金(各档相同, 09-18)
            winValue: toInt(sl && sl.win_amount && sl.win_amount.count),    // 该档胜利可获得(09-18)
            loseValue: toInt(sl && sl.lose_amount && sl.lose_amount.count), // 该档失败可返还(09-18)
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

/**
 * 我的夺宝状态 (含我自己的宝藏/余额等, 实测挂在 activity.body field115)
 * #115 = ActivityBodyTreasureHunt { #1 mine, #2 counter, #3 balance, #4 手记, #6 锦囊, #7 护送记录 }
 */
async function getMyTreasureStatus() {
    const { body } = await operateActivityRaw(CMD.MISC, {
        treasure_hunt_misc: { field1: toLong(1) },
    });
    // 我的夺宝状态是 optional 展示信息, 解析失败不影响主流程
    let mine = null;
    let counter = 0;
    let escorts = [];
    try {
        const body115 = pickRawField(pickRawField(body, 3) || Buffer.alloc(0), 115);
        if (body115) {
            const f = scanFields(body115);
            const mineRaw = f.find(x => x.no === 1 && x.b);
            if (mineRaw) {
                const mf = scanFields(mineRaw.b);
                mine = {
                    value: toInt(mf.find(x => x.no === 3) && mf.find(x => x.no === 3).v),
                    startAt: toInt(mf.find(x => x.no === 5) && mf.find(x => x.no === 5).v),
                };
            }
            const counterRaw = f.find(x => x.no === 2 && x.b);
            if (counterRaw) {
                counter = toInt(scanFields(counterRaw.b).find(y => y.no === 1)?.v);
            }
            // #7 = 我的护送记录(可能含已结束未领取的)
            const escortRaw = f.find(x => x.no === 7 && x.b);
            if (escortRaw) escorts = parseEscortList(escortRaw.b);
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const ended = escorts.filter(e => e.endTime > 0 && e.endTime <= nowSec);
        return { raw: null, mine, counter, escorts, endedEscorts: ended, endedUnclaimed: ended.length };
    } catch (e) {
        return { raw: null, mine, counter, escorts, endedEscorts: [], endedUnclaimed: 0, decodeError: e.message };
    }
}

/**
 * 解析 #115.#7 = 我的护送记录(可能多条: 进行中 + 已结束待领取)
 * 实测字段: #1 宝藏ID, #2 币种, #3 当前价值, #4 开始, #5 状态, #6 结束,
 *           #8 博弈资金, #9 保底, #10 上限, #13 疑似已被夺次数, #14 夺宝次数上限
 */
function parseEscortList(raw) {
    const out = [];
    if (!raw || !raw.length) return out;
    for (const entry of scanFields(raw)) {
        if (entry.no !== 1 || !entry.b) continue;
        const f = scanFields(entry.b);
        const get = (n) => f.find(x => x.no === n);
        const treasureId = asString(get(1) && get(1).b);
        if (!treasureId) continue;
        out.push({
            treasureId,
            settleItemId: toInt(get(2) && get(2).v),
            value: toInt(get(3) && get(3).v),
            startTime: toInt(get(4) && get(4).v),
            status: toInt(get(5) && get(5).v),
            endTime: toInt(get(6) && get(6).v),
            funds: toInt(get(8) && get(8).v),
            bonusValue: toInt(get(9) && get(9).v),
            maxValue: toInt(get(10) && get(10).v),
            robbedCount: toInt(get(13) && get(13).v),      // 疑似已被夺次数(语义待确认)
            maxRobCount: toInt(get(14) && get(14).v),
        });
    }
    return out;
}

/**
 * 领取护送结算奖励 (cmd=45)
 * 护送结束(到期/被夺满 3 次/爆仓)后宝藏资金不会自动到账, 客户端打开活动页时会自动领一次。
 * 实测(09-18): 响应 #145 = { #1: { #1: 1029, #2: 690 } }, 幸运星 +690 = 两条已结束护送的价值(350+340)
 */
async function claimEscortSettlement() {
    const { body } = await operateActivityRaw(CMD.SETTLE_CLAIM, {});
    if (!body || !body.length) return { ok: false, reason: 'empty_reply' };
    const raw145 = pickRawField(body, 145);
    if (!raw145 || !raw145.length) {
        // 没有结果字段: 多半是无可领取(err=0), 不当错误
        return { ok: true, claimed: false, reward: null };
    }
    const f = scanFields(raw145);
    const inner = f.find(x => x.no === 1 && x.b);
    const reward = inner ? readItemAmount(inner.b) : null;
    // 被拒文案(与战报同款结构, 防御式读取)
    const message = asString(f.find(x => x.no === 12) && f.find(x => x.no === 12).b);
    const claimed = !!(reward && reward.count > 0);
    if (claimed) {
        log('夺宝', `已领取护送结算奖励: ${reward.name || itemNameOf(reward.id)}×${reward.count}`, {
            module: 'activity', event: '护送结算', result: 'ok', rewardCount: reward.count,
        });
    }
    return { ok: true, claimed, reward, message };
}

/**
 * 检查并领取护送结算: 有已结束未领取的护送才调 cmd=45, 避免空跑
 */
async function checkAndClaimEscortSettlement() {
    const st = await getMyTreasureStatus();
    if (!st.endedEscorts || !st.endedEscorts.length) {
        return { ok: true, claimed: false, reason: 'no_ended_escort', endedUnclaimed: 0 };
    }
    const names = st.endedEscorts.map(e => String(e.treasureId).slice(-8)).join(',');
    const r = await claimEscortSettlement();
    if (!r.claimed) return { ...r, reason: r.message || 'no_reward', endedUnclaimed: st.endedEscorts.length };
    addRobRecord({
        outcome: 'win', ok: true, won: true,
        gid: 0, friendName: '护送结算', bookName: '护送结算领取',
        reward: r.reward, source: 'auto',
        message: `已结束护送: ${names}`,
    });
    return { ...r, endedUnclaimed: st.endedEscorts.length, treasures: names };
}

// ============ 战报解析 (cmd=43 结果 #143) ============

/** 读 8 字节 little-endian double (protobuf fixed64) */
function readDoubleLE(buf, offset) {
    if (!buf || offset + 8 > buf.length) return 0;
    const v = buf.readDoubleLE(offset);
    return Number.isFinite(v) ? v : 0;
}

/** 只扫 wire=1(fixed64) 字段并以 double 读出 —— 用于 #9.#5 的双方胜率 */
function scanDoubles(buf) {
    const out = [];
    if (!buf || !buf.length) return out;
    let i = 0;
    while (i < buf.length) {
        let tag = 0; let shift = 0; let c = 0;
        do { c = buf[i++]; tag += (c & 0x7f) * Math.pow(2, shift); shift += 7; } while (c & 0x80);
        if (i > buf.length) break;
        const no = Math.floor(tag / 8);
        const wire = tag & 7;
        if (wire === 1) { out.push({ no, value: readDoubleLE(buf, i) }); i += 8; }
        else if (wire === 0) { while (i < buf.length && (buf[i] & 0x80)) i++; i += 1; }
        else if (wire === 2) {
            let len = 0; let sh = 0; let d = 0;
            do { d = buf[i++]; len += (d & 0x7f) * Math.pow(2, sh); sh += 7; } while (d & 0x80);
            i += len;
        } else if (wire === 5) { i += 4; }
        else break;
    }
    return out;
}

/** { #1: item_id, #2: count } → { id, count, name } */
function readItemAmount(buf) {
    if (!buf || !buf.length) return null;
    const f = scanFields(buf);
    const id = toInt((f.find(x => x.no === 1) || {}).v);
    if (!id) return null;
    const count = toInt((f.find(x => x.no === 2) || {}).v);
    return { id, count, name: itemNameOf(id) };
}

/**
 * 解析 cmd=43 的战报 #143
 * @returns {{
 *   outcome:'win'|'lose'|'rejected'|'unknown', ok:boolean, won:boolean|null,
 *   reward:{id,count,name}|null, opponentName:string, message:string,
 *   myCharmKey:string, theirCharmKey:string, myCharm:string, theirCharm:string,
 *   myStake:object|null, theirStake:object|null, myWinRate:number, theirWinRate:number,
 *   settleWin:number|null, settleLose:number|null, rewardGuess:'win'|'lose'|null, mismatch:boolean,
 *   rawHex:string
 * }}
 */
function parseChallengeResult(raw143, ctx = {}) {
    const bookItemId = toNum(ctx.bookItemId);
    const rawHex = raw143 && raw143.length ? Buffer.from(raw143).toString('hex') : '';
    const settle = BOOK_SETTLE[bookItemId] || null;
    const base = {
        outcome: 'unknown', ok: false, won: null, reward: null, opponentName: '', message: '',
        myCharmKey: '', theirCharmKey: '', myCharm: '', theirCharm: '',
        myStake: null, theirStake: null, myWinRate: 0, theirWinRate: 0,
        settleWin: settle ? settle.win : null, settleLose: settle ? settle.lose : null,
        rewardGuess: null, mismatch: false, rawHex,
    };
    if (!raw143 || !raw143.length) {
        return { ...base, message: '响应里没有战报字段(#143 缺失)' };
    }
    const f = scanFields(raw143);
    const hit = (n) => f.find(x => x.no === n);
    const num = (n) => toInt(hit(n) && hit(n).v);

    // 被拒(战斗没打起来): 实测 #143 = { #10: 1, #12: "当前宝藏资金不足，无法使用该挑战书" }
    const rejectText = asString(hit(12) && hit(12).b);
    if (rejectText) {
        return { ...base, outcome: 'rejected', ok: false, message: rejectText };
    }

    const winFlag = hit(1) ? num(1) : null;
    // 胜: #1=1 且 #2=奖励; 败(09-18 实测): #1/#2 都缺省, 返还金额在 #6
    const hasBattleBody = !!(hit(3) || hit(6) || hit(9));
    let won;
    if (winFlag !== null) won = winFlag === 1;
    else if (hasBattleBody) won = false;      // 打了但没有胜负标志 = 落败
    else won = null;                          // 连战报主体都没有
    let reward = readItemAmount(hit(2) && hit(2).b);
    const mySettle = readItemAmount(hit(6) && hit(6).b);
    if (!reward && mySettle) reward = mySettle;   // 落败: 返还金额在 #6
    const opponentName = asString(hit(3) && hit(3).b);

    // #9 = 对战详情 { #1 我方锦囊, #2 对方锦囊, #4 双方争资, #5 双方胜率 }
    let myCharmKey = ''; let theirCharmKey = '';
    let myStake = null; let theirStake = null;
    let myWinRate = 0; let theirWinRate = 0;
    const sub = hit(9) && hit(9).b;
    if (sub) {
        const sf = scanFields(sub);
        const sh = (n) => sf.find(x => x.no === n);
        myCharmKey = asString(sh(1) && sh(1).b);
        theirCharmKey = asString(sh(2) && sh(2).b);
        const stakeBuf = sh(4) && sh(4).b;
        if (stakeBuf) {
            const t = scanFields(stakeBuf);
            myStake = readItemAmount((t.find(x => x.no === 1) || {}).b);
            theirStake = readItemAmount((t.find(x => x.no === 2) || {}).b);
        }
        const rateBuf = sh(5) && sh(5).b;
        if (rateBuf) {
            const d = scanDoubles(rateBuf);
            myWinRate = (d.find(x => x.no === 1) || {}).value || 0;
            theirWinRate = (d.find(x => x.no === 2) || {}).value || 0;
        }
    }

    // 用奖励金额反查档位, 与 #1 交叉校验
    let rewardGuess = null;
    if (settle && reward && reward.count) {
        if (reward.count === settle.win) rewardGuess = 'win';
        else if (reward.count === settle.lose) rewardGuess = 'lose';
    }
    const mismatch = !!(rewardGuess && won !== null && ((rewardGuess === 'win') !== won));

    return {
        ...base,
        outcome: won === null ? 'unknown' : (won ? 'win' : 'lose'),
        ok: won === true,
        won,
        reward,
        opponentName,
        mySettle,
        myCharmKey,
        theirCharmKey,
        myCharm: charmLabel(myCharmKey),
        theirCharm: charmLabel(theirCharmKey),
        myStake,
        theirStake,
        myWinRate,
        theirWinRate,
        rewardGuess,
        mismatch,
        winFlag,
    };
}

// ============ 抢夺记录(按账号持久化) ============

const RECORD_LIMIT = 300;   // 每个账号最多保留多少条(超出丢最旧的)
let recordsCache = null;

const OUTCOME_TEXT = {
    win: '成功',
    lose: '失败',
    rejected: '未发起',
    unknown: '未知',
    error: '异常',
};

function recordsFile() {
    const accountId = String(process.env.FARM_ACCOUNT_ID || 'default').replace(/[^\w-]/g, '_');
    return getDataFile(path.join('treasure-rob-records', `${accountId}.json`));
}

function loadRobRecords() {
    if (recordsCache) return recordsCache;
    recordsCache = [];
    try {
        const file = recordsFile();
        if (fs.existsSync(file)) {
            const j = readJsonFile(file, () => ({ records: [] }));
            if (j && Array.isArray(j.records)) recordsCache = j.records;
        }
    } catch (e) {
        recordsCache = [];
    }
    return recordsCache;
}

function saveRobRecords() {
    try {
        writeJsonFileAtomic(recordsFile(), {
            records: loadRobRecords().slice(-RECORD_LIMIT),
            updatedAt: Date.now(),
        });
    } catch (e) {
        log('夺宝', `保存抢夺记录失败: ${e.message}`, { module: 'activity', event: '夺宝记录', result: 'error' });
    }
}

/** 追加一条抢夺记录(含被拒/异常) */
function addRobRecord(entry) {
    const list = loadRobRecords();
    const rec = {
        at: Date.now(),
        outcome: 'unknown',
        outcomeText: OUTCOME_TEXT.unknown,
        ok: false,
        ...entry,
    };
    rec.outcomeText = OUTCOME_TEXT[rec.outcome] || OUTCOME_TEXT.unknown;
    rec.rewardText = rec.reward ? `${rec.reward.name || itemNameOf(rec.reward.id)}×${rec.reward.count}` : '';
    rec.rewardImage = rec.reward ? getItemImageById(rec.reward.id) : '';
    list.push(rec);
    if (list.length > RECORD_LIMIT) list.splice(0, list.length - RECORD_LIMIT);
    saveRobRecords();
    return rec;
}

/**
 * 抢夺记录列表(最新在前)
 * 排序: 先按时间倒序, 同一毫秒的记录用"写入顺序倒序"兜底 ——
 * 否则一次自动夺宝连抢几刀会长得像乱序。
 */
function listRobRecords(options = {}) {
    const limit = Math.min(Math.max(toInt(options.limit) || 50, 1), RECORD_LIMIT);
    const offset = Math.max(toInt(options.offset) || 0, 0);
    const all = loadRobRecords()
        .map((r, i) => ({ r, i }))
        .sort((a, b) => ((b.r.at || 0) - (a.r.at || 0)) || (b.i - a.i))
        .map(x => x.r);
    const rows = all.slice(offset, offset + limit);
    return {
        records: rows,
        total: all.length,
        summary: {
            win: all.filter(r => r.outcome === 'win').length,
            lose: all.filter(r => r.outcome === 'lose').length,
            rejected: all.filter(r => r.outcome === 'rejected').length,
            error: all.filter(r => r.outcome === 'error').length,
            // 累计夺得奖励只统计成功的(落败是返还, 不计入"夺得")
            rewardTotal: all.reduce((n, r) => n + (r.outcome === 'win' && r.reward ? toInt(r.reward.count) : 0), 0),
            // 今日已用次数 / 每日上限(面板显示"今日 X/20")
            today: countTodayRobAttempts(),
            dailyLimit: toInt(getRobThrottleConfig().dailyLimit),
        },
    };
}

/** 清空抢夺记录 */
function clearRobRecords() {
    recordsCache = [];
    try {
        writeJsonFileAtomic(recordsFile(), { records: [], updatedAt: Date.now() });
    } catch { /* 忽略 */ }
    return { ok: true };
}

/** 发起夺宝挑战(消耗一张挑战书)。三级挑战书传参完全一致, 只有 book_item_id 不同 */
async function challengeTreasure({ gid, treasureId, bookItemId }) {
    const targetGid = toNum(gid);
    const treasure = String(treasureId || '').trim();
    const book = toNum(bookItemId);
    if (!targetGid) throw new Error('缺少好友 gid');
    if (!treasure) throw new Error('缺少宝藏实例ID');
    if (!BOOK_IDS.includes(book)) throw new Error(`不支持的挑战书: ${book}`);

    const { body } = await operateActivityRaw(CMD.CHALLENGE, {
        treasure_hunt_challenge: {
            gid: toLong(targetGid),
            treasure_id: treasure,
            book_item_id: toLong(book),
        },
    });
    // 战报在根层 #143 (proto 里没声明这个响应), 用字段扫描取, 避开脏尾导致的整包 decode 失败
    const result = parseChallengeResult(pickRawField(body, 143), { bookItemId: book });
    return { body, result };
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
    return CHALLENGE_BOOKS.map(b => ({ ...b, count: counts[b.id] || 0, image: getItemImageById(b.id) }));
}

/** 挑一张可用挑战书: 优先高等级 */
function pickBestBook(inventory) {
    const list = Array.isArray(inventory) ? inventory : [];
    const sorted = [...list].sort((a, b) => b.level - a.level);
    return sorted.find(b => toNum(b.count) > 0) || null;
}

/**
 * 针对具体宝藏挑书(优先): 在"有库存"且"这个宝藏用得动"的档位里, 选面值最大的。
 * · 宝藏的 book_slots[].gold = 当前可博弈资金; 资金不够的档位会被服务端拒绝(白贴一张挑战书)
 * · 没有槽位数据时退回 pickBestBook(老行为)
 */
function pickBestBookForTreasure(inventory, target) {
    const slots = Array.isArray(target && target.bookSlots) ? target.bookSlots : [];
    if (!slots.length) return pickBestBook(inventory);
    const list = Array.isArray(inventory) ? inventory : [];
    const byId = {};
    for (const s of slots) byId[toNum(s.bookItemId)] = s;
    const funds = Math.max(0, ...slots.map(s => toNum(s.gold)));
    const owned = list.filter(b => toNum(b.count) > 0);
    const usable = owned.filter((b) => {
        const slot = byId[toNum(b.id)];
        // 有槽位数据时, 服务端没列出的档位 / gold=0 的档位都视为"用不了"
        // (宁可跳过也别白贴一张书 —— 面值超资金会被拒)
        if (slots.length && (!slot || toNum(slot.gold) <= 0)) return false;
        // 面值超过宝藏可博弈资金 → 会被拒绝
        // 面值以 CHALLENGE_BOOKS 为准(库存对象可能没带 value 字段)
        const meta = CHALLENGE_BOOKS.find(x => toNum(x.id) === toNum(b.id)) || {};
        const bookValue = toNum(b.value !== undefined ? b.value : meta.value);
        if (funds > 0 && bookValue > funds) return false;
        return true;
    });
    if (!usable.length) return null;
    return usable.sort((a, b) => b.level - a.level)[0];
}

/** 今日已发起的夺宝次数(成功+落败; 被拒不计, 护送结算不计) */
function countTodayRobAttempts() {
    const today = new Date();
    const isSameDay = (ms) => {
        if (!ms) return false;
        const d = new Date(ms);
        return d.getFullYear() === today.getFullYear()
            && d.getMonth() === today.getMonth()
            && d.getDate() === today.getDate();
    };
    const all = loadRobRecords();
    return all.filter(r => isSameDay(r.at)
        && (r.outcome === 'win' || r.outcome === 'lose')
        && toNum(r.bookItemId) > 0).length;
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
    let skippedEnded = 0;   // 已结束/非运送中的宝藏(仅统计, 不展示)
    for (const f of (Array.isArray(friends) ? friends : [])) {
        const gid = toNum(f && f.gid);
        if (!gid) continue;
        queried += 1;
        try {
            const list = await queryFriendTreasures(gid);
            const friendName = String((f && (f.name || f.remark)) || '');
            const active = list.filter(isActiveTreasure);
            if (active.length) {
                // 同一好友可能有多个宝藏, 只保留"最好抢的"那个(可夺价值最高), 其余仅计数
                const best = active.slice().sort((a, b) => b.stealableValue - a.stealableValue)[0];
                targets.push({
                    ...best,
                    gid,
                    friendName,
                    treasureCount: active.length,
                    // 该好友全部宝藏ID(手动夺宝时若某个失败可换下一个)
                    allTreasureIds: active.map(x => x.treasureId),
                });
                skippedEnded += (list.length - active.length);
            }
        } catch (e) {
            log('夺宝', `查询好友 ${gid} 宝藏失败: ${e.message}`, { module: 'activity', event: '夺宝查询', result: 'error' });
        }
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
    // 排序: 可夺价值高的优先
    targets.sort((a, b) => b.stealableValue - a.stealableValue);
    return { targets, friendCount: queried, skippedEnded };
}

/**
 * 执行一次夺宝(含结果判定 + 写入抢夺记录)
 *
 * 判定以服务端战报 #143 为准(夺得/落败/被拒), 不再"再查一次猜结果";
 * 只有 #143 缺失时才回落到老办法(可夺价值下降 / 宝藏消失)。
 * @returns {Promise<{ ok:boolean, outcome:string, won:boolean|null, reward:object|null, result:object, before:number|null, after:number|null }>}
 */
async function robOnce({ gid, treasureId, bookItemId, friendName = '', verify = true, source = 'manual' }) {
    const book = bookName(bookItemId);
    const targetGid = toNum(gid);
    const bookId = toNum(bookItemId);
    const info = { gid: targetGid, friendName: String(friendName || ''), treasureId: String(treasureId || ''),
        bookItemId: bookId, bookName: book, source };
    let before = null;
    if (verify) {
        try {
            const list = await queryFriendTreasures(targetGid);
            const hit = list.find(t => t.treasureId === treasureId);
            before = hit ? hit.stealableValue : 0;
        } catch (e) { /* 查询失败不影响发起 */ }
    }

    let result;
    try {
        ({ result } = await challengeTreasure({ gid: targetGid, treasureId, bookItemId }));
    } catch (e) {
        const rec = addRobRecord({ ...info, outcome: 'error', ok: false, won: null, message: e.message, before });
        log('夺宝', `夺宝异常: 好友 ${info.friendName || targetGid} 【${book}】${e.message}`, {
            module: 'activity', event: '夺宝', result: 'error', friendGid: targetGid, bookItemId: bookId,
        });
        const err = new Error(e.message);
        err.record = rec;
        throw err;
    }

    // 战报已经给出结论(夺得/落败/被拒) → 不必再查一次好友宝藏
    const decided = result.outcome === 'win' || result.outcome === 'lose' || result.outcome === 'rejected';
    let after = null;
    let ok;
    if (decided) {
        ok = result.outcome === 'win';
    } else {
        // 战报缺失/语义不明 → 老办法兜底
        ok = true;
        if (verify) {
            await new Promise(r => setTimeout(r, 1200));
            try {
                const list = await queryFriendTreasures(targetGid);
                const hit = list.find(t => t.treasureId === treasureId);
                after = hit ? hit.stealableValue : 0;
                ok = before === null ? true : (after < before || !hit);
            } catch (e) { /* 保持 ok=true */ }
        }
    }

    const friend = (result.opponentName || info.friendName || String(targetGid));
    const rec = addRobRecord({
        ...info,
        friendName: friend,
        outcome: result.outcome,
        ok,
        won: result.won,
        winFlag: result.winFlag === undefined ? null : result.winFlag,
        reward: result.reward,
        message: result.message || '',
        myCharmKey: result.myCharmKey, myCharm: result.myCharm,
        theirCharmKey: result.theirCharmKey, theirCharm: result.theirCharm,
        myWinRate: result.myWinRate, theirWinRate: result.theirWinRate,
        rewardGuess: result.rewardGuess,
        mismatch: result.mismatch,
        before, after,
        treasureShort: String(treasureId || '').slice(-8),
    });

    // 日志: 成功带奖励金额, 失败带原因, 便于直接看日志对账
    if (result.outcome === 'win') {
        log('夺宝', `夺宝成功: 好友 ${friend} 用【${book}】夺得 ${rec.rewardText || '奖励'}` +
            (result.theirCharm ? ` (对方锦囊:${result.theirCharm})` : ''), {
            module: 'activity', event: '夺宝', result: 'ok', friendGid: targetGid, bookItemId: bookId,
            rewardCount: result.reward ? result.reward.count : 0,
        });
    } else if (result.outcome === 'lose') {
        log('夺宝', `夺宝失败: 好友 ${friend} 用【${book}】落败, 返还 ${rec.rewardText || '奖励'}`, {
            module: 'activity', event: '夺宝', result: 'lose', friendGid: targetGid, bookItemId: bookId,
        });
    } else if (result.outcome === 'rejected') {
        log('夺宝', `夺宝未发起: 好友 ${friend} 【${book}】被服务端拒绝 — ${result.message}`, {
            module: 'activity', event: '夺宝', result: 'rejected', friendGid: targetGid, bookItemId: bookId,
        });
    } else if (!ok) {
        log('夺宝', `【${book}】未生效(可夺价值 ${before} → ${after}), 可能已达该宝藏夺取上限`, {
            module: 'activity', event: '夺宝', result: 'no_effect', friendGid: targetGid, bookItemId: bookId,
        });
    }
    if (result.mismatch) {
        log('夺宝', `⚠ 战报自检不一致: 胜负标志=#1:${result.winFlag} 但奖励 ${rec.rewardText} 更像${result.rewardGuess === 'win' ? '胜利' : '落败'}值(档位 ${book}), 请核对 #143 结构`, {
            module: 'activity', event: '夺宝', result: 'warn',
        });
    }

    return {
        ok,
        outcome: result.outcome,
        outcomeText: rec.outcomeText,
        won: result.won,
        reward: result.reward,
        rewardText: rec.rewardText,
        message: result.message || '',
        opponentName: friend,
        result,
        before,
        after,
        verifyError: undefined,
    };
}

/**
 * 自动夺宝: 遍历好友找可夺宝藏 → 优先用高等级可用挑战书 → 逐个夺
 * 开关: automation.rob_treasure
 * @returns {Promise<object>} 汇总结果
 */
async function runAutoRobTreasure(options = {}) {
    if (!isAutomationOn('rob_treasure')) return { skipped: true };

    // 消耗节奏(2026-09-18 调整): 每轮默认只抢 1 个 + 每日上限 20(官方规则),
    // 以前是"每 10 分钟抢 3 个", 一小时最多烧 18 张挑战书 → 用户反馈"消耗有点快"
    const throttle = getRobThrottleConfig();
    const maxPerRun = Math.max(1, Math.min(20, toNum(options.maxPerRun) || throttle.maxPerRun || 1));
    const dailyLimit = (options.dailyLimit === undefined || options.dailyLimit === null)
        ? throttle.dailyLimit
        : Math.max(0, toNum(options.dailyLimit));

    const result = {
        friends: 0, targets: 0, attempted: 0,
        win: 0,        // 战报 #1=1 夺得
        lose: 0,       // 战报 #1 缺省(落败, 09-18 实测)
        rejected: 0,   // 服务端拒绝(战斗没打起来)
        verified: 0,   // 响应里没有 #143, 复查发现可夺价值下降(老路径)
        noEffect: 0,   // 响应里没有 #143 且复查无变化
        failed: 0,     // 请求异常
        success: 0,    // 兼容旧字段: = win + verified
        todayAttempts: 0, dailyLimit, skippedNoUsableBook: 0,
        books: [], details: [],
    };

    const inventory = await getBookInventory();
    result.books = inventory.map(b => ({ id: b.id, name: b.name, count: b.count }));
    if (!pickBestBook(inventory)) {
        log('夺宝', '没有可用的挑战书(初级/中级/高级都没有), 跳过自动夺宝', { module: 'activity', event: '夺宝', result: 'no_book' });
        return { ...result, reason: 'no_book' };
    }

    // 每日上限(官方规则: 每日最多夺宝 20 次; 0 = 不限)
    result.todayAttempts = countTodayRobAttempts();
    if (dailyLimit > 0 && result.todayAttempts >= dailyLimit) {
        log('夺宝', `今日已夺宝 ${result.todayAttempts} 次(上限 ${dailyLimit}), 跳过自动夺宝`, { module: 'activity', event: '夺宝', result: 'daily_limit' });
        return { ...result, reason: 'daily_limit' };
    }

    const { targets, friendCount, skippedEnded } = await collectTargets();
    result.friends = friendCount;
    result.targets = targets.length;
    result.skippedEnded = skippedEnded || 0;
    if (!targets.length) return { ...result, reason: 'no_target' };

    for (const t of targets) {
        if (result.attempted >= maxPerRun) break;
        if (dailyLimit > 0 && result.todayAttempts + (result.win + result.lose) >= dailyLimit) {
            result.reason = 'daily_limit';
            log('夺宝', `本轮达到每日上限 ${dailyLimit}, 提前收手(本轮已抢 ${result.win + result.lose} 次)`, { module: 'activity', event: '夺宝', result: 'daily_limit' });
            break;
        }
        const inv = await getBookInventory();
        // 按宝藏挑书: 面值超过对方可博弈资金的档位会被服务端拒绝(白贴一张书),
        // 只在"用得动"的档位里选面值最大的; 都用不动就跳过这个宝藏
        const book = pickBestBookForTreasure(inv, t) || pickBestBook(inv);
        if (!book) { result.skippedNoUsableBook += 1; continue; }

        result.attempted += 1;
        try {
            const r = await robOnce({
                gid: t.gid, treasureId: t.treasureId, bookItemId: book.id,
                friendName: t.friendName, source: 'auto',
            });
            if (r.outcome === 'win') { result.win += 1; result.success += 1; }
            else if (r.outcome === 'lose') result.lose += 1;
            else if (r.outcome === 'rejected') result.rejected += 1;
            else if (r.ok) { result.verified += 1; result.success += 1; }   // 无战报但复查确认生效
            else result.noEffect += 1;
            result.details.push({
                gid: t.gid, friendName: t.friendName, treasureId: t.treasureId,
                book: book.name, ok: r.ok, outcome: r.outcome, outcomeText: r.outcomeText,
                reward: r.reward, rewardText: r.rewardText, message: r.message,
                before: r.before, after: r.after,
            });
            // 同一个宝藏被判定"未生效"时, 说明该宝藏已到上限, 后续不再重试它
        } catch (e) {
            result.failed += 1;
            result.details.push({ gid: t.gid, treasureId: t.treasureId, book: book.name, ok: false, outcome: 'error', outcomeText: '异常', error: e.message });
            log('夺宝', `夺宝失败: ${e.message}`, { module: 'activity', event: '夺宝', result: 'error' });
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    log('夺宝', `自动夺宝完成: 好友 ${result.friends} 人 / 可夺宝藏 ${result.targets} 个 → 尝试 ${result.attempted}, 成功 ${result.win}, 失败 ${result.lose}, 被拒 ${result.rejected}, 复查生效 ${result.verified}, 未生效 ${result.noEffect}, 异常 ${result.failed}, 今日 ${result.todayAttempts + result.win + result.lose}/${dailyLimit || '∞'}`, {
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
    BOOK_SETTLE,
    CHALLENGE_BOOKS,
    CMD,
    OUTCOME_TEXT,
    RECORD_LIMIT,
    TREASURE_ACTIVITY_ID,
    TREASURE_STATUS,
    addRobRecord,
    checkAndRobTreasure,
    challengeTreasure,
    clearRobRecords,
    collectTargets,
    getAutoRobIntervalMs,
    isActiveTreasure,
    getBookInventory,
    getMyTreasureStatus,
    listRobRecords,
    operateActivityRaw,
    parseChallengeResult,
    parseEscortList,
    parseTreasureList,
    pickBestBookForTreasure,
    claimEscortSettlement,
    checkAndClaimEscortSettlement,
    countTodayRobAttempts,
    pickBestBook,
    queryFriendTreasures,
    scanDoubles,
    scanFields,
    itemNameOf,
    charmLabel,
    robOnce,
    runAutoRobTreasure,
};
