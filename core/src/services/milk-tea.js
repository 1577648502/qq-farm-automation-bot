/**
 * 奶茶热销中 (2026-10-15 上线的新活动) —— 开店营业 / 工坊加工 / 好友助力 / 宣传加速
 *
 * ════════ 活动规则 (活动页 tips 原文, uid=MilkTeaActivity) ════════
 * 营业期 2026-10-15 — 2026-11-14; 结算期 2026-11-15 — 2026-11-16(48h)
 *  1. 开店营业: 确认店名开业领开业礼; 店铺自动卖奶茶(离线也积累) → 得奶茶券, 高级奶茶额外给金币
 *  2. 种植加工: 活动果实在「奶茶工坊」加工成高级奶茶; 变异果实按售价倍率换算产量;
 *     累计营业额达标升级店铺; 奶茶券可买种子/雇人/兑换(消费不减营业额)
 *  3. 好友助力: 雇佣好友得特长加成; 被雇后每班可在「我的工作」互动一次; 班次结束领工资+奖金
 *  4. 宣传加速: 宣传喇叭 → 立即获得基础热卖值对应的 1 小时销售收益(不吃加成)
 * ⚠ 收银台满载会暂停自动营业且**不补发** → 定时领收益(cmd=55)是自动化的核心
 *
 * ════════ 协议 (2026-10-15 抓包, 上行已解密实测) ════════
 * 活动组: 2026110101 主活动 / 2026110102 种子商店 / 2026110103 任务 / 2026110104 快乐不独享S4
 * 主活动(0101): **payload 字段 = cmd + 105**, 状态容器 = 活动体 #121.#1
 *   cmd=53 开业     {#158: {#1: "店名"}}
 *   cmd=55 领收益   {#160: ""}            ← 反复使用
 *   cmd=56 工坊加工 {#161: {#1: 1}}
 *   cmd=57 雇佣好友 {#162: {#1: {#1: 0, #2: 1, #3: 好友gid}}}
 *   cmd=58 宣传喇叭 {#163: ""}
 *   cmd=63 刷新/查询 {#168: ""}
 *   cmd=66 互动     {#171: {#1: 1}}
 *   cmd=67 班次     {#172: {#1: 时间戳}}
 *   cmd=69 查配方   {#174: {#1: {#1250: 配方id}}}
 *   状态 #121.#1: {#1: 结算时间, #2: 店名, #4: 1, #5: 数值, #15: {#1250: 当前配方}, #16: 时间}
 * 种子商店(0102): cmd=7 列表(结果在活动体 #102) / **cmd=1 购买 {#101: {#1: 商品ID, #2: 数量}}**
 *   商品: {#1: 商品ID, #2: {物品ID, 数量}, #3: {货币ID, 单价}, #7: 名称, #12: 'seed',
 *          #13: 解锁条件(如 "2026110101_奶茶店等级_3")}
 *   实测: 301「森野甜莓种子」单价 1001(金币)×10000, 买 108 个 → 扣 1080000 金币, 到账 20525×108
 * 任务(0103): cmd=7 列表(活动体 #122) = {#2: 累计奖励?, #3(repeated): {#1: 序号, #2: 条件, #3(repeated): {物品,数量}, #4: 状态}}
 */
const { log, toNum, toInt, sleep } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { operateRaw, parseTop, findField } = require('./mengchong');

const GROUP_MAIN = 2026110101;
const GROUP_SHOP = 2026110102;
const GROUP_TASK = 2026110103;
const GROUP_HAPPY = 2026110104;      // 快乐不独享 S4(复用 happy-share 服务)
const SUB_ID = 2026110100;

// 主活动命令
const CMD_OPEN = 53;        // 确认店名开业
const CMD_CASHIER = 55;     // 领取收银台收益
const CMD_CRAFT = 56;       // 工坊加工
const CMD_HIRE = 57;        // 雇佣好友
const CMD_SPEAKER = 58;     // 宣传喇叭
const CMD_REFRESH = 63;     // 刷新/查询
const CMD_INTERACT = 66;    // 互动(我的工作)
const CMD_SHIFT = 67;       // 班次(带时间戳)
const CMD_RECIPE = 69;      // 查询配方
const FIELD_OFFSET = 105;   // 主活动 payload 字段 = cmd + 105

// 商店命令(payload/结果字段 = cmd + 100)
const CMD_SHOP_LIST = 7;
const CMD_SHOP_BUY = 1;
const FIELD_SHOP_BUY = 101;

const STATE_FIELD = 121;    // 主活动状态容器
const SHOP_BODY_FIELD = 102;// 商店列表所在字段
const TASK_BODY_FIELD = 122;// 任务列表所在字段

