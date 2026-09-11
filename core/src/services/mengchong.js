/**
 * 萌宠赛季游记 (S3 萌宠, uid=SEASON_BEAR_CAMPAIGN)
 *
 * 三个请求 group 都属于同一个活动 "S3 萌宠", 对应三个子模块 (2026-09-11 抓包确认):
 *   group=2026090101 → body #115 = 宠物状态 (投喂/寻宝/手记)
 *     cmd=27 (payload field126, 空): 打开/刷新活动
 *     cmd=29 (payload field128, 空): 投喂比熊 (消耗萌宠元气糕 1028)
 *     cmd=31 (payload field130, 空): 寻宝 (消耗元气糕, 得幸运星 1029/宝藏/挑战书)
 *     cmd=32 (payload field131 = {#1: 手记id}): 领取爪印手记奖励
 *     cmd=47 (payload field147 = {#1: 好友gid}): 好友夺宝 (语义待确认)
 *     cmd=49 (payload field149 = bytes 0a0101): 解锁/翻看手记
 *   group=2026090102 → body #110 = 【每日免费稀有种子礼包】31 天列表
 *     cmd=21 (payload field119, 空): 领取当日种子礼包, 响应结果 #120 = {#1: 第几天, #2...: 种子}
 *     ⚠ 与"千星游记自动点亮领取"(star_register 通道) 是同一接口, 重复调用服务端报已领
 *   group=2026090103 → body #102 = 带价格的条目列表(13 项, 语义未确认, 疑兑换/商店)
 *     cmd=7 无结果字段, 不产生任何效果 → 已停止调用 (曾是"报成功但没领到"的原因)
 *   游记商城: MallService.Purchase (goodsId 1041~1051)
 *
 * field115 宠物状态结构:
 *   #1 { 宠物类型, 成长值, 数量 }, #3 { 数值, {元气糕id, 数量} },
 *   #4 容器 { 内部 repeated #1 = 手记条目 { id, 已解锁=#3, 照片JSON=#4, 已领取=#5 } }
 *
 * 物品 id: 1028=萌宠元气糕, 1029=幸运星, 29004=泡泡棉花糖种子, 20516=狗尾草种子 (以配置同步为准)
 */

const protobuf = require('protobufjs');
const { sendMsgAsync } = require('../utils/network');
const { toLong, toNum, log, logWarn, randomDelay } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');
const { getItemById } = require('../config/gameConfig');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';

const GROUP_MAIN = 2026090101;  // S3 萌宠: 宠物状态 (body #115)
const GROUP_GIFT = 2026090102;  // 每日免费稀有种子礼包 31 天列表 (body #110), 领取 = cmd21 走 star_light_up 通道
const GROUP_EXTRA = 2026090103; // 另一模块(body #102: 带价格的条目列表, 语义未确认, 暂不调用)

// 主活动各 cmd 对应的 OperateRequest payload 字段号
const MAIN_CMD_PAYLOAD_FIELD = {
    27: 126,
    29: 128,   // 投喂
    31: 130,   // 寻宝
    32: 131,   // 领取爪印手记奖励
    47: 147,   // 好友操作(夺宝)
    49: 149,   // 解锁/翻看爪印手记
};

// 萌宠元气糕 = 物品 1028 (投喂/寻宝消耗品); 幸运星 = 1029 (游记代币)
// 注意: 29004 是"泡泡棉花糖种子"(新农作物种子), 不是元气糕 — 名称以 QQ 缓存同步的 ItemInfo 为准
const ITEM_ID_YUANQIGAO = 1028;
const ITEM_ID_LUCKYSTAR = 1029;

// 免费种子礼包领取用的 payload 字段号 (cmd=21 → field 119)
const CMD_GIFT_CLAIM_FIELD = 119;

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
    if (cfg && cfg.name) return String(cfg.name);
    // ItemInfo 未收录的新道具: 不显示生硬的"物品#id"
    return `游记道具#${nid}`;
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
                    // 奖励条目直接就是 {id=1, count=2} 的物品消息
                    if (r.f === 5 && r.w === 2) {
                        const it = parseTop(r.v);
                        const id = toNum((findField(it, 1) || {}).v);
                        const count = toNum((findField(it, 2) || {}).v);
                        if (id > 0) items.push({ id, count: count || 1, name: itemName(id) });
                    }
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
        const curEntry = body.find((x) => x.f === 1 && x.w === 0);
        const totalEntry = body.find((x) => x.f === 2 && x.w === 0);
        return {
            currentDay: toNum(curEntry && curEntry.v) || 0,
            totalDays: toNum(totalEntry && totalEntry.v) || days.length,
            days,
        };
    }
    return null;
}

