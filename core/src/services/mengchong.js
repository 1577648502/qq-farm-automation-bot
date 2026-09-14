/**
 * 萌宠赛季游记 (S3 萌宠, uid=SEASON_BEAR_CAMPAIGN)
 *
 * 三个请求 group 都属于同一个活动 "S3 萌宠", 对应三个子模块 (2026-09-11/09-14 抓包确认):
 *   group=2026090101 → body #115 = 宠物状态 (投喂/寻宝/手记)
 *     cmd=27 (payload field126, 空): 打开/刷新活动
 *     cmd=29 (payload field128, 空): 投喂比熊 — 每次消耗 700 萌宠元气糕 → 成长值+700、幸运星+100
 *                                    元气糕不足报 1000019; 阶段(#1.#4)=2 即成年
 *     cmd=30 (payload field129, 空): 寻宝 — 消耗元气糕700 → 待护送宝藏+初级挑战书+幸运星50, 自动开启4小时护送
 *                                    响应结果 #130 = {#2: 消耗, #5...: 获得}; 护送状态在 #115.#7
 *     cmd=42 (payload field142 = 锦囊id 字符串): 选择锦囊 (状态 #6.#1/#2 为当日两个锦囊)
 *     cmd=47 (payload field147 = {#1: 好友gid}): 好友夺宝
 *     cmd=48 (无 payload 字段): 领取比熊犬 (成年后解锁宠物), 结果 #148 = {#1: 90031}
 *     cmd=49 (payload field149 = {#1: 手记id 裸varint字节}): 点亮/翻看爪印手记
 *     cmd=32 (payload field131 = {#1: 手记id}): 领取爪印手记奖励
 *     cmd=31 (payload field130, 空): 语义未确认 (旧抓包出现过一次), 暂不使用
 *   group=2026090102 → body #110 = 【每日免费稀有种子礼包】31 天列表
 *     cmd=21 (payload field119, 空): 领取当日种子礼包, 响应结果 #120 = {#1: 第几天, #2...: 种子}
 *     ⚠ 与"千星游记自动点亮领取"(star_register 通道) 是同一接口, 重复调用服务端报已领
 *   group=2026090103 → body #102 = 【拾物小铺】(ActivityBodyShop, type=3), 13 件商品, 消耗幸运星兑换
 *     cmd=7 (无 payload): 拉取小铺列表 (响应 body #102)
 *     cmd=1 + shop_buy{#1: 商品id, #2: 数量} (field 101): 兑换 (协议同其他活动商城, 待实测确认)
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
const { isAutomationOn, getActivityStatus } = require('../models/store');
const { getItemById } = require('../config/gameConfig');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';

const GROUP_MAIN = 2026090101;  // S3 萌宠: 宠物状态 (body #115)
const GROUP_GIFT = 2026090102;  // 每日免费稀有种子礼包 31 天列表 (body #110), 领取 = cmd21 走 star_light_up 通道
const GROUP_SHOP = 2026090103;  // 拾物小铺 (type=3, body #102 = ActivityBodyShop, 消耗幸运星兑换)
const CMD_SHOP_LIST = 7;        // 拉取小铺列表 (实测: 空 payload, 响应 body #102)
const CMD_SHOP_BUY = 1;         // 兑换 (协议同其他活动: cmd=1 + shop_buy{goods_id,count})
const SHOP_BUY_PAYLOAD_FIELD = 101;

// 寻宝 (2026-09-14 抓包实测): cmd=30, payload field129 空
// 消耗 萌宠元气糕×700 → 必得 待护送宝藏×1 + 初级挑战书×1 + 幸运星×50, 并自动开启 4 小时护送
const CMD_TREASURE_HUNT = 30;
const HUNT_PAYLOAD_FIELD = 129;
const HUNT_COST_YUANQIGAO = 700;
// 锦囊: 每日0点刷新2个选1个; cmd=41 刷新(结果返回锦囊id), cmd=42 选择(payload=锦囊id字符串)
const CMD_WISH_BAG_REFRESH = 41;
const CMD_WISH_BAG_SELECT = 42;

// 主活动各 cmd 对应的 OperateRequest payload 字段号
const MAIN_CMD_PAYLOAD_FIELD = {
    27: 126,
    29: 128,   // 投喂
    31: 130,   // (旧) 语义未确认
    32: 131,   // 领取爪印手记奖励
    41: 141,   // 寻宝 (推断: 结果带宝藏id+开始时间, 状态 #6 记录)
    42: 142,   // 选择锦囊 (payload = 锦囊id 字符串)
    47: 147,   // 好友夺宝
    48: 0,     // 领取比熊犬 (实测请求不带 payload 字段)
    49: 149,   // 点亮/翻看爪印手记 (payload = {#1: 手记id 裸 varint 字节})
};

// toNum 对字符串会原样返回(parseTop 的 varint 都是字符串), 比较/计算前统一走 toInt
function toInt(value) {
    const n = Number(toNum(value));
    return Number.isFinite(n) ? n : 0;
}

const ITEM_ID_YUANQIGAO = 1028;   // 萌宠元气糕 (投喂/寻宝消耗, 每次投喂 700)
const ITEM_ID_LUCKYSTAR = 1029;   // 幸运星
const ITEM_ID_BEAR = 90031;       // 比熊犬 (成年后领取)
const FEED_COST = 700;            // 单次投喂消耗的元气糕
const STAGE_ADULT = 2;            // 成长阶段: 2 = 成年 (可领比熊犬/寻宝)

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
                        const id = toInt((findField(it, 1) || {}).v);
                        const count = toInt((findField(it, 2) || {}).v);
                        if (id > 0) items.push({ id, count: count || 1, name: itemName(id) });
                    }
                }
                days.push({
                    day: toInt((findField(d, 1) || {}).v),
                    unlocked: toInt((findField(d, 2) || {}).v) > 0,
                    claimed: toInt((findField(d, 3) || {}).v) > 0,
                    items,
                });
            }
        }
        days.sort((a, b) => a.day - b.day);
        const curEntry = body.find((x) => x.f === 1 && x.w === 0);
        const totalEntry = body.find((x) => x.f === 2 && x.w === 0);
        return {
            currentDay: toInt(curEntry && curEntry.v),
            totalDays: toInt(totalEntry && totalEntry.v) || days.length,
            days,
        };
    }
    return null;
}

/** 解析 #115 宠物状态: 成长值 / 阶段 / 投喂次数 / 幸运星 / 爪印手记列表 */
function parsePetState(stateBuf) {
    const f = parseTop(stateBuf);
    const pet = { growth: 0, petType: 0, stage: 0, feedCount: 0, lastFeedAt: 0, items: [], handnotes: [] };
    const f1 = findField(f, 1);
    if (f1 && f1.w === 2) {
        const inner = parseTop(f1.v);
        pet.petType = toInt((findField(inner, 1) || {}).v);
        pet.growth = toInt((findField(inner, 3) || {}).v);
        pet.stage = toInt((findField(inner, 4) || {}).v);
        pet.lastFeedAt = toInt((findField(inner, 5) || {}).v);
        pet.adult = pet.stage >= STAGE_ADULT;
    }
    // #2 { #1: 投喂次数 }
    const f2 = findField(f, 2);
    if (f2 && f2.w === 2) {
        pet.feedCount = toInt((findField(parseTop(f2.v), 1) || {}).v);
    }
    // #3 { #3: 数值(幸运星), #4: {#1: 物品id, #2: 数量} }
    const f3 = findField(f, 3);
    if (f3 && f3.w === 2) {
        for (const x of parseTop(f3.v)) {
            if (x.w === 0 && x.f === 3) pet.luckyStar = toInt(x.v);
            if (x.w === 2) {
                const inner = parseTop(x.v);
                const id = toInt((findField(inner, 1) || {}).v);
                const count = toInt((findField(inner, 2) || {}).v);
                if (id > 0) pet.items.push({ id, count, name: itemName(id) });
            }
        }
    }
    // #6 = 锦囊状态 { #1: 刷新出的备选key, #2: 当前生效key, #4: 附加数值, #6: 已选标记, #7: 已刷新标记 }
    const f6 = findField(f, 6);
    if (f6 && f6.w === 2) {
        const t = parseTop(f6.v);
        const keys = [];
        const readKey = (field) => {
            const e = findField(t, field);
            if (e && e.w === 2) {
                const str = e.v.toString('utf8');
                if (/^[\x20-\x7e]{1,8}$/.test(str)) return str;
            }
            return '';
        };
        const k1 = readKey(1);
        const k2 = readKey(2);
        if (k2) keys.push(k2);
        if (k1 && k1 !== k2) keys.push(k1);
        pet.wishBags = {
            keys,                                              // 今日两个锦囊 key
            selectedKey: k2,                                   // 当前生效(#2)
            refreshedKey: k1,                                  // 刷新出的备选(#1)
            hasSelection: toInt((findField(t, 6) || {}).v) > 0,
            refreshed: toInt((findField(t, 7) || {}).v) > 0,
            extraCounter: toInt((findField(t, 8) || {}).v),   // 含义未确认(实测出现 3), 仅保留备查
        };
        const f4 = findField(t, 4);
        if (f4 && f4.w === 2) {
            const inner = parseTop(f4.v);
            pet.wishBags.extra = {
                a: toInt((findField(inner, 1) || {}).v),
                b: toInt((findField(inner, 2) || {}).v),
                c: toInt((findField(inner, 3) || {}).v),
            };
        }
        // 兼容旧字段
        pet.extra = { ...(pet.extra || {}), ...pet.wishBags };
    }
    for (const x of f) {
        if (x.f === 2 && x.w === 2) {
            const inner = parseTop(x.v);
            const v = toInt((findField(inner, 1) || {}).v);
            if (v > 0) pet.baseValue = v;
        }
    }
    // #7 = 护送/宝藏状态 { #1: { #1: 宝藏ID, #2: 货币id, #3: 价值, #4: 开始时间, #6: 结束时间,
    //                          #8: 博弈资金, #9: 保底, #10: 上限, #14: 夺宝次数上限 } }
    const f7 = findField(f, 7);
    if (f7 && f7.w === 2) {
        const wrap = parseTop(f7.v).find(x => x.f === 1 && x.w === 2);
        if (wrap) {
            const t = parseTop(wrap.v);
            const idBuf = findField(t, 1);
            const now = Math.floor(Date.now() / 1000);
            const endTime = toInt((findField(t, 6) || {}).v);
            pet.escort = {
                treasureId: idBuf && idBuf.w === 2 ? idBuf.v.toString('utf8') : '',
                currencyId: toInt((findField(t, 2) || {}).v),
                value: toInt((findField(t, 3) || {}).v),
                startTime: toInt((findField(t, 4) || {}).v),
                endTime,
                betFunds: toInt((findField(t, 8) || {}).v),
                floor: toInt((findField(t, 9) || {}).v),
                cap: toInt((findField(t, 10) || {}).v),
                maxRobCount: toInt((findField(t, 14) || {}).v),
                remainingSec: endTime > now ? endTime - now : 0,
                active: endTime > now,
            };
        }
    }
    // #4 是容器消息: 内部 repeated #1 才是手记条目 (实测 2026-09-14 修正标志位)
    // 条目字段: #1=id, #2=1, #3=1 表示【已领取奖励】, #4=照片JSON, #5=1 表示【已点亮/翻开】
    for (const x of f) {
        if (x.f !== 4 || x.w !== 2) continue;
        for (const entry of parseTop(x.v)) {
            if (entry.f !== 1 || entry.w !== 2) continue;
            const d = parseTop(entry.v);
            const id = toInt((findField(d, 1) || {}).v);
            if (!id) continue;
            const photoBuf = findField(d, 4);
            let photo = null;
            if (photoBuf && photoBuf.w === 2) {
                try { photo = JSON.parse(photoBuf.v.toString('utf8')); } catch { photo = null; }
            }
            const opened = toInt((findField(d, 5) || {}).v) > 0;
            const claimed = toInt((findField(d, 3) || {}).v) > 0;
            pet.handnotes.push({
                id,
                opened,                                  // 已点亮(可领取)
                claimed,                                 // 已领取
                unlocked: opened,                        // 兼容旧字段名
                claimable: opened && !claimed,
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
            const id = toInt(it && it.id);
            if (id === ITEM_ID_YUANQIGAO) result.yuanqigao = toInt(it.count);
            else if (id === ITEM_ID_LUCKYSTAR) result.luckyStar = toInt(it.count);
        }
    } catch (e) { /* 背包读取失败不阻断 */ }
    return result;
}

// ============ 拾物小铺 ============

/** 解析 body #102 (ActivityBodyShop) 的商品列表 */
function parseShopBody(activityBuf) {
    if (!activityBuf) return [];
    const shopField = parseTop(activityBuf).find(x => x.f === 102 && x.w === 2);
    if (!shopField) return [];
    const items = [];
    for (const g of parseTop(shopField.v)) {
        if (g.f !== 1 || g.w !== 2) continue;
        const d = parseTop(g.v);
        const id = toInt((findField(d, 1) || {}).v);
        if (!id) continue;
        const itemField = findField(d, 2);
        const costField = findField(d, 3);
        const nameBuf = findField(d, 7);
        let item = null;
        if (itemField && itemField.w === 2) {
            const it = parseTop(itemField.v);
            item = { id: toInt((findField(it, 1) || {}).v), count: toInt((findField(it, 2) || {}).v) || 1 };
            item.name = itemName(item.id);
        }
        let cost = null;
        if (costField && costField.w === 2) {
            const ct = parseTop(costField.v);
            const cid = toInt((findField(ct, 1) || {}).v);
            cost = { id: cid, amount: toInt((findField(ct, 2) || {}).v), name: itemName(cid) };
        }
        const descBuf = findField(d, 8);
        let icon = '';
        if (descBuf && descBuf.w === 2) {
            try { icon = (JSON.parse(descBuf.v.toString('utf8')) || {}).res || ''; } catch { icon = ''; }
        }
        const limit = toInt((findField(d, 4) || {}).v);
        const bought = toInt((findField(d, 5) || {}).v);
        items.push({
            id,
            name: nameBuf && nameBuf.w === 2 ? nameBuf.v.toString('utf8') : (item ? item.name : `商品#${id}`),
            item,
            cost,
            limit,                                   // 限购数量
            bought,                                  // 已兑换数量
            remaining: limit > 0 ? Math.max(0, limit - bought) : null,
            order: toInt((findField(d, 6) || {}).v),
            quality: toInt((findField(d, 10) || {}).v),
            restrictionType: toInt((findField(d, 11) || {}).v),
            icon,
        });
    }
    items.sort((a, b) => a.order - b.order);
    return items;
}

/**
 * 拾物小铺列表 (cmd=7, 空 payload) — 消耗幸运星兑换
 */
async function getMengchongShop() {
    const res = await operateRaw(GROUP_SHOP, CMD_SHOP_LIST, 0, null);
    if (res.errorCode !== 0) throw new Error(`获取拾物小铺失败: code=${res.errorCode}`);
    const items = parseShopBody(res.activity);
    // 幸运星余额
    let luckyStar = 0;
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const bag = await getBag();
        for (const it of getBagItems(bag)) {
            if (toInt(it && it.id) === ITEM_ID_LUCKYSTAR) { luckyStar = toInt(it.count); break; }
        }
    } catch (e) { /* 背包失败不阻断 */ }
    return { updatedAt: Date.now(), luckyStar, items };
}

/**
 * 拾物小铺兑换 (cmd=1 + shop_buy, 协议同其他活动商城)
 * 校验: 重新拉取小铺对比 purchased_count 是否增加 (协议差异时不会误报成功)
 */
async function exchangeMengchongShopGoods(goodsId, count = 1) {
    const id = Math.floor(Number(goodsId) || 0);
    const num = Math.max(1, Math.min(99, Math.floor(Number(count) || 1)));
    if (!id) throw new Error('缺少商品 ID');

    const before = await getMengchongShop();
    const target = (before.items || []).find(it => it.id === id);
    if (!target) throw new Error('该商品不在拾物小铺中');
    if (target.remaining !== null && num > target.remaining) throw new Error(`该商品最多还可兑换 ${target.remaining} 个`);
    if (target.cost && before.luckyStar > 0 && before.luckyStar < target.cost.amount * num) {
        throw new Error(`幸运星不足 (需要 ${target.cost.amount * num}, 现有 ${before.luckyStar})`);
    }

    // ShopBuyReq { goods_id=1, count=2 }
    const inner = new protobuf.Writer();
    inner.uint32((1 << 3) | 0).int64(toLong(id));
    inner.uint32((2 << 3) | 0).int64(toLong(num));
    const res = await operateRaw(GROUP_SHOP, CMD_SHOP_BUY, SHOP_BUY_PAYLOAD_FIELD, Buffer.from(inner.finish()));
    if (res.errorCode !== 0) throw new Error(`兑换失败: code=${res.errorCode}`);

    // 校验: 重新拉列表看已兑换数量是否变化
    let after = null;
    try { after = await getMengchongShop(); } catch (e) { after = null; }
    const afterTarget = after ? (after.items || []).find(it => it.id === id) : null;
    const verified = !!(afterTarget && afterTarget.bought > (target.bought || 0));
    return {
        goodsId: id,
        count: num,
        name: target.name,
        ok: verified,
        verified,
        reason: verified ? '' : '兑换未生效(商城协议可能与预期不同, 请抓包确认)',
        luckyStar: after ? after.luckyStar : null,
        shopItem: afterTarget || null,
    };
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
            if (x.w === 0) result['f' + x.f] = toInt(x.v);
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
                        const id = toInt((findField(it, 1) || {}).v);
                        const count = toInt((findField(it, 2) || {}).v);
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
        if (x.w === 0) out['f' + x.f] = toInt(x.v);
        else if (x.w === 2 && x.v.length <= 16) {
            const inner = parseTop(x.v);
            const id = toInt((findField(inner, 1) || {}).v);
            const count = toInt((findField(inner, 2) || {}).v);
            if (id > 0 && count > 0) out.items = [...(out.items || []), { id, count, name: itemName(id) }];
        }
    }
    return out;
}

