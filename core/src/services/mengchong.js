/**
 * 萌宠赛季游记 (S3 比熊, uid=SEASON_BEAR_CAMPAIGN)
 *
 * 抓包(2026-09-10)确认协议 (均走 ActivityService.Operate):
 *   主活动   group=2026090101 (head.type=18, name="S3 萌宠")
 *     cmd=27 (payload field126, 空串): 打开/刷新活动 (响应 activity.head.desc 带规则 JSON)
 *     cmd=31 (payload field130, 空串): 待确认 — 响应结果字段(130+1=131)带奖励 items 与时间戳
 *     cmd=47 (payload field147={#1: 好友gid}): 待确认 — 疑似拜访/夺宝 (抓包前有 VisitService.Enter)
 *   比熊赠礼 group=2026090102 (head.type=13, star_register body@110, 31 天)
 *     cmd=21 走 star_light_up 通道 — 已由"千星游记自动点亮领取"通用覆盖, 本服务不重复实现
 *   免费礼包 group=2026090103
 *     cmd=7 (无 payload 字段): 领取每日免费稀有种子礼包 (规则: 每日 0 点刷新, 未领可累计)
 *   游记商城: MallService.Purchase (goodsId=1044 实测), 复用 mall 模块
 *
 * 备注: 宠物成长/寻宝/护送的完整状态字段未在本次抓包中出现(疑似独立 season 服务),
 *       cmd=31/47 语义为按操作时序推断, 页面操作入口保留, 待后续抓包确认后再完善语义。
 */

const protobuf = require('protobufjs');
const { sendMsgAsync } = require('../utils/network');
const { toLong, toNum, log, logWarn, randomDelay } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');
const { getItemById } = require('../config/gameConfig');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';

const GROUP_MAIN = 2026090101;  // S3 萌宠 主活动
const GROUP_GIFT = 2026090102;  // 比熊赠礼 (31 天, star_register)
const GROUP_SEED = 2026090103;  // 每日免费稀有种子礼包

// 主活动各 cmd 对应的 OperateRequest payload 字段号
const MAIN_CMD_PAYLOAD_FIELD = {
    27: 126,
    31: 130,
    47: 147,
};

// ============ 底层工具 ============

/** 手动构造 Operate 请求 {id=1: groupId, cmd=2: cmd, payloadField: payload} */
function encodeOperateRaw(groupId, cmd, payloadField, payloadBytes) {
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 0).int64(toLong(groupId));
    w.uint32((2 << 3) | 0).int64(toLong(cmd));
    if (payloadField) {
        w.uint32((payloadField << 3) | 2).bytes(payloadBytes || Buffer.alloc(0));
    }
    return w.finish();
}

/** 极简 protobuf 顶层字段解析: 返回 [{f, w, v}] (v: varint->string, wire2->Buffer) */
function parseTop(buf) {
    const out = [];
    const reader = protobuf.Reader.create(buf);
    try {
        while (reader.pos < reader.len) {
            const tag = reader.uint64();
            const f = Math.floor(Number(tag) / 8);
            const w = Number(tag) & 7;
            if (w === 0) out.push({ f, w, v: reader.uint64().toString() });
            else if (w === 2) out.push({ f, w, v: Buffer.from(reader.bytes()) });
            else if (w === 1) { out.push({ f, w, v: buf.slice(reader.pos, reader.pos + 8) }); reader.skip(8); }
            else if (w === 5) { out.push({ f, w, v: buf.slice(reader.pos, reader.pos + 4) }); reader.skip(4); }
            else break;
        }
    } catch { /* 截断保底 */ }
    return out;
}

function findField(fields, f) {
    return fields.find((x) => x.f === f) || null;
}

function itemName(id) {
    const nid = toNum(id);
    if (!nid) return '';
    const cfg = getItemById(nid);
    return cfg && cfg.name ? String(cfg.name) : `物品#${nid}`;
}

function parseItems(buf) {
    // corepb.Item { id=1, count=2 }
    return parseTop(buf)
        .filter((x) => x.w === 2)
        .map((x) => {
            const f = parseTop(x.v);
            return {
                id: toNum((findField(f, 1) || {}).v),
                count: toNum((findField(f, 2) || {}).v),
                name: itemName((findField(f, 1) || {}).v),
            };
        });
}

/** 发送 Operate 并返回 { err, errorCode, resultField, resultHex, activity } */
async function operateRaw(groupId, cmd, payloadField, payloadBytes) {
    const body = encodeOperateRaw(groupId, cmd, payloadField, payloadBytes);
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'Operate', body);
    const top = parseTop(replyBody);
    const errorCode = toNum((findField(top, 6) || {}).v) || 0;
    const activityBuf = (findField(top, 3) || {}).v || null;
    // 结果字段: 大于 100 的 wire2 字段 (排除 activity=3)
    const resultField = top.find((x) => x.f > 100 && x.w === 2) || null;
    return {
        errorCode,
        resultFieldNo: resultField ? resultField.f : 0,
        resultHex: resultField ? resultField.v.toString('hex') : '',
        activity: activityBuf,
    };
}

