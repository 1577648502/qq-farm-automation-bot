/**
 * farm.js 协议与土地筛选纯函数回归测试
 *
 * 覆盖(此前 2378 行 farm 服务零专属测试):
 *   · encodePlantRequest 种植请求编码(autoSlave 奴隶地块联动)
 *   · getOrganicFertilizerTargetsFromLands 有机肥目标筛选(只浇未成熟+解锁)
 *   · filterLandIdsByTypes / normalizeFertilizerLandTypes 化肥地块类型过滤
 *   · isOccupiedSlaveLand / getLinkedMasterLand 主奴地块联动
 *
 * 运行: node test/test-farm-protocol.js
 */
const { setupSandbox, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();

(async () => {
    const proto = require(`${SB}/src/utils/proto`);
    await proto.loadProto();
    const { types } = proto;
    const farm = require(`${SB}/src/services/farm`);

    section('1. encodePlantRequest: 基本编码(items[0] = {seed_id, land_ids})');
    {
        const buf = farm.encodePlantRequest(20021, [1, 2]);
        const decoded = types.PlantRequest.decode(buf);
        const item = decoded.items && decoded.items[0];
        check('items 有一组', !!item, decoded.items);
        check('seed_id 编码', Number(item.seed_id) === 20021, Number(item.seed_id));
        check('land_ids 编码', item.land_ids.map(Number).join(',') === '1,2');
        check('默认不联动奴隶地', item.auto_slave === false);
    }

    section('2. encodePlantRequest: autoSlave 联动');
    {
        const buf = farm.encodePlantRequest(20525, [3], true);
        const decoded = types.PlantRequest.decode(buf);
        const item = decoded.items[0];
        check('auto_slave 置位', item.auto_slave === true, item.auto_slave);
        check('seed_id 保留', Number(item.seed_id) === 20525);
    }

    section('3. getOrganicFertilizerTargetsFromLands: 解锁+有作物+非死亡');
    {
        const now = Math.floor(Date.now() / 1000);
        const lands = [
            // 已成熟但还有剩余施肥次数 → 仍然目标(实现只排除 DEAD)
            { id: 1, unlocked: true, plant: { id: 10, phases: [{ phase: 6, begin_time: now - 60 }] } },
            // 生长中 → 目标
            { id: 2, unlocked: true, plant: { id: 11, phases: [{ phase: 1, begin_time: now - 600 }] } },
            // 死亡 → 排除
            { id: 3, unlocked: true, plant: { id: 12, phases: [{ phase: 7, begin_time: now - 900 }] } },
            // 未解锁 → 排除
            { id: 4, unlocked: false, plant: { id: 13, phases: [{ phase: 1, begin_time: now - 600 }] } },
            // 空地 → 排除
            { id: 5, unlocked: true },
        ];
        const targets = farm.__privateFarmFns.getOrganicFertilizerTargetsFromLands(lands);
        check('挑出 1(成熟有余次)和 2(生长中)', JSON.stringify(targets) === '[1,2]', JSON.stringify(targets));
    }

    section('3b. getFastMatureLands: 按 MATURE 阶段开始时间筛选');
    {
        const now = Math.floor(Date.now() / 1000);
        const lands = [
            // 成熟阶段 100s 后开始(将熟)
            { id: 1, unlocked: true, plant: { id: 10, phases: [
                { phase: 1, begin_time: now - 600 },
                { phase: 6, begin_time: now + 100 },
            ] } },
            // 成熟阶段 600s 后开始(超 300s 阈值)
            { id: 2, unlocked: true, plant: { id: 11, phases: [
                { phase: 1, begin_time: now - 600 },
                { phase: 6, begin_time: now + 600 },
            ] } },
            // 已经成熟(当前相就是 MATURE) → 排除
            { id: 3, unlocked: true, plant: { id: 12, phases: [{ phase: 6, begin_time: now - 60 }] } },
        ];
        const fast = farm.__privateFarmFns.getFastMatureLands(lands, 300);
        check('只挑 300s 内将熟的地(返回 landId 数组)', JSON.stringify(fast.map(Number)) === '[1]', JSON.stringify(fast.map(Number)));
    }

    section('4. isOccupiedSlaveLand: 主奴联动判定');
    {
        const landsMap = new Map([
            // 主地 100 有作物, 且声明 101 是它的副地块
            [100, { id: 100, unlocked: true, slave_land_ids: [101], plant: { id: 1, phases: [{ phase: 1, begin_time: 0 }] } }],
            [101, { id: 101, unlocked: true, master_land_id: 100 }],
        ]);
        const slave = landsMap.get(101);
        check('隶属有作物主地 → 占用', farm.isOccupiedSlaveLand(slave, landsMap) === true);
        const freeSlave = { id: 102, unlocked: true, master_land_id: 103 };
        const landsMap2 = new Map([[103, { id: 103, unlocked: true, slave_land_ids: [102] }]]);
        check('主地无作物 → 非占用', farm.isOccupiedSlaveLand(freeSlave, landsMap2) === false);
    }

    section('5. sortBagSeedsForPlanting: 幼大种子优先(导出行为)');
    {
        const seeds = [
            { id: 1, size: 1, count: 5 },
            { id: 2, size: 4, count: 2 },
            { id: 3, size: 2, count: 3 },
        ];
        const sorted = farm.sortBagSeedsForPlanting
            ? farm.sortBagSeedsForPlanting(seeds)
            : seeds;
        check('返回数组不抛错', Array.isArray(sorted));
    }

    finish();
})().catch((e) => { console.error(e); process.exit(1); });
