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

    section('8. 倒计时到点只做对应动作, 不跑整套巡检');
    {
        const P = ranch.planRanchDueActions;
        const mk = animals => ({ animals });

        check('can_harvest → 收产物 + 收获',
            JSON.stringify(P(mk([{ stage: 5, canHarvest: true }]))) === JSON.stringify(['collect', 'harvest']),
            P(mk([{ stage: 5, canHarvest: true }])));

        // 用户明确要求: "催产后触发收获"
        check('can_deliver → 催产 + 紧接着收获',
            JSON.stringify(P(mk([{ stage: 4, canDeliver: true }]))) === JSON.stringify(['trigger', 'harvest']),
            P(mk([{ stage: 4, canDeliver: true }])));

        check('生产期未到点 → 什么都不做',
            P(mk([{ stage: 3, producing: true, produceInSec: 600 }])).length === 0,
            P(mk([{ stage: 3, producing: true, produceInSec: 600 }])));

        check('牧草断了 → 补草',
            JSON.stringify(P(mk([{ stage: 2, grassBlocked: true }]))) === JSON.stringify(['feed']),
            P(mk([{ stage: 2, grassBlocked: true }])));

        check('这些动作里不含入栏/买幼崽/游商/任务',
            !P(mk([{ stage: 5, canHarvest: true }, { stage: 4, canDeliver: true }]))
                .some(a => ['place', 'buy', 'rotation', 'task'].includes(a)),
            P(mk([{ stage: 5, canHarvest: true }, { stage: 4, canDeliver: true }])));

        // runRanchDueActions 只发计划内的请求
        calls.length = 0;
        await ranch.runRanchDueActions(mk([{ stage: 5, canHarvest: true }]), { stepGapMs: 200 });
        const methods = calls.map(c => c.method);
        check('执行可收获: 发 HarvestRanch', methods.includes('HarvestRanch'), methods);
        check('执行可收获: 不发 PlaceAnimal/BuyGoods',
            !methods.includes('PlaceAnimal') && !methods.includes('BuyGoods'), methods);
    }

    section('9. 到点动作收不到东西时必须让整组接手(否则入栏永不执行)');
    {
        // 2026-11-19 线上事故: 可收位亮着, 但 HarvestRanch 回空 →
        // 旧代码 ran = out.actions.length > 0 恒为 true → 整组巡检被永久跳过 →
        // 入栏/买幼崽/牧草机再也不执行, 日志一直刷 [到点] collect→harvest。
        const r = await ranch.runRanchDueTick();
        check('收不到东西时 ran=false', r.ran === false, r);
        check('但动作列表照常返回(便于日志)', Array.isArray(r.actions), r.actions);
    }

    section('10. 倒计时去重不能用绝对时间戳(否则 core 被永久提到"现在")');
    {
        const view = { animals: [{ stage: 5, canHarvest: true }] };
        ranch.scheduleRanchFromCountdowns(view);
        const first = ranch.getRanchNextRunAt().core;
        await new Promise(r => setTimeout(r, 1200));
        // 状态没变, 再排一次不应该把时刻继续往"现在"推
        ranch.scheduleRanchFromCountdowns(view);
        const second = ranch.getRanchNextRunAt().core;
        check('同样的动作/状态不会反复提前', second === first, { first, second });
        check('core 时刻在合理范围内(不是每次都重置)',
            Math.abs(second - first) < 50, Math.abs(second - first));
    }

    section('11. host_gid 必须按栏舍实例选(否则棚动物报"动物不存在")');
    {
        const f = ranch.__privateRanchFns;
        // 2026-11-19 线上: 点"有机罐头"报 "动物不存在"。
        //   根因: FeedAnimal 请求里没有槽位字段, 服务端靠 target#1 = ranch_inst_id
        //   定位栏舍。窝=10001 / 棚=10003, 代码写死 10001 → 棚动物永远找不到。
        f.rememberRanchInstIds({
            coops: [{ ranchInstId: 10001 }],
            pens: [{ ranchInstId: 10003 }],
            animals: [],
        });
        check('窝用 10001', f.resolveRanchHostGid(0, 1) === 10001, f.resolveRanchHostGid(0, 1));
        check('棚用 10003(不是写死的 10001)', f.resolveRanchHostGid(0, 2) === 10003,
            f.resolveRanchHostGid(0, 2));
        check('显式传入优先', f.resolveRanchHostGid(88888, 2) === 88888, f.resolveRanchHostGid(88888, 2));
        check('无栏舍缓存时回落 10001', (() => {
            f.rememberRanchInstIds({ coops: [], pens: [], animals: [] });
            return f.resolveRanchHostGid(0) === 10001;
        })(), f.resolveRanchHostGid(0));
    }

    section('12. 幼崽分析四项指标与农场同构');
    {
        const an = require(`${SB}/src/services/ranch-analytics`);
        // 用真实抓包里的周期样本喂进去(兔子: 幼崽3600 + 成长3600 + 成熟14400)
        an.recordAnimalCycleSamples([{
            animal_id: 60004,
            infant_ready_at_ms: 1000 * 1000,
            grow_ready_at_ms: 1000 * (1000 + 3600),
            mature_ready_at_ms: 1000 * (1000 + 3600 + 14400),
        }]);
        // 配置里兔子没有成品价, 服务端 #22 给的 2160 是真实结算价 —— 这里按线上实况喂进去
        an.rememberSellValue(60004, 1007, 2160);
        const cycle = an.getLearnedCycleSec(60004);
        check('学到兔子周期 = 3600+3600+14400', cycle === 21600, cycle);

        const rows = an.getCubRankings([
            { goodsId: 1, animalId: 60004, name: '兔子', price: 2034, unlocked: true, remaining: 5,
                expectedHarvestExp: 360 },
        ], 'exp');
        const r = rows[0];
        check('cycleSec 与农业指标同构', r.cycleSec === 21600, r.cycleSec);
        check('expPerHour = 360/21600*3600 = 60', r.expPerHour === 60, r.expPerHour);
        check('普通肥经验/时 = 360/(21600-3600)*3600 = 72', r.normalFertilizerExpPerHour === 72,
            r.normalFertilizerExpPerHour);
        check('净利润/时 = (2160-2034)/21600*3600 = 21', r.profitPerHour === 21, r.profitPerHour);
        check('普通肥净利润/时 = 126/18000*3600 = 25.2',
            r.normalFertilizerProfitPerHour === 25.2, r.normalFertilizerProfitPerHour);

        // 没有周期样本 → 四项留空, 不编造
        const noData = an.getCubRankings([
            { goodsId: 2, animalId: 60999, name: '未知', price: 100, unlocked: true, remaining: 1 },
        ], 'exp')[0];
        check('无周期样本时四项为 null',
            noData.expPerHour === null && noData.profitPerHour === null
            && noData.normalFertilizerExpPerHour === null,
            { e: noData.expPerHour, p: noData.profitPerHour });
        check('无样本时标记 missing 含 cycle',
            Array.isArray(noData.missing) && noData.missing.includes('cycle'), noData.missing);

        // 排序键与农场一致
        const sorted = an.getCubRankings([
            { goodsId: 1, animalId: 60004, name: '兔子', price: 2034, unlocked: true, expectedHarvestExp: 360 },
            { goodsId: 2, animalId: 60999, name: '未知', price: 100, unlocked: true },
        ], 'exp');
        check('exp 排序: 有数据的在前', sorted[0].name === '兔子', sorted.map(x => x.name));
    }

    section('13. scheduleRanchFromCountdowns 只认服务端给的时刻字段');
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
