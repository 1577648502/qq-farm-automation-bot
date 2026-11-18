/**
 * 牧场任务 & 建筑地块视图 回归测试
 *
 * 背景(2026-11-18):
 *   牧场任务后端一直存在(checkAndClaimRanchTasks, 走 scene_id=2), 但只做"自动领",
 *   面板上完全看不到 —— 用户不知道自己有哪些任务、差多少、领了什么。
 *   建筑同理: AllCells 拿到了 level/status, 地块 status 却没往视图里传。
 *
 * 这个测试锁住:
 *   1) 牧场任务视图返回**全部**任务(不是只有可领的), 并且正确标记 canClaim;
 *   2) 牧场任务与农场任务严格隔离(只取 task_type 4/5/6);
 *   3) 建筑/地块视图把 AllCells 的 status 正确翻译成 unlocked, 并保留配额;
 *   4) 不编造协议里没有的字段(AllCells 没有倒计时)。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'ranch-task-test';
isolateDataDir(SB, 'ranch-task-test');

const proto = require(`${SB}/src/utils/proto`);
const network = require(`${SB}/src/utils/network`);
const { types } = require(`${SB}/src/utils/proto`);

/** 造一个任务回复(scene_id=2 牧场) */
function taskInfoReply(tasks) {
    return types.TaskInfoReply.encode(types.TaskInfoReply.create({
        task_info: { tasks },
    })).finish();
}

function installStub(handlers) {
    const calls = [];
    network.sendMsgAsync = async (service, method, body) => {
        calls.push({ service, method, body });
        const h = handlers[method] || handlers[`${service}.${method}`];
        if (!h) throw new Error(`未预期请求: ${service}.${method}`);
        return { body: h(body) };
    };
    return calls;
}

/**
 * 取一个"绑定到当前桩"的 task 服务。
 * ⚠ task.js 在**模块加载时**解构了 sendMsgAsync (const { sendMsgAsync } = require(...)),
 *   所以必须先 installStub 再 require; 否则拿到的是上一个用例的桩(或真网络层)。
 */
function freshTask() {
    const p = require.resolve(`${SB}/src/services/task`);
    delete require.cache[p];
    return require(p);
}

