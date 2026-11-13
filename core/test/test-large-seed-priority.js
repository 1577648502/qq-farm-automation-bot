/**
 * 2x2 种子有限等待回归测试
 *
 * 目标:
 *   · 有 2x2 种子时，先留出有限时间等 4 格连续空地，不让 1x1 种子立即占满
 *   · 等待超时后恢复普通种子补种，避免永久空置
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
// 2x2 种植时服务端会补出 3 块副地块, 这里按用例指定
let largeSeedSlaveIds = [];

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
            slave_land_ids: largeSeedSlaveIds,
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
        collectReleasedLandGroupIds,
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
    largeSeedSlaveIds = [];
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

    section('2. 2x2 空地不足时有限等待');
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
    check('布局失败后继续有限等待', layoutWaiting.fallbackAllowed === false && layoutWaiting.waitingForLargeSeed && layoutWaiting.waitingForLargeSeed.seedId === largeSeedA.seedId, layoutWaiting);

    section('4. 等待超时后恢复普通种子');
    resetScenario([largeSeedA, smallSeed], []);
    getOrCreateLargeSeedWaitState(largeSeedA, Date.now() - LARGE_SEED_WAIT_MS - 1, 'default');
    const timedOut = await plantFromBagSeeds([1, 2, 3]);
    check('超时后种植普通种子', timedOut.totalPlanted === 3, timedOut);
    check('普通种子逐块提交', plantRequests.length === 3 && plantRequests.every(item => item.seedId === smallSeed.seedId), plantRequests);
    check('超时后不再返回等待状态', timedOut.waitingForLargeSeed === null, timedOut.waitingForLargeSeed);
    check('超时后允许后续回退', timedOut.fallbackAllowed === true, timedOut.fallbackAllowed);

    section('5. 没有 2x2 时行为不变');
    resetScenario([smallSeed, otherSmallSeed], [otherSmallSeed.seedId, smallSeed.seedId]);
    const normalSorted = sortBagSeedsForPlanting(bagSeeds, priorityList);
    check('仍按手动优先级种植', normalSorted.map(seed => seed.seedId).join(',') === `${otherSmallSeed.seedId},${smallSeed.seedId}`, normalSorted.map(seed => seed.seedId));

    section('6. 账号等待状态互不影响');
    resetLargeSeedWaitStates('account-a');
    resetLargeSeedWaitStates('account-b');
    const nowA = 1_000_000;
    const nowB = 2_000_000;
    getOrCreateLargeSeedWaitState(largeSeedA, nowA, 'account-a');
    getOrCreateLargeSeedWaitState(largeSeedB, nowB, 'account-b');
    const stateA = getOrCreateLargeSeedWaitState(largeSeedA, nowA + 1_000, 'account-a');
    const stateB = getOrCreateLargeSeedWaitState(largeSeedB, nowB + 1_000, 'account-b');
    check('账号 A 独立计时', stateA.startedAt === nowA, stateA);
    check('账号 B 独立计时', stateB.startedAt === nowB, stateB);

    section('7. 收获后整组 2x2 空地一次性回收');
    // 抓包实测(20261026-155015): 收获后主地块 plant 清空且 slave_land_ids 被清空,
    // 副地块 plant 为空但 master_land_id 仍指向主地块。
    // analyzeLands 在收获前把副地块当"被主地块占用"跳过 → 只回收主地块会凑不齐 4 块。
    {
        // (a) 用收获前的快照: 主地块还带 slave_land_ids, 整组关系最完整
        const preHarvestLands = [
            { id: 21, unlocked: true, plant: { phases: [{ phase: 6 }] }, slave_land_ids: [17, 18, 22] },
            { id: 17, unlocked: true, master_land_id: 21 },
            { id: 18, unlocked: true, master_land_id: 21 },
            { id: 22, unlocked: true, master_land_id: 21 },
            // 另一组大作物仍在生长, 不能被误收
            { id: 31, unlocked: true, plant: { phases: [{ phase: 1 }] }, slave_land_ids: [32, 33, 34] },
            { id: 32, unlocked: true, master_land_id: 31 },
            { id: 33, unlocked: true, master_land_id: 31 },
            { id: 34, unlocked: true, master_land_id: 31 },
        ];
        const preReleased = collectReleasedLandGroupIds([21], preHarvestLands, { trustedMasterIds: [21] });
        check('按收获前 slave_land_ids 回收 3 块副地块', preReleased.sort((a, b) => a - b).join(',') === '17,18,22', preReleased);
        check('主地块自身不重复计入', !preReleased.includes(21), preReleased);
        check('仍在生长的大作物不被回收', collectReleasedLandGroupIds([31], preHarvestLands, { trustedMasterIds: [21] }).length === 0, collectReleasedLandGroupIds([31], preHarvestLands, { trustedMasterIds: [21] }));
        check('没有主地块时不回收', collectReleasedLandGroupIds([], preHarvestLands).length === 0);

        // (b) 收获后快照: slave_land_ids 已清空, 只能靠 master_land_id 反查
        const postHarvestLands = [
            { id: 21, unlocked: true },
            { id: 17, unlocked: true, master_land_id: 21 },
            { id: 18, unlocked: true, master_land_id: 21 },
            { id: 22, unlocked: true, master_land_id: 21 },
            { id: 31, unlocked: true, plant: { phases: [{ phase: 1 }] } },
            { id: 32, unlocked: true, master_land_id: 31 },
        ];
        const postReleased = collectReleasedLandGroupIds([21], postHarvestLands);
        check('收获后按 master_land_id 反查回收 3 块副地块', postReleased.sort((a, b) => a - b).join(',') === '17,18,22', postReleased);
        check('反查时仍在生长的大作物不被回收', collectReleasedLandGroupIds([31], postHarvestLands).length === 0, collectReleasedLandGroupIds([31], postHarvestLands));

        // 回收后 4 块连续空地能正常种下 2x2
        resetScenario([largeSeedA, smallSeed], []);
        largeSeedSlaveIds = [17, 18, 22];
        const groupLands = collectReleasedLandGroupIds([21], preHarvestLands, { trustedMasterIds: [21] });
        const planted = await plantFromBagSeeds([21, ...groupLands]);
        check('整组回收后可种下 1 组 2x2', planted.totalPlanted === 1 && plantRequests.length === 1 && plantRequests[0].seedId === largeSeedA.seedId, { planted, plantRequests });
        check('整组回收后不再进入等待', planted.waitingForLargeSeed === null, planted.waitingForLargeSeed);

        // (c) 多季大作物收货后回到生长状态: 不在 trustedMasterIds 里就绝不能回收副地块
        const multiSeasonLands = [
            { id: 21, unlocked: true, plant: { phases: [{ phase: 2 }] }, slave_land_ids: [17, 18, 22] },
            { id: 17, unlocked: true, master_land_id: 21 },
            { id: 18, unlocked: true, master_land_id: 21 },
            { id: 22, unlocked: true, master_land_id: 21 },
        ];
        check('多季大作物(仍在生长)不回收副地块',
            collectReleasedLandGroupIds([21], multiSeasonLands, { trustedMasterIds: [] }).length === 0,
            collectReleasedLandGroupIds([21], multiSeasonLands, { trustedMasterIds: [] }));
    }

    finish();
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