/** 从 Operate 响应的 activity 里取出某条手记的最新状态 (用于校验操作是否真的生效) */
function findHandnoteInActivity(activityBuf, handnoteId) {
    if (!activityBuf) return null;
    const stateField = parseTop(activityBuf).find(x => x.f === 115 && x.w === 2);
    if (!stateField) return null;
    const pet = parsePetState(stateField.v);
    // 注意: parseTop 里 varint 存的是字符串, toNum 对字符串原样返回 → 必须用 toInt 转数字比较
    return pet.handnotes.find(h => toInt(h.id) === toInt(handnoteId)) || null;
}

/**
 * 点亮/翻开爪印手记 (cmd=49, payload field149 = {#1: 手记id 裸varint字节})
 * 抓包实测: 手记 2 → payload 0a0102，点亮后状态里该条目 #5 = 1
 * 注意: 对未开放的手记, 服务端可能返回 err=0 但状态不变 → 必须校验状态, 否则会误报成功
 */
async function unlockPetHandnote(handnoteId) {
    const id = Math.floor(Number(handnoteId) || 0);
    if (!id) throw new Error('缺少手记 id');
    // 手记 id 是裸 varint 字节 (实测 id=2 → 0a0102)
    const inner = new protobuf.Writer();
    inner.uint64(toLong(id));
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 2).bytes(inner.finish());
    const res = await operateRaw(GROUP_MAIN, 49, MAIN_CMD_PAYLOAD_FIELD[49], w.finish());
    if (res.errorCode !== 0) throw new Error(`点亮手记失败: code=${res.errorCode}`);
    const after = findHandnoteInActivity(res.activity, id);
    // 无法从响应校验时, 一律按"未生效"处理 (避免误报成功)
    if (!after) {
        return { handnoteId: id, ok: false, reason: '无法校验结果(响应未带状态)' };
    }
    if (!after.opened) {
        return { handnoteId: id, ok: false, reason: '该手记尚不可点亮', handnote: after };
    }
    return { handnoteId: id, ok: true, verified: true, handnote: after };
}

