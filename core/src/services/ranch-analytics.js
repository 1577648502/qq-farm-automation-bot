/**
 * 牧场分析 —— 幼崽收益排行(对照 analytics.js 的 getPlantRankings)
 *
 * 农场按「经验/时、普通肥经验/时、净利润/时、普通肥净利润/时」给作物排序;
 * 牧场这边用同样的四个指标, 只是把"生长时间"换成动物的完整周期。
 *
 * ⭐ 与农场的一一对应关系:
 *   农场                         牧场
 *   ────────────────────────────────────────────
 *   growTime(生长时间)           cycleSec(幼崽期 + 成长期 + 成熟期)
 *   harvestExp(收获经验)         AnimalInfo#21 expected_harvest_exp(服务端给)
 *   reduceSec(化肥减少)          普通罐头减 3600 秒(抓包: FeedAnimal 后 #2=3412/3597)
 *   income(毛收益)               整只回收价(成品 type=106 的 price)
 *   seedPrice(种子成本)          幼崽商城价
 *   netProfit = income - 成本    整只回收 − 幼崽价
 *
 * ⭐ 周期数据从哪来(2026-11-19 补齐, 全部有据可查):
 *   官方客户端 mcRes bundle 里有 `mcconfig/MCAnimalConfig`, 含全部 28 种动物的
 *   infant_sec / grow_sec / mature_sec / product_round_sec / max_produce_count /
 *   harvest_exp / produce_exp / product_item / byproduct_item。
 *   (来源: https://cdn-resource.nqf.qq.com/release/remote/mcRes/config.<hash>.json
 *    → import/<uuid>.<ver>.json, 由 scripts/sync-animal-config.js 同步到
 *    core/src/gameConfig/MCAnimalConfig.json)
 *
 *   交叉验证(抓包 GetRanchDetail 的 *_ready_at_ms 差值):
 *     天竺鼠 14400/14400 + 成熟 28800、松鼠 21600/21600 + 43200、
 *     驴     14400/14400 + 28800、牛   21600/21600 + 43200 —— 与配置表逐条吻合。
 *
 *   所以现在**所有 28 种幼崽**都能算出四项指标, 不需要"先养一次"。
 *   抓包样本仍然继续采集, 作为"官方表万一改版"的兜底(见 learnOverrides),
 *   并且**落盘持久化**到 data/ranch-analytics.json —— 之前只存在 worker 内存里,
 *   重启即丢, 分析页就全变成 "-"。
 *
 *   ItemInfo 里确实没有任何时长字段(幼崽 60004 只有 price/level/type/desc…),
 *   所以配置表是唯一的一手来源, 不是编的。
 */
const fs = require('node:fs');
const gameConfig = require('../config/gameConfig');
const { getItemById, getAnimalConfig } = gameConfig;
const { getDataFile } = require('../config/runtime-paths');

/** 普通罐头/桶带来的加速(秒)。抓包: 用 1 个 → 桶剩余 3595~3597, 用 2 个 → 3412~3403 */
const NORMAL_CAN_ADVANCE_SEC = 3600;

/** 持久化文件: 官方表缺失/改版时, 用实际养过的样本兜底; 重启后仍可用 */
const STATE_FILE = getDataFile('ranch-analytics.json');

// ============ 运行时学习(兜底) ============
/** animalId → 各段时长直方图(众数代表常态周期) */
const cycleTable = new Map();
/** animalId → 服务端给的收获经验(#21) */
const learnedExp = new Map();
/** animalId → 服务端给的收获所得(#22) */
const learnedSellValue = new Map();

let loadedFromDisk = false;
let dirty = false;

/** 首次访问时把落盘的学习样本读回来(worker/admin 两个进程都读同一份) */
function ensureLoaded() {
    if (loadedFromDisk) return;
    loadedFromDisk = true;
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        for (const [id, row] of Object.entries(saved.cycles || {})) {
            const n = Number(id) || 0;
            if (n > 0) cycleTable.set(n, row);
        }
        for (const [id, v] of Object.entries(saved.exp || {})) {
            const n = Number(id) || 0;
            if (n > 0 && Number(v) > 0) learnedExp.set(n, Number(v));
        }
        for (const [id, v] of Object.entries(saved.sell || {})) {
            const n = Number(id) || 0;
            if (n > 0 && v && Number(v.value) > 0) learnedSellValue.set(n, v);
        }
    } catch { /* 读不了就当没有(分析照样能用官方表) */ }
}