/** 解析 #115 宠物状态: 成长值 / 货币 / 爪印手记列表 */
function parsePetState(stateBuf) {
    const f = parseTop(stateBuf);
    const pet = { growth: 0, petType: 0, items: [], handnotes: [] };
    const f1 = findField(f, 1);
    if (f1 && f1.w === 2) {
        const inner = parseTop(f1.v);
        pet.petType = toNum((findField(inner, 1) || {}).v);
        pet.growth = toNum((findField(inner, 3) || {}).v);
    }
    // #3 { #3: 数值, #4: {#1: 货币id, #2: 数量} } + #2 单值
    const f3 = findField(f, 3);
    if (f3 && f3.w === 2) {
        for (const x of parseTop(f3.v)) {
            if (x.w === 2) {
                const inner = parseTop(x.v);
                const id = toNum((findField(inner, 1) || {}).v);
                const count = toNum((findField(inner, 2) || {}).v);
                if (id > 0) pet.items.push({ id, count, name: itemName(id) });
            }
        }
    }
    for (const x of f) {
        if (x.f === 2 && x.w === 2) {
            const inner = parseTop(x.v);
            const v = toNum((findField(inner, 1) || {}).v);
            if (v > 0) pet.baseValue = v;
        }
    }
    // #4 是容器消息: 内部 repeated #1 才是手记条目 (实测 2026-09-10)
    for (const x of f) {
        if (x.f !== 4 || x.w !== 2) continue;
        for (const entry of parseTop(x.v)) {
            if (entry.f !== 1 || entry.w !== 2) continue;
            const d = parseTop(entry.v);
            const id = toNum((findField(d, 1) || {}).v);
            if (!id) continue;
            const photoBuf = findField(d, 4);
            let photo = null;
            if (photoBuf && photoBuf.w === 2) {
                try { photo = JSON.parse(photoBuf.v.toString('utf8')); } catch { photo = null; }
            }
            pet.handnotes.push({
                id,
                unlocked: toNum((findField(d, 3) || {}).v) > 0,
                claimed: toNum((findField(d, 5) || {}).v) > 0,
                photo,
            });
        }
    }
    pet.handnotes.sort((a, b) => a.id - b.id);
    return pet;
}

/**
 * 萌宠游记概览: 三个 group 的 head 信息 + 赠礼天数 + 免费礼包 + 宠物状态
 * 宠物状态优先取 GetGroup 的 children(#115); 取不到时用 cmd=27(打开活动页) 兜底拉取
 */
async function getMengchongOverview() {
    const result = { updatedAt: Date.now(), active: false, main: null, seedGift: null, pet: null, yuanqigao: 0, luckyStar: 0 };
    try {
        const reply = await getGroupRaw(GROUP_MAIN);
        const parsed = parseGroupReply(reply);
        if (parsed.head) {
            result.main = {
                id: parsed.head.id,
                name: parsed.head.nameText,
                type: parsed.head.type,
                startTime: parsed.head.startTime,
                endTime: parsed.head.endTime,
                ruleTitle: parsed.head.descJson && parsed.head.descJson.tips ? parsed.head.descJson.tips.title : '',
            };
            result.active = true;
        }
        for (const childBuf of parsed.children) {
            const inner = parseTop(childBuf);
            const stateField = inner.find(x => x.f === 115 && x.w === 2);
            if (stateField) { result.pet = parsePetState(stateField.v); break; }
        }
    } catch (e) { /* 主活动可能未开启 */ }
    // GetGroup 不带状态时, 用主活动 cmd=27 拉一次
    if (!result.pet) {
        try {
            const res = await operateRaw(GROUP_MAIN, 27, MAIN_CMD_PAYLOAD_FIELD[27], null);
            if (res.activity) {
                const stateField = parseTop(res.activity).find(x => x.f === 115 && x.w === 2);
                if (stateField) result.pet = parsePetState(stateField.v);
            }
        } catch (e) { /* 忽略 */ }
    }
    try {
        const reply = await getGroupRaw(GROUP_GIFT);
        const parsed = parseGroupReply(reply);
        if (parsed.head) {
            const days = [];
            for (const childBuf of parsed.children) {
                const parsedDays = parseSigninDays(childBuf);
                if (parsedDays) { days.push(parsedDays); break; }
            }
            result.seedGift = {
                id: parsed.head.id,
                name: parsed.head.nameText || '每日免费稀有种子礼包',
                type: parsed.head.type,
                startTime: parsed.head.startTime,
                endTime: parsed.head.endTime,
                ...(days[0] || { currentDay: 0, totalDays: 0, days: [] }),
            };
            result.active = true;
        }
    } catch (e) { /* 忽略 */ }
    // 背包里的游记道具数量 (1028 萌宠元气糕 = 投喂/寻宝消耗; 1029 幸运星 = 游记代币)
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const bag = await getBag();
        for (const it of getBagItems(bag)) {
            const id = toNum(it && it.id);
            if (id === ITEM_ID_YUANQIGAO) result.yuanqigao = toNum(it.count);
            else if (id === ITEM_ID_LUCKYSTAR) result.luckyStar = toNum(it.count);
        }
    } catch (e) { /* 背包读取失败不阻断 */ }
    return result;
}

