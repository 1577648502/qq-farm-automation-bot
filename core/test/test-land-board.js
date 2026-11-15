/**
 * 农田棋盘布局回归测试
 *
 * 背景:
 *   2x2/4x4 合种作物是**一棵植物占多块地**: 只有主地块带 plant, 副地块 plant 为空、
 *   只带 master_land_id。前端逐块渲染会显示成 4 块一模一样的土地, 只有 1 块能操作
 *   —— 用户反馈的"4 块土地施肥要一个一个试"就是这个问题。
 *
 * 覆盖:
 *   · 列数推断: 24 块地要能得到 4 列(抓包实测), 且所有组都能拼成实心矩形
 *   · 合并规则: 只保留主地块, 副地块进 groupedSlaveIds, 主地块拿到正确 span
 *   · 边界: 组关系对不上 / 主地块没有作物数据 / 没有合种作物 时不能乱合并
 *   · 汇总: 按作物数算, 2x2 只算 1 棵(不按 4 格算)
 *   · 单地块操作: 点到副地块时归属主地块, 升级/种植仍落在原地块
 *
 * 运行: node test/test-land-board.js
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'land-board-test';
isolateDataDir(SB, 'land-board-test');

const { buildLandBoard, resolveBoardColumns, getGroupRect } = require(`${SB}/src/services/land-layout`);

/** 生成 24 块地(1..24), 可指定某几组合种作物 */
function makeLands(groupSpecs = []) {
    const lands = [];
    const byId = new Map();
    for (let id = 1; id <= 24; id++) {
        const land = { id, unlocked: true, level: 4, max_level: 6 };
        lands.push(land);
        byId.set(id, land);
    }
    for (const spec of groupSpecs) {
        const [masterId, ...slaveIds] = spec;
        const master = byId.get(masterId);
        master.plant = { id: 1029005, name: '森野黄金芽', phases: [{ phase: 2, begin_time: 0 }] };
        master.slave_land_ids = slaveIds;
        for (const slaveId of slaveIds) {
            byId.get(slaveId).master_land_id = masterId;
        }
    }
    return lands;
}

section('1. 列数推断: 抓包里 24 块地 + 2x2 组 = 4 列');
{
    // 抓包 20261107-112023 实测: 主地块 13, 副地块 [9, 14, 10]
    const lands = makeLands([[13, 9, 14, 10]]);
    const group = [13, 9, 14, 10];
    const board = buildLandBoard(lands);
    check('24 块地推断出 4 列', board.columns === 4, { columns: board.columns });
    check('24 块 / 4 列 = 6 行', lands.length / board.columns === 6, { rows: lands.length / board.columns });
    check('该组在 4 列下拼成 2x2', !!getGroupRect(group, 4), getGroupRect(group, 4));
    check('该组在 6 列下拼不成矩形',
        !getGroupRect(group, 6) || getGroupRect(group, 6).width * getGroupRect(group, 6).height !== 4,
        getGroupRect(group, 6));
}

section('2. 合并: 只留主地块, 副地块不再单独渲染');
{
    const lands = makeLands([[13, 9, 14, 10]]);
    const board = buildLandBoard(lands);
    check('副地块 9/14/10 被合并', board.groupedSlaveIds.sort((a, b) => a - b).join(',') === '9,10,14',
        board.groupedSlaveIds);

    const masterSlot = board.slots.find(s => s.landId === 13);
    check('主地块 13 是唯一跨格的格子', masterSlot && masterSlot.rowSpan === 2 && masterSlot.columnSpan === 2, masterSlot);
    // 组 9/10/13/14 在 4 列棋盘上占 0-based 行2..3、列0..1 → 1-based 第3行第1列
    check('主地块锚点用整组最小行列(第3行第1列)',
        masterSlot && masterSlot.row === 3 && masterSlot.column === 1, masterSlot);

    // slots 只含要渲染的格子: 24 - 被合并的 3 块 = 21
    check('可渲染格子数 = 24 - 3', board.slots.length === 21, board.slots.length);
    check('副地块不在可渲染格子里',
        !board.slots.some(s => board.groupedSlaveIds.includes(s.landId)),
        board.slots.map(s => s.landId));
}

section('3. 多组合种: 每组都要正确合并');
{
    // 抓包 20261027-135436 实测两组: 7←[3,8,4] 和 15←[11,16,12]
    const lands = makeLands([[7, 3, 8, 4], [15, 11, 16, 12]]);
    const board = buildLandBoard(lands);
    check('两组都推断成 4 列', board.columns === 4, board.columns);
    check('两组副地块都被合并', board.groupedSlaveIds.length === 6, board.groupedSlaveIds);
    check('两组主地块都在可渲染格子里',
        board.slots.filter(s => s.rowSpan === 2).map(s => s.landId).sort((a, b) => a - b).join(',') === '7,15',
        board.slots.filter(s => s.rowSpan === 2));

    const slot7 = board.slots.find(s => s.landId === 7);
    const slot15 = board.slots.find(s => s.landId === 15);
    check('主地块 7 跨 2x2', slot7.rowSpan === 2 && slot7.columnSpan === 2, slot7);
    check('主地块 15 跨 2x2', slot15.rowSpan === 2 && slot15.columnSpan === 2, slot15);
    check('两组锚点不重叠', slot7.row !== slot15.row || slot7.column !== slot15.column, { slot7, slot15 });
}