/**
 * 领取爪印手记奖励 (cmd=32, payload field131 = {#1: 手记id})
 * 校验: 领取成功后状态里该条目 #3 = 1
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
        const itemId = toInt((findField(inner, 1) || {}).v);
        const count = toInt((findField(inner, 2) || {}).v);
        if (itemId > 0 && count > 0) awards.push({ id: itemId, count, name: itemName(itemId) });
    }
    const after = findHandnoteInActivity(res.activity, id);
    if (!after) {
        const hasAwards = awards.length > 0;
        return { handnoteId: id, awards, ok: hasAwards, reason: hasAwards ? '' : '无法校验结果(响应未带状态)' };
    }
    if (!after.claimed) {
        return { handnoteId: id, awards, ok: false, reason: '未领取成功', handnote: after };
    }
    return { handnoteId: id, awards, ok: true, verified: true, handnote: after };
}

/**
 * 领取比熊犬 (cmd=48, payload field148 空) — 比熊成年后解锁宠物, 结果 #148 = {#1: 90031 比熊犬}
 */
async function claimBearPet() {
    const res = await operateRaw(GROUP_MAIN, 48, MAIN_CMD_PAYLOAD_FIELD[48], null);
    if (res.errorCode !== 0) throw new Error(`领取比熊犬失败: code=${res.errorCode}`);
    const f = parseTop(Buffer.from(res.resultHex || '', 'hex'));
    const itemId = toInt((findField(f, 1) || {}).v);
    return { ok: true, itemId, name: itemId ? itemName(itemId) : '' };
}

