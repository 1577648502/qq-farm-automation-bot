/**
 * 2x2 种子持续优先等待回归测试
 *
 * 目标:
 *   · 背包仍有 2x2 种子时，持续保留空地等待，不让 1x1 种子占满
 *   · 只种下一颗 2x2 后，如果背包里还有同类种子，也继续优先等待
 *   · 2x2 种子全部种完后，剩余空地仍可按普通种子补种
 *   · 2x2 种子优先于手动排序，但多个 2x2 之间仍尊重用户排序
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'large-seed-priority');

const store = require(`${SB}/src/models/store`);
const warehouse = require(`${SB}/src/services/warehouse`);
const network = require(`${SB}/src/utils/network`);
const proto = require(`${SB}/src/utils/proto`);
const { types } = proto;

let bagSeeds = [];
let priorityList = [];
let plantRequests = [];
let failPlantSeedId = 0;

warehouse.getBagSeeds = async () => bagSeeds.map(seed => ({ ...seed }));
store.getBagSeedPriority = () => [...priorityList];
store.getPlantSeedExclude = () => [];
network.sendMsgAsync = async (_service, method, body) => {
    if (method !== 'Plant') throw new Error(`unexpected method: ${method}`);
    const request = types.PlantRequest.decode(body);
    const item = request.items && request.items[0];
    const landId = Number(item && item.land_ids && item.land_ids[0]);
    const seedId = Number(item && item.seed_id);
    plantRequests.push({ seedId, landId });
    if (seedId === failPlantSeedId) {
        throw new Error('种植失败 code=1001052');
    }

    const replyBody = types.PlantReply.encode(types.PlantReply.create({
        land: [{
            id: landId,
            plant: {
                id: seedId,
                phases: [{ phase: 1, begin_time: Math.floor(Date.now() / 1000) }],
            },
            slave_land_ids: seedId === largeSeedA.seedId || seedId === largeSeedB.seedId
                ? [landId + 1, landId + 2, landId + 3]
                : [],
        }],
    })).finish();
    return { body: replyBody };
};

const farm = require(`${SB}/src/services/farm`);
const {
    sortBagSeedsForPlanting,
    __privateFarmFns: {
        getOrCreateLargeSeedWaitState,
        resetLargeSeedWaitStates,
        plantFromBagSeeds,
    },
} = farm;

const largeSeedA = { seedId: 20046, name: '爱心果', count: 1, requiredLevel: 1, plantSize: 2 };
const largeSeedB = { seedId: 20416, name: '哈哈南瓜', count: 1, requiredLevel: 1, plantSize: 2 };
const smallSeed = { seedId: 20002, name: '白萝卜', count: 5, requiredLevel: 1, plantSize: 1 };
const otherSmallSeed = { seedId: 20003, name: '胡萝卜', count: 2, requiredLevel: 1, plantSize: 1 };

function resetScenario(seeds = [], priorities = []) {
    bagSeeds = seeds;
    priorityList = priorities;
    plantRequests = [];
    failPlantSeedId = 0;
    resetLargeSeedWaitStates();
}

async function run() {
    await proto.loadProto();

    section('1. 2x2 无条件优先于手动排序');
    const sorted = sortBagSeedsForPlanting(
        [smallSeed, largeSeedB, otherSmallSeed, largeSeedA],
        [smallSeed.seedId, largeSeedB.seedId, otherSmallSeed.seedId, largeSeedA.seedId],
    );
    check('两个 2x2 排在最前', sorted.slice(0, 2).every(seed => seed.plantSize === 2), sorted.map(seed => seed.seedId));
    check('2x2 内部尊重手动顺序', sorted[0].seedId === largeSeedB.seedId && sorted[1].seedId === largeSeedA.seedId, sorted.map(seed => seed.seedId));
    check('普通种子保持手动顺序', sorted.slice(2).map(seed => seed.seedId).join(',') === `${smallSeed.seedId},${otherSmallSeed.seedId}`, sorted.map(seed => seed.seedId));

    section('2. 2x2 空地不足时持续等待');
    resetScenario([largeSeedA, smallSeed], []);
    const waiting = await plantFromBagSeeds([1, 2, 3]);
    check('本轮不种普通种子', plantRequests.length === 0, plantRequests);
    check('保留全部空地', waiting.totalPlanted === 0 && waiting.remainingLandIds.length === 3, waiting);
    check('禁止回退商店补种', waiting.fallbackAllowed === false, waiting);
    check('返回 2x2 等待状态', waiting.waitingForLargeSeed && waiting.waitingForLargeSeed.seedId === largeSeedA.seedId, waiting.waitingForLargeSeed);

    section('3. 有空地但不连续时继续等待');
    resetScenario([largeSeedA, smallSeed], []);
    failPlantSeedId = largeSeedA.seedId;
    const layoutWaiting = await plantFromBagSeeds([1, 2, 3, 4]);
    check('尝试所有 2x2 候选主地块', plantRequests.length === 4 && plantRequests.every(item => item.seedId === largeSeedA.seedId), plantRequests);
    check('布局失败后不种 1x1', layoutWaiting.totalPlanted === 0 && layoutWaiting.remainingLandIds.length === 4, layoutWaiting);
    check('布局失败后继续持续等待', layoutWaiting.fallbackAllowed === false && layoutWaiting.waitingForLargeSeed && layoutWaiting.waitingForLargeSeed.seedId === largeSeedA.seedId, layoutWaiting);

    section('4. 超过原等待时间后仍不恢复普通种子');
    resetScenario([largeSeedA, smallSeed], []);
    getOrCreateLargeSeedWaitState(largeSeedA, Date.now() - 24 * 60 * 60 * 1000, 'default');
    const persistentWaiting = await plantFromBagSeeds([1, 2, 3]);
    check('旧计时已过仍不种普通种子', plantRequests.length === 0 && persistentWaiting.totalPlanted === 0, { persistentWaiting, plantRequests });
    check('继续保留全部空地', persistentWaiting.remainingLandIds.length === 3, persistentWaiting.remainingLandIds);
    check('仍返回大种子等待状态', persistentWaiting.waitingForLargeSeed && persistentWaiting.waitingForLargeSeed.seedId === largeSeedA.seedId, persistentWaiting.waitingForLargeSeed);
    check('仍禁止后续回退', persistentWaiting.fallbackAllowed === false, persistentWaiting.fallbackAllowed);

    section('5. 种下一颗后背包仍有 2x2 时继续等待');
    resetScenario([{ ...largeSeedA, count: 2 }, smallSeed], []);
    const partialLarge = await plantFromBagSeeds([1, 2, 3, 4, 5, 6]);
    check('只先种下一颗 2x2', partialLarge.totalPlanted === 1 && plantRequests.length === 1 && plantRequests[0].seedId === largeSeedA.seedId, { partialLarge, plantRequests });
    check('2x2 占满四块土地', partialLarge.occupiedCount === 4 && partialLarge.remainingLandIds.join(',') === '5,6', partialLarge);
    check('剩余大种子继续等待', partialLarge.waitingForLargeSeed && partialLarge.waitingForLargeSeed.remainingSeedCount === 1, partialLarge.waitingForLargeSeed);
    check('不拿 1x1 填剩余空地', partialLarge.fallbackAllowed === false, partialLarge.fallbackAllowed);

    section('6. 2x2 全部种完后恢复普通种子');
    resetScenario([{ ...largeSeedA, count: 2 }, smallSeed], []);
    const largeThenSmall = await plantFromBagSeeds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    check('先种完两颗 2x2', plantRequests.slice(0, 2).every(item => item.seedId === largeSeedA.seedId), plantRequests);
    check('剩余空地由 1x1 补种', plantRequests.length === 6 && plantRequests.slice(2).every(item => item.seedId === smallSeed.seedId), plantRequests);
    check('没有剩余大种子等待状态', largeThenSmall.waitingForLargeSeed === null, largeThenSmall.waitingForLargeSeed);

    section('7. 没有 2x2 时行为不变');
    resetScenario([smallSeed, otherSmallSeed], [otherSmallSeed.seedId, smallSeed.seedId]);
    const normalSorted = sortBagSeedsForPlanting(bagSeeds, priorityList);
    check('仍按手动优先级种植', normalSorted.map(seed => seed.seedId).join(',') === `${otherSmallSeed.seedId},${smallSeed.seedId}`, normalSorted.map(seed => seed.seedId));

    section('8. 账号等待状态互不影响');
    resetLargeSeedWaitStates('account-a');
    resetLargeSeedWaitStates('account-b');
    const nowA = 1_000_000;
    const nowB = 2_000_000;
    getOrCreateLargeSeedWaitState(largeSeedA, nowA, 'account-a');
    getOrCreateLargeSeedWaitState(largeSeedA, nowB, 'account-b');
    const stateA = getOrCreateLargeSeedWaitState(largeSeedA, nowA + 1_000, 'account-a');
    const stateB = getOrCreateLargeSeedWaitState(largeSeedA, nowB + 1_000, 'account-b');
    check('账号 A 独立计时', stateA.startedAt === nowA, stateA);
    check('账号 B 独立计时', stateB.startedAt === nowB, stateB);

    finish();
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
