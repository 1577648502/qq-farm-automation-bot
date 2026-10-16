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
const { getItemById, getItemImageById, getPlantBySeedId } = require('../config/gameConfig');
const { operateRaw, parseTop, findField } = require('./mengchong');

const GROUP_MAIN = 2026110101;
const GROUP_SHOP = 2026110102;
const GROUP_TASK = 2026110103;
const GROUP_HAPPY = 2026110104;      // 快乐不独享 S4(复用 happy-share 服务)
const SUB_ID = 2026110100;

// 主活动命令
const CMD_OPEN = 53;        // 确认店名开业
const CMD_CASHIER = 55;     // 领取收银台收益
const CMD_CRAFT = 56;       // ⚠ 实际返回「员工列表(好友+NPC店员)」→ 工坊/招募面板(非"加工")
const CMD_HIRE = 57;        // 雇佣好友(返回班次+特长)
const CMD_SPEAKER = 58;     // ⚠ 实际返回「9 种配方菜单」→ 菜单查询(非"喇叭")
const CMD_CASHIER_DETAIL = 55;// **收银台详情**(结果 #160: 可领取/明细) —— ⚠ 它**不是领取**, 只是查询
const CMD_CLAIM_CASHIER = 59; // **领取收银台收益**(执行) → 响应 #164 = 到账物品(实测 奶茶券×10 + 金币×8648)
const CMD_CASHIER_INFO = 60;// **收银台查询**: {#1: 容量, #2: 当前待领, #3: 杯数}
const CMD_REFRESH = 63;     // 刷新/查询
const CMD_INTERACT = 66;    // ⚠ 实际返回「好友店铺排行(店名+热度)」→ 排行查询(非"互动")
const CMD_WORK_INTERACT = 65;// **互动(我的工作)**: 请求 #170 = {#1: 好友gid, #2: 互动类型}
const CMD_CLAIM_WAGE = 64;   // **领工资**: 请求 #169 空 → 响应 {#1: {#1: 1041, #2: 120}}(奶茶券×120)
/**
 * 互动(工作事项)5 选 1 —— 名称/效果取自游戏「工作事项」界面(2026-10-16 截图)
 * ⚠ 实测 type=5 会造成工资 -20(带"工资减半"风险的那档), 所以默认改成 2
 */
// 实测对照(2026-10-16 09:04 抓包): 选"宣传推广"(type=1) → 工资 40→48(#8#3=+8, 即 +20%) ✓ 与下表一致
const WORK_INTERACT_OPTIONS = [
    { id: 1, name: '宣传推广', desc: '帮老板立刻卖出40杯奶茶，获得本班工资 20% 的奖金' },
    { id: 2, name: '花式摇杯', desc: '老板未来3小时奶茶券收益+10%，获得本班工资 30% 奖金', recommended: true },
    { id: 3, name: '招牌试饮', desc: '老板未来2小时奶茶券收益+20%，随机获得 4 杯高级奶茶' },
    { id: 4, name: '划水摸鱼', desc: '40% 概率得宣传喇叭×1，60% 概率工资减半（有风险）' },
    { id: 5, name: '申请涨薪', desc: '60% 概率工资翻倍，40% 概率工资减半（实测亏损过）' },
];
const WORK_INTERACT_TYPE = 2;// 默认互动类型(推荐值: 花式摇杯, 稳定 +30%)
const CMD_SHIFT = 67;       // 班次(带时间戳)
const CMD_RECIPE = 69;      // 查询配方
const FIELD_OFFSET = 105;   // 主活动 payload 字段 = cmd + 105

// 商店命令(payload/结果字段 = cmd + 100)
const CMD_SHOP_LIST = 7;
const CMD_SHOP_BUY = 1;
const FIELD_SHOP_BUY = 101;

const STATE_FIELD = 121;    // 主活动状态容器
const MILK_COUPON_ID = 1041; // 奶茶券(活动货币)
/** 奶茶活动可加工的种子 = **森野系列 8 种**(商店 301~308) →
 *  ⚠ 商店里同时在售的金币果(20522)/经验蘑菇(20523) **不属于本活动**, 不能拿来制作奶茶(用户 2026-10-15 明确)
 *  · 甜莓 20525 / 白桃 20526 / 甜橙 20527 / 红柚 20528 / 可可豆 20021 / 柿子 21435 / 芭乐 20529 / 黄金芽 29005
 */
const MILK_TEA_SEED_IDS = [20525, 20526, 20527, 20528, 20021, 21435, 20529, 29005];

/**
 * 动态推导"可制作的果实 id"——不要写死列表(会漏):
 *  · 优先用官方 Plant.json 的 fruit.id / fruit_alter.id / special_fruit.id(含变异果实)
 *  · 官方表缺(如森野系列)时按实测规律兜底: **果实 id = 种子 id + 20000**(20525→40525, 29005→49005)
 */
function getCraftableFruitIds() {
    const ids = new Set();
    for (const seed of MILK_TEA_SEED_IDS) {
        const plant = getPlantBySeedId(seed) || getFallbackPlantBySeedId(seed);
        const add = (o) => {
            const id = toNum(o && o.id);
            if (id > 0) ids.add(id);
        };
        if (plant) {
            add(plant.fruit);
            add(plant.fruit_alter);
            add(plant.special_fruit);
        }
        // 兜底: 无论官方有没有, 都按规律补一个(幂等, 重复无害)
        ids.add(seed + 20000);
    }
    return [...ids];
}
const CMD_CRAFT_REAL = 62;   // 制作奶茶(工坊加工): 请求 #167 = {#1: 果实 uid 列表(packed varint)}
const SHOP_BODY_FIELD = 102;// 商店列表所在字段
const TASK_BODY_FIELD = 122;// 任务列表所在字段