// ============ 操作 ============

/**
 * 领取每日免费稀有种子礼包
 * 正确通道 (2026-09-11 抓包确认): Operate(group=2026090102, cmd=21, payload field119 空)
 *   → 响应结果字段 #120 = { #1: 第几天, #2...: {种子物品id, 数量} }
 *   注意: 与"千星游记自动点亮领取"是同一接口(star_register 通道), 重复调用服务端会报已领, 按跳过处理
 */
async function claimFreeSeedGift() {
    const res = await operateRaw(GROUP_GIFT, 21, CMD_GIFT_CLAIM_FIELD, null);
    if (res.errorCode !== 0) {
        throw new Error(`领取免费种子礼包失败: code=${res.errorCode}`);
    }
    const awards = [];
    let day = 0;
    if (res.resultHex) {
        for (const x of parseTop(Buffer.from(res.resultHex, 'hex'))) {
            if (x.f === 1) {
                day = x.w === 0 ? toNum(x.v) : (x.v.length === 1 ? x.v[0] : toNum(x.v));
            } else if (x.w === 2 && x.v.length <= 16) {
                const inner = parseTop(x.v);
                const id = toNum((findField(inner, 1) || {}).v);
                const count = toNum((findField(inner, 2) || {}).v);
                if (id > 0 && count > 0) awards.push({ id, count, name: itemName(id) });
            }
        }
    }
    return { ok: true, day, awards };
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

/**
 * 投喂比熊 (cmd=29, payload field128 空) — 消耗背包里的萌宠元气糕
 * 抓到的是"一键投喂"(空 payload), 响应结果字段129 带成长值/幸运星变化
 */
async function feedPet() {
    const res = await operateRaw(GROUP_MAIN, 29, MAIN_CMD_PAYLOAD_FIELD[29], null);
    if (res.errorCode !== 0) throw new Error(`投喂失败: code=${res.errorCode}`);
    const r = parseTop(Buffer.from(res.resultHex || '', 'hex'));
    const out = { ok: true, raw: res.resultHex };
    for (const x of r) {
        if (x.w === 0) out['f' + x.f] = toNum(x.v);
        else if (x.w === 2 && x.v.length <= 16) {
            const inner = parseTop(x.v);
            const id = toNum((findField(inner, 1) || {}).v);
            const count = toNum((findField(inner, 2) || {}).v);
            if (id > 0 && count > 0) out.items = [...(out.items || []), { id, count, name: itemName(id) }];
        }
    }
    return out;
}

/**
 * 领取爪印手记奖励 (cmd=32, payload field131 = {#1: 手记id})
 */
async function claimPetHandnote(handnoteId) {
    const id = Math.floor(Number(handnoteId) || 0);
    if (!id) throw new Error('缺少手记 id');
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 0).int64(toLong(id));
    const res = await operateRaw(GROUP_MAIN, 32, MAIN_CMD_PAYLOAD_FIELD[32], w.finish());
    if (res.errorCode !== 0) throw new Error(`领取手记奖励失败: code=${res.errorCode}`);
    const r = parseTop(Buffer.from(res.resultHex || '', 'hex'));
    const awards = [];
    for (const x of r) {
        if (x.w !== 2 || x.v.length > 16) continue;
        const inner = parseTop(x.v);
        const itemId = toNum((findField(inner, 1) || {}).v);
        const count = toNum((findField(inner, 2) || {}).v);
        if (itemId > 0 && count > 0) awards.push({ id: itemId, count, name: itemName(itemId) });
    }
    return { handnoteId: id, awards };
}