/**
 * 寻宝 (cmd=41, payload field141 空, 抓包推断)
 * 结果 #141 = { #1: 宝藏id(字符串), #2: 开始时间, #4/#5: 标记 }; 状态 #6 记录宝藏与护送信息
 */
async function bagCountOf(itemId) {
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const bag = await getBag();
        for (const it of getBagItems(bag)) {
            if (toInt(it && it.id) === itemId) return toInt(it.count);
        }
    } catch (e) { /* 忽略 */ }
    return 0;
}

/**
 * 寻宝 (cmd=30, payload field129 空) — 比熊成年后解锁
 * 实测: 消耗萌宠元气糕×700 → 待护送宝藏×1 + 初级挑战书×1 + 幸运星×50, 并自动开启 4 小时护送
 * 响应结果 #130 = { #2: 消耗{id,count}, #5...: 获得{id,count} }
 */
async function treasureHunt() {
    const res = await operateRaw(GROUP_MAIN, CMD_TREASURE_HUNT, HUNT_PAYLOAD_FIELD, null);
    if (res.errorCode !== 0) {
        if (String(res.errorCode) === '1000019') throw new Error('萌宠元气糕不足(需要 700)');
        throw new Error(`寻宝失败: code=${res.errorCode}`);
    }
    const f = parseTop(Buffer.from(res.resultHex || '', 'hex'));
    let cost = null;
    const gains = [];
    for (const x of f) {
        if (x.w !== 2 || x.v.length > 16) continue;
        const inner = parseTop(x.v);
        const id = toInt((findField(inner, 1) || {}).v);
        const count = toInt((findField(inner, 2) || {}).v);
        if (!id) continue;
        const entry = { id, count, name: itemName(id) };
        if (x.f === 2) cost = entry; else gains.push(entry);
    }
    // 护送状态 (#115.#7)
    let escort = null;
    if (res.activity) {
        const st = parseTop(res.activity).find(x => x.f === 115 && x.w === 2);
        if (st) escort = parsePetState(st.v).escort || null;
    }
    const gainText = gains.map(g => `${g.name}×${g.count}`).join('、');
    log('活动', `萌宠游记: 寻宝成功 消耗${cost ? `${cost.name}×${cost.count}` : '元气糕×700'} → ${gainText}${escort ? ` (护送至 ${new Date(escort.endTime * 1000).toLocaleTimeString('zh-CN', { hour12: false })})` : ''}`, {
        module: 'activity', event: '萌宠游记', result: 'hunt_ok',
    });
    return { ok: true, verified: gains.length > 0, cost, gains, escort };
}

