/**
 * 牧场分析 —— 幼崽收益排行(完全对照 analytics.js 的 getPlantRankings)
 *
 * 农场按「经验/时、普通肥经验/时、净利润/时、普通肥净利润/时」给作物排序;
 * 牧场这边用同样的四个指标, 只是把"生长时间"换成动物的完整周期。
 *
 * ⭐ 与农场的一一对应关系:
 *   农场                         牧场
 *   ────────────────────────────────────────────
 *   growTime(生长时间)           cycleSec(幼崽期 + 成长期 + 成熟期)
 *   harvestExp(收获经验)         expected_harvest_exp(#21 服务端直接给)
 *   reduceSec(化肥减少)          普通罐头减 3600 秒(抓包: FeedAnimal 后 #2=3412/3597)
 *   income(毛收益)               整只回收价(成品 type=106 的 price)
 *   seedPrice(种子成本)          幼崽商城价
 *   netProfit = income - 成本    整只回收 − 幼崽价
 *
 * 周期时长来源(不是编的):
 *   官方 AnimalInfo 的 *_ready_at_ms 三件套在同一帧内相减即可得到各段时长:
 *     infant_ready_at_ms(#14) → grow_ready_at_ms(#10) → mature_ready_at_ms(#25)
 *   抓包实测(20261119-091627_罐头 等):
 *     鸡  : 幼崽 4s  + 成长 4s  + 成熟 10~14s
 *     兔子: 幼崽 3600s + 成长 3600s + 成熟 14400s
 *     天竺鼠: 幼崽 14400s + …
 *   配置里没有这些数值, 所以由运行时采集的样本汇总成一张"周期表",
 *   采集不到时返回 null(不编造), 与 farm analytics 对缺失价格的处理一致。
 */
const gameConfig = require('../config/gameConfig');
const { getItemById } = gameConfig;

/** 普通罐头/桶带来的加速(秒)。抓包: 用 1 个 → 桶剩余 3595~3597, 用 2 个 → 3412~3403 */
const NORMAL_CAN_ADVANCE_SEC = 3600;

/**
 * 幼崽 id → 成品(可卖) id。
 * 实测 ItemInfo: 60001 鸡 → 2060001(p3); 60002 鸭 → 2060002(p2160)
 * 规律不统一, 按"同名 + type=106"匹配。
 */
function findGrownItemId(animalId) {
    const cub = getItemById(Number(animalId) || 0);
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
 * 优先成品(type=106)的 price; 取不到退回幼崽自身 price。
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
    // 配置里没有成品价的动物(实测兔子 60004 就没有 106 条目),
    // 用运行时从服务端学到的 expected_harvest_sells(#22) 兜底 —— 那是真实结算价。
    const learned = Number((learnedSellValue.get(Number(animalId) || 0) || {}).value) || 0;
    if (learned > 0) return learned;
    return cub;
}

// 运行时从 AnimalInfo#22(expected_harvest_sells) 学到的收获所得
const learnedSellValue = new Map();

/**
 * 记录服务端给的"收获预计所得"(#22)。
 * 供配置里缺成品价的动物(如兔子)兜底用。
 */
function rememberSellValue(animalId, itemId, amount) {
    const id = Number(animalId) || 0;
    const amt = Number(amount) || 0;
    const cur = Number(itemId) || 1007;
    if (id > 0 && amt > 0) learnedSellValue.set(id, { itemId: cur, value: amt });
}

// ============ 周期时长表(运行时采集, 不是硬编码) ============
/**
 * animalId → 各段时长(秒)。
 * 由 recordAnimalCycleSamples(view) 从真实的 *_ready_at_ms 里算出并累加学习。
 */
const cycleTable = new Map();

/**
 * 从一次 GetRanchDetail 快照里学习各动物的阶段时长。
 *
 * 同一只动物在一帧里同时带着:
 *   infant_ready_at_ms(幼崽结束) / grow_ready_at_ms(成长结束) / mature_ready_at_ms(成熟)
 * 差值就是各段时长 —— 与服务端时钟无关, 所以跨账号/跨时间都可比。
 *
 * @param {object} view toRanchView() 的返回
 */
