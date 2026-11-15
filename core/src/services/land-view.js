/**
 * 地块视图(给前端面板的 DTO)构造。
 *
 * 为什么单独一个模块:
 *   自己的农场(farm.js)和好友农场(friend.js)都要把服务端的原始 land
 *   转成"面板能直接渲染"的对象。两份实现曾各自手写三段式
 *   (locked / empty / growing)的大对象字面量, 字段名、季数换算、
 *   成熟倒计时、plantSize 全都要人工保持一致 —— 改一处漏一处就会出现
 *   "自己的农场显示对、好友农场显示错"。
 *
 *   这里只负责**两边完全一致**的那部分字段; 各自特有的字段
 *   (farm 的升级条件与变异、friend 的偷菜状态)由调用方 spread 上去。
 */
const { PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantName, getPlantById, getSeedImageBySeedId, getPlantGrowTime } = require('../config/gameConfig');
const { toNum, toTimeSec } = require('../utils/utils');

// 占位植物(服务端用于"地块上什么都没有"的特殊 ID), 不该出现在面板上
const PLACEHOLDER_SEED_ID = 29999;

/** 未解锁地块 */
function buildLockedLand({ id, level, phaseName = '' }) {
    return {
        id,
        unlocked: false,
        status: 'locked',
        plantName: '',
        phaseName,
        level,
        needWater: false,
        needWeed: false,
        needBug: false,
        currentSeason: 0,
        totalSeason: 0,
        occupiedByMaster: false,
        masterLandId: 0,
        occupiedLandIds: [],
        plantSize: 1,
    };
}

/** 空地(没有作物, 或当前阶段无法识别) */
function buildEmptyLand({ id, level, phaseName = '空地', context }) {
    return {
        id,
        unlocked: true,
        status: 'empty',
        plantName: '',
        phaseName,
        level,
        needWater: false,
        needWeed: false,
        needBug: false,
        currentSeason: 0,
        totalSeason: 0,
        occupiedByMaster: context.occupiedByMaster,
        masterLandId: context.masterLandId,
        occupiedLandIds: context.occupiedLandIds,
        plantSize: 1,
    };
}

/**
 * 有作物的地块。
 *
 * @param plant  作物数据(合种作物时可能来自主地块)
 * @param context getDisplayLandContext 的结果
 * @param options.resolveStatus (phaseVal, plant) => status 字符串
 *                自己的农场: harvestable/dead/growing
 *                好友农场: stealable/harvested/dead/growing
 * @param options.currentPhase 当前生长阶段(由调用方用 getCurrentPhase 算好传入,
 *                保证和自己的农场判定完全一致)
 * @param options.nowSec 服务器秒级时间
 * @param options.usePhaseTimers 是否额外按阶段时间(dry_time/weeds_time/insect_time)
 *                判定缺水/草/虫。自己的农场用 true(更准确), 好友农田服务端不给阶段时间, 用 false
 * @returns null 表示这是占位植物(29999), 调用方应整块跳过
 */
function buildPlantedLand({
    id, level, plant, context, currentPhase, nowSec, resolveStatus, usePhaseTimers = false,
}) {
    const phaseVal = currentPhase.phase;
    const plantId = toNum(plant.id);
    const plantCfg = getPlantById(plantId);
    const seedId = toNum(plantCfg && plantCfg.seed_id);
    if (seedId === PLACEHOLDER_SEED_ID) return null;

    // 阶段时间型判定: 时间已到且 >0 也算需要处理
    const phaseTimerReached = (key) => {
        if (!usePhaseTimers) return false;
        const t = toTimeSec(currentPhase[key]);
        return t > 0 && t <= nowSec;
    };

    const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
    const currentSeasonRaw = toNum(plant.season);
    const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
    const maturePhase = Array.isArray(plant.phases)
        ? plant.phases.find(p => p && toNum(p.phase) === PlantPhase.MATURE)
        : null;
    const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
    const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;

    return {
        id,
        unlocked: true,
        status: resolveStatus(phaseVal, plant),
        plantName: getPlantName(plantId) || plant.name || '未知',
        seedId,
        seedImage: seedId > 0 ? getSeedImageBySeedId(seedId) : '',
        phaseName: PHASE_NAMES[phaseVal] || '',
        currentSeason,
        totalSeason,
        level,
        matureInSec,
        totalGrowTime: getPlantGrowTime(plantId, plant),
        needWater: (toNum(plant.dry_num) > 0) || phaseTimerReached('dry_time'),
        needWeed: !!(plant.weed_owners && plant.weed_owners.length > 0) || phaseTimerReached('weeds_time'),
        needBug: !!(plant.insect_owners && plant.insect_owners.length > 0) || phaseTimerReached('insect_time'),
        occupiedByMaster: context.occupiedByMaster,
        masterLandId: context.masterLandId,
        occupiedLandIds: context.occupiedLandIds,
        plantSize: Math.max(1, toNum(plantCfg && plantCfg.size) || 1),
    };
}

module.exports = {
    PLACEHOLDER_SEED_ID,
    buildLockedLand,
    buildEmptyLand,
    buildPlantedLand,
};