/**
 * 刷新锦囊 (cmd=41, 空 payload) — 官方说明: 每日 0 点刷新 2 个锦囊, 每日 1 次免费刷新
 * 结果 #141 = { #1: 锦囊id, #2: 刷新时间, #4/#5: 标志 }; 状态 #115.#6.#1/#2 = 当日两个锦囊 id
 */
async function refreshWishBags() {
    const res = await operateRaw(GROUP_MAIN, CMD_WISH_BAG_REFRESH, MAIN_CMD_PAYLOAD_FIELD[41], null);
    if (res.errorCode !== 0) throw new Error(`刷新锦囊失败: code=${res.errorCode}`);
    const f = parseTop(Buffer.from(res.resultHex || '', 'hex'));
    const idBuf = findField(f, 1);
    const key = idBuf && idBuf.w === 2 ? idBuf.v.toString('utf8') : '';
    // 校验: 响应状态里的备选锦囊要有变化(或已刷新标记)
    const after = readWishBagsFromActivity(res.activity);
    const verified = !!(after && (after.refreshedKey === key || after.refreshed));
    return {
        ok: verified,
        verified,
        reason: verified ? '' : '刷新未生效(可能今日免费刷新已用完)',
        wishBagKey: key,
        refreshedAt: toInt((findField(f, 2) || {}).v),
        wishBags: after,
    };
}