function recordAnimalCycleSamples(view) {
    // worker 模式下 view 里是没有绝对时刻的(已被转成相对秒), 所以这里直接读原始 proto
    // 由调用方在 toRanchView 之前喂进来(见 ranch.js 的 recordCycleSamplesFromReply)
    if (!view || !Array.isArray(view)) return;
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
        const prev = cycleTable.get(animalId) || { infantSec: 0, matureSec: 0, n: 0 };
        // 取见过的最大值: 服务端会给"剩余时间", 中途观察到的差值可能被截短
        cycleTable.set(animalId, {
            infantSec: Math.max(prev.infantSec, infantSec),
            matureSec: Math.max(prev.matureSec, matureSec),
            n: prev.n + 1,
        });
    }
}

/** 取某动物学到的周期(秒); 没有样本返回 null */
function getLearnedCycleSec(animalId) {
    const r = cycleTable.get(Number(animalId) || 0);
    if (!r) return null;
    // 成长期通常与幼崽期等长(抓包: 兔子 3600/3600); 没有 mature 样本时用它兜底
    const growSec = r.infantSec;
    const total = r.infantSec + growSec + (r.matureSec || 0);
    return total > 0 ? total : null;
}

/**
 * 由商城幼崽列表算出排行(四项指标与农场同构)。
 * @param {Array} shop getCubShop() 的返回
 * @param {string} sortBy ratio|exp|fert_exp|profit|fert_profit|cost|name|level
 * @returns {Array<object>}
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

        const cubInfo = getItemById(animalId) || {};
        const level = Number(g.level) || Number(cubInfo.level) || null;

        // ⚠ 指标优先取 getCubShop() 已经算好并随候选下发的值。
        //   本模块自己的 cycleTable 只在 **worker 进程**里被喂数据
        //   (toRanchView 每次拿详情都会 recordAnimalCycleSamples),
        //   而 admin 进程里的 cycleTable 永远是空的 —— 之前这里重新算一遍,
        //   于是面板上四项指标全是 "-", 而商城接口(cub-shop)却是有值的。
        const hasOwnMetrics = g.cycleSec !== undefined || g.expPerHour !== undefined;
        const cycleSec = hasOwnMetrics ? (g.cycleSec ?? null) : getLearnedCycleSec(animalId);
        const harvestExp = Number(g.expectedHarvestExp) || 0;

        let expPerHour = hasOwnMetrics ? (g.expPerHour ?? null) : null;
        let normalFertilizerExpPerHour = hasOwnMetrics ? (g.fertExpPerHour ?? null) : null;
        let profitPerHour = hasOwnMetrics ? (g.netProfitPerHour ?? null) : null;
        let normalFertilizerProfitPerHour = hasOwnMetrics ? (g.fertProfitPerHour ?? null) : null;

        // 没有现成指标时, 本进程若恰好有周期样本就自己算一份(worker 内调用时)
        if (!hasOwnMetrics && cycleSec && cycleSec > 0) {
            const fertSec = Math.max(1, cycleSec - NORMAL_CAN_ADVANCE_SEC);
            if (harvestExp > 0) {
                expPerHour = Number.parseFloat(((harvestExp / cycleSec) * 3600).toFixed(2));
                normalFertilizerExpPerHour = Number.parseFloat(((harvestExp / fertSec) * 3600).toFixed(2));
            }
            if (netProfit !== null) {
                profitPerHour = Number.parseFloat(((netProfit / cycleSec) * 3600).toFixed(2));
                normalFertilizerProfitPerHour = Number.parseFloat(((netProfit / fertSec) * 3600).toFixed(2));
            }
        }

        return {
            goodsId: Number(g.goodsId) || 0,
            animalId,
            name: String(g.name || ''),
            level,
            cost,
            grownValue,
            ratio,
            profit: netProfit,
            cycleSec,
            expPerHour,
            normalFertilizerExpPerHour,
            profitPerHour,
            normalFertilizerProfitPerHour,
            hasCycleData: cycleSec !== null,
            limit: Number(g.limit) || 0,
            bought: Number(g.bought) || 0,
            remaining: g.remaining === null || g.remaining === undefined ? null : Number(g.remaining),
            unlocked: !!g.unlocked,
            missing: [
                !(grownValue > 0) ? 'price' : null,
                !(cycleSec > 0) ? 'cycle' : null,
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

module.exports = {
    getCubRankings,
    rememberSellValue,
    learnedSellValue,
    getGrownValue,
    findGrownItemId,
    // 周期学习: ranch.js 每次拿到 GetRanchDetail 帧就喂一次
    recordAnimalCycleSamples,
    getLearnedCycleSec,
    cycleTable,
    NORMAL_CAN_ADVANCE_SEC,
};