function itemLabel(id, count) {
    const it = getItemById(toNum(id));
    return `${(it && it.name) || `物品#${id}`}×${count}`;
}

/** 最近一次游戏请求时间: 奶茶活动的请求一律串行 + 至少间隔 300ms,
 *  避免页面一进来并发打十几个请求把游戏队列打满("队列已满"→心跳异常掉线, 踩过) */
let lastCallAt = 0;
async function throttle() {
    const gap = 300 - (Date.now() - lastCallAt);
    if (gap > 0) await sleep(gap);
    lastCallAt = Date.now();
}

/** 主活动请求(串行节流) */
async function mainOperate(cmd, payloadField, payloadBytes) {
    await throttle();
    return operateSafe(GROUP_MAIN, cmd, payloadField === undefined ? cmd + FIELD_OFFSET : payloadField, payloadBytes || Buffer.alloc(0));
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
    const out = { ok: false, storeName: '', value: 0, recipeId: 0, at: 0, nextAt: 0, storeLevel: 0, startAt: 0, endAt: 0, settleAt: 0, workFlag: 0, employed: false };
    if (!activityBuf || !activityBuf.length) return out;
    try {
        const act = parseTop(activityBuf);
        const head = findField(act, 1);
        const hf = head && head.w === 2 ? parseTop(head.v) : [];
        if (toInt((findField(hf, 1) || {}).v) !== GROUP_MAIN) return out;
        // 活动头时间(实测): #6 开始 / #7 结束 / #24 结算期开始(= #7 - 48h)
        out.startAt = toInt((findField(hf, 6) || {}).v);
        out.endAt = toInt((findField(hf, 7) || {}).v);
        out.settleAt = toInt((findField(hf, 24) || {}).v);
        const box = findField(act, STATE_FIELD);
        const inner = box && box.w === 2 ? findField(parseTop(box.v), 1) : null;
        if (!inner || inner.w !== 2) { out.ok = true; return out; }
        const f = parseTop(inner.v);
        const nameField = findField(f, 2);
        out.storeName = nameField && nameField.w === 2 ? nameField.v.toString('utf8') : '';
        out.value = toInt((findField(f, 5) || {}).v);        // 累计营业额
        out.storeLevel = toInt((findField(f, 4) || {}).v);   // 店铺等级(实测 #4; Lv1 时"需等级≥3"的商品点不了)
        // **受雇标志**(实测 #11): 2026-10-15 晚的抓包(做过互动)里 =1, 早先(未参与员工玩法)的抓包里没有该字段
        // 说明: 规则里"被雇佣后每班可在【我的工作】互动一次" → 用 #11 作为"是否被雇佣"的判据(待更多样本确认)
        out.workFlag = toInt((findField(f, 11) || {}).v);
        out.employed = out.workFlag > 0;
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
    const work = parseWorkFromRefresh(r.resultHex);
    if (work.employer && work.employer.gid) lastEmployer = work.employer;
    return { ...st, work, ok: st.ok };
}

/** 领取收银台收益(核心: 满载会暂停营业且不补发) */
async function claimCashier() {
    const before = await getMainStatus().catch(() => null);
    if (before && before.ok && isSettling(before)) {
        return { ok: false, skipped: true, reason: '结算期, 不能领取收银台收益' };
    }
    // 先看有没有可领(收银台查询 #2 = 待领取), 没有就不发领取请求(避免无意义请求/报错)
    const info = await getCashierStatus().catch(() => null);
    if (info && info.ok && info.pending <= 0) {
        return { ok: true, skipped: true, reason: '收银台暂无可领取收益' };
    }
    // ⚠ 真正的"领取"是 cmd=59(实测: 响应 #164 = 到账物品); cmd=55 只是收银台详情(踩过)
    const r = await mainOperate(CMD_CLAIM_CASHIER, 164, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `领取收银台收益失败 code=${r.errorCode}` };
    // 结果 #164 = 重复的 #1 {物品id, 数量} = 本次到账
    const gainedList = [];
    if (r.resultHex) {
        try {
            for (const x of parseTop(Buffer.from(r.resultHex, 'hex'))) {
                if (x.f !== 1 || x.w !== 2) continue;
                const xf = parseTop(x.v);
                const id = toInt((findField(xf, 1) || {}).v);
                const count = toInt((findField(xf, 2) || {}).v);
                if (id) gainedList.push({ id, count, name: itemLabel(id, count) });
            }
        } catch (e) { /* 忽略 */ }
    }
    const after = parseMainState(r.activity);
    const emp = parseEmployerFromCashier(r.resultHex);
    if (emp && emp.gid) lastEmployer = emp;
    log('活动', `奶茶热销中: 已领取收银台收益${gainedList.length ? ` → ${gainedList.map((x) => x.name).join('、')}` : ''}${after.value ? ` (累计营业额 ${after.value})` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok',
    });
    return { ok: true, gained: gainedList, gainedList, value: after.value, before: before && before.value, employer: emp, state: after };
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
    if (r.errorCode !== 0) return { ok: false, reason: `互动失败 ${r.reason || `code=${r.errorCode}`}` };
    log('活动', '奶茶热销中: 已完成一次互动', { module: 'activity', event: '奶茶热销中', result: 'ok' });
    return { ok: true, state: parseMainState(r.activity) };
}

/** 种子商店列表(0102 cmd=7) */
async function getShopGoods() {
    await throttle();
    const r = await operateSafe(GROUP_SHOP, CMD_SHOP_LIST, 0, Buffer.alloc(0));
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
                let requireLevel = 0;      // 需要的奶茶店等级(0 = 无要求)
                if (unlock && unlock.w === 2) {
                    const uf = parseTop(unlock.v);
                    const cond = findField(uf, 2);
                    const need = toInt((findField(uf, 5) || {}).v);
                    if (cond && cond.w === 2) unlockText = cond.v.toString('utf8') + (need ? ` ≥${need}` : '');
                    // 实测条件名形如 "2026110101_奶茶店等级_3" + #5=3 → 需要的店铺等级
                    requireLevel = need;
                }
                // 限购(#4) / 类型(#12: seed=种子, exchange=装扮兑换, 空=道具) / 每单限购份数(#11)
                const limitCount = toInt((findField(f, 4) || {}).v);
                const kindField = findField(f, 12);
                const kind = kindField && kindField.w === 2 ? kindField.v.toString('utf8') : '';
                const itemDef = getItemById(itemId);
                const bought = toInt(shopBought.get(goodsId) || 0);
                goods.push({
                    goodsId,
                    boughtCount: bought,
                    soldOut: limitCount > 0 && bought >= limitCount,
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
                    requireLevel,
                });
            }
        }
    } catch (e) { /* 解析失败返回空 */ }
    return { ok: true, goods };
}

/** 本次进程内各商品已兑换数量(用于显示"已限购"; 服务端没给已购字段, 只能自己记) */
const shopBought = new Map();

/** 兑换/购买商品(数量必填) —— 实测 {#101: {#1: 商品ID, #2: 数量}} */
async function buyShopGoods(goodsId, count = 1) {
    const st0 = await getMainStatus().catch(() => null);
    if (st0 && isSettling(st0)) return { ok: false, reason: '活动已进入结算期(11/15–11/16), 不能兑换活动种子' };
    const id = toNum(goodsId);
    const n = Math.max(1, Math.min(9999, toInt(count) || 1));
    if (!id) return { ok: false, reason: '缺少商品 ID' };
    // ⚠ 实测(20261015 抓包): #101 的值**直接**就是 {#1: 商品ID, #2: 数量} = 08 ad02 10 6c,
    //   不能像 cmd=57 那样再套一层 {#1: ...}, 否则服务端报 1034006「活动商品不存在」(踩过)
    // 等级没达标就别发请求(服务端会报 1034006, 白跑一趟)
    try {
        const goods = await getShopGoods();
        const target = (goods.goods || []).find((g) => toNum(g.goodsId) === id);
        if (target && target.requireLevel > 0) {
            const st = await getMainStatus();
            const lv = toNum(st.storeLevel) || 0;
            // 等级读不到时(<=0)不拦, 免得误锁; 交给服务端判断(报错也会原样透出)
            if (lv > 0 && lv < target.requireLevel) {
                return { ok: false, reason: `「${target.name}」需要奶茶店等级 ≥${target.requireLevel}（当前 Lv${lv}）` };
            }
        }
    } catch (e) { /* 校验失败就按原样尝试 */ }
    const payload = Buffer.concat([encodeVarintField(1, id), encodeVarintField(2, n)]);
    const r = await operateSafe(GROUP_SHOP, CMD_SHOP_BUY, FIELD_SHOP_BUY, payload);
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
    shopBought.set(id, (shopBought.get(id) || 0) + n);
    log('活动', `奶茶热销中: 兑换 ${n} 个商品#${id}${got ? ` → ${itemLabel(got.id, got.count)}` : ''}${cost ? `, 花费 ${cost.amount} ${(getItemById(cost.currencyId) || {}).name || ''}` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok', goodsId: id, count: n,
    });
    return { ok: true, goodsId: id, count: n, got, cost };
}