/** 选择锦囊 (cmd=42, payload field142 = 锦囊key 字符串) */
async function selectWishBag(wishBagKey) {
    const key = String(wishBagKey || '').trim();
    if (!key) throw new Error('缺少锦囊 key');
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 2).bytes(Buffer.from(key, 'utf8'));
    const res = await operateRaw(GROUP_MAIN, CMD_WISH_BAG_SELECT, MAIN_CMD_PAYLOAD_FIELD[42], w.finish());
    if (res.errorCode !== 0) throw new Error(`选择锦囊失败: code=${res.errorCode}`);
    // 校验: 响应状态里 #2(当前生效) 应等于所选 key
    const after = readWishBagsFromActivity(res.activity);
    const verified = !!(after && after.selectedKey === key);
    return {
        ok: verified,
        verified,
        reason: verified ? '' : '选择未生效(该锦囊可能不可选)',
        wishBagKey: key,
        wishBags: after,
    };
}

/** 从 Operate 响应的 activity 里读锦囊状态 */
function readWishBagsFromActivity(activityBuf) {
    if (!activityBuf) return null;
    const st = parseTop(activityBuf).find(x => x.f === 115 && x.w === 2);
    if (!st) return null;
    const pet = parsePetState(st.v);
    return pet.wishBags || null;
}

/** 活动玩法说明 (活动 head.desc 的 JSON: tips / tips1 / tips2) */
async function getMengchongRules() {
    const reply = await getGroupRaw(GROUP_MAIN);
    const { head } = parseGroupReply(reply);
    const json = head && head.descJson;
    const out = { uid: json && json.uid ? json.uid : '', sections: [] };
    if (!json) return out;
    const clean = (s) => String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<\/?b>/gi, '').replace(/&nbsp;/g, ' ').trim();
    for (const key of ['tips', 'tips1', 'tips2', 'tips3']) {
        const t = json[key];
        if (!t || !Array.isArray(t.txt)) continue;
        out.sections.push({
            key,
            title: t.title || '',
            lines: t.txt.filter(x => typeof x === 'string').map(clean).filter(Boolean),
        });
    }
    return out;
}

/**
 * 自动投喂: 每次消耗 700 萌宠元气糕 → 成长值 +700, 幸运星 +100 (抓包实测)
 * 元气糕不足时服务端报 1000019, 直接结束; 成年后自动领取比熊犬
 */
