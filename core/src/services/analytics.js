/**
 * 数据分析模块 - 作物效率分析
 */

const { getAllPlants, getFruitPrice, getSeedPrice, getItemImageById } = require('../config/gameConfig');

function parseGrowTime(growPhases) {
    if (!growPhases) return 0;
    const phases = growPhases.split(';').filter(p => p.length > 0);
    let totalTime = 0;
    for (const phase of phases) {
        const match = phase.match(/:(\d+)$/);
        if (match) {
            totalTime += Number.parseInt(match[1]);
        }
    }
    return totalTime;
}

function parseNormalFertilizerReduceSec(growPhases) {
    if (!growPhases) return 0;
    const phases = String(growPhases).split(';').filter(p => p.length > 0);
    if (!phases.length) return 0;
    const first = phases[0];
    const match = first.match(/:(\d+)$/);
    return match ? (Number.parseInt(match[1], 10) || 0) : 0;
}

function formatTime(seconds) {
    if (seconds < 60) return `秒`;
    if (seconds < 3600) return `分秒`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `时分` : `时`;
}

function getPlantRankings(sortBy = 'exp') {
    const plants = getAllPlants();
    
    // 筛选普通作物
    const normalPlants = plants.filter(p => {
        // 放宽条件，只要有种子ID且有生长阶段数据
        return p.seed_id > 0 && p.grow_phases;
    });

    const results = [];
    for (const plant of normalPlants) {
        const baseGrowTime = parseGrowTime(plant.grow_phases);
        if (baseGrowTime <= 0) continue;
        const seasons = Number(plant.seasons) || 1;
        const isTwoSeason = seasons === 2;
        const growTime = isTwoSeason ? (baseGrowTime * 1.5) : baseGrowTime;
        
        const harvestExpBase = Number.parseInt(plant.exp) || 0;
        const harvestExp = isTwoSeason ? (harvestExpBase * 2) : harvestExpBase;
        const expPerHour = (harvestExp / growTime) * 3600;
        // 普通化肥：直接减少第一生长阶段时长（reduceSec）
        const reduceSecBase = parseNormalFertilizerReduceSec(plant.grow_phases);
        const reduceSecApplied = isTwoSeason ? (reduceSecBase * 2) : reduceSecBase;
        const fertilizedGrowTime = growTime - reduceSecApplied;
        const safeFertilizedTime = fertilizedGrowTime > 0 ? fertilizedGrowTime : 1;
        const normalFertilizerExpPerHour = (harvestExp / safeFertilizedTime) * 3600;
        
        const fruitId = Number(plant.fruit && plant.fruit.id) || 0;
        const fruitCount = Number(plant.fruit && plant.fruit.count) || 0;
        const fruitPrice = getFruitPrice(fruitId);
        const seedPrice = getSeedPrice(Number(plant.seed_id) || 0);

        // 检查价格数据是否完整（部分特殊/活动作物无定价数据）
        const hasPriceData = fruitId > 0 && fruitPrice > 0 && fruitCount > 0;

        // 单次收获总金币（毛收益）与净收益
        let income, netProfit, goldPerHour, profitPerHour, normalFertilizerProfitPerHour;

        if (hasPriceData) {
            income = (fruitCount * fruitPrice) * (isTwoSeason ? 2 : 1);
            netProfit = income - seedPrice;
            goldPerHour = (income / growTime) * 3600;
            profitPerHour = (netProfit / growTime) * 3600;
            normalFertilizerProfitPerHour = (netProfit / safeFertilizedTime) * 3600;
        } else {
            income = null;
            netProfit = null;
            goldPerHour = null;
            profitPerHour = null;
            normalFertilizerProfitPerHour = null;
        }

        const cfgLevel = Number(plant.land_level_need);
        const requiredLevel = (Number.isFinite(cfgLevel) && cfgLevel > 0) ? cfgLevel : null;
        results.push({
            id: plant.id,
            seedId: plant.seed_id,
            name: plant.name,
            seasons,
            level: requiredLevel,
            growTime,
            growTimeStr: formatTime(growTime),
            reduceSec: reduceSecBase,
            reduceSecApplied,
            expPerHour: Number.parseFloat(expPerHour.toFixed(2)),
            normalFertilizerExpPerHour: Number.parseFloat(normalFertilizerExpPerHour.toFixed(2)),
            goldPerHour: goldPerHour !== null ? Number.parseFloat(goldPerHour.toFixed(2)) : null,
            profitPerHour: profitPerHour !== null ? Number.parseFloat(profitPerHour.toFixed(2)) : null,
            normalFertilizerProfitPerHour: normalFertilizerProfitPerHour !== null ? Number.parseFloat(normalFertilizerProfitPerHour.toFixed(2)) : null,
            income: income !== null ? income : null,
            netProfit: netProfit !== null ? netProfit : null,
            fruitId,
            fruitCount,
            fruitPrice,
            seedPrice,
            image: getItemImageById(plant.seed_id),
            // 标记是否为变异/衍生作物，用于名称去重
            _isMutant: !!plant.mutant_effect_plant,
        });
    }

    // 处理重名作物：追加区分标记
    const nameCount = {};
    for (const r of results) {
        nameCount[r.name] = (nameCount[r.name] || 0) + 1;
    }
    // 对有重复的名称，按seedId排序确保顺序稳定，追加区分后缀
    for (let i = 0; i < results.length; i++) {
        const name = results[i].name;
        if (nameCount[name] > 1) {
            // 使用等级或变异标记做区分
            const lv = results[i].level;
            if (results[i]._isMutant) {
                results[i].name = name + ' ★变异'; // ★变异
            } else {
                results[i].name = name; // 基础版保持原名
            }
        }
    }
    // 清理内部标记
    for (const r of results) delete r._isMutant;

    if (sortBy === 'exp') {
        results.sort((a, b) => b.expPerHour - a.expPerHour);
    } else if (sortBy === 'fert') {
        results.sort((a, b) => b.normalFertilizerExpPerHour - a.normalFertilizerExpPerHour);
    } else if (sortBy === 'gold') {
        results.sort((a, b) => {
            if (a.goldPerHour === null && b.goldPerHour === null) return 0;
            if (a.goldPerHour === null) return 1;
            if (b.goldPerHour === null) return -1;
            return b.goldPerHour - a.goldPerHour;
        });
    } else if (sortBy === 'profit') {
        results.sort((a, b) => {
            if (a.profitPerHour === null && b.profitPerHour === null) return 0;
            if (a.profitPerHour === null) return 1;
            if (b.profitPerHour === null) return -1;
            return b.profitPerHour - a.profitPerHour;
        });
    } else if (sortBy === 'fert_profit') {
        results.sort((a, b) => {
            if (a.normalFertilizerProfitPerHour === null && b.normalFertilizerProfitPerHour === null) return 0;
            if (a.normalFertilizerProfitPerHour === null) return 1;
            if (b.normalFertilizerProfitPerHour === null) return -1;
            return b.normalFertilizerProfitPerHour - a.normalFertilizerProfitPerHour;
        });
    } else if (sortBy === 'level') {
        const lv = (v) => (v === null || v === undefined ? -1 : Number(v));
        results.sort((a, b) => lv(b.level) - lv(a.level));
    }

    return results;
}

module.exports = {
    getPlantRankings,
};