/** 任务列表(0103 cmd=7) */
async function getTasks() {
    await throttle();
    const r = await operateSafe(GROUP_TASK, 7, 0, Buffer.alloc(0));
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

/** 好友列表(给"可选好友"用): 复用好友服务(带缓存)。
 *  ⚠ 首次会做重同步(访客记录+SyncAll+GetAll ≈ 6 个请求) → 页面必须"按需加载",
 *  不要随页面打开一起拉, 否则和别的请求叠加会把游戏队列打满(队列已满→掉线) */
async function getFriendList() {
    try {
        const { getFriendsList } = require('./friend');
        const list = await getFriendsList().catch(() => null);
        const arr = Array.isArray(list) ? list : (list && list.friends) || [];
        return {
            ok: true,
            friends: arr.map((f) => ({
                gid: toNum(f && (f.gid || f.id)) || 0,
                name: String((f && (f.name || f.nick || f.remark)) || ''),
                level: toNum(f && (f.level || f.lv)) || 0,
            })).filter((f) => f.gid > 0),
        };
    } catch (e) {
        return { ok: false, reason: e.message, friends: [] };
    }
}

/**
 * 自动雇佣: 从白名单里挑一个去雇佣(服务端对已雇佣/不可雇佣会报错, 失败就换下一个)
 * @param hireGids 白名单(账号配置里的 milkTeaHireGids)
 */
async function autoHire(hireGids) {
    const list = (Array.isArray(hireGids) ? hireGids : []).map((g) => toNum(g)).filter((g) => g > 0);
    if (!list.length) return { ok: false, reason: '未配置可雇佣好友(先在页面里勾选)' };
    const errors = [];
    for (const gid of list) {
        const r = await hireFriend(gid).catch((e) => ({ ok: false, reason: e.message }));
        if (r && r.ok) return { ok: true, friendGid: gid };
        errors.push(shortErr((r && r.reason) || '失败'));
        await sleep(600);
    }
    // 日志别太长: 只给"尝试了几个 + 第一条原因"
    const first = errors[0] || '未知错误';
    const same = errors.every((x) => x === first);
    return { ok: false, reason: `${list.length} 位好友均雇佣失败: ${first}${same ? '' : ' 等'}` };
}

/**
 * 是否处于结算期(11/15–11/16, 规则: 停止自动营业/喇叭/雇佣/互动/买专属种子)
 * 依据活动头 #24(结算期开始, 实测 = 结束时间 - 48h)
 */
function isSettling(st) {
    const settleAt = toNum(st && st.settleAt) || 0;
    if (!settleAt) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec >= settleAt;
}

/** 打包 varint(protobuf packed repeated) */
function encodePackedVarints(values) {
    return Buffer.concat((Array.isArray(values) ? values : []).map((v) => encodeVarint(v)));
}

/** 收集背包里所有可加工的果实 uid(只读一次背包) */
async function collectFruitUids() {
    const { getBag, getBagItems } = require('./warehouse');
    const items = getBagItems(await getBag());
    const fruitIds = getCraftableFruitIds();
    const uids = [];
    for (const it of items) {
        if (!fruitIds.includes(toNum(it && it.id))) continue;
        const uid = toNum(it && it.uid);
        if (uid > 0) uids.push(uid);
    }
    return { uids, fruitIds };
}

/**
 * 把背包里**所有**活动果实都做成高级奶茶(分批发, 每批 20 个, 批间隔 700ms 防队列打满)
 * @param perBatch 每批提交几个果实 uid
 * @param maxBatches 最多几批(防跑飞)
 */
async function craftAllFruits(perBatch = 20, maxBatches = 20) {
    let all = { uids: [], fruitIds: [] };
    try {
        all = await collectFruitUids();
    } catch (e) {
        return { ok: false, reason: `读取背包失败: ${e.message}` };
    }
    if (!all.uids.length) return { ok: false, reason: '背包里没有活动果实(森野系列)，先种再收' };

    const made = [];
    let used = 0;         // 投入的"组"数(背包里每个 uid 一组)
    let usedUnits = 0;    // 实际消耗的果实个数
    let batches = 0;
    for (let i = 0; i < all.uids.length; i += perBatch) {
        if (batches >= maxBatches) break;
        const slice = all.uids.slice(i, i + perBatch);
        const r = await mainOperateCraft(slice);
        batches += 1;
        if (!r.ok) {
            if (batches === 1) return r;            // 第一批就失败 → 直接报错
            break;                                   // 后续批次失败 → 停手, 但保留已完成的
        }
        used += slice.length;
        made.push(...(r.made || []));
        if (i + perBatch < all.uids.length) await sleep(700);
    }
    log('活动', `奶茶热销中: 已加工 ${used} 组果实(共 ${usedUnits || '?'} 个)${made.length ? `: ${made.map((m) => m.name).join('、')}` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok', fruits: used, batches,
    });
    return { ok: true, used, usedUnits, batches, made, state: null };
}

/** 提交一批果实 uid 去制作(内部用) */
async function mainOperateCraft(uids) {
    const packed = encodePackedVarints(uids);
    const payload = Buffer.concat([Buffer.from([0x0a, packed.length]), packed]);
    const r = await operateSafe(GROUP_MAIN, CMD_CRAFT_REAL, 167, payload);
    if (r.errorCode !== 0) return { ok: false, reason: `制作失败 code=${r.errorCode}` };
    const made = [];
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            for (const x of rf) {
                if (x.f !== 3 || x.w !== 2) continue;
                const xf = parseTop(x.v);
                const id = toInt((findField(xf, 1) || {}).v);
                const count = toInt((findField(xf, 2) || {}).v);
                if (id) made.push({ id, count, name: itemLabel(id, count) });
            }
        } catch (e) { /* 忽略 */ }
    }
    return { ok: true, made };
}

/**
 * 制作奶茶(cmd=62, 实测 2026-10-15 新抓包):
 *   请求 #167 = {#1: [果实 uid...](packed)} → 响应回产出的高级奶茶 {#1: 物品id, #2: 数量}
 * 果实来源: 背包里 40525/40526/… 这些活动果实(每个实例有独立 uid)
 * @param limit 单次最多提交几个果实(抓包里一次 6 个)
 */
async function craftMilkTea(limit = 10) {
    await throttle();
    let items = [];
    try {
        const { getBag, getBagItems } = require('./warehouse');
        items = getBagItems(await getBag());
    } catch (e) {
        return { ok: false, reason: `读取背包失败: ${e.message}` };
    }
    const fruitIds = getCraftableFruitIds();
    const picked = [];
    const usedIds = new Set();
    for (const it of items) {
        if (picked.length >= limit) break;
        const iid = toNum(it && it.id);
        if (!fruitIds.includes(iid)) continue;
        usedIds.add(iid);
        const uid = toNum(it && it.uid);
        if (uid > 0) picked.push(uid);
    }
    if (!picked.length) return { ok: false, reason: '背包里没有活动果实(森野系列)，先种再收' };
    const packed = encodePackedVarints(picked);
    const payload = Buffer.concat([Buffer.from([0x0a, packed.length]), packed]);   // {#1: packed uids}
    const r = await operateSafe(GROUP_MAIN, CMD_CRAFT_REAL, 167, payload);
    if (r.errorCode !== 0) return { ok: false, reason: `制作失败 code=${r.errorCode}` };
    const made = [];
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            for (const x of rf) {
                if (x.f !== 3 || x.w !== 2) continue;
                const xf = parseTop(x.v);
                const id = toInt((findField(xf, 1) || {}).v);
                const count = toInt((findField(xf, 2) || {}).v);
                if (id) made.push({ id, count, name: itemLabel(id, count) });
            }
        } catch (e) { /* 忽略 */ }
    }
    log('活动', `奶茶热销中: 已制作奶茶(投入 ${picked.length} 个果实)${made.length ? ` → ${made.map((m) => m.name).join('、')}` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok', fruits: picked.length,
    });
    return { ok: true, used: picked.length, usedFruits: [...usedIds], made, state: parseMainState(r.activity) };
}

/**
 * 互动(我的工作, cmd=65) —— 被雇佣后每班可互动一次, 影响工资
 * 实测(20261015-211043_互动.jsonl idx=130): 请求 #170 = {#1: 1244632861(好友gid), #2: 5}
 * 响应 = {#1: 5, #2: 1, #4: 90005(称号), #8: {#1: 10000, #3: 40}(工资相关)}
 * 待补: 互动类型(#2)的可选值与各自收益 —— 拿到后按"最优"排序执行
 */
async function interactWithFriend(friendGid, type = WORK_INTERACT_TYPE) {
    let gid = toNum(friendGid);   // 可能会被纠正为"当前老板"(见下方), 所以用 let
    if (!gid) return { ok: false, reason: '缺少好友 gid(先在页面勾选并保存雇佣好友)' };
    // ⚠ 前置判断: 互动只属于"**正在进行中的班次**"(【我的工作】的本次兼职)
    //   —— 判据用刷新(63)结果的 work.active(有当前老板且未到结束时间),
    //   不要用 #11(它只表示"参与过兼职", 班次结束后仍为 1 → 会误判), 更不能回退到历史记录(会报 本班工作已结束)
    const st = await getMainStatus().catch(() => null);
    if (st && st.ok) {
        const w = st.work || {};
        if (!w.employer || !w.employer.gid) {
            return { ok: false, reason: '当前没有进行中的兼职(未被雇佣), 不能互动' };
        }
        if (w.endAt && Math.floor(Date.now() / 1000) >= w.endAt) {
            return { ok: false, reason: '本班工作已结束, 互动次数已用完' };
        }
        if (gid !== toNum(w.employer.gid)) {
            // 传的 gid 不是当前老板 → 直接纠正为当前老板(避免 1034147)
            log('活动', `奶茶热销中: 互动目标 gid ${gid} 与当前老板 ${w.employer.gid} 不一致, 已按当前老板执行`, {
                module: 'activity', event: '奶茶热销中', result: 'warn',
            });
            gid = toNum(w.employer.gid);
        }
    }
    const inner = Buffer.concat([encodeVarintField(1, gid), encodeVarintField(2, toInt(type) || WORK_INTERACT_TYPE)]);
    const payload = Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
    let r = await mainOperate(CMD_WORK_INTERACT, 170, payload);
    // 自愈: 1034147(本班工作已结束) 通常是"老板/班次在这期间换了" —— 刷新拿新老板重试一次
    if (r.errorCode === 1034147) {
        const st2 = await getMainStatus().catch(() => null);
        const newGid = st2 && st2.work && st2.work.employer && st2.work.employer.gid;
        if (newGid && newGid !== gid) {
            log('活动', `奶茶热销中: 互动目标已变更(${gid} → ${newGid}), 用新老板重试一次`, {
                module: 'activity', event: '奶茶热销中', result: 'warn',
            });
            gid = newGid;
            const inner2 = Buffer.concat([encodeVarintField(1, gid), encodeVarintField(2, toInt(type) || WORK_INTERACT_TYPE)]);
            const payload2 = Buffer.concat([Buffer.from([0x0a, inner2.length]), inner2]);
            r = await mainOperate(CMD_WORK_INTERACT, 170, payload2);
        }
    }
    if (r.errorCode !== 0) return { ok: false, reason: `互动失败 code=${r.errorCode}` };
    let result = null;
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            const wage = findField(rf, 8);
            result = {
                type: toInt((findField(rf, 1) || {}).v),
                titleId: toInt((findField(rf, 4) || {}).v),
                wage: wage && wage.w === 2
                    ? { base: toInt((findField(parseTop(wage.v), 1) || {}).v), extra: toInt((findField(parseTop(wage.v), 3) || {}).v) }
                    : null,
            };
        } catch (e) { /* 忽略 */ }
    }
    log('活动', `奶茶热销中: 已与好友 ${gid} 互动(type=${toInt(type) || WORK_INTERACT_TYPE})`, {
        module: 'activity', event: '奶茶热销中', result: 'ok', friendGid: gid, type: toInt(type) || WORK_INTERACT_TYPE,
    });
    return { ok: true, friendGid: gid, interact: result };
}