function itemLabel(id, count) {
    const it = getItemById(toNum(id));
    return `${(it && it.name) || `物品#${id}`}×${count}`;
}

/** 主活动请求 */
function mainOperate(cmd, payloadField, payloadBytes) {
    return operateRaw(GROUP_MAIN, cmd, payloadField === undefined ? cmd + FIELD_OFFSET : payloadField, payloadBytes || Buffer.alloc(0));
}

/** 把 varint 编成 payload: {#1: n} */
function encodeUint1(n) {
    return Buffer.from([0x08, toInt(n) & 0x7f]);
}
function encodeVarint(v) {
    const out = [];
    let n = Math.max(0, toInt(v));
    do { out.push(n & 0x7f); n = Math.floor(n / 128); } while (n > 0);
    return Buffer.from(out.map((b, i) => (i === out.length - 1 ? b : b | 0x80)));
}

/** 解析主活动状态容器 #121.#1 */
function parseMainState(activityBuf) {
    const out = { ok: false, storeName: '', value: 0, recipeId: 0, at: 0, nextAt: 0 };
    if (!activityBuf || !activityBuf.length) return out;
    try {
        const act = parseTop(activityBuf);
        const head = findField(act, 1);
        const hf = head && head.w === 2 ? parseTop(head.v) : [];
        if (toInt((findField(hf, 1) || {}).v) !== GROUP_MAIN) return out;
        const box = findField(act, STATE_FIELD);
        const inner = box && box.w === 2 ? findField(parseTop(box.v), 1) : null;
        if (!inner || inner.w !== 2) { out.ok = true; return out; }
        const f = parseTop(inner.v);
        const nameField = findField(f, 2);
        out.storeName = nameField && nameField.w === 2 ? nameField.v.toString('utf8') : '';
        out.value = toInt((findField(f, 5) || {}).v);
        out.nextAt = toInt((findField(f, 1) || {}).v);
        out.at = toInt((findField(f, 16) || {}).v);
        const recipe = findField(f, 15);
        if (recipe && recipe.w === 2) out.recipeId = toInt((findField(parseTop(recipe.v), 1250) || {}).v);
        out.opened = !!out.storeName;
        out.ok = true;
    } catch (e) { /* 解析失败按"读不到"处理 */ }
    return out;
}

/** 刷新并读取主活动状态 */
async function getMainStatus() {
    const r = await mainOperate(CMD_REFRESH, undefined, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `刷新失败 code=${r.errorCode}` };
    const st = parseMainState(r.activity);
    return { ...st, ok: st.ok };
}