async function autoFeedPet(opts = {}) {
    const maxFeeds = Math.max(1, Math.min(200, Math.floor(Number(opts.maxFeeds) || 100)));
    // reserve: 给自动寻宝预留的元气糕数量(避免投喂把元气糕吃光导致寻宝没得用)
    const reserve = Math.max(0, Math.floor(Number(opts.reserve) || 0));
    const summary = { feeds: 0, growth: 0, luckyStar: 0, petUnlocked: false, stopped: '' };
    let remaining = await bagCountOf(ITEM_ID_YUANQIGAO);
    if (remaining < FEED_COST + reserve) {
        summary.stopped = `元气糕不足(需 ${FEED_COST + reserve}, 现有 ${remaining})`;
        return summary;
    }
    for (let i = 0; i < maxFeeds; i++) {
        if (remaining < FEED_COST + reserve) {
            summary.stopped = reserve > 0 ? `已为寻宝预留 ${reserve} 元气糕` : '元气糕不足';
            break;
        }
        let r;
        try {
            r = await feedPet();
        } catch (e) {
            summary.stopped = e.message.includes('1000019') ? '元气糕不足' : e.message;
            break;
        }
        remaining = Math.max(0, remaining - FEED_COST);
        summary.feeds += 1;
        if (r.f1) summary.growth = toInt(r.f1);
        const lucky = (r.items || []).find(it => toInt(it.id) === ITEM_ID_LUCKYSTAR);
        if (lucky) summary.luckyStar = toInt(lucky.count);
        summary.stage = toInt(r.f4) || summary.stage || 0;
        await randomDelay(400, 900);
    }
    // 成年后领取比熊犬
    if (summary.stage >= STAGE_ADULT && !opts.skipPetClaim) {
        try {
            const p = await claimBearPet();
            summary.petUnlocked = true;
            summary.petName = p.name;
        } catch (e) {
            summary.stopped = summary.stopped || `领取比熊犬失败: ${e.message}`;
        }
    }
    return summary;
}

/**
 * 自动寻宝: 比熊成年 + 无护送中的宝藏 + 元气糕充足 时执行
 * 单次消耗元气糕 700, 必得 待护送宝藏 + 初级挑战书 + 幸运星50, 并自动开启 4 小时护送
 * 默认每轮只寻宝 1 次(每日次数有限, 避免一次烧光元气糕)
 */
async function autoTreasureHunt(opts = {}) {
    const maxHunts = Math.max(1, Math.min(5, Math.floor(Number(opts.maxHunts) || 1)));
    const summary = { hunts: 0, gains: [], escort: null, stopped: '' };
    // 先读状态: 需要成年 + 当前没有护送中的宝藏(一次只能护送一个)
    let pet = null;
    try {
        const res = await operateRaw(GROUP_MAIN, 27, MAIN_CMD_PAYLOAD_FIELD[27], null);
        const st = res.activity ? parseTop(res.activity).find(x => x.f === 115 && x.w === 2) : null;
        if (st) pet = parsePetState(st.v);
    } catch (e) {
        summary.stopped = `读取宠物状态失败: ${e.message}`;
        return summary;
    }
    if (!pet) { summary.stopped = '未取到宠物状态'; return summary; }
    if (!pet.adult) { summary.stopped = '比熊未成年'; return summary; }
    if (pet.escort && pet.escort.active) { summary.stopped = '已有护送中的宝藏'; return summary; }

    if (await bagCountOf(ITEM_ID_YUANQIGAO) < HUNT_COST_YUANQIGAO) {
        summary.stopped = `元气糕不足(需 ${HUNT_COST_YUANQIGAO})`;
        return summary;
    }
    for (let i = 0; i < maxHunts; i++) {
        if (await bagCountOf(ITEM_ID_YUANQIGAO) < HUNT_COST_YUANQIGAO) { summary.stopped = '元气糕不足'; break; }
        try {
            const r = await treasureHunt();
            summary.hunts += 1;
            summary.gains = r.gains || [];
            summary.escort = r.escort || null;
            await randomDelay(1000, 1800);
        } catch (e) {
            summary.stopped = e.message;
            break;
        }
    }
    return summary;
}

/**
 * 每天自动领取已解锁但未领取的爪印手记奖励
 */
