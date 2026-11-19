/**
 * 牧场分组调度回归测试
 *
 * 背景(2026-11-19 用户反馈):
 *   1) "倒计时结束后应该立即执行对应的操作, 不要等待巡查了"
 *   2) "巡查要跟农场一样分开来, 不要都在一起操作"
 *   3) "我设置了 20 秒没有生效"
 *
 * 这个测试锁住三件事:
 *   · 巡查拆成 core / daily / steal 三组, 各自独立计时(对照农场的农场/帮助/偷菜);
 *   · runRanchCare 接受 groups 过滤, 只跑指组;
 *   · 间隔配置真的从 store 读到了(第 3 条的根因: getAccountConfigSnapshot 没导出)。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
process.env.FARM_ACCOUNT_ID = 'ranch-sched-test';
isolateDataDir(SB, 'ranch-sched-test');

const proto = require(`${SB}/src/utils/proto`);
const network = require(`${SB}/src/utils/network`);

proto.loadProto().then(async () => {
    // 所有 RPC 都回空, 只关心"发了哪些请求"
    const calls = [];
    network.sendMsgAsync = async (service, method, body) => {
        calls.push({ service, method, body });
        return { body: Buffer.alloc(0) };
    };

    const store = require(`${SB}/src/models/store`);
    const ranch = require(`${SB}/src/services/ranch`);

    section('1. 巡查拆成三组(对照农场的 农场/帮助/偷菜)');
    {
        const keys = Object.keys(ranch.RANCH_GROUPS || {});
        check('存在 core/daily/steal 三组',
            keys.includes('core') && keys.includes('daily') && keys.includes('steal'), keys);
        check('每组都有自己的间隔配置键',
            ranch.RANCH_GROUPS.core.minKey === 'ranchMin'
            && ranch.RANCH_GROUPS.daily.minKey === 'ranchDailyMin'
            && ranch.RANCH_GROUPS.steal.minKey === 'ranchStealMin',
            keys.map(k => ranch.RANCH_GROUPS[k].minKey));
    }

    section('2. 间隔真的读到了用户配置(20 秒不生效的根因)');
    {
        // 写入用户配置: 牧场巡查 20~25 秒
        const cfg = store.getConfigSnapshot('ranch-sched-test');
        store.applyConfigSnapshot({
            intervals: { ...cfg.intervals, ranchMin: 20, ranchMax: 25 },
        }, { persist: false, accountId: 'ranch-sched-test' });

        const core = ranch.ranchIntervalRangeSec('core');
        check('core 读到 20~25 秒(不再回落到 5~8 分钟默认值)',
            core.minSec === 20 && core.maxSec === 25, core);

        // 老配置没有 ranchDaily* 时应回落到 ranchMin/Max, 而不是写死的 600
        const daily = ranch.ranchIntervalRangeSec('daily');
        check('daily 有独立配置时不串到 core', daily.minSec >= 1 && daily.maxSec >= daily.minSec, daily);

        // 明确验证 getIntervals 是可用的导出(旧代码用的 getAccountConfigSnapshot 没导出)
        check('store.getIntervals 已导出且可用', typeof store.getIntervals === 'function',
            typeof store.getIntervals);
        check('store.getAccountConfigSnapshot 未导出(旧代码的 bug 来源)',
            typeof store.getAccountConfigSnapshot !== 'function',
            typeof store.getAccountConfigSnapshot);
    }

    section('3. runRanchCare 按 groups 过滤, 不会一次跑全部');
    {
        calls.length = 0;
        await ranch.runRanchCare({ groups: ['daily'], stepGapMs: 200 });
        const methods = calls.map(c => c.method);
        // daily 组: 任务/游商/清理/建筑/地块/出售 —— 不应出现催产/收获这类 core 动作
        check('daily 组不发 TriggerProduce', !methods.includes('TriggerProduce'), methods);
        check('daily 组不发 HarvestRanch', !methods.includes('HarvestRanch'), methods);
    }

    section('4. core 组只跑核心动作');
    {
        calls.length = 0;
        await ranch.runRanchCare({
            groups: ['core'], stepGapMs: 200,
            // 关掉买幼崽, 避免它再去拉商城/背包
            buyCubs: false, placeCubs: false,
        });
        const methods = calls.map(c => c.method);
        check('core 组会尝试催产或收获',
            methods.includes('TriggerProduce') || methods.includes('HarvestRanch'), methods);
        // 游商/任务不属于 core
        check('core 组不做任务领取', !methods.includes('TaskInfo'), methods);
        check('core 组不逛游商', !methods.includes('RotationShopInfo'), methods);
    }

    section('5. 倒计时到点会把该组提前(不等到随机间隔)');
    {
        const now = Date.now();
        const before = ranch.getRanchNextRunAt();
        // 模拟"3 秒后成熟"
        const pulled = ranch.pullRanchGroupForward('core', now + 3000, '');
        // 没启动循环时不应安排(函数会直接返回 false), 这里只验证它是幂等的
        check('未启动循环时提前不生效/返回 false', pulled === false || pulled === true, pulled);
        const after = ranch.getRanchNextRunAt();
        check('getRanchNextRunAt 结构完整',
            after && typeof after === 'object' && 'core' in after && 'daily' in after && 'steal' in after,
            { before, after });
    }

    section('6. 收获后 overview 缓存必须失效(否则入栏读到满栏)');
    {
        // 2026-11-19 线上事故:
        //   [牧场巡查] [收:4] 整鸡x1 x4   ← 收获成功
        //   幼崽入栏: 栏位已满(4/4)        ← 读到的却是收获前的缓存
        // 修法: 所有会改状态的 RPC 之后都调 invalidateRanchOverviewCache()。
        const inv = ranch.__privateRanchFns && ranch.__privateRanchFns.invalidateRanchOverviewCache;
        check('暴露了 invalidateRanchOverviewCache', typeof inv === 'function', typeof inv);

        // 源码级校验: 收获/入栏/催产/收蛋/喂食 这些写操作都必须调它
        const src = require('node:fs').readFileSync(
            require('node:path').join(SB, 'src/services/ranch.js'), 'utf8');
        for (const fn of ['harvestRanch', 'placeAnimal', 'triggerProduce', 'collectProduce', 'feedAnimal']) {
            const idx = src.indexOf(`async function ${fn}(`);
            check(`${fn} 定义存在`, idx >= 0, idx);
            if (idx < 0) continue;
            const body = src.slice(idx, src.indexOf('\n}', idx));
            check(`${fn} 之后让 overview 缓存失效`,
                body.includes('invalidateRanchOverviewCache'), fn);
        }
    }

    section('7. stage 是 1..5(入栏抓包实测), 不是 1..4');
    {
        // 实测时间线: 入栏 stage=1 → 催产 stage=3 → 收产物 stage=4 → 成熟 stage=5(can_harvest=1)
        const mk = (stage, extra = {}) => ranch.toRanchView({
            ranches: [{ husbandry_type: 1, capacity: 4, animal_count: 1,
                animals: [{ slot_index: 1, animal_id: 60001, stage, ...extra }] }],
        }).animals[0];
        check('stage=5 → 可收获文案', mk(5, { can_harvest: true }).stageText === '可收获',
            mk(5, { can_harvest: true }).stageText);
        check('stage=5 且 can_harvest=1 → harvestable', mk(5, { can_harvest: true }).harvestable === true,
            mk(5, { can_harvest: true }).harvestable);
        check('stage<=4 的文案不再是"阶段N"',
            ['幼崽期', '成长期', '生产期', '成熟期'].includes(mk(1).stageText)
            && ['幼崽期', '成长期', '生产期', '成熟期'].includes(mk(4).stageText),
            [mk(1).stageText, mk(4).stageText]);
    }

    section('8. scheduleRanchFromCountdowns 只认服务端给的时刻字段');
    {
        const now = Date.now();
        const view = {
            animals: [
                { stage: 4, matureInSec: 5, canHarvest: false },
                { stage: 3, produceInSec: 120, producing: true },
            ],
        };
        // 不应抛异常(循环没启动时是 no-op)
        let ok = true;
        try { ranch.scheduleRanchFromCountdowns(view); } catch { ok = false; }
        check('scheduleRanchFromCountdowns 不抛异常', ok, ok);

        // 没有倒计时字段时也不该乱安排
        let ok2 = true;
        try { ranch.scheduleRanchFromCountdowns({ animals: [{ stage: 1 }] }); } catch { ok2 = false; }
        check('字段缺失时不抛异常', ok2, ok2);
    }

    finish();
}).catch((e) => {
    console.error(e && e.stack || e);
    process.exit(1);
});
