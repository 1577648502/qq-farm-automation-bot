/**
 * 牧场分析 —— 幼崽收益排行(对照 analytics.js 的 getPlantRankings)
 *
 * 农场按"经验/时、净利润/时"排作物; 牧场没有同样的耕作模型, 能可靠算出来的是:
 *   · 幼崽成本(商城价, 金券)
 *   · 整只回收价(成熟后卖掉的价, 金券)
 *   · 收益比 = 整只回收 / 幼崽成本  ← 买幼崽策略"max_profit"用的就是它
 *
 * ⚠ 没有编造"每小时收益": 协议里没有稳定的产出间隔字段
 *   (#23 produce_interval 只在兔子上出现过, 鸡完全没有), 算不出来就不给。
 *   这一点和农场不同, 农场的 grow_phases 是完整的。
 */
const gameConfig = require('../config/gameConfig');
const { getItemById } = gameConfig;

/**
 * 幼崽 id → 成品(可卖) id 的映射。
 *
 * 实测 ItemInfo:
 *   60001 鸡(幼崽, type=105, price=1)   → 2060001 鸡(成品, type=106, price=3)
 *   60002 鸭(幼崽, type=105, price=540) → 2060002 鸭(成品, type=106, price=2160)
 * 规律: 成品 id = 2 + 幼崽 id + 100000 - 40000? 不成立, 所以按名字匹配更稳。
 *
 * 这里用"同名 + type=106"来找成品, 找不到再退回幼崽自身价格。
 */
function findGrownItemId(animalId) {
    const cub = getItemById(Number(animalId) || 0);
    if (!cub) return 0;
    const name = String(cub.name || '');
    if (!name) return 0;
    // 遍历全部物品找同名且 type=106(成品动物)
    const all = typeof gameConfig.getAllItems === 'function' ? gameConfig.getAllItems() : null;
    if (!Array.isArray(all)) return 0;
    const hit = all.find(it => Number(it.type) === 106 && String(it.name || '') === name);
    return hit ? Number(hit.id) || 0 : 0;
}

/**
 * 成熟动物的整只回收价(金券)。
 * 优先取"成品动物"(type=106) 的 price; 取不到才退回幼崽自身 price。
 * @param {number} animalId 幼崽 id(60001 …)
 * @returns {number}
 */
function getGrownValue(animalId) {
    const grownId = findGrownItemId(animalId);
    const pick = (id) => {
        const info = getItemById(Number(id) || 0);
        const price = Number(info && info.price);
        return Number.isFinite(price) && price > 0 ? price : 0;
    };
    const grown = grownId ? pick(grownId) : 0;
    // 成品价明显更高才用(幼崽价通常远低于整只回收)
    const cub = pick(animalId);
    return grown > cub ? grown : cub;
}

/**
 * 由商城幼崽列表算出收益排行。
 * @param {Array<{goodsId:number, animalId:number, name:string, price:number,
 *                limit:number, bought:number, remaining:number|null, unlocked:boolean}>} shop
 * @param {string} sortBy ratio|price|name
 * @returns {Array<object>}
 */
function getCubRankings(shop, sortBy = 'ratio') {
    const rows = (Array.isArray(shop) ? shop : []).map((g) => {
        const animalId = Number(g.animalId) || 0;
        const cost = Number(g.price) || 0;
        const grownValue = getGrownValue(animalId);
        const ratio = cost > 0 && grownValue > 0 ? grownValue / cost : 0;
        return {
            goodsId: Number(g.goodsId) || 0,
            animalId,
            name: String(g.name || ''),
            cost,
            grownValue,
            ratio,
            // 净赚 = 整只回收 - 幼崽成本
            profit: grownValue > 0 && cost > 0 ? grownValue - cost : null,
            limit: Number(g.limit) || 0,
            bought: Number(g.bought) || 0,
            remaining: g.remaining === null || g.remaining === undefined ? null : Number(g.remaining),
            unlocked: !!g.unlocked,
        };
    });

    const sorters = {
        ratio: (a, b) => (b.ratio - a.ratio) || (a.cost - b.cost),
        profit: (a, b) => ((b.profit ?? -1) - (a.profit ?? -1)) || (b.ratio - a.ratio),
        cost: (a, b) => a.cost - b.cost,
        name: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
    };
    rows.sort(sorters[sortBy] || sorters.ratio);
    return rows;
}

module.exports = { getCubRankings, getGrownValue };