async function autoClaimPetHandnotes() {
    const summary = { claimed: 0, unlocked: 0, handnotes: [], skipped: [] };
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
    // 1) 先点亮未点亮的手记 (cmd=49) — 按顺序尝试, 遇到"未生效"即停止
    //    (手记按进度依次开放: 前面的未开放时, 后面的必然未开放, 避免无意义请求)
    let stopped = false;
    for (const h of pet.handnotes) {
        if (h.opened) continue;
        if (stopped) { summary.skipped.push(`手记${h.id}(前序未开放)`); continue; }
        try {
            const r = await unlockPetHandnote(h.id);
            // 校验: 响应里该手记 #5 必须变为 1, 否则视为未生效(避免误报成功)
            if (r.ok && r.verified !== false) {
                summary.unlocked += 1;
                h.opened = true;
                log('活动', `萌宠游记: 点亮爪印手记 ${h.id}`, { module: 'activity', event: '萌宠游记', result: 'handnote_unlock' });
            } else {
                stopped = true;
                summary.skipped.push(`手记${h.id}(${r.reason || '未生效'})`);
            }
            await randomDelay(600, 1200);
        } catch (e) {
            stopped = true;
            summary.skipped.push(`手记${h.id}点亮(${e.message.includes('code=') ? '条件未满足' : e.message})`);
        }
    }
    // 2) 领取已点亮未领取的奖励 (cmd=32)
    for (const h of pet.handnotes) {
        if (!h.opened || h.claimed) continue;
        try {
            const r = await claimPetHandnote(h.id);
            // 校验: 响应里该手记 #3 应变为 1; 拿不到状态时以"是否返回奖励"为准
            const ok = r.ok && (r.verified !== false || (r.awards || []).length > 0);
            if (!ok) {
                summary.skipped.push(`手记${h.id}(${r.reason || '未生效'})`);
                continue;
            }
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
    const summary = { giftClaimed: false, handnoteClaims: 0, handnoteUnlocks: 0, feeds: 0, hunts: 0, petUnlocked: false, skipped: [], errors: [] };
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
        summary.handnoteUnlocks = r.unlocked || 0;
        summary.skipped.push(...(r.skipped || []));
    } catch (e) {
        summary.errors.push(`手记奖励领取失败: ${e.message}`);
    }

    // 自动投喂: 消耗元气糕喂比熊, 成年后自动领取比熊犬
    // 若开启了自动寻宝, 则预留一份寻宝消耗(700), 避免投喂把元气糕吃光
    const huntOn = isAutomationOn('mengchong_hunt') && getActivityStatus().mengChongEnabled !== false;
    try {
        const f = await autoFeedPet({ reserve: huntOn ? HUNT_COST_YUANQIGAO : 0 });
        summary.feeds = f.feeds;
        summary.petUnlocked = !!f.petUnlocked;
        if (f.feeds > 0) {
            log('活动', `萌宠游记: 自动投喂 ${f.feeds} 次 (成长值 ${f.growth}, 幸运星 ${f.luckyStar}${f.petUnlocked ? `, 已解锁${f.petName || '比熊犬'}` : ''})`, {
                module: 'activity', event: '萌宠游记', result: 'feed_ok',
            });
        }
        if (f.stopped && !/元气糕不足/.test(f.stopped)) summary.skipped.push(`投喂(${f.stopped})`);
    } catch (e) {
        summary.errors.push(`自动投喂失败: ${e.message}`);
    }

    // 自动寻宝 (独立开关 mengchong_hunt)
    if (huntOn) {
        try {
            const h = await autoTreasureHunt();
            summary.hunts = h.hunts;
            if (h.hunts > 0) {
                const gainText = (h.gains || []).map(g => `${g.name}×${g.count}`).join('、');
                log('活动', `萌宠游记: 自动寻宝 ${h.hunts} 次 → ${gainText}${h.escort ? ` (护送至 ${new Date(h.escort.endTime * 1000).toLocaleTimeString('zh-CN', { hour12: false })})` : ''}`, {
                    module: 'activity', event: '萌宠游记', result: 'hunt_auto_ok',
                });
            } else if (h.stopped) {
                summary.skipped.push(`寻宝(${h.stopped})`);
            }
        } catch (e) {
            summary.errors.push(`自动寻宝失败: ${e.message}`);
        }
    }

    return summary;
}

/**
 * 顶层自动化入口 (受 mengchong_task 开关控制)
 */
async function checkAndRunMengchongTasks() {
    // 后台关闭了「萌宠游记」菜单 → 自动化一并停止
    if (getActivityStatus().mengChongEnabled === false) return { skipped: true, reason: '活动已在后台关闭' };
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
    __testing: { parseTop, parseGroupReply, parseSigninDays, parsePetState, parseShopBody, itemName },
    GROUP_MAIN,
    GROUP_GIFT,
    getMengchongOverview,
    getMengchongShop,
    exchangeMengchongShopGoods,
    claimFreeSeedGift,
    feedPet,
    autoFeedPet,
    autoTreasureHunt,
    claimBearPet,
    treasureHunt,
    refreshWishBags,
    selectWishBag,
    getMengchongRules,
    unlockPetHandnote,
    claimPetHandnote,
    autoClaimPetHandnotes,
    petOperate,
    autoRunMengchongTasks,
    checkAndRunMengchongTasks,
};
