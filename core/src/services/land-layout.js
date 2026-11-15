/**
 * 农田棋盘布局 - 把服务端下发的土地列表摆回真实农场的样子
 *
 * 为什么需要:
 *   · 服务端只给 `id` 和平铺的列表, 不给行列坐标(抓包里 land_size 恒为 0);
 *   · 2x2/4x4 合种作物是**一棵植物占多块地**: 只有主地块带 plant 数据,
 *     其余副地块 plant 为空、只带 master_land_id。前端如果逐块渲染,
 *     用户会看到"4 块一模一样的土地", 点另外 3 块必然报错。
 *
 * 所以这里做两件事:
 *   1. 推断棋盘的列数(24 块地 / 4 列 = 6 行, 见下方 resolveBoardColumns 的实测依据);
 *   2. 把整组地块折算成"一块跨格的大地": 只保留主地块, 给出它在棋盘上的
 *      起始行列与跨格数, 前端用 CSS Grid 的 span 直接铺成大格子。
 *
 * 实测依据(wx-code-grabber/captures 下 8 份带 2x2 作物的 AllLands 抓包):
 *   每一组副地块都是 {主地块-4, 主地块-3, 主地块-1, 主地块} 的相邻关系
 *   (如 5←[1,6,2]、7←[3,8,4]、21←[17,22,18])。按 24 块地枚举列数,
 *   只有 4 列能让所有组的 4 块地在棋盘上拼成实心 2x2 矩形。
 */
const { toNum } = require('../utils/utils');

// 棋盘列数的候选上限: 再宽就不可能是手机农场了
const MAX_LAYOUT_COLUMNS = 12;
// 找不到任何能拼成矩形的列数时(地块关系异常)用的兜底列数
const DEFAULT_LAYOUT_COLUMNS = 4;

/**
 * 地块分组关系(主地块 / 副地块)的**唯一**判定入口。
 * farm.js 的展示上下文、汇总、单地块操作归属都从这里取, 避免两套定义打架。
 */
function getSlaveLandIds(land) {
    const ids = Array.isArray(land && land.slave_land_ids) ? land.slave_land_ids : [];
    return [...new Set(ids.map(id => toNum(id)).filter(Boolean))];
}

function hasPlantData(land) {
    const plant = land && land.plant;
    return !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
}

/**
 * 这块地的整组地块 ID(主地块在前)。
 * 只有主地块真的带作物数据时才算数 —— 收获后服务端会把 slave_land_ids 清空,
 * 空主地块不该继续占 4 格。
 */
function getLandGroup(land) {
    const selfId = toNum(land && land.id);
    if (!selfId || !hasPlantData(land)) return null;
    const slaveIds = getSlaveLandIds(land).filter(id => id !== selfId);
    if (slaveIds.length === 0) return null;
    return [selfId, ...slaveIds];
}

/** 一组地块在 columns 列棋盘上是否恰好铺满一个实心矩形 */
function getGroupRect(cellIds, columns) {
    const positions = cellIds.map(id => ({
        row: Math.floor((id - 1) / columns),
        column: (id - 1) % columns,
    }));
    const rows = positions.map(p => p.row);
    const cols = positions.map(p => p.column);
    const top = Math.min(...rows);
    const bottom = Math.max(...rows);
    const left = Math.min(...cols);
    const right = Math.max(...cols);
    const height = bottom - top + 1;
    const width = right - left + 1;
    if (height * width !== cellIds.length) return null;

    const occupied = new Set(positions.map(p => `${p.row},${p.column}`));
    for (let row = top; row <= bottom; row++) {
        for (let column = left; column <= right; column++) {
            if (!occupied.has(`${row},${column}`)) return null;
        }
    }
    return { row: top, column: left, height, width };
}

/**
 * 推断棋盘列数。
 *
 * 条件: 能整除地块总数, 且**所有**合种组都能在这一列数下拼成实心矩形。
 * 有合种组时取满足条件的**最大值**(组本身已经把列数钉死了, 越大越不会漏解);
 * 没有合种组时取最接近正方形的列数 —— 抓包里 24 块地就是 4 列 6 行,
 * 这样 2x2 作物才能真的在界面上拼成 2x2 而不是被拉成长条。
 */