/** GetGroup 原始响应 Buffer */
async function getGroupRaw(groupId) {
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 0).int64(toLong(groupId));
    const { body } = await sendMsgAsync(ACTIVITY_SERVICE, 'GetGroup', w.finish());
    return body;
}

/** 从 GetGroupReply 提取 { head, childrenBuffer } */
function parseGroupReply(replyBuf) {
    const top = parseTop(replyBuf);
    const group = findField(top, 1);
    if (!group || group.w !== 2) return { head: null, children: [] };
    const g = parseTop(group.v);
    const headBuf = findField(g, 1);
    const head = headBuf && headBuf.w === 2 ? parseHead(headBuf.v) : null;
    const children = [];
    for (const f of g) {
        if (f.f === 2 && f.w === 2) children.push(f.v);
    }
    return { head, children };
}

/** 解析 ActivityHead */
function parseHead(buf) {
    const f = parseTop(buf);
    const descBuf = findField(f, 5);
    let descJson = null;
    if (descBuf && descBuf.w === 2 && descBuf.v.length > 2 && descBuf.v[0] === 0x7b) {
        try { descJson = JSON.parse(descBuf.v.toString('utf8')); } catch { /* 忽略 */ }
    }
    return {
        id: toNum((findField(f, 1) || {}).v),
        groupId: toNum((findField(f, 2) || {}).v),
        type: toNum((findField(f, 3) || {}).v),
        nameText: (() => {
            const nb = findField(f, 4);
            return nb && nb.w === 2 ? nb.v.toString('utf8') : '';
        })(),
        startTime: toNum((findField(f, 6) || {}).v),
        endTime: toNum((findField(f, 7) || {}).v),
        descJson,
    };
}

// ============ 概览 ============

/** 解析比熊赠礼 star_register (field 110) 的 31 天列表 */
function parseSigninDays(activityDataBuf) {
    const act = parseTop(activityDataBuf);
    for (const child of act) {
        if (child.f !== 2 || child.w !== 2) continue; // children
        const dataTop = parseTop(child.v);
        const reg = findField(dataTop, 110);
        if (!reg || reg.w !== 2) continue;
        const body = parseTop(reg.v);
        const days = [];
        for (const entry of body) {
            if (entry.f === 4 && entry.w === 2) {
                const d = parseTop(entry.v);
                const items = [];
                for (const r of d) {
                    if (r.f === 5 && r.w === 2) items.push(...parseItems(r.v));
                }
                days.push({
                    day: toNum((findField(d, 1) || {}).v),
                    unlocked: toNum((findField(d, 2) || {}).v) > 0,
                    claimed: toNum((findField(d, 3) || {}).v) > 0,
                    items,
                });
            }
        }
        days.sort((a, b) => a.day - b.day);
        return {
            currentDay: toNum((findField(body.find((x) => x.f === 1) || {}).v) || 0) || 0,
            totalDays: toNum((findField(body.find((x) => x.f === 2) || {}).v) || 0) || days.length,
            days,
        };
    }
    return null;
}

/**
 * 萌宠游记概览: 三个 group 的 head 信息 + 赠礼天数 + 活动状态字段
 */
async function getMengchongOverview() {
    const result = { updatedAt: Date.now(), active: false, main: null, signin: null, seedGift: null };
    try {
        const reply = await getGroupRaw(GROUP_MAIN);
        const { head } = parseGroupReply(reply);
        if (head) {
            result.main = {
                id: head.id,
                name: head.nameText,
                type: head.type,
                startTime: head.startTime,
                endTime: head.endTime,
                ruleTitle: head.descJson && head.descJson.tips ? head.descJson.tips.title : '',
            };
            result.active = true;
        }
    } catch (e) { /* 主活动可能未开启 */ }
    try {
        const reply = await getGroupRaw(GROUP_GIFT);
        const parsed = parseGroupReply(reply);
        if (parsed.head) {
            const days = [];
            for (const childBuf of parsed.children) {
                const parsedDays = parseSigninDays(childBuf);
                if (parsedDays) { days.push(parsedDays); break; }
            }
            result.signin = {
                name: parsed.head.nameText,
                startTime: parsed.head.startTime,
                endTime: parsed.head.endTime,
                ...(days[0] || { currentDay: 0, totalDays: 0, days: [] }),
            };
            result.active = true;
        }
    } catch (e) { /* 忽略 */ }
    try {
        const reply = await getGroupRaw(GROUP_SEED);
        const { head } = parseGroupReply(reply);
        if (head) {
            result.seedGift = {
                id: head.id,
                name: head.nameText,
                startTime: head.startTime,
                endTime: head.endTime,
            };
            result.active = true;
        }
    } catch (e) { /* 忽略 */ }
    return result;
}