/** 领取收银台收益(核心: 满载会暂停营业且不补发) */
async function claimCashier() {
    const before = await getMainStatus().catch(() => null);
    const r = await mainOperate(CMD_CASHIER, undefined, Buffer.alloc(0));
    if (r.errorCode !== 0) {
        return { ok: false, reason: `领取收益失败 code=${r.errorCode}` };
    }
    const after = parseMainState(r.activity);
    log('活动', `奶茶热销中: 已领取收银台收益${after.value ? ` (营业额 ${after.value})` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok', before: before && before.value, after: after.value,
    });
    return { ok: true, value: after.value, before: before && before.value, state: after };
}

/** 工坊加工(把活动果实加工成高级奶茶) */
async function craft() {
    const r = await mainOperate(CMD_CRAFT, undefined, encodeUint1(1));
    if (r.errorCode !== 0) return { ok: false, reason: `加工失败 code=${r.errorCode}` };
    log('活动', '奶茶热销中: 已提交工坊加工', { module: 'activity', event: '奶茶热销中', result: 'ok' });
    return { ok: true, state: parseMainState(r.activity) };
}

/** 宣传喇叭(立即拿 1 小时基础收益) */
async function useSpeaker() {
    const r = await mainOperate(CMD_SPEAKER, undefined, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `使用宣传喇叭失败 code=${r.errorCode}` };
    log('活动', '奶茶热销中: 已使用宣传喇叭', { module: 'activity', event: '奶茶热销中', result: 'ok' });
    return { ok: true, state: parseMainState(r.activity) };
}

/** 开业(确认店名) */
async function openStore(storeName) {
    const name = String(storeName || '').trim() || '奶茶小铺';
    const nameBuf = Buffer.from(name, 'utf8');
    const payload = Buffer.concat([Buffer.from([0x0a, nameBuf.length]), nameBuf]);   // {#1: string}
    const r = await mainOperate(CMD_OPEN, undefined, payload);
    if (r.errorCode !== 0) return { ok: false, reason: `开业失败 code=${r.errorCode}` };
    log('活动', `奶茶热销中: 已开业(店名「${name}」)`, { module: 'activity', event: '奶茶热销中', result: 'ok' });
    return { ok: true, storeName: name, state: parseMainState(r.activity) };
}

/** 雇佣好友(#1: 0, #2: 1, #3: 好友gid 实测) */
async function hireFriend(friendGid) {
    const gid = toNum(friendGid);
    if (!gid) return { ok: false, reason: '缺少好友 gid' };
    const inner = Buffer.concat([encodeVarintField(1, 0), encodeVarintField(2, 1), encodeVarintField(3, gid)]);
    const payload = Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
    const r = await mainOperate(CMD_HIRE, undefined, payload);
    if (r.errorCode !== 0) return { ok: false, reason: `雇佣失败 code=${r.errorCode}` };
    log('活动', `奶茶热销中: 已雇佣好友 ${gid}`, { module: 'activity', event: '奶茶热销中', result: 'ok', friendGid: gid });
    return { ok: true, friendGid: gid, state: parseMainState(r.activity) };
}
function encodeVarintField(field, value) {
    return Buffer.concat([Buffer.from([(field << 3) | 0]), encodeVarint(value)]);
}

/** 我的工作: 每班一次互动 */
async function interact() {
    const r = await mainOperate(CMD_INTERACT, undefined, encodeUint1(1));
    if (r.errorCode !== 0) return { ok: false, reason: `互动失败 code=${r.errorCode}` };
    log('活动', '奶茶热销中: 已完成一次互动', { module: 'activity', event: '奶茶热销中', result: 'ok' });
    return { ok: true, state: parseMainState(r.activity) };
}

/** 种子商店列表(0102 cmd=7) */
async function getShopGoods() {
    const r = await operateRaw(GROUP_SHOP, CMD_SHOP_LIST, 0, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `读取商店失败 code=${r.errorCode}`, goods: [] };
    const goods = [];
    try {
        const act = parseTop(r.activity);
        const box = findField(act, SHOP_BODY_FIELD);
        if (box && box.w === 2) {
            for (const it of parseTop(box.v)) {
                if (it.w !== 2) continue;
                const f = parseTop(it.v);
                const goodsId = toInt((findField(f, 1) || {}).v);
                if (!goodsId) continue;
                const item = findField(f, 2);
                const price = findField(f, 3);
                const nameField = findField(f, 7);
                const unlock = findField(f, 13);
                const itemFields = item && item.w === 2 ? parseTop(item.v) : [];
                const priceFields = price && price.w === 2 ? parseTop(price.v) : [];
                const itemId = toInt((findField(itemFields, 1) || {}).v);
                const itemCount = toInt((findField(itemFields, 2) || {}).v) || 1;
                const currencyId = toInt((findField(priceFields, 1) || {}).v);
                const unitPrice = toInt((findField(priceFields, 2) || {}).v);
                let unlockText = '';
                if (unlock && unlock.w === 2) {
                    const uf = parseTop(unlock.v);
                    const cond = findField(uf, 2);
                    const need = toInt((findField(uf, 5) || {}).v);
                    if (cond && cond.w === 2) unlockText = cond.v.toString('utf8') + (need ? ` ≥${need}` : '');
                }
                // 限购(#4) / 类型(#12: seed=种子, exchange=装扮兑换, 空=道具) / 每单限购份数(#11)
                const limitCount = toInt((findField(f, 4) || {}).v);
                const kindField = findField(f, 12);
                const kind = kindField && kindField.w === 2 ? kindField.v.toString('utf8') : '';
                const itemDef = getItemById(itemId);
                goods.push({
                    goodsId,
                    name: nameField && nameField.w === 2 ? nameField.v.toString('utf8') : `商品#${goodsId}`,
                    itemId,
                    itemCount,
                    // 内容物名称: 官方表没有这个名字时留空, 由界面只显示商品名(避免出现"物品#20525")
                    itemName: itemDef ? itemLabel(itemId, itemCount) : '',
                    itemNameKnown: !!itemDef,
                    image: getItemImageById(itemId),
                    currencyId,
                    currencyName: (getItemById(currencyId) || {}).name || `货币#${currencyId}`,
                    unitPrice,
                    limitCount,
                    kind,
                    unlockText,
                });
            }
        }
    } catch (e) { /* 解析失败返回空 */ }
    return { ok: true, goods };
}