/**
 * 领工资(cmd=64) —— 兼职(被雇佣)班次结束后在【我的工作】里领
 * 实测(20261016-080455 idx=127): 请求 #169 = ""; 响应 = {#1: {#1: 1041(奶茶券), #2: 120}, #2: 2}
 */
async function claimWage() {
    const r = await mainOperate(CMD_CLAIM_WAGE, 169, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `领工资失败 code=${r.errorCode}` };
    let gained = null;
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            const g = findField(rf, 1);
            if (g && g.w === 2) {
                const gf = parseTop(g.v);
                gained = { id: toInt((findField(gf, 1) || {}).v), count: toInt((findField(gf, 2) || {}).v) };
            }
        } catch (e) { /* 忽略 */ }
    }
    log('活动', `奶茶热销中: 已领取兼职工资${gained ? ` ${itemLabel(gained.id, gained.count)}` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok',
    });
    return { ok: true, gained, state: parseMainState(r.activity) };
}

/** 我的工作(兼职)信息: 从收银台结果里解析**雇主**(兼职记录 #1.#9.#11 = {#1: gid, #2: 名字}) */
function parseEmployerFromCashier(resultHex) {
    if (!resultHex) return null;
    try {
        const rf = parseTop(Buffer.from(resultHex, 'hex'));
        const box = findField(rf, 1);
        const inner = box && box.w === 2 ? parseTop(box.v) : rf;
        const rec = findField(inner, 9);
        if (!rec || rec.w !== 2) return null;
        const r2 = parseTop(rec.v);
        const fr = findField(r2, 11);
        if (!fr || fr.w !== 2) return null;
        const f2 = parseTop(fr.v);
        const gid = toInt((findField(f2, 1) || {}).v);
        return gid > 0 ? { gid, name: String(((findField(f2, 2) || {}).v || '').toString?.() || '') } : null;
    } catch (e) { return null; }
}

/**
 * 解析"我的工作"信息 —— 来自**刷新(cmd=63)的结果 #168**(权威来源, 实测 2026-10-16):
 *   #168.#1 = 本次兼职(进行中): #1 = {gid, 名字} = **当前老板**, #2 店名, #3 班次id,
 *             #4/#5 我的特长, #6/#7 班次起止, #11 工资, #13 = {#1 已完成班次, #2 累计奖金}
 *   #168.#2 = 兼职记录(历史, repeated)   #168.#3/#4 = 我的特长 id/名称
 * ⚠ 互动(cmd=65)要传的 gid = 这里 #1.#1.#1(当前老板); 别从收银台详情(55)的历史记录取(踩过, 取到旧班次)
 */
function parseWorkFromRefresh(resultHex) {
    const out = { ok: false, employer: null, storeName: '', startAt: 0, endAt: 0, wage: 0, bonus: 0, titleId: 0, titleName: '', records: [], active: false };
    if (!resultHex) return out;
    try {
        const rf = parseTop(Buffer.from(resultHex, 'hex'));
        const cur = findField(rf, 1);
        if (cur && cur.w === 2) {
            const c = parseTop(cur.v);
            const emp = findField(c, 1);
            if (emp && emp.w === 2) {
                const e = parseTop(emp.v);
                const gid = toInt((findField(e, 1) || {}).v);
                const nm = (findField(e, 2) || {}).v;
                if (gid > 0) out.employer = { gid, name: nm ? String(nm) : '' };
            }
            const store = (findField(c, 2) || {}).v;
            out.storeName = store ? String(store) : '';
            out.startAt = toInt((findField(c, 6) || {}).v);
            out.endAt = toInt((findField(c, 7) || {}).v);
            out.wage = toInt((findField(c, 11) || {}).v);
            const t13 = findField(c, 13);
            if (t13 && t13.w === 2) out.bonus = toInt((findField(parseTop(t13.v), 2) || {}).v);
            out.ok = !!out.employer;
            // "进行中的班次" = 有本次兼职 && (没给结束时间 或 现在还没到结束时间)
            const nowSec = Math.floor(Date.now() / 1000);
            out.active = !!out.employer && (!out.endAt || nowSec < out.endAt);
        }
        const t = findField(rf, 3);
        if (t && t.w === 0) out.titleId = toInt(t.v);
        const tn = findField(rf, 4);
        if (tn && tn.w === 2) out.titleName = String(tn.v);
        for (const x of rf) {
            if (x.f !== 2 || x.w !== 2) continue;
            const r2 = parseTop(x.v);
            const emp2 = findField(r2, 1);
            if (!emp2 || emp2.w !== 2) continue;
            const e2 = parseTop(emp2.v);
            const gid2 = toInt((findField(e2, 1) || {}).v);
            const nm2 = (findField(e2, 2) || {}).v;
            if (gid2 > 0) out.records.push({ gid: gid2, name: nm2 ? String(nm2) : '' });
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/**
 * 收银台详情(cmd=55) —— **查询**用: 结果 #160 内含可领取与**兼职雇主**(#1.#9.#11 = {gid, 名字})
 * 注意: 实测它不会发放任何东西(别当领取用, 踩过)
 */
async function getCashierDetail() {
    const r = await mainOperate(CMD_CASHIER_DETAIL, 160, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `收银台详情失败 code=${r.errorCode}` };
    const emp = parseEmployerFromCashier(r.resultHex);
    if (emp && emp.gid) lastEmployer = emp;
    let claimable = null;
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            const box = findField(rf, 1);
            const inner = box && box.w === 2 ? parseTop(box.v) : rf;
            const c23 = findField(inner, 23);
            if (c23 && c23.w === 2) {
                const f = parseTop(c23.v);
                claimable = { id: toInt((findField(f, 1) || {}).v), count: toInt((findField(f, 2) || {}).v) };
            }
        } catch (e) { /* 忽略 */ }
    }
    return { ok: true, employer: emp, claimable, at: Date.now() };
}

/**
 * 收银台查询(cmd=60): 返回待领取收益等。规则说"满载会暂停营业且不补发", 所以顶部要显示待领。
 * 实测结果 #1 = {#1: 容量(40), #2: 当前待领(253), #3: 累计杯数(164312)}
 */
async function getCashierStatus() {
    const r = await mainOperate(CMD_CASHIER_INFO, undefined, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `收银台查询失败 code=${r.errorCode}` };
    const out = { ok: true, capacity: 0, pending: 0, cups: 0 };
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            out.capacity = toInt((findField(rf, 1) || {}).v);
            out.pending = toInt((findField(rf, 2) || {}).v);
            out.cups = toInt((findField(rf, 3) || {}).v);
        } catch (e) { /* 忽略 */ }
    }
    return out;
}

/** 奶茶券余额(背包里的 1041); 加 60s 缓存, 避免每次读状态都打一次背包请求 */
let couponCache = { at: 0, value: 0 };
async function getMilkCouponBalance(force = false) {
    if (!force && couponCache.at && (Date.now() - couponCache.at) < 60000) return couponCache.value;
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const bag = await getBag();
        for (const it of getBagItems(bag)) {
            if (toNum(it && it.id) === MILK_COUPON_ID) {
                couponCache = { at: Date.now(), value: toNum(it.count) || 0 };
                return couponCache.value;
            }
        }
    } catch (e) { /* 读不到就当 0 */ }
    couponCache = { at: Date.now(), value: 0 };
    return 0;
}

/**
 * 任务奖励领取 —— ⚠ 该活动"任务"需充值激活, 界面入口已移除(2026-10-15 用户确认),
 * 这里保留协议实现但不自动执行; 若以后激活, 直接用 claimAllTasks() 即可。
 *
 * 领取任务奖励
 * ⚠ 领取命令**没有抓到**(抓包里只有列表 cmd=7) → 用候选命令逐个试, 并用"任务状态变 3"校验;
 *   成功的命令记在内存里, 下次直接用(和秋祈良愿的愿望编号一个思路)
 */
let workingTaskClaimCmd = 0;
const TASK_CLAIM_CANDIDATES = [1, 8, 6, 9];

async function claimTask(taskId) {
    const id = toInt(taskId);
    if (!id) return { ok: false, reason: '缺少任务序号' };
    const candidates = [];
    if (workingTaskClaimCmd > 0) candidates.push(workingTaskClaimCmd);
    TASK_CLAIM_CANDIDATES.forEach((c) => { if (!candidates.includes(c)) candidates.push(c); });
    const errors = [];
    for (const cmd of candidates) {
        let r = null;
        try {
            r = await operateSafe(GROUP_TASK, cmd, cmd + 100, encodeUint1(id));
        } catch (e) {
            errors.push(`cmd=${cmd}: ${e.message}`);
            continue;
        }
        if (r.errorCode !== 0) { errors.push(`cmd=${cmd}: code=${r.errorCode}`); continue; }
        // 校验: 重新拉任务表看该任务是否变"已领"
        await sleep(800);
        const t = await getTasks().catch(() => null);
        const after = t && (t.tasks || []).find((x) => toNum(x.id) === id);
        if (after && after.status === 3) {
            workingTaskClaimCmd = cmd;
            log('活动', `奶茶热销中: 已领取任务#${id} 奖励(${(after.rewards || []).map((x) => x.name).join('、') || '已发放'})`, {
                module: 'activity', event: '奶茶热销中', result: 'ok', cmd,
            });
            return { ok: true, taskId: id, cmd, rewards: after.rewards || [] };
        }
        errors.push(`cmd=${cmd}: 状态未变`);
    }
    return { ok: false, reason: `领取失败(${errors.slice(0, 2).join('; ')})`, taskId: id };
}