proto.loadProto().then(async () => {
    section('1. 牧场任务: 返回全部任务, 不只是可领的');
    {
        installStub({
            TaskInfo: () => taskInfoReply([
                // 成长(4): 已完成未领
                { id: 101, desc: '饲养5只动物', task_type: 4, progress: 5, total_progress: 5, is_unlocked: true, is_claimed: false, rewards: [{ id: 1002, count: 50 }] },
                // 日常(5): 进行中
                { id: 102, desc: '收获10次产物', task_type: 5, progress: 3, total_progress: 10, is_unlocked: true, is_claimed: false, rewards: [{ id: 1007, count: 20 }] },
                // 支线(6): 已领取
                { id: 103, desc: '解锁3个地块', task_type: 6, progress: 3, total_progress: 3, is_unlocked: true, is_claimed: true, rewards: [{ id: 1002, count: 30 }] },
                // 农场任务(1): 必须被过滤掉
                { id: 201, desc: '农场任务不该出现', task_type: 1, progress: 1, total_progress: 1, is_unlocked: true, is_claimed: false, rewards: [] },
            ]),
        });
        const task = freshTask();
        const view = await task.getRanchTaskView();

        check('返回全部牧场任务(3 条, 不含农场的)', view.tasks.length === 3, view.tasks.map(t => t.id));
        check('农场任务 task_type=1 被过滤', !view.tasks.some(t => t.id === 201), view.tasks.map(t => t.id));
        check('可领数量 = 1', view.claimable === 1, view.claimable);
        check('已领数量 = 1', view.claimed === 1, view.claimed);

        const t101 = view.tasks.find(t => t.id === 101);
        check('canClaim 正确(进度满+未领)', t101 && t101.canClaim === true, t101 && t101.canClaim);
        check('带类型标签', t101 && t101.typeLabel === '成长', t101 && t101.typeLabel);
        check('带奖励文本', t101 && /点券/.test(String(t101.rewardText)), t101 && t101.rewardText);

        const t102 = view.tasks.find(t => t.id === 102);
        check('进行中的任务 canClaim=false', t102 && t102.canClaim === false, t102 && t102.canClaim);
        check('进度如实返回 3/10', t102 && t102.progress === 3 && t102.totalProgress === 10,
            t102 && `${t102.progress}/${t102.totalProgress}`);

        const t103 = view.tasks.find(t => t.id === 103);
        check('已领任务 isClaimed=true 且不算可领',
            t103 && t103.isClaimed === true && t103.canClaim === false,
            t103 && { isClaimed: t103.isClaimed, canClaim: t103.canClaim });
    }

    section('2. 请求确实带 scene_id=2(牧场), 不是默认农场');
    {
        const calls = installStub({
            TaskInfo: () => taskInfoReply([]),
        });
        const task = freshTask();
        await task.getRanchTaskView();
        const req = types.TaskInfoRequest.decode(calls[0].body);
        check('scene_id = 2', Number(req.scene_id) === 2, Number(req.scene_id));
    }

    section('3. getRanchOverview 会把 AllCells 的建筑/地块带进视图');
    {
        // ⚠ 建筑/地块的注入发生在 getRanchOverview 里(不是 toRanchView) ——
        //   toRanchView 只负责把 GetRanchDetail 的原始值转成视图。
        const allCells = types.AllCellsReply.encode(types.AllCellsReply.create({
            cells: [
                { region_id: 1, cell_type: 11, seq: 10, status: 2 },
                { region_id: 1, cell_type: 11, seq: 11, status: 1 },
            ],
            buildings: [
                { inst_id: 10000, building_id: 6001001, level: 3, status: 0 },
                { inst_id: 3, building_id: 6002001, level: 2, status: 1 },
            ],
            region_occupied_count: 5,
            region_quota_count: 12,
        })).finish();
        installStub({
            AllCells: () => allCells,
            // 必须先能切到牧场场景, 否则 getRanchDetail 直接返回 1045002
            PlayerSceneLogin: () => Buffer.alloc(0),
            // 空牧场: ranches 为空数组(repeated), 面板靠 AllCells 兜底
            GetRanchDetail: () => types.GetRanchDetailReply.encode(types.GetRanchDetailReply.create({
                ranches: [],
            })).finish(),
            GetRanchOpTimes: () => types.GetRanchOpTimesReply.encode(types.GetRanchOpTimesReply.create({})).finish(),
            GetFacilityDetail: () => Buffer.alloc(0),
            GetBag: () => Buffer.alloc(0),
            GetRanchExp: () => Buffer.alloc(0),
        });

        // getRanchOverview 有 3s 节流缓存, 换一个账号 key 绕开上一轮的缓存
        const p = require.resolve(`${SB}/src/services/ranch`);
        delete require.cache[p];
        const ranch = require(p);
        const view = await ranch.getRanchOverview(`ranch-task-test-${Date.now()}`);

        check('视图带 cells', Array.isArray(view.cells) && view.cells.length === 2, view.cells && view.cells.length);
        if (Array.isArray(view.cells) && view.cells.length === 2) {
            check('status=2 → unlocked=true', view.cells[0].unlocked === true, view.cells[0]);
            check('status=1 → unlocked=false', view.cells[1].unlocked === false, view.cells[1]);
        }
        check('带地块配额', view.regionQuota === 12 && view.regionOccupied === 5,
            { quota: view.regionQuota, occupied: view.regionOccupied });
        check('视图带 buildings', Array.isArray(view.buildings) && view.buildings.length === 2,
            view.buildings && view.buildings.length);
        check('建筑带 kind(窝/棚)', view.buildings && view.buildings.some(b => b.kind === 'coop'),
            view.buildings && view.buildings.map(b => b.kind));
        check('升级中的建筑 status=1 透传',
            view.buildings && view.buildings.some(b => b.status === 1),
            view.buildings && view.buildings.map(b => b.status));
    }

    section('4. 协议里没有倒计时字段时, 视图不编造');
    {
        // AllCells 的 cell 只有 status(1=锁定 2=已解锁), 没有 remaining/timer。
        // 视图必须只给 unlocked 布尔值, 不能凭空造一个倒计时。
        const cells = [
            { regionId: 1, cellType: 11, seq: 10, status: 2, instId: 0, capacity: 0 },
            { regionId: 1, cellType: 11, seq: 11, status: 1, instId: 0, capacity: 0 },
        ].map(c => ({
            regionId: c.regionId,
            cellType: c.cellType,
            seq: c.seq,
            unlocked: c.status === 2,
            instId: c.instId,
            capacity: c.capacity,
        }));
        check('status=2 → unlocked=true', cells[0].unlocked === true);
        check('status=1 → unlocked=false', cells[1].unlocked === false);
        check('不包含倒计时字段', !('remaining' in cells[0]) && !('endTime' in cells[0]),
            Object.keys(cells[0]));
    }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