/**
 * 每天自动领取已解锁但未领取的爪印手记奖励
 */
async function autoClaimPetHandnotes() {
    const summary = { claimed: 0, handnotes: [], skipped: [] };
    let pet = null;
    try {
        const res = await operateRaw(GROUP_MAIN, 27, MAIN_CMD_PAYLOAD_FIELD[27], null);
        const stateField = res.activity ? parseTop(res.activity).find(x => x.f === 115 && x.w === 2) : null;
        if (stateField) pet = parsePetState(stateField.v);
    } catch (e) {
        summary.skipped.push(`读取宠物状态失败: ${e.message}`);
        return summary;
    }
    if (!pet || !pet.handnotes.length) {
        summary.skipped.push('暂无可领取手记');
        return summary;
    }
    for (const h of pet.handnotes) {
        if (!h.unlocked || h.claimed) continue;
        try {
            const r = await claimPetHandnote(h.id);
            summary.claimed += 1;
            summary.handnotes.push(h.id);
            const awardText = (r.awards || []).map(a => `${a.name}×${a.count}`).join('、');
            log('活动', `萌宠游记: 领取爪印手记 ${h.id} 奖励${awardText ? ` → ${awardText}` : ''}`, {
                module: 'activity', event: '萌宠游记', result: 'handnote_ok',
            });
            await randomDelay(800, 1500);
        } catch (e) {
            summary.skipped.push(`手记${h.id}(${e.message.includes('code=') ? '已领或不可领' : e.message})`);
        }
    }
    return summary;
}

// ============ 自动化 ============

/**
 * 每日萌宠任务: 领免费稀有种子礼包 + 自动领已解锁的爪印手记奖励
 * (比熊赠礼由千星游记 star_light_up 覆盖; 投喂消耗元气糕, 保持手动)
 */
async function autoRunMengchongTasks() {
    const summary = { giftClaimed: false, handnoteClaims: 0, skipped: [], errors: [] };
    // 手动"执行每日任务"直接跑; 每日定时入口在外层 checkAndRunMengchongTasks 里判开关

    try {
        const g = await claimFreeSeedGift();
        summary.giftClaimed = true;
        summary.giftDay = g.day;
        summary.giftAwards = (g.awards || []).map(a => `${a.name}×${a.count}`).join('、');
        log('活动', `萌宠游记: 领取每日免费稀有种子礼包成功${summary.giftAwards ? ` (第${g.day}天 → ${summary.giftAwards})` : ''}`, { module: 'activity', event: '萌宠游记', result: 'gift_ok' });
    } catch (e) {
        // 已领过/活动未开启按跳过处理
        summary.skipped.push(`免费种子礼包(${e.message.includes('code=') ? '今日已领或不可领' : e.message})`);
        if (!e.message.includes('code=')) {
            logWarn('活动', `萌宠游记免费礼包领取失败: ${e.message}`, { module: 'activity', event: '萌宠游记', result: 'error' });
        }
    }

    try {
        const r = await autoClaimPetHandnotes();
        summary.handnoteClaims = r.claimed;
        summary.skipped.push(...(r.skipped || []));
    } catch (e) {
        summary.errors.push(`手记奖励领取失败: ${e.message}`);
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
        log('活动', `萌宠游记每日自动化: 免费礼包 ${result.giftClaimed ? '是' : '否'}, 手记奖励 ${result.handnoteClaims || 0} 个`, {
            module: 'activity', event: '萌宠游记', result: 'auto_done',
        });
        return result;
    } catch (e) {
        logWarn('活动', `萌宠游记每日自动化失败: ${e.message}`, { module: 'activity', event: '萌宠游记', result: 'auto_error' });
        return { error: e.message };
    }
}

module.exports = {
    __testing: { parseTop, parseGroupReply, parseSigninDays, parsePetState, itemName },
    GROUP_MAIN,
    GROUP_GIFT,
    GROUP_GIFT,
    getMengchongOverview,
    claimFreeSeedGift,
    feedPet,
    claimPetHandnote,
    petOperate,
    autoRunMengchongTasks,
    checkAndRunMengchongTasks,
};