section('4. 只有主地块带作物时才算合种');
{
    // 收获后服务端会清空主地块的 slave_land_ids, 这时不该再占 4 格
    const lands = makeLands();
    lands.find(l => l.id === 5).slave_land_ids = [1, 6, 2];
    // 主地块没有 plant → 不算合种
    const board = buildLandBoard(lands);
    check('空主地块不合并副地块', board.groupedSlaveIds.length === 0, board.groupedSlaveIds);
    check('空主地块的 span 还是 1x1',
        (() => {
            const s = board.slots.find(x => x.landId === 5);
            return s.rowSpan === 1 && s.columnSpan === 1;
        })(), board.slots.find(x => x.landId === 5));
}

section('5. 没有合种作物时按最接近正方形摆放');
{
    const lands = makeLands();
    const board = buildLandBoard(lands);
    check('24 块地 → 4 列', board.columns === 4, board.columns);
    check('没有合并任何地块', board.groupedSlaveIds.length === 0, board.groupedSlaveIds);
    check('每块地都是 1x1 span', board.slots.every(s => s.rowSpan === 1 && s.columnSpan === 1), board.slots[0]);
    check('地块数量 = 24', board.slots.length === 24, board.slots.length);
}

section('6. 组关系对不上时保持逐块渲染(不能漏格子)');
{
    // 人为造一组在 4 列下也拼不成矩形的关系: 主地块 1, 副地块 [10, 15, 20]
    const lands = makeLands([[1, 10, 15, 20]]);
    const board = buildLandBoard(lands);
    check('组不合法时不合并', board.groupedSlaveIds.length === 0, board.groupedSlaveIds);
    check('全部 24 块地都能渲染', board.slots.length === 24, board.slots.length);
    check('主地块仍是 1x1', (() => {
        const s = board.slots.find(x => x.landId === 1);
        return s.rowSpan === 1 && s.columnSpan === 1;
    })(), board.slots.find(x => x.landId === 1));
}

section('7. 列数推断的容错');
{
    check('空列表不会崩', buildLandBoard([]).columns >= 1, buildLandBoard([]));
    check('非 24 块(如 12 块) 也能整除',
        12 % resolveBoardColumns(Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }))) === 0,
        resolveBoardColumns(Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }))));
}

section('8. getLandsDetail 的汇总按作物计数(2x2 只算 1 棵)');
{
    const { types } = require(`${SB}/src/utils/proto`);
    const proto = require(`${SB}/src/utils/proto`);
    const network = require(`${SB}/src/utils/network`);
    const plantCallNames = [];
    // 24 块地里 1 组 2x2 已成熟: 主地块 13 成熟, 副地块 9/14/10 无 plant
    const rawLands = [];
    for (let id = 1; id <= 24; id++) {
        const land = { id, unlocked: true, level: 4, max_level: 6, could_upgrade: false };
        if (id === 13) {
            land.plant = { id: 1029005, name: '森野黄金芽', phases: [{ phase: 6, begin_time: 0 }] };
            land.slave_land_ids = [9, 14, 10];
        }
        if ([9, 14, 10].includes(id)) land.master_land_id = 13;
        rawLands.push(land);
    }
    const replies = {
        AllLands: () => types.AllLandsReply.encode(types.AllLandsReply.create({ lands: rawLands })).finish(),
        WaterLand: () => types.WaterLandReply.encode(types.WaterLandReply.create({})).finish(),
        WeedOut: () => types.WeedOutReply.encode(types.WeedOutReply.create({})).finish(),
        UpgradeLand: () => types.UpgradeLandReply.encode(types.UpgradeLandReply.create({})).finish(),
    };
    network.sendMsgAsync = async (_service, method) => {
        plantCallNames.push(method);
        const make = replies[method];
        if (!make) throw new Error('unexpected ' + method);
        return { body: Buffer.from(make()) };
    };
    proto.loadProto().then(async () => {
        const farm = require(`${SB}/src/services/farm`);
        const detail = await farm.getLandsDetail();
        check('汇总里可收 = 1(一棵 2x2 作物), 不是 4', detail.summary.harvestable === 1, detail.summary);
        check('汇总里空地 = 20(24 格 - 4 格合种)', detail.summary.empty === 20, detail.summary);
        check('返回了棋盘布局', !!detail.board && detail.board.columns === 4, detail.board && detail.board.columns);
        check('棋盘把副地块合并掉', detail.board.groupedSlaveIds.length === 3, detail.board.groupedSlaveIds);

        section('9. 点到副地块时归属主地块');
        {
            plantCallNames.length = 0;
            const r = await farm.operateSingleLand({ landId: 9, op: 'water' });
            check('浇水打到主地块 13', r.landId === 13, r);
            check('确实发了 WaterLand', plantCallNames.includes('WaterLand'), plantCallNames);

            plantCallNames.length = 0;
            const upgrade = await farm.operateSingleLand({ landId: 9, op: 'upgrade' });
            check('升级仍落在原地块 9', upgrade.landId === 9, upgrade);
        }

        section('10. 前端带上 masterLandId 时不再多拉一次全量地块');
        {
            // 面板渲染的就是主地块: 前端把 masterLandId 一起传来, 后端不需要再拉 AllLands
            plantCallNames.length = 0;
            const r = await farm.operateSingleLand({ landId: 13, masterLandId: 13, op: 'water' });
            check('直接按传入的主地块浇水', r.landId === 13, r);
            check('没有为此额外发 AllLands', !plantCallNames.includes('AllLands'), plantCallNames);

            // 没带 masterLandId 时仍走兜底快照(向后兼容老前端)
            plantCallNames.length = 0;
            const fallback = await farm.operateSingleLand({ landId: 9, op: 'weed' });
            check('未带 masterLandId 时兜底拉快照', plantCallNames.includes('AllLands'), plantCallNames);
            check('兜底也能归属到主地块 13', fallback.landId === 13, fallback);
        }

        finish();
    });
}