function resolveBoardColumns(lands, groups = []) {
    const total = Array.isArray(lands) ? lands.length : 0;
    if (total <= 0) return DEFAULT_LAYOUT_COLUMNS;

    const divisors = [];
    for (let columns = 2; columns <= Math.min(MAX_LAYOUT_COLUMNS, total); columns++) {
        if (total % columns === 0) divisors.push(columns);
    }

    // ⚠ 没有合种组时 [].every(...) 恒为 true, 会误判成"所有列都满足"而取到最宽的列数,
    //   所以必须先确认真的存在合种组
    const withGroups = groups.length === 0
        ? []
        : divisors.filter(columns => groups.every(group => !!getGroupRect(group, columns)));
    if (withGroups.length > 0) return withGroups[withGroups.length - 1];

    // 没有合种作物(或关系全对不上): 取最接近正方形的那组行列
    // 24 块 → 候选 [2,3,4,6,8,12], |2-12|=10、|3-8|=5、|4-6|=2 → 4 列
    let closest = DEFAULT_LAYOUT_COLUMNS;
    let closestGap = Number.POSITIVE_INFINITY;
    for (const columns of divisors) {
        const gap = Math.abs(columns - total / columns);
        if (gap < closestGap) {
            closestGap = gap;
            closest = columns;
        }
    }
    return divisors.length > 0 ? closest : DEFAULT_LAYOUT_COLUMNS;
}

/**
 * 生成棋盘布局。
 *
 * 返回:
 *   columns         列数
 *   groupedSlaveIds 被主地块合并掉的副地块 ID
 *   slots           只含**要渲染的格子**, 被合并的副地块已剔除
 *                   { landId, row, column, rowSpan, columnSpan } —— 1-based
 *
 * 只有**整组能拼成实心矩形**时才合并; 关系对不上时保持逐块渲染,
 * 否则会漏掉没有主地块兜住的那几格。
 */
function buildLandBoard(lands) {
    const list = Array.isArray(lands) ? lands : [];
    const groups = [];
    const groupByMasterId = new Map();
    for (const land of list) {
        const group = getLandGroup(land);
        if (!group) continue;
        groups.push(group);
        groupByMasterId.set(toNum(land.id), group);
    }

    const columns = resolveBoardColumns(list, groups);
    const slotById = new Map();
    const groupedSlaveIds = new Set();

    // 先摆普通地块(包括没能合并的组), 再用跨格覆盖
    for (const land of list) {
        const id = toNum(land && land.id);
        if (!id) continue;
        slotById.set(id, {
            landId: id,
            row: Math.floor((id - 1) / columns) + 1,
            column: ((id - 1) % columns) + 1,
            rowSpan: 1,
            columnSpan: 1,
        });
    }

    for (const [masterId, group] of groupByMasterId) {
        const rect = getGroupRect(group, columns);
        if (!rect || rect.height * rect.width !== group.length) continue;
        // 锚点用整组的最小行列(主地块自身的位置, 否则会压到组外的地)
        slotById.set(masterId, {
            landId: masterId,
            row: rect.row + 1,
            column: rect.column + 1,
            rowSpan: rect.height,
            columnSpan: rect.width,
        });
        // 副地块已并进主地块的大格子, 从 slots 里剔除 —— 前端不需要再判断"跳过谁"
        for (const id of group) {
            if (id === masterId) continue;
            groupedSlaveIds.add(id);
            slotById.delete(id);
        }
    }

    return {
        columns,
        groupedSlaveIds: [...groupedSlaveIds],
        slots: [...slotById.values()].sort((a, b) => a.landId - b.landId),
    };
}

module.exports = {
    buildLandBoard,
    resolveBoardColumns,
    getLandGroup,
    getGroupRect,
    getSlaveLandIds,
    hasPlantData,
};