/**
 * 落盘: 只在内容真的变了才写(调用点是"每次 GetRanchDetail"与"每次学到新值",
 * 频率很低, 文件也就几 KB)。同步写 + 内容去重, 保证重启前一定已经落盘。
 */
let lastWritten = '';
function persistNow() {
    if (!dirty) return;
    try {
        const cycles = {};
        for (const [id, row] of cycleTable) cycles[id] = row;
        const exp = {};
        for (const [id, v] of learnedExp) exp[id] = v;
        const sell = {};
        for (const [id, v] of learnedSellValue) sell[id] = v;
        const payload = `${JSON.stringify({ cycles, exp, sell }, null, 2)}\n`;
        if (payload === lastWritten) {
            dirty = false;
            return;
        }
        fs.mkdirSync(require('node:path').dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, payload);
        lastWritten = payload;
        dirty = false;
    } catch { /* 写不了就丢掉, 不影响运行(官方表才是主数据源) */ }
}

/**
 * 幼崽 id → 成品(可卖) id。
 * 优先用官方 MCAnimalConfig 的 product_item.id(整只回收物);
 * 没收录(活动动物)时退回"同名 + type=106"匹配。
 */
function findGrownItemId(animalId) {
    const id = Number(animalId) || 0;
    const cfg = getAnimalConfig(id);
    const productId = Number(cfg && cfg.product_item && cfg.product_item.id) || 0;
    if (productId > 0) {
        const it = getItemById(productId);
        if (it && Number(it.price) > 0) return productId;
    }
    const cub = getItemById(id);
    if (!cub) return 0;
    const name = String(cub.name || '');
    if (!name) return 0;
    const all = typeof gameConfig.getAllItems === 'function' ? gameConfig.getAllItems() : null;
    if (!Array.isArray(all)) return 0;
    const hit = all.find(it => Number(it.type) === 106 && String(it.name || '') === name);
    return hit ? Number(hit.id) || 0 : 0;
}

/**
 * 成熟动物的整只回收价(金券)。
 * 优先成品(type=106 / MCAnimalConfig.product_item)的 price; 取不到退回幼崽自身 price。
 */
function getGrownValue(animalId) {
    const grownId = findGrownItemId(animalId);
    const pick = (id) => {
        const info = getItemById(Number(id) || 0);
        const price = Number(info && info.price);
        return Number.isFinite(price) && price > 0 ? price : 0;
    };
    const grown = grownId ? pick(grownId) : 0;
    const cub = pick(animalId);
    if (grown > cub) return grown;
    // 配置里没有成品价的动物, 用运行时从服务端学到的 expected_harvest_sells(#22) 兜底
    // —— 那是真实结算价。
    ensureLoaded();
    const learned = Number((learnedSellValue.get(Number(animalId) || 0) || {}).value) || 0;
    if (learned > 0) return learned;
    return cub;
}

/**
 * 记录服务端给的"收获预计所得"(#22)。供配置里缺成品价的动物兜底用。
 */
function rememberSellValue(animalId, itemId, amount) {
    ensureLoaded();
    const id = Number(animalId) || 0;
    const amt = Number(amount) || 0;
    const cur = Number(itemId) || 1007;
    if (id > 0 && amt > 0) {
        learnedSellValue.set(id, { itemId: cur, value: amt });
        dirty = true;
        persistNow();
    }
}

/**
 * 记录服务端给的"收获经验"(#21)。
 * 官方表里也有 harvest_exp, 两者一致(抓包逐条核对); 服务端值优先,
 * 因为活动/变异动物可能不在官方表里。
 */
function rememberHarvestExp(animalId, exp) {
    ensureLoaded();
    const id = Number(animalId) || 0;
    const v = Number(exp) || 0;
    if (id > 0 && v > 0 && learnedExp.get(id) !== v) {
        learnedExp.set(id, v);
        dirty = true;
        persistNow();
    }
}

// ============ 周期时长 ============
/**
 * 从一次 GetRanchDetail 快照里学习各动物的阶段时长。
 *
 * 同一只动物在一帧里同时带着:
 *   infant_ready_at_ms(幼崽结束) / grow_ready_at_ms(成长结束) / mature_ready_at_ms(成熟)
 * 差值就是各段时长 —— 与服务端时钟无关, 所以跨账号/跨时间都可比。
 *
 * ⚠ 这不是主数据源(官方表才是), 只在官方表缺失/改版时兜底。
 *   罐头会直接推进 *_ready_at_ms(抓包: 喂一次普通罐头, 剩余 7025s → 3600s),
 *   所以同一只动物在不同帧里会算出不同"段时长"(鸡的成熟段实测 8/10/12/14 秒),
 *   取**众数**而不是最大值。
 *
 * @param {object} view toRanchView() 的返回
 */