// ============ 操作 ============

/**
 * 领取每日免费稀有种子礼包 (group 2026090103, cmd=7, 无 payload)
 * 已领过时服务端报错, 调用方需捕获
 */
async function claimFreeSeedGift() {
    const res = await operateRaw(GROUP_SEED, 7, 0, null);
    if (res.errorCode !== 0) {
        throw new Error(`领取免费种子礼包失败: code=${res.errorCode}`);
    }
    return { ok: true, activity: !!res.activity };
}

/**
 * 主活动通用操作 (cmd 27/31/47; payload 由调用方给 varint 数组, 如 47 传 [好友gid])
 * @param {object} opts { cmd, payloadField?, payloadVarints?, payloadHex? }
 */
async function petOperate(opts = {}) {
    const cmd = Math.floor(Number(opts.cmd) || 0);
    if (!cmd) throw new Error('缺少 cmd');
    const payloadField = Math.floor(Number(opts.payloadField)) || MAIN_CMD_PAYLOAD_FIELD[cmd] || 0;
    let payloadBytes = null;
    if (opts.payloadHex) {
        payloadBytes = Buffer.from(String(opts.payloadHex).replace(/[^0-9a-fA-F]/g, ''), 'hex');
    } else if (Array.isArray(opts.payloadVarints) && opts.payloadVarints.length) {
        const w = new protobuf.Writer();
        for (const v of opts.payloadVarints) {
            w.uint32((1 << 3) | 0).int64(toLong(v));
        }
        payloadBytes = w.finish();
    }
    const res = await operateRaw(GROUP_MAIN, cmd, payloadField, payloadBytes);
    if (res.errorCode !== 0) {
        throw new Error(`操作失败: code=${res.errorCode}`);
    }
    let result = null;
    if (res.resultHex) {
        // 通用解析结果字段: varint 与子消息里的奖励 items
        const f = parseTop(Buffer.from(res.resultHex, 'hex'));
        result = { raw: res.resultHex };
        for (const x of f) {
            if (x.w === 0) result['f' + x.f] = x.v;
            else if (x.w === 2 && x.v.length <= 64) result['f' + x.f] = x.v.toString('hex');
        }
        // 尝试提取奖励 items (字段 2/3 里的 {id,count})
        const awards = [];
        for (const x of f) {
            if (x.w === 2 && x.v.length > 2 && x.v.length <= 64) {
                const inner = parseTop(x.v);
                for (const y of inner) {
                    if (y.w === 2 && y.v.length <= 16) {
                        const it = parseTop(y.v);
                        const id = toNum((findField(it, 1) || {}).v);
                        const count = toNum((findField(it, 2) || {}).v);
                        if (id > 0 && count > 0) awards.push({ id, count, name: itemName(id) });
                    }
                }
            }
        }
        if (awards.length) result.awards = awards;
    }
    return { cmd, result };
}

// ============ 自动化 ============

/**
 * 每日萌宠任务: 领免费稀有种子礼包 (比熊赠礼由千星游记 star_light_up 覆盖)
 */
async function autoRunMengchongTasks() {
    const summary = { giftClaimed: false, skipped: [], errors: [] };
    if (!isAutomationOn('mengchong_task')) return { skipped: true };

    try {
        await claimFreeSeedGift();
        summary.giftClaimed = true;
        log('活动', '萌宠游记: 领取每日免费稀有种子礼包成功', { module: 'activity', event: '萌宠游记', result: 'gift_ok' });
    } catch (e) {
        // 已领过/活动未开启按跳过处理
        summary.skipped.push(`免费种子礼包(${e.message.includes('code=') ? '今日已领或不可领' : e.message})`);
        if (!e.message.includes('code=')) {
            logWarn('活动', `萌宠游记免费礼包领取失败: ${e.message}`, { module: 'activity', event: '萌宠游记', result: 'error' });
        }
    }
    return summary;
}

/**
 * 顶层自动化入口 (受 mengchong_task 开关控制)
 */
async function checkAndRunMengchongTasks() {
    if (!isAutomationOn('mengchong_task')) return { skipped: true };
    try {
        const result = await autoRunMengchongTasks();
        log('活动', `萌宠游记每日自动化: 免费礼包 ${result.giftClaimed ? '是' : '否'}`, {
            module: 'activity', event: '萌宠游记', result: 'auto_done',
        });
        return result;
    } catch (e) {
        logWarn('活动', `萌宠游记每日自动化失败: ${e.message}`, { module: 'activity', event: '萌宠游记', result: 'auto_error' });
        return { error: e.message };
    }
}

module.exports = {
    GROUP_MAIN,
    GROUP_GIFT,
    GROUP_SEED,
    getMengchongOverview,
    claimFreeSeedGift,
    petOperate,
    autoRunMengchongTasks,
    checkAndRunMengchongTasks,
};
