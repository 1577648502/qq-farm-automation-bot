/**
 * 萌宠赛季游记 (S3 比熊, uid=SEASON_BEAR_CAMPAIGN)
 *
 * 抓包(2026-09-10 两轮)确认协议 (均走 ActivityService.Operate, group=2026090101 主活动):
 *   cmd=27 (payload field126, 空): 打开/刷新活动 (响应 activity 带 head.desc 规则 JSON + field115 宠物状态)
 *   cmd=29 (payload field128, 空): 投喂比熊 (消耗元气糕, 响应结果字段129 带成长值/幸运星变化)
 *   cmd=31 (payload field130, 空): 寻宝 (响应结果字段131 带奖励, 待进一步确认)
 *   cmd=32 (payload field131 = message{#1: 手记id}): 领取爪印手记奖励 (响应结果132 带奖励物品+手记JSON)
 *   cmd=47 (payload field147 = message{#1: 好友gid}): 好友操作(夺宝, 待确认)
 *   cmd=49 (payload field149 = bytes 0x01): 解锁/翻看爪印手记 (响应无结果字段, 状态里手记 entry 增加 #5=1)
 *   比熊赠礼 group=2026090102 (type=13, star_register@110, 31 天): cmd=21 走 star_light_up, 由千星游记覆盖
 *   免费礼包 group=2026090103: cmd=7 (无 payload) 领取每日免费稀有种子礼包
 *   游记商城: MallService.Purchase (goodsId 1041~1051)
 *
 * field115 宠物状态结构 (实测):
 *   #1 { #1: 宠物类型, #3: 成长值(实测700), #4: 数量 }
 *   #2 { #1: 1 }
 *   #3 { #3: 数值, #4: {#1: 货币物品id(1028), #2: 数量} }
 *   #4 repeated 爪印手记 { #1: id(1~9), #2, #3: 1=已解锁, #4: 照片JSON, #5: 1=已领取 }
 *   #6 其他与手记进度相关
 *
 * 备注: 宠物成长/寻宝的完整数值语义仍部分推断, 页面操作入口保留, 继续按抓包迭代。
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
    29: 128,   // 投喂
    31: 130,   // 寻宝
    32: 131,   // 领取爪印手记奖励
    47: 147,   // 好友操作(夺宝)
    49: 149,   // 解锁/翻看爪印手记
};

const ITEM_ID_YUANQIGAO = 29004;  // 萌宠元气糕

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
    // #4 repeated 爪印手记
    for (const x of f) {
        if (x.f !== 4 || x.w !== 2) continue;
        const d = parseTop(x.v);
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
    pet.handnotes.sort((a, b) => a.id - b.id);
    return pet;
}

/**
 * 萌宠游记概览: 三个 group 的 head 信息 + 赠礼天数 + 免费礼包 + 宠物状态
 * 宠物状态优先取 GetGroup 的 children(#115); 取不到时用 cmd=27(打开活动页) 兜底拉取
 */
async function getMengchongOverview() {
    const result = { updatedAt: Date.now(), active: false, main: null, signin: null, seedGift: null, pet: null, yuanqigao: 0 };
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
    // 背包里的萌宠元气糕数量 (投喂消耗品)
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const bag = await getBag();
        for (const it of getBagItems(bag)) {
            if (toNum(it && it.id) === ITEM_ID_YUANQIGAO) {
                result.yuanqigao = toNum(it.count);
                break;
            }
        }
    } catch (e) { /* 背包读取失败不阻断 */ }
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
    GROUP_MAIN,
    GROUP_GIFT,
    GROUP_SEED,
    getMengchongOverview,
    claimFreeSeedGift,
    feedPet,
    claimPetHandnote,
    petOperate,
    autoRunMengchongTasks,
    checkAndRunMengchongTasks,
};