function recordAnimalCycleSamples(view) {
    if (!view || !Array.isArray(view)) return;
    ensureLoaded();
    for (const a of view) {
        const animalId = Number(a.animal_id) || 0;
        if (!animalId) continue;
        const inf = Number(a.infant_ready_at_ms) || 0;
        const gro = Number(a.grow_ready_at_ms) || 0;
        const mat = Number(a.mature_ready_at_ms) || 0;
        if (!inf || !gro) continue;
        const infantSec = Math.round((gro - inf) / 1000);
        const matureSec = mat > gro ? Math.round((mat - gro) / 1000) : 0;
        if (infantSec < 0) continue;
        const prev = cycleTable.get(animalId) || { infantHist: {}, matureHist: {}, n: 0 };
        const bump = (hist, v) => {
            if (!(v > 0)) return hist;
            const key = String(v);
            return { ...hist, [key]: (hist[key] || 0) + 1 };
        };
        cycleTable.set(animalId, {
            infantHist: bump(prev.infantHist || {}, infantSec),
            matureHist: bump(prev.matureHist || {}, matureSec),
            n: (prev.n || 0) + 1,
        });
        dirty = true;
    }
    if (dirty) persistNow();
}

/** 从直方图里取众数(出现次数最多的值); 空/无样本返回 0 */
function modeOf(hist) {
    let best = 0;
    let bestN = -1;
    for (const [k, n] of Object.entries(hist || {})) {
        const v = Number(k);
        if (!(v > 0)) continue;
        if (n > bestN || (n === bestN && v > best)) {
            best = v; bestN = n;
        }
    }
    return best;
}

/** 官方 MCAnimalConfig 算出的完整周期(秒); 没收录返回 null */
function getConfigCycleSec(animalId) {
    const cfg = getAnimalConfig(animalId);
    if (!cfg) return null;
    const infant = Number(cfg.infant_sec) || 0;
    const grow = Number(cfg.grow_sec) || 0;
    const mature = Number(cfg.mature_sec) || 0;
    const total = infant + grow + mature;
    return total > 0 ? total : null;
}

/** 从抓包样本学到的周期(秒); 没有样本返回 null */
function getLearnedCycleSec(animalId) {
    ensureLoaded();
    const r = cycleTable.get(Number(animalId) || 0);
    if (!r) return null;
    const infantSec = modeOf(r.infantHist);
    if (!(infantSec > 0)) return null;
    const matureSec = modeOf(r.matureHist);
    const growSec = infantSec;   // 抓包里幼崽期与成长期等长(官方表亦如此)
    const total = infantSec + growSec + matureSec;
    return total > 0 ? total : null;
}

/**
 * 某动物的完整周期(秒) + 来源。
 *   ① 官方 MCAnimalConfig(权威, 覆盖全部 28 种)
 *   ② 实际养过的抓包样本(兜底: 官方表没收录的新动物)
 *   ③ 都没有 → null(不编造)
 * @returns {{cycleSec:number|null, source:'config'|'learned'|'none', parts?:object}}
 *   周期秒数、数据来源与各段拆分
 */
function getCycleInfo(animalId) {
    const cfg = getAnimalConfig(animalId);
    const configCycle = getConfigCycleSec(animalId);
    if (configCycle) {
        return {
            cycleSec: configCycle,
            source: 'config',
            parts: {
                infantSec: Number(cfg.infant_sec) || 0,
                growSec: Number(cfg.grow_sec) || 0,
                matureSec: Number(cfg.mature_sec) || 0,
                productRoundSec: Number(cfg.product_round_sec) || 0,
            },
        };
    }
    const learned = getLearnedCycleSec(animalId);
    if (learned) return { cycleSec: learned, source: 'learned' };
    return { cycleSec: null, source: 'none' };
}

/** 收获经验: 服务端 #21 优先, 官方表 harvest_exp 兜底 */
function getHarvestExp(animalId) {
    ensureLoaded();
    const id = Number(animalId) || 0;
    const server = Number(learnedExp.get(id)) || 0;
    if (server > 0) return server;
    const cfg = getAnimalConfig(id);
    const conf = Number(cfg && cfg.harvest_exp) || 0;
    return conf > 0 ? conf : 0;
}