/** 领取所有"可领"的任务(status=2) */
async function claimAllTasks() {
    const t = await getTasks();
    if (!t.ok) return { ok: false, reason: t.reason };
    const todo = (t.tasks || []).filter((x) => x.status === 2);
    if (!todo.length) return { ok: true, claimed: [], skipped: true, reason: '没有可领任务' };
    const claimed = [];
    for (const task of todo) {
        const r = await claimTask(task.id);
        claimed.push({ id: task.id, ok: r.ok, reason: r.reason });
        await sleep(700);
    }
    return { ok: true, claimed };
}

/** 批量雇佣: 逐个尝试(带节流, 默认最多 10 个); 已雇过的会失败并跳过 */
async function hireAll(hireGids, limit = 10) {
    const list = (Array.isArray(hireGids) ? hireGids : []).map((g) => toNum(g)).filter((g) => g > 0).slice(0, Math.max(1, limit));
    if (!list.length) return { ok: false, reason: '未选择好友' };
    const results = [];
    for (const gid of list) {
        const r = await hireFriend(gid).catch((e) => ({ ok: false, reason: e.message }));
        results.push({ gid, ok: !!(r && r.ok), reason: (r && r.reason) || '' });
        await sleep(700);   // 节流: 避免把游戏请求队列打满(满了会心跳异常掉线)
    }
    const okCount = results.filter((x) => x.ok).length;
    log('活动', `奶茶热销中: 批量雇佣 ${okCount}/${results.length} 成功`, { module: 'activity', event: '奶茶热销中', result: okCount ? 'ok' : 'warn' });
    return { ok: okCount > 0, hired: okCount, total: results.length, results };
}