/** 兑换/购买商品(数量必填) —— 实测 {#101: {#1: 商品ID, #2: 数量}} */
async function buyShopGoods(goodsId, count = 1) {
    const id = toNum(goodsId);
    const n = Math.max(1, Math.min(9999, toInt(count) || 1));
    if (!id) return { ok: false, reason: '缺少商品 ID' };
    const inner = Buffer.concat([encodeVarintField(1, id), encodeVarintField(2, n)]);
    const payload = Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
    const r = await operateRaw(GROUP_SHOP, CMD_SHOP_BUY, FIELD_SHOP_BUY, payload);
    if (r.errorCode !== 0) return { ok: false, reason: `兑换失败 code=${r.errorCode}` };
    // 结果 #101 = {#1: {物品ID, 数量}, #2: {货币ID, 总价}}
    let got = null; let cost = null;
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            const a = findField(rf, 1);
            const b = findField(rf, 2);
            if (a && a.w === 2) {
                const af = parseTop(a.v);
                got = { id: toInt((findField(af, 1) || {}).v), count: toInt((findField(af, 2) || {}).v) };
            }
            if (b && b.w === 2) {
                const bf = parseTop(b.v);
                cost = { currencyId: toInt((findField(bf, 1) || {}).v), amount: toInt((findField(bf, 2) || {}).v) };
            }
        } catch (e) { /* 忽略 */ }
    }
    log('活动', `奶茶热销中: 兑换 ${n} 个商品#${id}${got ? ` → ${itemLabel(got.id, got.count)}` : ''}${cost ? `, 花费 ${cost.amount} ${(getItemById(cost.currencyId) || {}).name || ''}` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok', goodsId: id, count: n,
    });
    return { ok: true, goodsId: id, count: n, got, cost };
}

/** 任务列表(0103 cmd=7) */
async function getTasks() {
    const r = await operateRaw(GROUP_TASK, 7, 0, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `读取任务失败 code=${r.errorCode}`, tasks: [] };
    const tasks = [];
    try {
        const act = parseTop(r.activity);
        const box = findField(act, TASK_BODY_FIELD);
        if (box && box.w === 2) {
            for (const it of parseTop(box.v)) {
                if (it.f !== 3 || it.w !== 2) continue;
                const f = parseTop(it.v);
                const id = toInt((findField(f, 1) || {}).v);
                if (!id) continue;
                const rewards = [];
                for (const rw of f) {
                    if (rw.f !== 3 || rw.w !== 2) continue;
                    const rwf = parseTop(rw.v);
                    const rid = toInt((findField(rwf, 1) || {}).v);
                    const rcount = toInt((findField(rwf, 2) || {}).v);
                    if (rid) rewards.push({ id: rid, count: rcount || 1, name: itemLabel(rid, rcount || 1) });
                }
                tasks.push({ id, status: toInt((findField(f, 4) || {}).v), rewards });
            }
        }
    } catch (e) { /* 忽略 */ }
    return { ok: true, tasks };
}

/**
 * 自动流程(每次调用都幂等):
 *   ① 刷新状态(顺带确认活动还在)  ② 未开业则开业  ③ 领收银台收益  ④ 用工坊加工  ⑤ 用宣传喇叭
 * 开关由调用方(worker)按配置决定是否执行各步。
 */
async function runMilkTea(opts = {}) {
    const doCashier = opts.cashier !== false;
    const doCraft = !!opts.craft;
    const doSpeaker = !!opts.speaker;
    const out = { ok: true, steps: [] };

    let st = await getMainStatus();
    if (!st.ok) return { ok: false, reason: st.reason };
    out.state = st;

    if (!st.opened && opts.openStore !== false) {
        const r = await openStore(opts.storeName);
        out.steps.push({ step: 'openStore', ...r });
        await sleep(1200);
        st = await getMainStatus().catch(() => st);
    }
    if (doCashier) {
        const r = await claimCashier();
        out.steps.push({ step: 'cashier', ...r });
        await sleep(1200);
    }
    if (doCraft) {
        const r = await craft();
        out.steps.push({ step: 'craft', ...r });
        await sleep(1200);
    }
    if (doSpeaker) {
        const r = await useSpeaker();
        out.steps.push({ step: 'speaker', ...r });
    }
    out.state = await getMainStatus().catch(() => st);
    return out;
}

module.exports = {
    GROUP_MAIN,
    GROUP_SHOP,
    GROUP_TASK,
    GROUP_HAPPY,
    SUB_ID,
    CMD_OPEN,
    CMD_CASHIER,
    CMD_CRAFT,
    CMD_HIRE,
    CMD_SPEAKER,
    CMD_REFRESH,
    CMD_INTERACT,
    CMD_SHIFT,
    CMD_RECIPE,
    CMD_SHOP_LIST,
    CMD_SHOP_BUY,
    __testing: { parseMainState, encodeUint1, encodeVarint },
    getMainStatus,
    claimCashier,
    craft,
    useSpeaker,
    openStore,
    hireFriend,
    interact,
    getShopGoods,
    buyShopGoods,
    getTasks,
    runMilkTea,
};
