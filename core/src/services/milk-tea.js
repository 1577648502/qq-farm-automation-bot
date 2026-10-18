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
 * ⚠ 收银台满载会暂停自动营业且**不补发** → 定时领收益(cmd=59)是自动化的核心
 *
 * ════════ 协议 (2026-10-18 三级解锁抓包复核) ════════
 * 活动组: 2026110100 根组 / 2026110101 主活动 / 2026110102 商店 /
 *         2026110103 任务 / 2026110104 快乐不独享S4
 * 活动列表: gamepb.activitypb.ActivityService.List(空请求)
 *   根组 #1=活动头, #2=repeated 子活动; 活动头 #6 开始 / #7 结束 / #24 结算期开始。
 *   商店和任务以 List 快照为准, 服务端约有 20~30 秒缓存, 购买/升级后主动失效本地缓存。
 * 主活动(0101): **payload 字段 = cmd + 105**, 状态容器 = 活动体 #121.#1
 *   cmd=53 开业     {#158: {#1: "店名"}}
 *   cmd=55 收银台详情 {#160: ""}
 *   cmd=56 员工面板 {#161: {#1: selector(普通列表实测=1)}}
 *   cmd=57 雇佣好友 {#162: {#1: {#1: 1, #2: 班次档位, #3: 好友gid}}}
 *        ⚠ 全部 3 个字段必发: 抓包只有 #1=1 的实测(#2=1), 缺任一字段服务端会拒。
 *        #2 只对 #1=1 有证据(班次 = #9.#5-#9.#4 = 14400s = 4h); 12/24h 档位值未抓到, 不猜。
 *   cmd=58 配方菜单 {#163: ""}
 *   cmd=59 领取收银台收益 {#164: ""}
 *   cmd=60 查询 {#165: {#1: 1}} → {#1,#2,#3} 业务语义未闭环
 *   cmd=61 店铺升级 {#166: ""}
 *   cmd=62 制作奶茶 {#167: {#1: packed 果实uid}}
 *   cmd=63 刷新/查询 {#168: ""}
 *   cmd=65 互动     {#170: {#1: 好友gid, #2: 互动类型}}
 *   cmd=66 好友店铺排行 {#171: {#1: 页码}}
 *   cmd=67 班次     {#172: {#1: 时间戳}}
 *   cmd=69 查配方   {#174: {#1: {#1250: 配方id}}}
 *   状态 #121.#1: {#1: 开业时间, #2: 店名, #4: 店铺等级, #5: 累计营业额,
 *                  #15: {#1250: 当前配方}, #16: 刷新时间}
 * 商店(0102): List 子活动 #102 / **cmd=1 购买 {#101: {#1: 商品ID, #2: 数量}}**
 *   商品: {#1 ID, #2 repeated 内容物, #3 repeated 价格, #4 限购, #5 已购,
 *          #7/#8 名称/描述, #11 限购类型, #12 类型, #13 解锁条件}
 *   解锁只认 #13.#3===1; 无 #13 表示无限制。#13.#5 可展示需求等级。
 * 任务(0103): List 子活动 #122 = {#2 汇总, #3(repeated) 任务}
 *   任务: {#1 ID, #2 条件, #3 repeated 奖励, #4 状态(1进行中/2可领/3已领)}
 *   领取协议尚未抓到, claimTask/claimAllTasks 一律禁用, 不发送候选请求。
 * 收银台(cmd55/#160): #1 等级, #2 累计营业额, #3 下一级门槛, #4=172800, #9 当前在岗员工,
 *   #10 当日品类销量, #19 repeated 待领取收益, #22/#24 当日累计杯数(两侧同值),
 *   #23 repeated 长期累计收益, #25 repeated 累计品类销量。
 *   #9 员工: #3 班次UID(17位,必须字符串), #4 开始, #5 结束, #6 工资,
 *           #7 特长id, #8 特长名, #11 {#1 gid, #2 昵称, #4 等级}
 *   领取前必须先查 #19(2026-10-18 逐帧对照: 领取前 #19=[券585,金837609], 领取后 #19=[],
 *     #164 到账正好是 券585+金837609; #23 一直不动 = 长期累计, 不是待领取)。
 *   无 #19 时不得发送 cmd59。
 * cmd60/#165 = {#1: 50, #2: 2250, #3: 2908400} 与 #160.#23 完全同值 → 是"长期累计"视图,
 *   用它判断"有无待领取"是错的(它不随待领取变化)。
 * 排行榜(cmd66/#171): 条目 {#1 身份, #2 店名, #3 等级, #4 营业额, #5 排名},
 *   外层 #3 时间 / #4 页码 / #5 是否有下一页。
 * 营业记录(cmd67/#172): 员工记录 #6 是 17 位班次 UID, 必须按字符串保存。
 */
const { log, toNum, toInt, sleep } = require('../utils/utils');
const { getItemById, getItemImageById, getPlantBySeedId } = require('../config/gameConfig');
const { operateRaw, parseTop, findField } = require('./mengchong');
const { sendMsgAsync } = require('../utils/network');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';
const GROUP_MAIN = 2026110101;
const GROUP_SHOP = 2026110102;
const GROUP_TASK = 2026110103;
const GROUP_HAPPY = 2026110104;      // 快乐不独享 S4(复用 happy-share 服务)
const SUB_ID = 2026110100;

// 主活动命令
const CMD_OPEN = 53;        // 确认店名开业
const CMD_EMPLOYEES = 56;   // 员工列表(好友+NPC店员)
const CMD_HIRE = 57;        // 雇佣好友(返回班次+特长)
const CMD_MENU = 58;        // 配方菜单(9 种配方)
const CMD_CASHIER_DETAIL = 55;// **收银台详情**(结果 #160: 可领取/明细) —— ⚠ 它**不是领取**, 只是查询
const CMD_SALES_RECORD = 67;   // **营业记录(按天)**(实测: 字段 #172 = {#1 日期})
const CMD_UPGRADE_STORE = 61;  // **店铺升级**(实测: 字段 #166, 空 payload)
const CMD_CLAIM_CASHIER = 59; // **领取收银台收益**(执行) → 响应 #164 = 到账物品(实测 奶茶券×10 + 金币×8648)
const CMD_CASHIER_INFO = 60;// 查询: 请求 {#1: 1}; 响应 #1/#2/#3 业务语义未闭环
const CMD_REFRESH = 63;     // 刷新/查询兼职状态(只用于 #168)
const CMD_RANKING = 66;     // 好友店铺排行(店名+热度)
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

function normalizeInteractType(type) {
    const id = toInt(type);
    return WORK_INTERACT_OPTIONS.some((op) => op.id === id) ? id : WORK_INTERACT_TYPE;
}

const CMD_SHIFT = 67;       // 班次(带时间戳)
const CMD_RECIPE = 69;      // 查询配方
const FIELD_OFFSET = 105;   // 主活动 payload 字段 = cmd + 105

// 商店购买命令(payload/结果字段 = cmd + 100)
const CMD_SHOP_LIST = 7;    // 旧版列表命令, 仅为兼容导出保留
const CMD_SHOP_BUY = 1;
const FIELD_SHOP_BUY = 101;

const STATE_FIELD = 121;    // 主活动状态容器
const GOLD_ID = 1001;       // 金币
const MILK_COUPON_ID = 1041; // 奶茶券(活动货币)
/** 奶茶活动可加工的种子 = **森野系列 8 种**(商店 301~308) →
 *  ⚠ 商店里同时在售的金币果(20522)/经验蘑菇(20523) **不属于本活动**, 不能拿来制作奶茶(用户 2026-10-15 明确)
 *  · 甜莓 20525 / 白桃 20526 / 甜橙 20527 / 红柚 20528 / 可可豆 20021 / 柿子 21435 / 芭乐 20529 / 黄金芽 29005
 */
// ⚠ 区分两组(踩过): **可加工果实**的种子 与 **兑换商店**里的种子不是同一批
//  A. 可加工(制作奶茶用) = 森野系列 8 种
const MILK_TEA_SEED_IDS = [20525, 20526, 20527, 20528, 20021, 21435, 20529, 29005];
//  B. 兑换商店在售的活动种子(实测 20261016-195923 #102 商品301-310) = A + 金币果 + 经验蘑菇
//     301 20525 甜莓 / 302 20526 白桃 / 303 20527 甜橙 / 304 20528 红柚 / 305 20021 可可豆
//     306 21435 柿子 / 307 20529 芭乐 / 308 29005 黄金芽 / 309 20522 金币果 / 310 20523 经验蘑菇
const EXCHANGE_SEED_IDS = [20525, 20526, 20527, 20528, 20021, 21435, 20529, 29005, 20522, 20523];
// **每日自动兑换**只买这一种: 森野黄金芽种子(商品308, 物品29005, 8000 奶茶券, 限购1)
const DAILY_BUY_SEED_ID = 29005;

/**
 * 可加工果实 → 配方 id。
 * 抓包(cmd=58)确认配方 #2..#9 与 MILK_TEA_SEED_IDS 顺序一一对应；
 * 变异/特殊果实也按所属植物归到同一配方，未知果实不提交。
 */
function getCraftableFruitRecipeMap() {
    const map = new Map();
    MILK_TEA_SEED_IDS.forEach((seed, index) => {
        const recipeId = index + 2;
        const plant = getPlantBySeedId(seed) || getFallbackPlantBySeedId(seed);
        const add = (o) => {
            const id = toNum(o && o.id);
            if (id > 0 && !map.has(id)) map.set(id, recipeId);
        };
        if (plant) {
            add(plant.fruit);
            add(plant.fruit_alter);
            add(plant.special_fruit);
        }
        // 官方表缺森野系列时，果实 id = 种子 id + 20000。
        add({ id: seed + 20000 });
    });
    return map;
}

/** 动态推导"可制作的果实 id"——不要写死列表(会漏)。 */
function getCraftableFruitIds() {
    return [...getCraftableFruitRecipeMap().keys()];
}
const CMD_CRAFT_REAL = 62;   // 制作奶茶(工坊加工): 请求 #167 = {#1: 果实 uid 列表(packed varint)}
const SHOP_BODY_FIELD = 102;// 商店列表所在字段
const TASK_BODY_FIELD = 122;// 任务列表所在字段

function itemLabel(id, count) {
    const it = getItemById(toNum(id));
    return `${(it && it.name) || `物品#${id}`}×${count}`;
}

/** 合并同一种产出，避免日志出现 "物品#50001×1×1" 或重复条目。 */
function aggregateMadeItems(made) {
    const agg = new Map();
    for (const m of made || []) {
        const id = toInt(m && m.id);
        if (!id) continue;
        const prev = agg.get(id) || { id, count: 0 };
        prev.count += Number(m.count) || 0;
        agg.set(id, prev);
    }
    const items = [...agg.values()].map((x) => {
        const cfg = getItemById(x.id);
        const fallback = String((made || []).find((m) => toInt(m.id) === x.id)?.name || `物品#${x.id}`)
            .replace(/×\d+$/, '');
        return { ...x, name: (cfg && cfg.name) || fallback };
    });
    return { items, text: items.map((x) => `${x.name}×${x.count}`).join('、') };
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
    const r = await operateSafe(GROUP_MAIN, cmd, payloadField === undefined ? cmd + FIELD_OFFSET : payloadField, payloadBytes || Buffer.alloc(0));
    if (MAIN_STATUS_MUTATING_CMDS.has(toInt(cmd))) clearMainStatusCache();
    return r;
}

/** 把 varint 编成 payload: {#1: n} */
function encodeUint1(n) {
    return Buffer.from([0x08, toInt(n) & 0x7f]);
}
function encodeVarint(v) {
    const out = [];
    let n;
    if (typeof v === 'bigint') n = v;
    else if (typeof v === 'string' && /^\d+$/.test(v.trim())) n = BigInt(v.trim());
    else n = BigInt(Math.max(0, Math.trunc(Number(v) || 0)));
    n = n < 0n ? 0n : n;
    do {
        let byte = Number(n & 0x7fn);
        n >>= 7n;
        if (n > 0n) byte |= 0x80;
        out.push(byte);
    } while (n > 0n);
    return Buffer.from(out.map((b, i) => (i === out.length - 1 ? b : b | 0x80)));
}

/** 解析主活动状态容器 #121.#1 */
function parseMainState(activityBuf) {
    const out = { ok: false, storeName: '', value: 0, recipeId: 0, at: 0, nextAt: 0, storeLevel: 0, startAt: 0, endAt: 0, settleAt: 0 };
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
        out.nextAt = toInt((findField(f, 1) || {}).v);
        out.at = toInt((findField(f, 16) || {}).v);
        const recipe = findField(f, 15);
        if (recipe && recipe.w === 2) out.recipeId = toInt((findField(parseTop(recipe.v), 1250) || {}).v);
        out.opened = !!out.storeName;
        out.ok = true;
    } catch (e) { /* 解析失败按"读不到"处理 */ }
    return out;
}

const MAIN_STATUS_CACHE_MS = 20 * 1000;
const MAIN_STATUS_MUTATING_CMDS = new Set([
    CMD_OPEN,
    CMD_HIRE,
    CMD_CLAIM_CASHIER,
    CMD_UPGRADE_STORE,
    CMD_CRAFT_REAL,
    CMD_CLAIM_WAGE,
    CMD_WORK_INTERACT,
]);
let mainStatusCache = null;
let mainStatusInFlight = null;
let mainStatusGeneration = 0;

function clearMainStatusCache() {
    mainStatusCache = null;
    // 让已经发出的旧 List 请求回来后不能重新写入缓存。
    mainStatusGeneration += 1;
}

/** 从 ActivityService.List 的根组里取出指定活动体。 */
function findActivityBody(replyBody, groupId = GROUP_MAIN) {
    for (const groupField of parseTop(replyBody)) {
        if (groupField.f !== 1 || groupField.w !== 2) continue;
        for (const activityField of parseTop(groupField.v)) {
            if (activityField.f !== 2 || activityField.w !== 2) continue;
            const body = Buffer.from(activityField.v);
            const head = findField(parseTop(body), 1);
            const headFields = head && head.w === 2 ? parseTop(head.v) : [];
            if (toInt((findField(headFields, 1) || {}).v) === toInt(groupId)) return body;
        }
    }
    return null;
}

async function fetchMainStatus() {
    try {
        await throttle();
        const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'List', Buffer.alloc(0));
        const activity = findActivityBody(replyBody, GROUP_MAIN);
        if (!activity) return { ok: false, reason: '活动列表未返回奶茶主活动' };
        const st = parseMainState(activity);
        return st.ok ? st : { ...st, ok: false, reason: '奶茶主活动状态解析失败' };
    } catch (e) {
        return { ok: false, reason: `读取活动列表失败: ${shortErr(e && e.message)}` };
    }
}

/** 读取主店状态: 权威来源是 ActivityService.List，短暂缓存并合并并发请求。 */
async function getMainStatus(force = false) {
    if (!force && mainStatusCache && Date.now() - mainStatusCache.at < MAIN_STATUS_CACHE_MS) {
        return mainStatusCache.value;
    }
    if (!force && mainStatusInFlight) return mainStatusInFlight;
    const generation = mainStatusGeneration;
    const task = (async () => {
        const value = await fetchMainStatus();
        if (value && value.ok && generation === mainStatusGeneration) {
            mainStatusCache = { at: Date.now(), value };
        }
        return value;
    })();
    if (!force) mainStatusInFlight = task;
    try {
        return await task;
    } finally {
        if (mainStatusInFlight === task) mainStatusInFlight = null;
    }
}

let claimCashierInFlight = null;

/** 领取收银台收益(核心: 满载会暂停营业且不补发) */
async function claimCashier() {
    if (claimCashierInFlight) return claimCashierInFlight;
    const task = claimCashierOnce();
    claimCashierInFlight = task;
    try {
        return await task;
    } finally {
        if (claimCashierInFlight === task) claimCashierInFlight = null;
    }
}

async function claimCashierOnce() {
    const before = await getMainStatus().catch(() => null);
    if (before && before.ok && isSettling(before)) {
        return { ok: false, skipped: true, reason: '结算期, 不能领取收银台收益' };
    }
    // ⚠ 待领取的唯一权威来源是 cmd55/#160 的 #19(2026-10-18 逐帧对照)。
    //   之前用 cmd60/#165.#2 判断是错的: 它是长期累计值, 不随待领取变化(实测恒为 2250)。
    const detail = await getCashierDetail().catch((e) => ({ ok: false, reason: e.message }));
    if (!detail || !detail.ok) {
        return {
            ok: false,
            skipped: true,
            reason: `无法确认收银台收益, 跳过领取${detail && detail.reason ? `: ${detail.reason}` : ''}`,
        };
    }
    if (!detail.pending.length) {
        return { ok: true, skipped: true, reason: '收银台暂无可领取收益' };
    }
    // ⚠ 真正的"领取"是 cmd=59(实测: 响应 #164 = 到账物品); cmd=55 只是收银台详情(踩过)
    const r = await mainOperate(CMD_CLAIM_CASHIER, 164, Buffer.alloc(0));
    if (!r.ok) return { ok: false, reason: `领取收银台收益失败 ${r.reason || `code=${r.errorCode}`}` };
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
    log('活动', `奶茶热销中: 已领取收银台收益${gainedList.length ? ` → ${gainedList.map((x) => x.name).join('、')}` : ''}${after.value ? ` (累计营业额 ${after.value})` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok',
    });
    return { ok: true, gained: gainedList, gainedList, value: after.value, before: before && before.value, state: after };
}

/** 宣传喇叭协议尚未从抓包确认；保留入口，但不发送猜测请求。 */
async function useSpeaker() {
    return { ok: false, skipped: true, reason: '宣传喇叭协议尚未确认，已禁用' };
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

/** 雇佣好友: #162.#1 = {#1: 1, #2: 班次档位, #3: 好友gid}(2026-10-18 抓包实测) */
async function hireFriend(friendGid, duration = 1, opts = {}) {
    const gid = toNum(friendGid);
    if (!gid) return { ok: false, reason: '缺少好友 gid' };
    if (!opts.skipCapacityCheck) {
        const hiring = await getHiringAvailability().catch((e) => ({ ok: false, reason: e.message }));
        if (!hiring.ok) {
            return { ok: false, skipped: true, reason: `无法确认员工容量，跳过雇佣: ${hiring.reason}` };
        }
        if (hiring.available <= 0) {
            return {
                ok: true,
                skipped: true,
                reason: `员工已满(${hiring.employeeCount}/${hiring.employeeCapacity})`,
                ...publicHiringState(hiring),
            };
        }
        if (hiring.currentGids.has(gid)) {
            return { ok: true, skipped: true, reason: `好友 ${gid} 已是当前员工`, ...publicHiringState(hiring) };
        }
    }
    const inner = Buffer.concat([
        encodeVarintField(1, 1),
        encodeVarintField(2, normalizeHireDuration(duration)),
        encodeVarintField(3, gid),
    ]);
    const payload = Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
    const r = await mainOperate(CMD_HIRE, undefined, payload);
    if (r.errorCode !== 0) return { ok: false, reason: `雇佣失败 code=${r.errorCode}` };
    log('活动', `奶茶热销中: 已雇佣好友 ${gid}`, { module: 'activity', event: '奶茶热销中', result: 'ok', friendGid: gid });
    return { ok: true, friendGid: gid, state: parseMainState(r.activity) };
}
function encodeVarintField(field, value) {
    return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

/** 未闭环字段保持原样: varint 转整数, length-delimited 转十六进制。 */
function rawFieldSnapshot(fields) {
    const out = {};
    for (const x of fields || []) {
        out[`field${x.f}`] = x.w === 0 ? toInt(x.v) : Buffer.from(x.v || []).toString('hex');
    }
    return out;
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
                // ⚠ 不用本地计数判断"已限购"(服务器只下发上限 #4, 不下发已购数) ——
                //    "已限购"一律以**服务端在购买时的应答**为准
                const bought = 0;
                goods.push({
                    goodsId,
                    boughtCount: bought,
                    soldOut: shopSoldOut.has(goodsId),   // 仅由服务端应答(限购/已购类错误)置位
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

/**
 * 已被**服务端明确拒绝**为"限购/已购"的商品(内存态; 页面刷新后重置, 再次点击时由服务端重新确认)
 * ⚠ 服务器只下发限购上限(#4), 不下发已购买数 → "已限购"只能以服务端应答为准
 */
const shopSoldOut = new Set();
function markShopGoodsSoldOut(goodsId) { if (goodsId) shopSoldOut.add(toInt(goodsId)); }

/** 本次进程内各商品已兑换数量(用于显示"已限购"; 服务端没给已购字段, 只能自己记) */
const shopBought = new Map();

/** 兑换/购买商品(数量必填) —— 实测 {#101: {#1: 商品ID, #2: 数量}} */
/**
 * 每日兑换种子 —— **只兑换森野黄金芽种子**(商品308/物品29005), 买 perSeed 份(默认 1), 一天一次
 * 实测(20261016-195923): 兑换 = 商店组 2026110102 cmd=1, payload #101 = {#1 商品id, #2 数量};
 *   响应 #101 = {#1 = {物品id, 数量}, #2 = {货币id, 总价}}
 */
/**
 * 店铺升级信息(cmd=55 收银台详情的 box 标量, 实测 20261017-062113):
 *   #1 = 当前等级   #2 = 累计营业额   #3 = 下一级所需营业额(实测升级后 14000 → 33000)
 * 条件: 营业额(#2) >= 所需(#3) 时可升级
 */
/**
 * 营业记录(按天) —— **cmd=67, 字段 #172** (实测 20261017-070514, 与游戏面板逐项吻合)
 *   请求: #172 = {#1: 该日 00:00 时间戳(北京时间)}
 *   响应 #172:
 *     #1 日期(时间戳)   #2 奶茶券收益   #3 金币收益   #4 当日总杯数
 *     #5 = repeated {#1 品类, #2 杯数}(今日售卖)     ← 面板"普通奶茶254杯/甜莓750杯…"
 *     #6 = repeated {#1 相对请求小时, #2 杯数}(分时销量; 0=本小时, 1=1小时前, 依此类推;
 *          条目可能乱序, 零销量小时省略; 各条 #2 合计等于 #4)
 *     #7 = repeated 雇员记录 { #1 老板{gid,名}, #2 开始时间, #3 时长(秒), #6 班次id,
 *            #8 特长id, #9 特长名, #10 未闭环嵌套字段 }
 *     #8 = repeated 收益物品 {#1 物品id, #2 数量}
 */
function beijingDayStart(tsSec) {
    const SHIFT = 8 * 3600;
    return Math.floor((toInt(tsSec) + SHIFT) / 86400) * 86400 - SHIFT;
}

async function getSalesRecord(dayTs) {
    const st = await getMainStatus().catch(() => null);
    const requestedAt = toInt(dayTs) > 0 ? toInt(dayTs) : (toInt(st && st.at) || Math.floor(Date.now() / 1000));
    const base = beijingDayStart(requestedAt);
    const payload = Buffer.concat([encodeVarintField(1, base)]);
    const r = await mainOperate(CMD_SALES_RECORD, 172, payload);
    if (r.errorCode !== 0) return { ok: false, reason: `读取营业记录失败 ${r.reason || `code=${r.errorCode}`}` };
    const out = {
        ok: true,
        day: base,
        coupon: 0,
        gold: 0,
        cups: 0,
        currentHourCups: 0,
        hourly: [],
        items: [],
        rewards: [],
        records: [],
    };
    try {
        const rf = parseTop(Buffer.from(r.resultHex || '', 'hex'));
        out.day = toInt((findField(rf, 1) || {}).v) || base;
        out.coupon = toInt((findField(rf, 2) || {}).v);
        out.gold = toInt((findField(rf, 3) || {}).v);
        out.cups = toInt((findField(rf, 4) || {}).v);
        const names = await getMenuNames();
        for (const x of rf) {
            if (x.w !== 2) continue;
            const e = parseTop(x.v);
            if (x.f === 5) out.items.push({ id: toInt((findField(e, 1) || {}).v), cups: toInt((findField(e, 2) || {}).v) });
            else if (x.f === 6) {
                out.hourly.push({
                    hoursAgo: toInt((findField(e, 1) || {}).v),
                    cups: toInt((findField(e, 2) || {}).v),
                });
            }
            else if (x.f === 8) {
                const id = toInt((findField(e, 1) || {}).v);
                const count = toInt((findField(e, 2) || {}).v);
                // #2/#3 已分别展示奶茶券和金币；#8 中这两种货币是同一收益的明细，不再重复展示。
                if (id && id !== GOLD_ID && id !== MILK_COUPON_ID) out.rewards.push({ id, count });
            }
            else if (x.f === 7) {
                const info = findField(e, 1);
                const fi = info && info.w === 2 ? parseTop(info.v) : [];
                const w10 = findField(e, 10);
                const w10f = w10 && w10.w === 2 ? parseTop(w10.v) : [];
                out.records.push({
                    gid: toInt((findField(fi, 1) || {}).v),
                    name: String((findField(fi, 2) || {}).v || ''),
                    startAt: toInt((findField(e, 2) || {}).v),
                    workSeconds: toInt((findField(e, 3) || {}).v),
                    titleId: toInt((findField(e, 8) || {}).v),
                    titleName: String((findField(e, 9) || {}).v || ''),
                    historyField10: rawFieldSnapshot(w10f),
                });
            }
        }
        for (const it of out.items) it.name = names.get(it.id) || `品类${it.id}`;
        out.items.sort((a, b) => b.cups - a.cups);
        out.hourly.sort((a, b) => a.hoursAgo - b.hoursAgo);
        out.currentHourCups = (out.hourly.find((x) => x.hoursAgo === 0) || { cups: 0 }).cups;
        for (const rw of out.rewards) rw.name = itemLabel(rw.id, rw.count);
    } catch (e) {
        return { ok: false, reason: `解析营业记录失败: ${e.message}` };
    }
    return out;
}

async function getUpgradeInfo() {
    const r = await mainOperate(CMD_CASHIER_DETAIL, 160, Buffer.alloc(0));
    if (!r.ok) return { ok: false, reason: r.reason || `读取店铺信息失败 code=${r.errorCode}` };
    try {
        const rf = parseTop(Buffer.from(r.resultHex || '', 'hex'));
        const box = findField(rf, 1);
        const inner = box && box.w === 2 ? parseTop(box.v) : rf;
        const level = toInt((findField(inner, 1) || {}).v);
        const revenue = toInt((findField(inner, 2) || {}).v);
        const required = toInt((findField(inner, 3) || {}).v);
        return { ok: true, level, revenue, required, canUpgrade: required > 0 && revenue >= required };
    } catch (e) {
        return { ok: false, reason: `解析店铺信息失败: ${e.message}` };
    }
}

/**
 * 店铺升级(cmd=61, 字段 #166, 空 payload —— 实测 20261017-062113)
 *   响应 #166 = {#1 = 升级后等级, #2 = repeated {#1 物品id, #2 数量}(升级奖励, 实测 黄金芽种子×2/喇叭×2/有机化肥×10)}
 */
async function upgradeStore() {
    const info = await getUpgradeInfo().catch(() => null);
    if (info && info.ok && !info.canUpgrade) {
        return { ok: false, skipped: true, reason: `营业额 ${info.revenue} < 升级所需 ${info.required}(Lv${info.level})` };
    }
    const r = await mainOperate(CMD_UPGRADE_STORE, 166, Buffer.alloc(0));
    if (r.errorCode !== 0) return { ok: false, reason: `升级失败 ${r.reason || `code=${r.errorCode}`}` };
    let level = 0;
    const got = [];
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            level = toInt((findField(rf, 1) || {}).v);
            for (const x of rf) {
                if (x.f !== 2 || x.w !== 2) continue;
                const e = parseTop(x.v);
                const id = toInt((findField(e, 1) || {}).v);
                const n = toInt((findField(e, 2) || {}).v);
                if (id) got.push(`${itemLabel(id, n)}`);
            }
        } catch (e) { /* 忽略 */ }
    }
    log('活动', `奶茶热销中: 店铺已升级到 Lv${level || '?'}${got.length ? ` (奖励 ${got.join('、')})` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok',
    });
    return { ok: true, level, got };
}

async function buyDailySeeds(perSeed = 1) {
    const st0 = await getMainStatus().catch(() => null);
    if (st0 && isSettling(st0)) return { ok: false, skipped: true, reason: '结算期, 不兑换' };
    const shop = await getShopGoods();
    if (!shop.ok) return { ok: false, reason: shop.reason || '读取商店失败' };
    const seeds = (shop.goods || []).filter((g) => toInt(g.itemId) === DAILY_BUY_SEED_ID);
    if (!seeds.length) return { ok: false, skipped: true, reason: '商店里没有森野黄金芽种子' };
    const bought = [];
    let spent = 0;
    let done = false;   // 是否"今天确实已经买过"(含限购)
    for (const g of seeds) {
        const n = Math.max(1, toInt(perSeed) || 1);
        const r = await buyShopGoods(g.goodsId, n);
        if (r && r.ok) {
            bought.push(`${g.name}×${n}`);
            spent += toInt(r.cost && r.cost.amount) || 0;
        } else if (r && /限购|已满|上限|已售|已购|已兑换|已领|1034007/.test(String(r.reason))) {
            // 今天已经买过/限购: 视为"当日已完成"(实测: 手动买过之后再自动买 → code=1034007)
            done = true;
        } else if (r) {
            log('活动', `奶茶热销中: 兑换「${g.name}」失败 — ${shortErr(r.reason)}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
        }
        await sleep(700);
    }
    if (!bought.length) {
        return done
            ? { ok: false, skipped: true, alreadyDone: true, reason: '今天已经买过森野黄金芽种子' }
            : { ok: false, reason: '森野黄金芽种子兑换未成功(下一轮重试)' };
    }
    log('活动', `奶茶热销中: 每日兑换种子 → ${bought.join('、')}${spent ? ` (花费 ${spent})` : ''}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok',
    });
    return { ok: true, bought, spent };
}

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
    if (r.errorCode !== 0) {
        const why = String(r.reason || `code=${r.errorCode}`);
        // 服务端明确说"限购/已购" → 记为已限购(界面显示"已限购")
        if (/限购|已满|上限|已售|已购|已兑换|已领|1034007/.test(why)) markShopGoodsSoldOut(id);
        return { ok: false, reason: `兑换失败 ${why}` };
    }
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
async function autoHire(hireGids, opts = {}) {
    const list = (Array.isArray(hireGids) ? hireGids : []).map((g) => toInt(g)).filter((g) => g > 0);
    if (!list.length) return { ok: false, reason: '未配置可雇佣好友(先在页面里勾选)' };
    const duration = normalizeHireDuration(opts.duration);
    const hiring = await getHiringAvailability().catch((e) => ({ ok: false, reason: e.message }));
    if (!hiring.ok) {
        return { ok: false, skipped: true, reason: `无法确认员工容量，跳过雇佣: ${hiring.reason}` };
    }
    if (hiring.available <= 0) {
        return {
            ok: true,
            skipped: true,
            reason: `员工已满(${hiring.employeeCount}/${hiring.employeeCapacity})`,
            ...publicAutoHireState(hiring),
        };
    }
    const currentNames = [];
    const skillOf = new Map();
    for (const f of hiring.currentEmployees) {
        currentNames.push(`${f.name || `GID:${f.gid}`}(${EMPLOYEE_SKILLS[toInt(f.titleId)] || '?'})`);
        skillOf.set(toInt(f.gid), toInt(f.titleId));
    }
    // 按"特长加成"排序: 先生命里带的高加成特长(默认 9001 销售 > 9002 宣传 > 9003 服务), 未知放最后
    const order = Array.isArray(opts.hireSkillOrder) && opts.hireSkillOrder.length ? opts.hireSkillOrder : DEFAULT_HIRE_SKILL_ORDER;
    const rank = (g) => {
        const sid = skillOf.get(toInt(g));
        const i = order.indexOf(sid);
        return i >= 0 ? i : order.length + 1;
    };
    const todo = [...new Set(list)]
        .filter((g) => !hiring.currentGids.has(g))
        .sort((a, b) => rank(a) - rank(b));
    if (!todo.length) {
        return {
            ok: true,
            skipped: true,
            reason: `白名单 ${list.length} 位已是当前员工(${currentNames.slice(0, 4).join('、')}${currentNames.length > 4 ? ' 等' : ''})`,
            ...publicAutoHireState(hiring),
        };
    }
    const result = await autoHireInner(todo, duration, hiring.available);
    return { ...result, ...publicAutoHireState(hiring, result.hired) };
}

/** autoHire 实际执行体 */
async function autoHireInner(list, duration = 1, maxHires = 1) {
    const errors = [];
    const hired = [];
    const results = [];
    for (const gid of list) {
        if (hired.length >= Math.max(1, toInt(maxHires))) break;
        const r = await hireFriend(gid, duration, { skipCapacityCheck: true }).catch((e) => ({ ok: false, reason: e.message }));
        results.push({ gid, ok: !!(r && r.ok && !r.skipped), reason: (r && r.reason) || '', skipped: !!(r && r.skipped) });
        if (r && r.ok && !r.skipped) {
            hired.push(gid);
            continue;
        }
        errors.push(shortErr((r && r.reason) || '失败'));
        await sleep(600);
    }
    if (hired.length) {
        return {
            ok: true,
            hired: hired.length,
            friendGid: hired[0],
            friendGids: hired,
            results,
        };
    }
    // 日志别太长: 只给"尝试了几个 + 第一条原因"
    const first = errors[0] || '未知错误';
    const same = errors.every((x) => x === first);
    // ⚠ 真实时间: 雇佣位何时空出 = 现有员工里最晚的下班时间(#6), 用它做退避结束点(而不是本地硬记 30 分钟)
    let nextAt = 0;
    try {
        const emp2 = await getEmployees();
        const offs = (emp2.friends || []).map((f) => toInt(f.offAt)).filter((x) => x > 0);
        if (offs.length) nextAt = Math.max.apply(null, offs);
    } catch (e) { /* 拿不到就退回本地冷却 */ }
    return { ok: false, reason: `${list.length} 位好友均雇佣失败: ${first}${same ? '' : ' 等'}`, nextAt };
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

/** 配方菜单缓存；只有服务端明确下发 #3=1 的配方才允许制作。 */
const MENU_CACHE_MS = 5 * 60 * 1000;
let menuRecipesCache = { at: 0, recipes: [], names: new Map() };

async function getMenuRecipes(force = false) {
    if (!force && menuRecipesCache.at && Date.now() - menuRecipesCache.at < MENU_CACHE_MS) {
        return menuRecipesCache.recipes;
    }
    const recipes = [];
    const r = await mainOperate(CMD_MENU, 163, Buffer.alloc(0));
    if (r.errorCode !== 0 || !r.resultHex) return [];
    try {
        for (const x of parseTop(Buffer.from(r.resultHex, 'hex'))) {
            if (x.w !== 2) continue;
            const e = parseTop(x.v);
            const id = toInt((findField(e, 1) || {}).v);
            if (!id) continue;
            const nameField = findField(e, 2);
            const unlockField = findField(e, 3);
            const field4 = findField(e, 4);
            const productField = findField(e, 5);
            const priceField = findField(e, 6);
            const field7 = findField(e, 7);
            recipes.push({
                id,
                name: nameField && nameField.w === 2 ? nameField.v.toString('utf8') : `品类${id}`,
                unlocked: !!unlockField && toInt(unlockField.v) === 1,
                field4: field4 ? toInt(field4.v) : 0,
                productId: productField ? toInt(productField.v) : 0,
                price: priceField ? toInt(priceField.v) : 0,
                field7: field7 ? (field7.w === 0 ? toInt(field7.v) : Buffer.from(field7.v).toString('hex')) : 0,
            });
        }
    } catch (e) {
        return [];
    }
    if (recipes.length) {
        const names = new Map(recipes.map((x) => [x.id, x.name]));
        menuRecipesCache = { at: Date.now(), recipes, names };
    }
    return recipes;
}

function clearMenuCache() {
    menuRecipesCache = { at: 0, recipes: [], names: new Map() };
}

function skippedFruitText(skipped) {
    const byRecipe = new Map();
    for (const x of skipped || []) {
        const key = `${x.reason}:${x.recipeId}:${x.recipeName}`;
        const prev = byRecipe.get(key) || {
            reason: x.reason,
            recipeName: x.recipeName,
            fruits: new Map(),
        };
        prev.fruits.set(x.itemName, (prev.fruits.get(x.itemName) || 0) + x.count);
        byRecipe.set(key, prev);
    }
    return [...byRecipe.values()].map((x) => {
        const fruits = [...x.fruits.entries()].map(([name, count]) => `${name}×${count}`).join('、');
        if (x.reason === 'locked') return `${x.recipeName}（${fruits}）`;
        return `${x.recipeName || '未知配方'}（${fruits}，配方未下发）`;
    }).join('、');
}

/** 收集背包里已解锁配方的果实 uid/count(只读一次背包，并查询配方菜单)。 */
async function collectFruitUids(limit = Number.MAX_SAFE_INTEGER) {
    const { getBag, getBagItems } = require('./warehouse');
    const items = getBagItems(await getBag());
    const fruitRecipeMap = getCraftableFruitRecipeMap();
    const fruitIds = new Set(fruitRecipeMap.keys());
    const recipes = await getMenuRecipes();
    const recipeById = new Map(recipes.map((x) => [x.id, x]));
    const uids = [];
    const entries = [];
    const skippedByKey = new Map();
    const max = Math.max(0, toInt(limit));
    for (const it of items) {
        const itemId = toNum(it && it.id);
        if (!fruitIds.has(itemId)) continue;
        const uid = toNum(it && it.uid);
        if (uid <= 0) continue;
        const count = Math.max(1, toInt(it.count) || 1);
        const recipeId = fruitRecipeMap.get(itemId);
        const recipe = recipeById.get(recipeId);
        if (!recipe || !recipe.unlocked) {
            const reason = recipe ? 'locked' : 'missing';
            const recipeName = recipe ? recipe.name : `配方#${recipeId}`;
            const itemCfg = getItemById(itemId);
            const itemName = (itemCfg && itemCfg.name) || `果实#${itemId}`;
            const key = `${reason}:${recipeId}:${itemId}`;
            const prev = skippedByKey.get(key) || {
                recipeId,
                recipeName,
                itemId,
                itemName,
                count: 0,
                groups: 0,
                reason,
            };
            prev.count += count;
            prev.groups += 1;
            skippedByKey.set(key, prev);
            continue;
        }
        if (uids.length < max) {
            uids.push(uid);
            entries.push({ uid, count, itemId, recipeId });
        }
    }
    return {
        uids,
        entries,
        fruitIds: [...fruitIds],
        recipes,
        skipped: [...skippedByKey.values()],
    };
}

/**
 * 把背包里**所有**活动果实都做成高级奶茶(分批提交, 批间隔 700ms 防队列打满)
 * @param perBatch 每批提交几个果实 uid(0/负数 = 用默认值)
 * @param maxBatches 最多几批(防跑飞)
 */
// 抓包已验证客户端一次提交 15 个果实 uid(20261018-095056, payload 45B = 15 个 varint)。
const CRAFT_BATCH_SIZE = 15;
async function craftAllFruits(perBatch = CRAFT_BATCH_SIZE, maxBatches = 50) {
    const pb = toInt(perBatch);
    perBatch = Math.min(CRAFT_BATCH_SIZE, pb > 0 ? pb : CRAFT_BATCH_SIZE);
    maxBatches = Math.max(1, toInt(maxBatches) || 50);
    let all = { uids: [], entries: [], fruitIds: [], recipes: [], skipped: [] };
    try {
        all = await collectFruitUids();
    } catch (e) {
        return { ok: false, reason: `读取背包失败: ${e.message}` };
    }
    if (!all.uids.length) {
        if (all.skipped.length) {
            const detail = skippedFruitText(all.skipped);
            const reason = `未制作: 配方尚未解锁 — ${detail}`;
            log('活动', `奶茶热销中: ${reason}`, {
                module: 'activity', event: '奶茶热销中', result: 'skip', skippedGroups: all.skipped.reduce((n, x) => n + x.groups, 0),
            });
            return {
                ok: false,
                skipped: true,
                reason,
                skippedItems: all.skipped,
                used: 0,
                usedUnits: 0,
                batches: 0,
                made: [],
            };
        }
        return { ok: false, reason: '背包里没有活动果实(森野系列)，先种再收' };
    }

    const entryByUid = new Map(all.entries.map((x) => [x.uid, x]));
    const made = [];
    let used = 0;         // 投入的"组"数(背包里每个 uid 一组)
    let usedUnits = 0;    // 实际消耗的果实个数
    let batches = 0;
    let failure = null;
    for (let i = 0; i < all.uids.length; i += perBatch) {
        if (batches >= maxBatches) break;
        const slice = all.uids.slice(i, i + perBatch);
        const r = await mainOperateCraft(slice);
        batches += 1;
        if (!r.ok) {
            failure = r;
            break; // 服务端拒绝后停手，保留已经成功的批次，不再逐 UID 刷请求。
        }
        used += slice.length;
        usedUnits += slice.reduce((sum, uid) => sum + (entryByUid.get(uid)?.count || 1), 0);
        made.push(...(r.made || []));
        if (i + perBatch < all.uids.length) await sleep(700);
    }

    const skippedDetail = skippedFruitText(all.skipped);
    const output = aggregateMadeItems(made);
    if (!used) {
        const reason = failure ? failure.reason : '制作未产生任何结果';
        const text = `奶茶热销中: 制作未完成 — ${reason}${skippedDetail ? `；跳过未解锁配方 ${skippedDetail}` : ''}`;
        log('活动', text, {
            module: 'activity', event: '奶茶热销中', result: 'error',
            errorCode: failure && failure.errorCode, skippedGroups: all.skipped.reduce((n, x) => n + x.groups, 0),
        });
        return {
            ok: false,
            errorCode: failure && failure.errorCode,
            reason,
            rawReason: failure && failure.rawReason,
            used,
            usedUnits,
            batches,
            made,
            skipped: false,
            skippedItems: all.skipped,
        };
    }

    const skipText = skippedDetail ? `；跳过未解锁配方 ${skippedDetail}` : '';
    const failureText = failure ? `；后续停止: ${failure.reason}` : '';
    log('活动', `奶茶热销中: 已制作 ${used} 组/共 ${usedUnits} 个果实${output.text ? ` → ${output.text}` : ''}${skipText}${failureText}`, {
        module: 'activity', event: '奶茶热销中', result: failure ? 'warn' : 'ok',
        fruits: used, batches, skippedGroups: all.skipped.reduce((n, x) => n + x.groups, 0),
    });
    return {
        ok: true,
        partial: !!failure,
        errorCode: failure && failure.errorCode,
        failureReason: failure && failure.reason,
        used,
        usedUnits,
        batches,
        made,
        skipped: false,
        skippedItems: all.skipped,
        state: null,
    };
}

/** 提交一批果实 uid 去制作(内部用) */
async function mainOperateCraft(uids) {
    await throttle();
    const packed = encodePackedVarints(uids);
    const payload = Buffer.concat([encodeVarint(0x0a), encodeVarint(packed.length), packed]);
    const r = await operateSafe(GROUP_MAIN, CMD_CRAFT_REAL, 167, payload);
    if (r.errorCode !== 0) {
        return {
            ok: false,
            errorCode: r.errorCode,
            reason: r.reason || `code=${r.errorCode}`,
            rawReason: r.rawReason || r.reason || '',
        };
    }
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
    return { ok: true, errorCode: 0, reason: '', made, state: parseMainState(r.activity) };
}

/**
 * 制作奶茶(cmd=62, 实测 2026-10-15 新抓包):
 *   请求 #167 = {#1: [果实 uid...](packed)} → 响应回产出的高级奶茶 {#1: 物品id, #2: 数量}
 * 果实来源: 背包里 40525/40526/… 这些活动果实(每个实例有独立 uid)
 * @param limit 单次最多提交几个果实(抓包已验证至少 15 个)
 */
async function craftMilkTea(limit = CRAFT_BATCH_SIZE) {
    const lm = toInt(limit);
    limit = Math.min(CRAFT_BATCH_SIZE, lm > 0 ? lm : CRAFT_BATCH_SIZE);
    let all;
    try {
        all = await collectFruitUids(limit);
    } catch (e) {
        return { ok: false, reason: `读取背包失败: ${e.message}` };
    }
    const picked = all.uids;
    const usedIds = new Set(all.entries.map((x) => x.itemId));
    const usedUnits = all.entries.reduce((sum, x) => sum + x.count, 0);
    if (!picked.length) {
        if (all.skipped.length) {
            const detail = skippedFruitText(all.skipped);
            const reason = `未制作: 配方尚未解锁 — ${detail}`;
            log('活动', `奶茶热销中: ${reason}`, {
                module: 'activity', event: '奶茶热销中', result: 'skip',
            });
            return {
                ok: false,
                skipped: true,
                reason,
                skippedItems: all.skipped,
                used: 0,
                usedUnits: 0,
                usedFruits: [],
            };
        }
        return { ok: false, reason: '背包里没有活动果实(森野系列)，先种再收' };
    }
    const r = await mainOperateCraft(picked);
    if (!r.ok) {
        log('活动', `奶茶热销中: 制作未完成 — ${r.reason}`, {
            module: 'activity', event: '奶茶热销中', result: 'error', errorCode: r.errorCode,
        });
        return {
            ...r,
            used: 0,
            usedUnits: 0,
            usedFruits: [...usedIds],
            skipped: false,
            skippedItems: all.skipped,
        };
    }
    const made = r.made || [];
    const output = aggregateMadeItems(made);
    const skipText = all.skipped.length ? `；跳过未解锁配方 ${skippedFruitText(all.skipped)}` : '';
    log('活动', `奶茶热销中: 已制作 ${picked.length} 组/共 ${usedUnits} 个果实${output.text ? ` → ${output.text}` : ''}${skipText}`, {
        module: 'activity', event: '奶茶热销中', result: 'ok', fruits: picked.length, usedUnits,
    });
    return {
        ok: true,
        used: picked.length,
        usedUnits,
        usedFruits: [...usedIds],
        made,
        skipped: false,
        skippedItems: all.skipped,
        state: r.state,
    };
}

/**
 * 互动(我的工作, cmd=65) —— 被雇佣后每班可互动一次, 影响工资
 * 实测(20261017-154632_互动.jsonl idx=113): 请求 #170 = {#1: 1253397809, #2: 2}
 * 互动前刷新 #168.#1.#11 = 40, 响应 #8.#3 = 12, 互动后刷新 #11 = 52
 * ⇒ 当前样本可确认 #8.#3 = 工资变化; #7 / #8.#1 的业务含义仍未确认。
 */
let interactInFlight = null;

async function interactWithFriend(type = WORK_INTERACT_TYPE) {
    const requestedType = normalizeInteractType(type);
    if (interactInFlight) {
        if (interactInFlight.type === requestedType) return interactInFlight.task;
        return {
            ok: false,
            skipped: true,
            reason: '另一项互动正在提交, 本次不重复发送',
            inFlight: true,
        };
    }
    const task = interactWithFriendOnce(requestedType);
    const current = { type: requestedType, task };
    interactInFlight = current;
    try {
        return await task;
    } finally {
        if (interactInFlight === current) interactInFlight = null;
    }
}

async function interactWithFriendOnce(type = WORK_INTERACT_TYPE) {
    const interactType = normalizeInteractType(type);
    // 互动目标只能来自动作发生前的实时 cmd63/#168，绝不接受页面缓存或配置里的 GID。
    const w = await getWorkStatus().catch(() => null);
    if (!w || !w.ok) {
        return {
            ok: false,
            skipped: true,
            reason: '无法确认当前兼职状态(cmd63 查询失败), 跳过互动',
            hasEmployer: false,
            shiftKey: 0,
        };
    }
    if (!w.hasEmployer || !w.employer || !w.employer.gid) {
        return {
            ok: false,
            skipped: true,
            reason: '当前没有进行中的兼职(未被雇佣), 不能互动',
            hasEmployer: false,
            shiftKey: 0,
        };
    }
    const gid = toInt(w.employer.gid);
    const shiftKey = toInt(w.startAt) || 0;
    const interactionCompleted = w.interactionCompleted === true
        || (shiftKey > 0 && interactCompletedShifts.has(shiftKey));
    if (interactionCompleted) {
        return {
            ok: false,
            skipped: true,
            reason: '本班已完成互动, 不再重复提交',
            diag: workDiag(w),
            hasEmployer: true,
            shiftKey,
            interactionCompleted: true,
        };
    }
    const inner = Buffer.concat([encodeVarintField(1, gid), encodeVarintField(2, interactType)]);
    // ⚠ 实测抓包(15:46 成功那次): #170 的内容**直接**就是 {#1: gid, #2: type}(8 字节),
    //   不能再像下面这样多包一层 {#1: <inner>}, 否则服务端收到的是嵌套两层 → 判定异常
    //   (此前写法: Buffer.concat([Buffer.from([0x0a, inner.length]), inner]) —— 已去掉)
    const payload = inner;
    // 本班已被服务端拒绝过(1034147) → 本地冷却 10 分钟再试
    const nextTryAt = shiftKey ? (interactCooldown.get(shiftKey) || 0) : 0;
    if (nextTryAt > Date.now()) {
        return {
            ok: false,
            skipped: true,
            reason: `本班暂不可互动(本地冷却中), ${Math.ceil((nextTryAt - Date.now()) / 60000)} 分钟后重试`,
            hasEmployer: true,
            shiftKey,
        };
    }
    log('活动', `奶茶热销中: [互动请求] gid=${gid} type=${interactType} ` +
        `payload=${payload.toString('hex')} (${payload.length}B)`, { module: 'activity', event: '奶茶热销中', result: 'info' });
    const r = await mainOperate(CMD_WORK_INTERACT, 170, payload);
    if (!r.ok) {
        log('活动', `奶茶热销中: [互动应答] code=${r.errorCode} reason=${String(r.reason || '').slice(0, 60)} ` +
            `raw=${String(r.resultHex || '').slice(0, 120) || '(空)'}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
    }
    if (r.errorCode === 1034147) {
        if (shiftKey) interactCooldown.set(shiftKey, Date.now() + INTERACT_COOLDOWN_MS);
        trimOldestEntries(interactCooldown, 50);
        return {
            ok: false,
            skipped: true,
            reason: `本班暂不可互动(${r.reason || 'code=1034147'}), 本地冷却 10 分钟后重试`,
            diag: workDiag(w),
            hasEmployer: true,
            shiftKey,
        };
    }
    if (!r.ok) {
        return {
            ok: false,
            reason: `互动失败 ${r.reason || `code=${r.errorCode}`}`,
            diag: workDiag(w),
            hasEmployer: true,
            shiftKey,
        };
    }
    let result = null;
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            const effect7 = findField(rf, 7);
            const effect8 = findField(rf, 8);
            const effect8Fields = effect8 && effect8.w === 2 ? parseTop(effect8.v) : [];
            const changeField = findField(effect8Fields, 3);
            const before = toInt(w.wage) || 0;
            const change = changeField ? toInt(changeField.v) : null;
            const snapshot = (field) => {
                if (!field || field.w !== 2) return null;
                const out = {};
                for (const x of parseTop(field.v)) {
                    out[x.f] = x.w === 0 ? toInt(x.v) : Buffer.from(x.v || []).toString('hex');
                }
                return out;
            };
            result = {
                type: toInt((findField(rf, 1) || {}).v),
                titleId: toInt((findField(rf, 4) || {}).v),
                wage: change === null
                    ? null
                    : {
                        before: before > 0 ? before : null,
                        after: before > 0 ? before + change : null,
                        change,
                    },
                effects: {
                    field7: snapshot(effect7),
                    field8: snapshot(effect8),
                },
            };
        } catch (e) { /* 忽略 */ }
    }
    const wageTxt = result && result.wage && result.wage.change !== null
        ? `, 工资${result.wage.before !== null ? ` ${result.wage.before}→${result.wage.after}` : ''}` +
          `(${result.wage.change >= 0 ? '+' : ''}${result.wage.change})`
        : '';
    log('活动', `奶茶热销中: 已与好友 ${gid} 互动(${interactNameOf(interactType)}${wageTxt})`, {
        module: 'activity', event: '奶茶热销中', result: 'ok', friendGid: gid, type: interactType,
    });
    rememberCompletedShift(shiftKey);
    return {
        ok: true,
        friendGid: gid,
        interact: result,
        hasEmployer: true,
        shiftKey,
        interactionCompleted: true,
    };
}

/**
 * 领工资(cmd=64) —— 当前班次有可领取工资时在【我的工作】里领取
 * 实测(20261016-080455 idx=127): 请求 #169 = ""; 响应 = {#1: {#1: 1041(奶茶券), #2: 120}, #2: 2}
 * 另有多笔班次仍在进行中的成功记录，因此不能用 #168.#1.#7(endAt) 阻止领取。
 */
let claimWageInFlight = null;

async function claimWage() {
    if (claimWageInFlight) return claimWageInFlight;
    const task = claimWageOnce();
    claimWageInFlight = task;
    try {
        return await task;
    } finally {
        if (claimWageInFlight === task) claimWageInFlight = null;
    }
}

async function claimWageOnce() {
    const work = await getWorkStatus().catch(() => null);
    if (!work || !work.ok) {
        return {
            ok: false,
            skipped: true,
            reason: `无法确认当前兼职状态(cmd63 查询失败), 跳过领工资${work && work.reason ? `: ${work.reason}` : ''}`,
            hasEmployer: false,
            shiftKey: 0,
        };
    }
    if (!work.hasEmployer) {
        return {
            ok: false,
            skipped: true,
            reason: '当前没有进行中的兼职(未被雇佣), 跳过领工资',
            hasEmployer: false,
            shiftKey: 0,
        };
    }
    const r = await mainOperate(CMD_CLAIM_WAGE, 169, Buffer.alloc(0));
    if (!r.ok) return { ok: false, reason: `领工资失败 ${r.reason || `code=${r.errorCode}`}` };
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

/**
 * 解析"我的工作"信息 —— 来自**刷新(cmd=63)的结果 #168**(权威来源, 实测 2026-10-16):
 *   #168.#1 = 本次兼职(进行中): #1 = {gid, 名字} = **当前老板**, #2 店名, #3 班次id,
 *             #4/#5 我的特长, #6/#7 班次起止, #11 工资, #12 = 本班最近一次互动记录,
 *             #13 = {#1 已完成班次, #2 累计奖金}
 *   #168.#2 = 兼职记录(历史, repeated)   #168.#3/#4 = 我的特长 id/名称
 * ⚠ 互动(cmd=65)要传的 gid = 这里 #1.#1.#1(当前老板); 别从收银台详情(55)的历史记录取(踩过, 取到旧班次)
 */
function parseWorkFromRefresh(resultHex) {
    const out = {
        ok: false,
        hasEmployer: false,
        employer: null,
        storeName: '',
        startAt: 0,
        endAt: 0,
        wage: 0,
        bonus: 0,
        titleId: 0,
        titleName: '',
        records: [],
        active: false,
        lastInteraction: null,
        interactionStatus: 0,
        interactionCompleted: false,
    };
    if (!resultHex) {
        // cmd63 成功但 #168 为空 = 当前没有兼职，不是查询失败。
        out.ok = true;
        return out;
    }
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
                // ⚠ #168.#1 = **我的老板(雇佣我的人)** = 互动目标
                //    确证(2026-10-16 13:07 原账号抓包): 互动请求的 #170.#1 = 1226530474,
                //    而该 gid 在 #168 里**只**出现在 #1#1(= '你玩得像蔡徐坤一样', 用户确认"被他雇佣"),
                //    #2 记录里是南桉(历史班次)。⇒ 互动目标 = #168.#1, 不是 #2[0]
                if (gid > 0) out.employer = { gid, name: nm ? String(nm) : '' };
            }
            const store = (findField(c, 2) || {}).v;
            out.storeName = store ? String(store) : '';
            out.startAt = toInt((findField(c, 6) || {}).v);
            out.endAt = toInt((findField(c, 7) || {}).v);
            out.wage = toInt((findField(c, 11) || {}).v);
            // #12 = 本班互动记录: #1 类型, #2 次数(部分响应缺省), #3 特长id, #4 时间。
            // 每班只能互动一次，因此当前班次只要出现 #12 就按已完成处理。
            const t12 = findField(c, 12);
            if (t12 && t12.w === 2) {
                const f12 = parseTop(t12.v);
                out.lastInteraction = {
                    type: toInt((findField(f12, 1) || {}).v),
                    count: toInt((findField(f12, 2) || {}).v),
                    titleId: toInt((findField(f12, 3) || {}).v),
                    at: toInt((findField(f12, 4) || {}).v),
                };
            }
            const t13 = findField(c, 13);
            if (t13 && t13.w === 2) out.bonus = toInt((findField(parseTop(t13.v), 2) || {}).v);
            // 抓包闭环: 本班互动前 #9 缺省/0；互动成功后 #9=1 且写入 #12；
            // 班次进入历史后 #9=2。当前只能确认 #12 是互动记录，不能把 #9 的
            // 生命周期值直接当成“已互动”，否则 #9=2 的已结束班次会被误显示为已互动。
            out.interactionStatus = toInt((findField(c, 9) || {}).v);
            out.interactionCompleted = !!out.lastInteraction;
            // "进行中的班次" = 有本次兼职 && (没给结束时间 或 现在还没到结束时间)
            // active = 有当前老板(兼职记录第一条存在) —— ⚠ 不用记录的时间窗口判断:
            // 实测 09:04 那次, 记录的 endAt 已过但互动仍成功(服务端有自己的判定), 用窗口会误杀
            out.hasEmployer = !!out.employer;
            out.active = out.hasEmployer;
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
            if (gid2 > 0) {
                // 每条兼职记录: #2 店名 / #4,#5 起止 / #6 工作时长。
                // #7/#10 的业务语义尚未由抓包闭环，保留原始字段供后续核对。
                const w7 = findField(r2, 7);
                const w7f = w7 && w7.w === 2 ? parseTop(w7.v) : [];
                const i10 = findField(r2, 10);
                const i10f = i10 && i10.w === 2 ? parseTop(i10.v) : [];
                out.records.push({
                    gid: gid2,
                    name: nm2 ? String(nm2) : '',
                    storeName: String((findField(r2, 2) || {}).v || ''),
                    startAt: toInt((findField(r2, 4) || {}).v),
                    endAt: toInt((findField(r2, 5) || {}).v),
                    workSeconds: toInt((findField(r2, 6) || {}).v),
                    historyField7: rawFieldSnapshot(w7f),
                    historyField10: rawFieldSnapshot(i10f),
                });
            }
        }
        out.ok = true;
    } catch (e) { /* 忽略 */ }
    // #2 = 兼职历史记录(老板/时长及未闭环字段), 仅用于展示, **不覆盖** employer
    return out;
}

/** 实时查询“我的工作”状态；唯一权威来源是 cmd63/#168。 */
async function getWorkStatus() {
    await throttle();
    const r = await operateSafe(GROUP_MAIN, CMD_REFRESH, 168, Buffer.alloc(0));
    if (!r.ok) {
        return {
            ...parseWorkFromRefresh(''),
            ok: false,
            reason: `查询兼职状态失败 ${r.reason || `code=${r.errorCode}`}`,
        };
    }
    const work = parseWorkFromRefresh(r.resultHex);
    if (!work.ok) return { ...work, reason: '兼职状态为空或解析失败' };
    if (work.hasEmployer && work.startAt && interactCompletedShifts.has(work.startAt)) {
        work.interactionCompleted = true;
    }
    return work;
}

/**
 * 员工/雇佣面板(cmd=56) —— 结果 #161:
 *   请求 #1 = selector(普通列表实测为 1)
 *   #1 响应 selector(与请求一致, 抓包见过 1/3), #2/#3 业务语义尚未闭环
 *   #4 = **好友员工列表**(repeated): #1 = {gid, 昵称, 等级}, #3/#4 = 该员工特长(9001 金牌销售…),
 *        #5 状态(1=在岗), #6 换班/下班时间, #7 上一班次
 *   #5 = NPC 店员(101 实习员工 / 102 …)
 * 用途: 雇佣好友时标出可雇佣性(避免 1034140 该雇佣位已有员工在工作)。
 * 注意: #4 列表里包含非本人雇佣的好友, 不能当员工总数。
 */
/** 兼容销量页：复用配方菜单缓存，返回"品类 id → 名字"。 */
async function getMenuNames(force = false) {
    await getMenuRecipes(force);
    return menuRecipesCache.names;
}

/** 兼容旧调用名；营业记录统一走 cmd=67/#172，传入北京时间当日 00:00。 */
async function getSalesRecords(dayTs) {
    return getSalesRecord(dayTs);
}

async function getEmployees() {
    const r = await mainOperate(CMD_EMPLOYEES, 161, encodeVarintField(1, 1));
    if (!r.ok && r.errorCode !== 0) return { ok: false, reason: r.reason || `员工列表失败 code=${r.errorCode}` };
    const friends = [];
    const npcs = [];
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            for (const x of rf) {
                if (x.w !== 2) continue;
                if (x.f === 4) {
                    const e = parseTop(x.v);
                    const info = findField(e, 1);
                    const fi = info && info.w === 2 ? parseTop(info.v) : [];
                    const gid = toInt((findField(fi, 1) || {}).v);
                    const nm = (findField(fi, 2) || {}).v;
                    // ⚠ 昵称可能是特殊字符(emoji 等), toString('utf8') 必须加 encoding 参数
                    //    (踩过: Buffer→String 不传 encoding 会按 latin1 解, 昵称变乱码)
                    const name = nm ? Buffer.from(nm).toString('utf8') : `GID:${gid}`;
                    const titleId = toInt((findField(e, 3) || {}).v);
                    const title = (findField(e, 4) || {}).v;
                    friends.push({
                        gid,
                        name,
                        level: toInt((findField(fi, 4) || {}).v),
                        titleId,
                        titleName: title ? Buffer.from(title).toString('utf8') : (EMPLOYEE_SKILLS[titleId] || ''),
                        state: toInt((findField(e, 5) || {}).v),
                        offAt: toInt((findField(e, 6) || {}).v),
                    });
                } else if (x.f === 5) {
                    const e = parseTop(x.v);
                    const info = findField(e, 1);
                    const fi = info && info.w === 2 ? parseTop(info.v) : [];
                    const npcTitle = (findField(e, 4) || {}).v;
                    const npcName = (findField(fi, 2) || {}).v;
                    npcs.push({
                        id: toInt((findField(fi, 1) || {}).v),
                        name: npcName ? Buffer.from(npcName).toString('utf8') : '',
                        titleName: npcTitle ? Buffer.from(npcTitle).toString('utf8') : '',
                    });
                }
            }
            return {
                ok: true,
                selector: toInt((findField(rf, 1) || {}).v),
                field2: toInt((findField(rf, 2) || {}).v),
                field3: toInt((findField(rf, 3) || {}).v),
                friends,
                npcs,
            };
        } catch (e) {
            return { ok: false, reason: `解析员工列表失败: ${e.message}` };
        }
    }
    return { ok: true, selector: 0, field2: 0, field3: 0, friends, npcs };
}

/** 等级 3 起有两个员工位；低等级只有 1 个。 */
function employeeCapacityForLevel(level) {
    return toInt(level) >= 3 ? 2 : 1;
}

/** 收银台 #160.#9 的当前员工记录，附带按真实时间计算的在岗状态。 */
async function getHiringAvailability() {
    const detail = await getCashierDetail();
    if (!detail || !detail.ok) {
        return { ok: false, reason: (detail && detail.reason) || '收银台详情不可用', currentEmployees: [] };
    }
    const currentEmployees = Array.isArray(detail.currentEmployees)
        ? detail.currentEmployees
        : decorateCashierEmployees(detail.employees || []);
    const employeeCapacity = detail.employeeCapacity || employeeCapacityForLevel(detail.level);
    return {
        ok: true,
        level: detail.level,
        employeeCapacity,
        employeeCount: currentEmployees.length,
        available: Math.max(0, employeeCapacity - currentEmployees.length),
        currentEmployees,
        currentGids: new Set(currentEmployees.map((e) => toInt(e.gid)).filter((gid) => gid > 0)),
        at: detail.at,
    };
}

function publicHiringState(hiring) {
    return {
        level: hiring.level,
        employeeCapacity: hiring.employeeCapacity,
        employeeCount: hiring.employeeCount,
        available: hiring.available,
        currentEmployees: hiring.currentEmployees || [],
        at: hiring.at,
    };
}

/** 自动雇佣返回补位前后的员工占位，界面和任务日志可直接展示最终状态。 */
function publicAutoHireState(hiring, hiredCount = 0) {
    const initialEmployeeCount = toInt(hiring.employeeCount);
    const employeeCapacity = toInt(hiring.employeeCapacity);
    const hired = Math.max(0, toInt(hiredCount));
    const finalEmployeeCount = Math.min(employeeCapacity, initialEmployeeCount + hired);
    return {
        ...publicHiringState(hiring),
        initialEmployeeCount,
        employeeCount: finalEmployeeCount,
        finalEmployeeCount,
        available: Math.max(0, employeeCapacity - finalEmployeeCount),
    };
}

/** 兼容旧调用: 返回当前员工全量；onDuty 字段区分在岗/已下班。 */
async function getOnDutyEmployees(detail) {
    const d = arguments.length > 0 ? detail : await getCashierDetail();
    if (!d || !d.ok) return { ok: false, reason: (d && d.reason) || '收银台详情不可用', employees: [] };
    const employees = Array.isArray(d.currentEmployees)
        ? d.currentEmployees
        : decorateCashierEmployees(d.employees || []);
    const onDutyEmployees = employees.filter((x) => x.onDuty);
    const employeeCapacity = d.employeeCapacity || employeeCapacityForLevel(d.level);
    return {
        ok: true,
        employees,
        currentEmployees: employees,
        onDutyEmployees,
        employeeCapacity,
        employeeCount: employees.length,
        onDutyEmployeeCount: onDutyEmployees.length,
        at: d.at,
    };
}

/** 从 repeated {#1 物品id, #2 数量} 里取出全部条目(带物品名) */
function parseItemEntries(inner, fieldNo) {
    const out = [];
    for (const x of inner || []) {
        if (x.f !== fieldNo || x.w !== 2) continue;
        const e = parseTop(x.v);
        const id = toInt((findField(e, 1) || {}).v);
        if (!id) continue;
        const count = toInt((findField(e, 2) || {}).v);
        out.push({ id, count, name: itemLabel(id, count) });
    }
    return out;
}

/** 解析 #160.#1 里的员工(#9): 17 位班次 UID 必须按字符串保存, 否则 JS number 会丢精度 */
function parseCashierEmployees(inner) {
    const out = [];
    for (const x of inner || []) {
        if (x.f !== 9 || x.w !== 2) continue;
        const e = parseTop(x.v);
        const info = findField(e, 11);
        const fi = info && info.w === 2 ? parseTop(info.v) : [];
        const gid = toInt((findField(fi, 1) || {}).v);
        const nm = (findField(fi, 2) || {}).v;
        const shiftUid = (findField(e, 3) || {}).v;
        const titleId = toInt((findField(e, 7) || {}).v);
        const titleName = (findField(e, 8) || {}).v;
        const typeField = findField(e, 1);
        const typeValue = typeField ? toInt(typeField.v) : null;
        const isFriend = typeValue === 1;
        const isNpc = typeValue === 0;
        out.push({
            // ⚠ 17 位 UID 直接 toInt 会丢精度; 存字符串 + 数字各一份(比较用字符串)
            shiftUid: shiftUid === undefined ? '' : String(shiftUid),
            gid,
            name: nm ? Buffer.from(nm).toString('utf8') : `GID:${gid}`,
            level: toInt((findField(fi, 4) || {}).v),
            startAt: toInt((findField(e, 4) || {}).v),
            endAt: toInt((findField(e, 5) || {}).v),
            wage: toInt((findField(e, 6) || {}).v),
            titleId,
            titleName: titleName ? Buffer.from(titleName).toString('utf8') : (EMPLOYEE_SKILLS[titleId] || ''),
            // 抓包里另一条已下班好友同样缺少 #1；缺失时只能记为 unknown。
            employeeType: isFriend ? 'friend' : (isNpc ? 'npc' : 'unknown'),
            isFriend,
            isNpc,
        });
    }
    return out;
}

function decorateCashierEmployees(employees) {
    const nowSec = Math.floor(Date.now() / 1000);
    return (employees || []).map((x) => ({
        ...x,
        remainSeconds: x.endAt > nowSec ? x.endAt - nowSec : 0,
        onDuty: x.endAt > nowSec,
    }));
}

/**
 * 收银台详情(cmd=55) —— **查询**用, 它不会发放任何东西(别当领取用, 踩过)
 * #160.#1: #1 等级, #2 累计营业额, #3 下一级门槛, #4=172800, #22/#24 当日累计杯数,
 *          #9 repeated 当前在岗员工, #10 repeated 当日品类销量,
 *          #19 repeated **待领取**收益, #23 repeated **长期累计**收益, #25 repeated 累计品类销量
 * 2026-10-18 逐帧对照: 领取前 #19=[券585,金837609] → cmd59 到账 #164=[券585,金837609]
 *   → 领取后 #19=[]; 期间 #23 恒为 [券2250,金2908400](= cmd60/#165 的 #2/#3)。
 */
async function getCashierDetail() {
    const r = await mainOperate(CMD_CASHIER_DETAIL, 160, Buffer.alloc(0));
    if (!r.ok) return { ok: false, reason: `收银台详情失败 ${r.reason || `code=${r.errorCode}`}` };
    if (!r.resultHex) return { ok: false, reason: '收银台详情无结果体' };
    const out = {
        ok: true,
        level: 0,
        revenue: 0,
        nextLevelRevenue: 0,
        field4: 0,
        referenceValue: 0,
        todayCups: 0,
        pending: [],
        pendingCount: 0,
        total: [],
        employees: [],
        todaySales: [],
        totalSales: [],
        at: Date.now(),
    };
    try {
        const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
        const box = findField(rf, 1);
        if (!box || box.w !== 2) throw new Error('缺少 #160.#1 容器');
        const inner = parseTop(box.v);
        if (!findField(inner, 1)) throw new Error('缺少 #160.#1.#1 等级字段');
        out.level = toInt((findField(inner, 1) || {}).v);
        out.revenue = toInt((findField(inner, 2) || {}).v);
        out.nextLevelRevenue = toInt((findField(inner, 3) || {}).v);
        out.field4 = toInt((findField(inner, 4) || {}).v);
        out.referenceValue = out.field4;
        out.todayCups = toInt((findField(inner, 22) || {}).v) || toInt((findField(inner, 24) || {}).v);
        out.pending = parseItemEntries(inner, 19);
        out.total = parseItemEntries(inner, 23);
        out.employees = decorateCashierEmployees(parseCashierEmployees(inner));
        out.pendingCount = out.pending.length;
        out.todaySales = parseSalesByKind(inner, 10);
        out.totalSales = parseSalesByKind(inner, 25);
    } catch (e) {
        return { ok: false, reason: `解析收银台详情失败: ${e.message}` };
    }
    out.pendingRewards = out.pending;
    out.longTermRewards = out.total;
    out.hasPending = out.pending.length > 0;
    out.currentEmployees = out.employees;
    out.employeeCapacity = employeeCapacityForLevel(out.level);
    out.employeeCount = out.currentEmployees.length;
    out.onDutyEmployeeCount = out.currentEmployees.filter((x) => x.onDuty).length;
    return out;
}

/** #10 当日品类销量 / #25 累计品类销量: {#1 品类id, #2 杯数} */
function parseSalesByKind(inner, fieldNo) {
    const out = [];
    for (const x of inner || []) {
        if (x.f !== fieldNo || x.w !== 2) continue;
        const e = parseTop(x.v);
        const id = toInt((findField(e, 1) || {}).v);
        const cups = toInt((findField(e, 2) || {}).v);
        if (id) out.push({ id, cups });
    }
    return out;
}

/**
 * 收银台查询(cmd=60): 返回待领取收益等。规则说"满载会暂停营业且不补发", 所以顶部要显示待领。
 * 实测结果 #1 = {#1: 容量(40), #2: 当前待领(253), #3: 累计杯数(164312)}
 */
async function getCashierStatus() {
    const r = await mainOperate(CMD_CASHIER_INFO, undefined, encodeUint1(1));
    if (!r.ok) return { ok: false, reason: `收银台查询失败 ${r.reason || `code=${r.errorCode}`}` };
    const out = { ok: true, todayCups: 0, couponTotal: 0, goldTotal: 0 };
    if (r.resultHex) {
        try {
            const rf = parseTop(Buffer.from(r.resultHex, 'hex'));
            out.todayCups = toInt((findField(rf, 1) || {}).v);
            out.couponTotal = toInt((findField(rf, 2) || {}).v);
            out.goldTotal = toInt((findField(rf, 3) || {}).v);
        } catch (e) {
            return { ok: false, reason: `解析收银台查询失败: ${e.message}` };
        }
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

/** 批量雇佣: 只补当前空位；满员时不发送 cmd57。 */
async function hireAll(hireGids, limit = 10, duration = 1) {
    const list = [...new Set((Array.isArray(hireGids) ? hireGids : []).map((g) => toNum(g)).filter((g) => g > 0))];
    if (!list.length) return { ok: false, reason: '未选择好友' };
    const hiring = await getHiringAvailability().catch((e) => ({ ok: false, reason: e.message }));
    if (!hiring.ok) {
        return { ok: false, skipped: true, reason: `无法确认员工容量，跳过雇佣: ${hiring.reason}` };
    }
    if (hiring.available <= 0) {
        return {
            ok: true,
            skipped: true,
            hired: 0,
            total: 0,
            results: [],
            reason: `员工已满(${hiring.employeeCount}/${hiring.employeeCapacity})`,
            ...publicHiringState(hiring),
        };
    }
    const candidates = list
        .filter((gid) => !hiring.currentGids.has(gid))
        .slice(0, Math.min(Math.max(1, toInt(limit) || 10), hiring.available));
    if (!candidates.length) {
        return {
            ok: true,
            skipped: true,
            hired: 0,
            total: 0,
            results: [],
            reason: '白名单中的好友已是当前员工',
            ...publicHiringState(hiring),
        };
    }
    const dur = normalizeHireDuration(duration);
    const results = [];
    let okCount = 0;
    for (const gid of candidates) {
        if (okCount >= hiring.available) break;
        const r = await hireFriend(gid, dur, { skipCapacityCheck: true }).catch((e) => ({ ok: false, reason: e.message }));
        results.push({ gid, ok: !!(r && r.ok), reason: (r && r.reason) || '' });
        if (r && r.ok) okCount += 1;
        await sleep(700);   // 节流: 避免把游戏请求队列打满(满了会心跳异常掉线)
    }
    log('活动', `奶茶热销中: 批量雇佣 ${okCount}/${candidates.length} 成功（员工 ${hiring.employeeCount + okCount}/${hiring.employeeCapacity}）`, {
        module: 'activity', event: '奶茶热销中', result: okCount ? 'ok' : 'warn',
    });
    return {
        ok: okCount > 0,
        hired: okCount,
        total: candidates.length,
        results,
        employeeCapacity: hiring.employeeCapacity,
        employeeCount: hiring.employeeCount + okCount,
    };
}

/**
 * 统一封装活动请求 —— ⚠ 关键: network 层遇到游戏错误码是 **抛异常**(new Error('gamepb... 错误: code=NNN ...')),
 * 直接 `const r = await operateRaw(...)` 再判断 `r.errorCode` 是**永远不成立的**(异常穿透) —— 踩过。
 * 这里统一 try/catch, 转成 { errorCode, ok, reason(已压短) }, 让所有调用点能正常处理错误。
 */
async function operateSafe(groupId, cmd, payloadField, payloadBytes) {
    try {
        const r = await operateRaw(groupId, cmd, payloadField, payloadBytes);
        const code = toInt(r.errorCode);          // ⚠ 必须 toInt: toNum 对字符串会原样返回 → 数字比较失效
        const reason = code === 0 ? '' : `code=${code}`;
        return { ...r, errorCode: code, ok: code === 0, reason, rawReason: reason };
    } catch (e) {
        const m = String((e && e.message) || '');
        const code = toInt((m.match(/code=(\d+)/) || [])[1]);   // ⚠ 必须 toInt(踩过: toNum 返回字符串)
        return {
            errorCode: code,
            resultFieldNo: 0,
            resultHex: '',
            activity: null,
            ok: false,
            reason: shortErr(m),
            rawReason: shortErr(m, 240),
            thrown: true,
        };
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
/** 互动类型名(与 WORK_INTERACT_OPTIONS 一致) */
function interactNameOf(type) {
    const hit = WORK_INTERACT_OPTIONS.find((o) => o.id === toInt(type));
    return hit ? hit.name : `type=${toInt(type)}`;
}

/** 互动判定用的诊断串(短), 用于日志里一眼看清各判据的实际取值 */
function workDiag(w) {
    const last = w && w.lastInteraction;
    return `当前${(w && w.employer && w.employer.gid) || 0} ` +
        `班次${(w && w.startAt) || 0}-${(w && w.endAt) || 0} ` +
        `最近互动=${last ? `type${last.type}/count${last.count}/at${last.at}` : '无'}`;
}

/** 已被服务端判定"本班不能互动"的班次(按班次开始时间记, 本班内不再重试) */
/**
 * 员工特长(实测 id↔名): 9001 金牌销售 / 9002 金牌宣传 / 9003 金牌服务 / 9004 默默搬砖(NPC)
 * 雇佣优先级: 销售 > 宣传 > 服务 (默认; 可被 opts.hireSkillOrder 覆盖)
 */
const EMPLOYEE_SKILLS = { 9001: '金牌销售', 9002: '金牌宣传', 9003: '金牌服务', 9004: '默默搬砖' };
const DEFAULT_HIRE_SKILL_ORDER = [9001, 9002, 9003];

/**
 * 雇佣班次档位(请求 #162.#1.#2, 2026-10-18 抓包)
 * 只有 #2=1 有证据: 雇佣应答 #162.#1.#5 的 #5-#4 = 1792302712-1792288312 = 14400s = 4 小时。
 * 12/24 小时档位值**没有抓到**, 不猜 → 非法值一律回落 1。
 */
const HIRE_DURATIONS = [
    { id: 1, label: '4 小时', seconds: 14400, confirmed: true },
];
function normalizeHireDuration(d) {
    const id = toInt(d);
    return HIRE_DURATIONS.some((x) => x.id === id) ? id : 1;
}

/** 步骤之间的固定间隔(实测: 客户端每个动作之间都有明显间隔; 统一 1.2~1.8s 抖动) */
const STEP_GAP_MIN_MS = 1200;
const STEP_GAP_MAX_MS = 1800;
function stepGap() {
    const ms = STEP_GAP_MIN_MS + Math.floor(Math.random() * (STEP_GAP_MAX_MS - STEP_GAP_MIN_MS));
    return sleep(ms);
}

let lastSeedBuyDay = '';
let interactSkipLoggedKey = '';   // 已记录过"本班暂不可互动"的班次(避免每 10 分钟刷一条)
const interactCooldown = new Map();   // 班次key → 下次可尝试时间(只在服务端返回 1034147 后写 10 分钟)
const interactCompletedShifts = new Set(); // 成功互动后的进程内兜底；权威状态以 #168.#1.#12 为准
// 实测(2026-10-16 23:05): 同一班次同一 payload, 距班次开始 5 分钟被拒(1034147)、17 分钟成功
// → 互动需等班次开始一段时间后才解锁(阈值协议里没有字段), 因此用"班次内定期重试"代替猜阈值
const INTERACT_COOLDOWN_MS = 10 * 60 * 1000;
const HIRE_BACKOFF_MS = 30 * 60 * 1000;

function trimOldestEntries(map, maxSize) {
    while (map.size > maxSize) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
    }
}

function rememberCompletedShift(shiftKey) {
    if (!shiftKey) return;
    interactCompletedShifts.add(shiftKey);
    trimOldestEntries(interactCompletedShifts, 50);
}
function isHireAlreadyError(msg) {
    const t = String(msg || '');
    // 关键词 或 错误码(1034140 = 该雇佣位已有员工在工作; 压短后中文可能丢失, 所以必须匹配码)
    return /已存在|已有|上限|已满|只能|重复|1034140/.test(t);
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
    if (!st.ok) {
        // ⚠ 以前这里是静默 return → 出问题时看不到任何日志, 表现为"自动流程不触发"
        log('活动', `奶茶热销中: 刷新活动状态失败, 跳过本轮(${shortErr(st.reason)})`, {
            module: 'activity', event: '奶茶热销中', result: 'warn',
        });
        return { ok: false, reason: st.reason };
    }
    out.state = st;
    if (isSettling(st)) {
        log('活动', '奶茶热销中: 已进入结算期(11/15–11/16), 跳过自动经营', { module: 'activity', event: '奶茶热销中', result: 'skip' });
        return { ok: true, skipped: true, reason: '结算期, 已停止经营', state: st };
    }

    if (!st.opened && opts.openStore !== false) {
        const r = await openStore(opts.storeName);
        out.steps.push({ step: 'openStore', ...r });
        await stepGap();
        st = await getMainStatus().catch(() => st);
    }
    if (doCashier) {
        const r = await claimCashier();
        out.steps.push({ step: 'cashier', ...r });
        await stepGap();
    }
    if (doCraft) {
        const r = await craftAllFruits();   // 自动 = 把背包里所有活动果实都做掉
        out.steps.push({ step: 'craft', ...r });
        await stepGap();
    }
    if (doSpeaker) {
        const r = await useSpeaker();
        out.steps.push({ step: 'speaker', ...r });
        await stepGap();
    }
    // 每日兑换种子(一天一次; 日期用状态里的服务器时间算, 取不到才用本地)
    if (opts.autoBuySeed) {
        const dayKey = (() => {
            const t = toInt(st && st.at) > 0 ? toInt(st.at) : Math.floor(Date.now() / 1000);
            const d = new Date((t + 8 * 3600) * 1000);
            return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
        })();
        if (lastSeedBuyDay !== dayKey) {
            const r = await buyDailySeeds(opts.seedBuyCount || 1);
            out.steps.push({ step: 'buyDailySeeds', ...r });
            // 只有"确实买到"或"服务端说今天已买过"才标记当天完成;
            // 其它失败**不标记**, 下一轮继续试(用户要求: 第一次失败不能标记)
            if (r.ok || r.alreadyDone) {
                lastSeedBuyDay = dayKey;
                if (r.alreadyDone) {
                    log('活动', `奶茶热销中: 今天已买过森野黄金芽种子, 当天不再尝试`, { module: 'activity', event: '奶茶热销中', result: 'skip' });
                }
            }
            await stepGap();
        } else {
            out.steps.push({ step: 'buyDailySeeds', ok: false, skipped: true, reason: `今天(${dayKey})已兑换过` });
        }
    }


    // 互动/领工资都由各自函数在动作前实时查询 cmd63/#168；这里不再使用初始化状态里的旧班次。
    if (opts.autoInteract) {
        const r = await interactWithFriend(opts.interactType).catch((e) => ({ ok: false, reason: e.message }));
        out.steps.push({ step: 'autoInteract', ...r });
        if (r.ok) {
            interactSkipLoggedKey = '';
        } else if (r.skipped && r.interactionCompleted) {
            // 本班成功互动后，后续轮次会持续返回该状态；成功日志已经记录过，不再重复提示。
        } else if (r.skipped) {
            // 每个班次只记一条(之后安静重试), 避免每 10 分钟刷一条
            const key = r.shiftKey ? `shift:${r.shiftKey}` : (r.hasEmployer ? 'active-unknown' : 'no-employer');
            if (key !== interactSkipLoggedKey) {
                interactSkipLoggedKey = key;
                log('活动', `奶茶热销中: 自动互动暂不可用 — ${r.reason}${r.diag ? ` [${r.diag}]` : ''}`, {
                    module: 'activity', event: '奶茶热销中', result: 'skip',
                });
            }
        } else {
            log('活动', `奶茶热销中: 自动互动未执行 — ${r.reason}${r.diag ? ` (${r.diag})` : ''}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
        }
        await sleep(700);
    }
    // 自动升级店铺(条件来自服务端: 营业额 >= 下一级所需)
    if (opts.autoUpgrade) {
        const r = await upgradeStore().catch((e) => ({ ok: false, reason: e.message }));
        out.steps.push({ step: 'upgradeStore', ...r });
        if (!r.ok && !r.skipped) {
            log('活动', `奶茶热销中: 店铺升级未成功 — ${shortErr(r.reason)}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
        }
        await stepGap();
    }
    // 自动领兼职工资: 独立开关(opts.autoWage); claimWage 自己实时查询当前班次。
    if (opts.autoWage !== false) {
        const r = await claimWage().catch((e) => ({ ok: false, reason: e.message }));
        out.steps.push({ step: 'claimWage', ...r });
        if (!r.ok && !r.skipped) {
            log('活动', `奶茶热销中: 领工资未成功 — ${r.reason}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
        }
        await stepGap();
    }
    if (opts.autoHire && Array.isArray(opts.hireGids) && opts.hireGids.length) {
        if (Date.now() < hireBackoffUntil) {
            out.steps.push({ step: 'autoHire', ok: false, skipped: true, reason: '上次提示雇佣位置已存在, 退避中' });
            return out;
        }
        const r = await autoHire(opts.hireGids, opts);
        out.steps.push({ step: 'autoHire', ...r });
        await stepGap();
        if (!r.ok && isHireAlreadyError(r.reason)) {
            const nowSec = Math.floor(Date.now() / 1000);
            if (r.nextAt && r.nextAt > nowSec) {
                // 真实时间: 按"现有员工最晚下班时间"退避
                hireBackoffUntil = r.nextAt * 1000 + 60000;
                const mins = Math.ceil((r.nextAt - nowSec) / 60);
                const hhmm = new Date(r.nextAt * 1000).toTimeString().slice(0, 5);
                log('活动', `奶茶热销中: 雇佣位被占(最近 ${hhmm} 空出, 约 ${mins} 分钟), 到点后自动重试`, {
                    module: 'activity', event: '奶茶热销中', result: 'skip',
                });
            } else {
                hireBackoffUntil = Date.now() + HIRE_BACKOFF_MS;
                log('活动', `奶茶热销中: 雇佣位已有员工/已满(未取到空出时间, 本地暂缓 30 分钟)`, {
                    module: 'activity', event: '奶茶热销中', result: 'skip',
                });
            }
            return out;
        }
        if (r.ok && !r.skipped && r.friendGid) {
            const gids = (Array.isArray(r.friendGids) && r.friendGids.length ? r.friendGids : [r.friendGid])
                .map((gid) => toNum(gid))
                .filter((gid) => gid > 0);
            const staff = r.initialEmployeeCount !== undefined && r.finalEmployeeCount !== undefined && r.employeeCapacity
                ? ` (员工 ${r.initialEmployeeCount}/${r.employeeCapacity} → ${r.finalEmployeeCount}/${r.employeeCapacity})`
                : '';
            log('活动', `奶茶热销中: 已自动补位 ${gids.join('、')}${staff}`, { module: 'activity', event: '奶茶热销中', result: 'ok' });
        } else {
            if (r.skipped) {
                log('活动', `奶茶热销中: 雇佣跳过(${r.reason})`, { module: 'activity', event: '奶茶热销中', result: 'skip' });
            } else {
                log('活动', `奶茶热销中: 自动雇佣未成功 — ${r.reason}`, { module: 'activity', event: '奶茶热销中', result: 'warn' });
            }
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
    CMD_EMPLOYEES,
    CMD_HIRE,
    CMD_MENU,
    CMD_CASHIER_DETAIL,
    CMD_SALES_RECORD,
    CMD_UPGRADE_STORE,
    CMD_CLAIM_CASHIER,
    CMD_CASHIER_INFO,
    CMD_REFRESH,
    CMD_RANKING,
    CMD_WORK_INTERACT,
    CMD_CLAIM_WAGE,
    CMD_SHIFT,
    CMD_RECIPE,
    CMD_SHOP_LIST,
    CMD_SHOP_BUY,
    __testing: {
        parseMainState,
        parseWorkFromRefresh,
        encodeUint1,
        encodeVarint,
        encodeVarintField,
        encodePackedVarints,
        shortErr,
        operateSafe,
        mainOperateCraft,
        getMenuRecipes,
        clearMenuCache,
        getCraftableFruitRecipeMap,
        collectFruitUids,
        getSalesRecords,
        interactWithFriend,
        craftAllFruits,
        useSpeaker,
        getEmployees,
        getCashierDetail,
        getOnDutyEmployees,
        getHiringAvailability,
        employeeCapacityForLevel,
        getWorkStatus,
        clearMainStatusCache,
        HIRE_DURATIONS,
        CRAFT_BATCH_SIZE,
    },
    getMainStatus,
    claimCashier,
    craftMilkTea,
    craftAllFruits,
    claimWage,
    getWorkStatus,
    getCashierDetail,
    parseWorkFromRefresh,
    WORK_INTERACT_OPTIONS,
    interactWithFriend,
    WORK_INTERACT_TYPE,
    getCraftableFruitIds,
    getCraftableFruitRecipeMap,
    getEmployees,
    getSalesRecords,
    getSalesRecord,
    getOnDutyEmployees,
    getCashierEmployees: getOnDutyEmployees,
    HIRE_DURATIONS,
    markShopGoodsSoldOut,
    getUpgradeInfo,
    upgradeStore,
    buyDailySeeds,
    getMenuRecipes,
    getMenuNames,
    useSpeaker,
    openStore,
    hireFriend,
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