/**
 * 统一封装活动请求 —— ⚠ 关键: network 层遇到游戏错误码是 **抛异常**(new Error('gamepb... 错误: code=NNN ...')),
 * 直接 `const r = await operateRaw(...)` 再判断 `r.errorCode` 是**永远不成立的**(异常穿透) —— 踩过。
 * 这里统一 try/catch, 转成 { errorCode, ok, reason(已压短) }, 让所有调用点能正常处理错误。
 */
async function operateSafe(groupId, cmd, payloadField, payloadBytes) {
    try {
        const r = await operateRaw(groupId, cmd, payloadField, payloadBytes);
        const code = toNum(r.errorCode) || 0;
        return { ...r, errorCode: code, ok: code === 0, reason: code === 0 ? '' : `code=${code}` };
    } catch (e) {
        const m = String((e && e.message) || '');
        const code = toNum((m.match(/code=(\d+)/) || [])[1]) || 0;
        return { errorCode: code, resultFieldNo: 0, resultHex: '', activity: null, ok: false, reason: shortErr(m) };
    }
}

/** 把服务端长错误压短(去掉 gamepb.xxx.Service.Method 错误: 前缀, 只留 code + 短因) */
function shortErr(msg, maxLen = 40) {
    let t = String(msg || '');
    t = t.replace(/^gamepb\.[\w.]+\s*错误:\s*/, '').replace(/\s+/g, ' ').trim();
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

/** 自动雇佣的退避: 遇到"位置已存在/已达上限"这类错误, 冷却一段时间不再尝试(避免一直刷报错) */
let hireBackoffUntil = 0;
/** 最近一次探测到的雇主(兼职记录里的老板) */
let lastEmployer = null;
const HIRE_BACKOFF_MS = 30 * 60 * 1000;
function isHireAlreadyError(msg) {
    const t = String(msg || '');
    return /已存在|已有|上限|已满|只能|重复/.test(t);
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
    if (isSettling(st)) {
        log('活动', '奶茶热销中: 已进入结算期(11/15–11/16), 跳过自动经营', { module: 'activity', event: '奶茶热销中', result: 'skip' });
        return { ok: true, skipped: true, reason: '结算期, 已停止经营', state: st };
    }

    if (!st.opened && opts.openStore !== false) {
        const r = await openStore(opts.storeName);
        out.steps.push({ step: 'openStore', ...r });
        await sleep(1200);
        st = await getMainStatus().catch(() => st);
    }
    if (opts.autoTask) {
        const r = await claimAllTasks().catch((e) => ({ ok: false, reason: e.message }));
        out.steps.push({ step: 'autoTask', ...r });
        await sleep(800);
    }
    if (opts.fetchEmployer !== false) {
        const d = await getCashierDetail().catch(() => null);
        if (d && d.ok) out.steps.push({ step: 'cashierDetail', employer: d.employer, claimable: d.claimable });
    }
    if (doCashier) {
        const r = await claimCashier();
        out.steps.push({ step: 'cashier', ...r });
        await sleep(1200);
    }
    if (doCraft) {
        const r = await craftAllFruits();   // 自动 = 把背包里所有活动果实都做掉
        out.steps.push({ step: 'craft', ...r });
        await sleep(1200);
    }
    if (doSpeaker) {
        const r = await useSpeaker();
        out.steps.push({ step: 'speaker', ...r });
        await sleep(1000);
    }
    // 互动/领工资都需要"被雇佣": 雇主 GID 优先用配置, 没配就用收银台结果里探测到的(兼职记录里的老板)
    // ⚠ 雇主只认"当前进行中的班次"(刷新 63 结果的 work.employer) ——
    //   不回退到收银台历史记录/缓存(那会拿到旧老板 → 服务端报 1034147 本班工作已结束)
    const curWork = (st && st.work) || {};
    // ⚠ 当前班次的老板优先级最高: 配置里填的(可能是上一个班次的)旧 GID **不能**覆盖它,
    //   否则会拿旧老板去互动 → 服务端报 1034147 本班工作已结束(踩过两次)
    const liveEmployerGid = (curWork.employer && curWork.employer.gid) || 0;
    const employerGid = liveEmployerGid || opts.employerGid || '';
    if (liveEmployerGid && opts.employerGid && toNum(opts.employerGid) !== liveEmployerGid) {
        log('活动', `奶茶热销中: 配置的雇主 GID(${opts.employerGid}) 与当前老板(${liveEmployerGid}) 不一致, 按当前老板执行`, {
            module: 'activity', event: '奶茶热销中', result: 'warn',
        });
    }
    const inShift = !!employerGid && (!curWork.endAt || Math.floor(Date.now() / 1000) < curWork.endAt);
    // 自动领兼职工资: 独立开关(opts.autoWage) + 必须处于"被雇佣"状态
    if (opts.autoWage !== false) {
        if (!inShift) {
            out.steps.push({ step: 'claimWage', ok: false, skipped: true, reason: '当前没有进行中的班次, 跳过领工资' });
        } else {
            const r = await claimWage().catch((e) => ({ ok: false, reason: e.message }));
            out.steps.push({ step: 'claimWage', ...r });
            if (!r.ok && !/没有|不存在|无/.test(String(r.reason))) {
                log('活动', `奶茶热销中: 领工资未成功 — ${r.reason}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
            }
            await sleep(600);
        }
    }
    if (opts.autoInteract && inShift) {
        const r = await interactWithFriend(employerGid, opts.interactType).catch((e) => ({ ok: false, reason: e.message }));
        out.steps.push({ step: 'autoInteract', ...r });
        if (r.ok) {
            log('活动', `奶茶热销中: 已自动互动(雇主 ${employerGid}, 类型 ${opts.interactType || WORK_INTERACT_TYPE})`, { module: 'activity', event: '奶茶热销中', result: 'ok' });
        } else {
            log('活动', `奶茶热销中: 自动互动未执行 — ${r.reason}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
        }
        await sleep(700);
    }
    if (opts.autoHire && Array.isArray(opts.hireGids) && opts.hireGids.length) {
        if (Date.now() < hireBackoffUntil) {
            out.steps.push({ step: 'autoHire', ok: false, skipped: true, reason: '上次提示雇佣位置已存在, 退避中' });
            return out;
        }
        const r = await autoHire(opts.hireGids);
        out.steps.push({ step: 'autoHire', ...r });
        if (!r.ok && isHireAlreadyError(r.reason)) {
            hireBackoffUntil = Date.now() + HIRE_BACKOFF_MS;
            log('活动', `奶茶热销中: 雇佣位已有员工/已满, 30 分钟内不再自动雇佣`, {
                module: 'activity', event: '奶茶热销中', result: 'skip',
            });
            return out;
        }
        if (r.ok) {
            log('活动', `奶茶热销中: 已自动雇佣好友 ${r.friendGid}`, { module: 'activity', event: '奶茶热销中', result: 'ok' });
        } else {
            log('活动', `奶茶热销中: 自动雇佣未成功 — ${r.reason}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
        }
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
    __testing: { parseMainState, encodeUint1, encodeVarint, encodePackedVarints, shortErr },
    getMainStatus,
    claimCashier,
    craft,
    craftMilkTea,
    craftAllFruits,
    claimWage,
    getCashierDetail,
    parseWorkFromRefresh,
    parseEmployerFromCashier,
    WORK_INTERACT_OPTIONS,
    interactWithFriend,
    WORK_INTERACT_TYPE,
    getCraftableFruitIds,
    getLastEmployer: () => lastEmployer,
    useSpeaker,
    openStore,
    hireFriend,
    interact,
    getShopGoods,
    buyShopGoods,
    getFriendList,
    autoHire,
    hireAll,
    getTasks,
    claimTask,
    claimAllTasks,
    getCashierStatus,
    getMilkCouponBalance,
    MILK_COUPON_ID,
    isSettling,
    runMilkTea,
};