/**
 * 完整指标(供 getCubShop / getCubRankings 共用, 口径只有一处)
 *
 * 公式(对照 analytics.js 的 getPlantRankings):
 *   经验/时         = 收获经验 / 周期 * 3600
 *   普通肥经验/时   = 收获经验 / (周期 - 3600) * 3600   ← 普通罐头减 3600 秒
 *   净利润/时       = (整只回收 - 幼崽成本) / 周期 * 3600
 *   普通肥净利润/时 = 同上, 分母换成 (周期 - 3600)
 *
 * @param {number} animalId
 * @param {{cost?:number, grownValue?:number}} [opts] 不传则自行推导
 */
function getAnimalMetrics(animalId, opts = {}) {
    const id = Number(animalId) || 0;
    const cost = Number(opts.cost) || 0;
    const grownValue = opts.grownValue !== undefined ? (Number(opts.grownValue) || 0) : getGrownValue(id);
    const info = getItemById(id);
    const cycle = getCycleInfo(id);
    const out = {
        animalId: id,
        level: Number(info && info.level) || null,
        cost,
        grownValue,
        cycleSec: cycle.cycleSec,
        cycleSource: cycle.source,
        cycleParts: cycle.parts || null,
        harvestExp: 0,
        expPerHour: null,
        fertExpPerHour: null,
        netProfit: grownValue > 0 && cost > 0 ? grownValue - cost : null,
        netProfitPerHour: null,
        fertProfitPerHour: null,
        productRoundSec: Number((getAnimalConfig(id) || {}).product_round_sec) || null,
        maxProduceCount: Number((getAnimalConfig(id) || {}).max_produce_count) || null,
    };

    out.harvestExp = getHarvestExp(id);

    if (cycle.cycleSec && cycle.cycleSec > 0) {
        const fertSec = Math.max(1, cycle.cycleSec - NORMAL_CAN_ADVANCE_SEC);
        const hasCanRoom = cycle.cycleSec > NORMAL_CAN_ADVANCE_SEC;
        if (out.harvestExp > 0) {
            out.expPerHour = Number(((out.harvestExp / cycle.cycleSec) * 3600).toFixed(2));
            out.fertExpPerHour = hasCanRoom
                ? Number(((out.harvestExp / fertSec) * 3600).toFixed(2))
                : null;
        }
        if (out.netProfit !== null) {
            out.netProfitPerHour = Number(((out.netProfit / cycle.cycleSec) * 3600).toFixed(2));
            out.fertProfitPerHour = hasCanRoom
                ? Number(((out.netProfit / fertSec) * 3600).toFixed(2))
                : null;
        }
    }
    return out;
}

/**
 * 由商城幼崽列表算出排行(四项指标与农场同构)。
 * @param {Array} shop getCubShop() 的返回
 * @param {string} sortBy ratio|exp|fert_exp|profit|fert_profit|cost|name|level
 * @returns {Array<object>} 按 sortBy 排序的排行行(含四项指标与周期来源)
 */
function getCubRankings(shop, sortBy = 'ratio') {
    const rows = (Array.isArray(shop) ? shop : []).map((g) => {
        const animalId = Number(g.animalId) || 0;
        const cost = Number(g.price) || 0;
        const grownValue = Number(g.grownValue) || getGrownValue(animalId);
        const ratio = cost > 0 && grownValue > 0
            ? grownValue / cost
            : (Number(g.valueRatio) || 0);
        const netProfit = grownValue > 0 && cost > 0 ? grownValue - cost : null;

        // ⚠ 指标口径只有一处(getAnimalMetrics): 官方表 + 服务端经验,
        //   所以 admin 进程(没有 worker 内存)也能算出全部 28 种, 重启不掉数据。
        const m = getAnimalMetrics(animalId, { cost, grownValue });
        const cubInfo = getItemById(animalId) || {};
        const level = Number(g.level) || Number(cubInfo.level) || m.level || null;

        return {
            goodsId: Number(g.goodsId) || 0,
            animalId,
            name: String(g.name || '') || String(cubInfo.name || ''),
            // 幼崽图标(2026-11-22 用户要求: 所有牧场展示动物的页面都带图)
            image: gameConfig.getItemImageById(animalId) || '',
            level,
            cost,
            grownValue,
            ratio,
            profit: netProfit,
            cycleSec: m.cycleSec,
            cycleSource: m.cycleSource,
            cycleParts: m.cycleParts,
            productRoundSec: m.productRoundSec,
            maxProduceCount: m.maxProduceCount,
            harvestExp: m.harvestExp,
            expPerHour: m.expPerHour,
            normalFertilizerExpPerHour: m.fertExpPerHour,
            profitPerHour: m.netProfitPerHour,
            normalFertilizerProfitPerHour: m.fertProfitPerHour,
            hasCycleData: m.cycleSec !== null,
            limit: Number(g.limit) || 0,
            bought: Number(g.bought) || 0,
            remaining: g.remaining === null || g.remaining === undefined ? null : Number(g.remaining),
            unlocked: !!g.unlocked,
            // 等级门槛(幼崽商店的解锁条件是大农场等级) —— 前端"为什么不能买"要用
            requiredLevel: Number(g.requiredLevel) || 0,
            levelLocked: !!g.levelLocked,
            playerLevel: g.playerLevel ?? null,
            missing: [
                !(grownValue > 0) ? 'price' : null,
                !(m.cycleSec > 0) ? 'cycle' : null,
                !(m.harvestExp > 0) ? 'exp' : null,
            ].filter(Boolean),
        };
    });

    const numDesc = (key) => (a, b) => {
        const av = a[key]; const bv = b[key];
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return bv - av;
    };
    const sorters = {
        ratio: (a, b) => (b.ratio - a.ratio) || (a.cost - b.cost),
        exp: numDesc('expPerHour'),
        fert_exp: numDesc('normalFertilizerExpPerHour'),
        profit: numDesc('profitPerHour'),
        fert_profit: numDesc('normalFertilizerProfitPerHour'),
        cost: (a, b) => a.cost - b.cost,
        level: (a, b) => (b.level ?? 0) - (a.level ?? 0),
        name: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
    };
    rows.sort(sorters[sortBy] || sorters.ratio);
    return rows;
}

