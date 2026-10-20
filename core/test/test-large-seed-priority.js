/**
 * 4x4 种子有限等待回归测试
 *
 * 目标:
 *   · 有 4x4 种子时，先留出有限时间等连续空地，不让 1x1/2x2 立即占满
 *   · 等待超时后恢复普通种子补种，避免永久空置
 *   · 4x4 种子优先于手动排序，但多个 4x4 之间仍尊重用户排序
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

    const replyBody = types.PlantReply.encode(types.PlantReply.create({
        land: [{
            id: landId,
            plant: {
                id: seedId,
                phases: [{ phase: 1, begin_time: Math.floor(Date.now() / 1000) }],
            },
            slave_land_ids: [],
        }],
    })).finish();
    return { body: replyBody };
};

const farm = require(`${SB}/src/services/farm`);
const {
    sortBagSeedsForPlanting,
    __privateFarmFns: {
        LARGE_SEED_WAIT_MS,
        getOrCreateLargeSeedWaitState,
        resetLargeSeedWaitStates,
        plantFromBagSeeds,
    },
} = farm;

const largeSeedA = { seedId: 90001, name: '四格种子甲', count: 1, requiredLevel: 1, plantSize: 4 };
const largeSeedB = { seedId: 90002, name: '四格种子乙', count: 1, requiredLevel: 1, plantSize: 4 };
const smallSeed = { seedId: 20002, name: '白萝卜', count: 5, requiredLevel: 1, plantSize: 1 };
const mediumSeed = { seedId: 29005, name: '森野黄金芽', count: 2, requiredLevel: 1, plantSize: 2 };

function resetScenario(seeds = [], priorities = []) {
    bagSeeds = seeds;
    priorityList = priorities;
    plantRequests = [];
    resetLargeSeedWaitStates();
}

async function run() {
    await proto.loadProto();

    section('1. 4x4 无条件优先于手动排序');
    const sorted = sortBagSeedsForPlanting(
        [smallSeed, largeSeedB, mediumSeed, largeSeedA],
        [smallSeed.seedId, largeSeedB.seedId, mediumSeed.seedId, largeSeedA.seedId],
    );
    check('两个 4x4 排在最前', sorted.slice(0, 2).every(seed => seed.plantSize === 4), sorted.map(seed => seed.seedId));
    check('4x4 内部尊重手动顺序', sorted[0].seedId === largeSeedB.seedId && sorted[1].seedId === largeSeedA.seedId, sorted.map(seed => seed.seedId));
    check('普通种子保持手动顺序', sorted.slice(2).map(seed => seed.seedId).join(',') === `${smallSeed.seedId},${mediumSeed.seedId}`, sorted.map(seed => seed.seedId));

    section('2. 4x4 空地不足时有限等待');
    resetScenario([largeSeedA, smallSeed], []);
    const waiting = await plantFromBagSeeds([1, 2, 3, 4]);
    check('本轮不种普通种子', plantRequests.length === 0, plantRequests);
    check('保留全部空地', waiting.totalPlanted === 0 && waiting.remainingLandIds.length === 4, waiting);
    check('禁止回退商店补种', waiting.fallbackAllowed === false, waiting);
    check('返回 4x4 等待状态', waiting.waitingForLargeSeed && waiting.waitingForLargeSeed.seedId === largeSeedA.seedId, waiting.waitingForLargeSeed);

    section('3. 等待超时后恢复普通种子');
    resetScenario([largeSeedA, smallSeed], []);
    getOrCreateLargeSeedWaitState(largeSeedA, Date.now() - LARGE_SEED_WAIT_MS - 1, 'default');
    const timedOut = await plantFromBagSeeds([1, 2, 3, 4]);
    check('超时后种植普通种子', timedOut.totalPlanted === 4, timedOut);
    check('普通种子逐块提交', plantRequests.length === 4 && plantRequests.every(item => item.seedId === smallSeed.seedId), plantRequests);
    check('超时后不再返回等待状态', timedOut.waitingForLargeSeed === null, timedOut.waitingForLargeSeed);
    check('超时后允许后续回退', timedOut.fallbackAllowed === true, timedOut.fallbackAllowed);

    section('4. 没有 4x4 时行为不变');
    resetScenario([smallSeed, mediumSeed], [mediumSeed.seedId, smallSeed.seedId]);
    const normalSorted = sortBagSeedsForPlanting(bagSeeds, priorityList);
    check('仍按手动优先级种植', normalSorted.map(seed => seed.seedId).join(',') === `${mediumSeed.seedId},${smallSeed.seedId}`, normalSorted.map(seed => seed.seedId));

    section('5. 账号等待状态互不影响');
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
