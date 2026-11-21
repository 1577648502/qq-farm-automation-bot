/**
 * 施肥请求数回归测试
 *
 * 背景:
 *   runFertilizerByConfig 原本无条件 getAllLands() 一次, smart 分支又拉一次,
 *   而巡田主流程(runFarmOperation)手上本来已有地块快照 —— 每轮巡田白打
 *   1~2 次全量请求。
 *   现在支持 options.lands 传入, 且 smart 分支复用同一份快照。
 *
 * 这个测试守住: 传入 lands 时不再额外拉全量; 不传时行为不变(仍会自己拉一次)。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'fert-req-test';
isolateDataDir(SB, 'fert-req-test');

const network = require(`${SB}/src/utils/network`);
const proto = require(`${SB}/src/utils/proto`);
const store = require(`${SB}/src/models/store`);
const { types } = proto;

let allLandsCalls = 0;
const lands = [];
for (let id = 1; id <= 24; id++) {
    const land = { id, unlocked: true, level: 4, max_level: 6, could_upgrade: false };
    // 前 12 块有作物
    if (id <= 12) land.plant = { id: 1020002, name: '白萝卜', phases: [{ phase: 2, begin_time: 0 }] };
    lands.push(land);
}

network.sendMsgAsync = async (_s, method) => {
    if (method === 'AllLands') {
        allLandsCalls++;
        return { body: Buffer.from(types.AllLandsReply.encode(types.AllLandsReply.create({ lands })).finish()) };
    }
    if (method === 'Fertilize') {
        return { body: Buffer.from(types.FertilizeReply.encode(types.FertilizeReply.create({})).finish()) };
    }
    throw new Error(`unexpected ${  method}`);
};

proto.loadProto().then(async () => {
    const farm = require(`${SB}/src/services/farm`);

    const setStrategy = (fertilizer) => store.applyConfigSnapshot(
        { automation: { fertilizer } },
        { accountId: process.env.FARM_ACCOUNT_ID, persist: false },
    );
    const plantedIds = lands.slice(0, 12).map(l => l.id);

    section('1. 传入 lands 时不再拉全量');
    {
        setStrategy('normal');
        allLandsCalls = 0;
        await farm.runFertilizerByConfig(plantedIds, { lands });
        check('normal 策略 + 传入快照 → 0 次 AllLands', allLandsCalls === 0, allLandsCalls);

        allLandsCalls = 0;
        await farm.runFertilizerByConfig([], { lands, skipNormal: true });
        check('smart 补施 + 传入快照 → 0 次 AllLands', allLandsCalls === 0, allLandsCalls);
    }

    section('2. 不传 lands 时保持原行为(自己拉一次)');
    {
        setStrategy('normal');
        allLandsCalls = 0;
        await farm.runFertilizerByConfig(plantedIds);
        check('不传快照 → 自己拉 1 次', allLandsCalls === 1, allLandsCalls);
    }

    section('3. smart 策略不重复拉取');
    {
        setStrategy('smart');
        allLandsCalls = 0;
        await farm.runFertilizerByConfig([], { lands });
        check('smart + 传入快照 → 0 次(原来会多拉 1 次)', allLandsCalls === 0, allLandsCalls);

        allLandsCalls = 0;
        await farm.runFertilizerByConfig([], {});
        check('smart + 不传快照 → 仍只拉 1 次(不是 2 次)', allLandsCalls === 1, allLandsCalls);
    }

    finish();
}).catch(e => {
    console.log('测试异常:', e && e.message);
    process.exit(1);
});