/**
 * 离线幼崽商城表(来自官方 MCGoods 的 shop_id=5 全量 28 行, 见
 * core/src/gameConfig/MCRanchCubShop.json; 抓包 ShopInfo 价格与之逐条一致)。
 *
 * 用途: 账号没在跑 / 商城拉不到时, 分析页仍然能列出全部 28 种并给出四项指标
 * (周期来自官方 MCAnimalConfig, 成本与等级门槛来自这张表)。
 * 一旦拿到实时商城, 价格以实时为准 —— 这张表只是兜底, 不参与购买。
 *
 * @param {number} [playerLevel] 玩家农场等级; 传了就按 MCRanchCubShop 的
 *   requiredLevel 判定 unlocked(与 ranch.getCubShop 的规则一致), 不传视为未知全放行
 * @returns {Array<object>} 幼崽商城行
 */
let offlineShopCache = null;
function getOfflineCubShop(playerLevel = 0) {
    if (!offlineShopCache) {
        try {
            const p = require('node:path').join(__dirname, '..', 'gameConfig', 'MCRanchCubShop.json');
            const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
            offlineShopCache = (Array.isArray(rows) ? rows : []).map((row) => {
                const animalId = Number(row.animalId) || 0;
                const price = Number(row.price) || 0;
                const info = getItemById(animalId) || {};
                return {
                    // 兜底行: 不参与购买(goodsId 保留仅为展示)
                    goodsId: Number(row.goodsId) || 0,
                    animalId,
                    name: String(row.name || info.name || ''),
                    price,
                    limit: 0,
                    bought: 0,
                    remaining: null,
                    requiredLevel: Number(row.requiredLevel) || 0,
                    level: Number(row.level) || Number(info.level) || null,
                    husbandryType: String(row.husbandryType || ''),
                    offline: true,
                };
            }).filter(r => r.animalId > 0 && r.price > 0);
        } catch {
            offlineShopCache = [];
        }
    }
    const lv = Number(playerLevel) || 0;
    return offlineShopCache.map(r => ({
        ...r,
        // 与实时侧同一条规则: 玩家等级不够 = 未解锁; 等级未知(0)则不本地拦截
        unlocked: !(lv > 0 && r.requiredLevel > lv),
        levelLocked: lv > 0 && r.requiredLevel > lv,
        playerLevel: lv || null,
    }));
}

module.exports = {
    getCubRankings,
    getAnimalMetrics,
    getOfflineCubShop,
    rememberSellValue,
    rememberHarvestExp,
    learnedSellValue,
    learnedExp,
    getGrownValue,
    findGrownItemId,
    // 周期: 官方表为准, 抓包样本兜底(且落盘)
    getConfigCycleSec,
    getLearnedCycleSec,
    getCycleInfo,
    getHarvestExp,
    recordAnimalCycleSamples,
    cycleTable,
    NORMAL_CAN_ADVANCE_SEC,
};