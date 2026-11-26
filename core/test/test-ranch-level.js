/**
 * 牧场等级换算 回归测试
 *
 * 历史(2026-11-18): 总经验 560, 面板显示"本级 3560/13000" 自相矛盾 —— 旧线性外推的负起点 bug, 已修。
 * 2026-11-26 定案: 等级表 = 官方 BigFarmLevel(delayRes bundle config/BigFarmLevel, 65级, 非线性)。
 *   六账号实测逐级吻合: 18级156080 / 19级167713 / 20级173212 / 21级205792+208027 / 38级731024。
 *   旧线性表(步进13000)把 205792 算成 Lv24, 已废; 只在 BigFarmLevel.json 缺失时兜底。
 *
 * 锁住不变量:
 *   0 <= current <= min(totalExp, needed), 且等级/进度与官方表一致。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'ranch-level-test');

const proto = require(`${SB}/src/utils/proto`);

proto.loadProto().then(async () => {
    const ranch = require(`${SB}/src/services/ranch`);
    const calc = ranch.__privateRanchFns.calcRanchLevel;
    // 官方表锚点(BigFarmLevel.json): Lv1=0 / Lv2=300 / Lv3=700 / Lv9=10000 / Lv10=23800
    const bigFarm = require(`${SB}/src/gameConfig/BigFarmLevel.json`);

    section('1. 不变量: 本级进度不能超过总经验, 也不能为负');
    {
        const samples = [0, 1, 560, 3560, 7000, 7966, 9999, 10000, 10001, 17966, 23000, 45999, 100000, 205792, 731024];
        const bad = [];
        for (const exp of samples) {
            const r = calc(exp);
            const ok = Number.isFinite(r.level) && r.level >= 1
                && r.current >= 0
                && r.current <= r.needed
                && r.current <= Math.max(0, exp);
            if (!ok) bad.push({ exp, ...r });
        }
        check('所有样本满足 0 <= current <= min(exp, needed)', bad.length === 0, bad);
    }

    section('2. 官方表实测锚点(六账号 2026-11-26)');
    {
        check('173212 → Lv20(账号3)', calc(173212).level === 20, calc(173212));
        check('167713 → Lv19(账号4)', calc(167713).level === 19, calc(167713));
        check('156080 → Lv18(账号6)', calc(156080).level === 18, calc(156080));
        check('205792 → Lv21(润出去激活时)', calc(205792).level === 21, calc(205792));
        check('208027 → Lv21(润出去现在)', calc(208027).level === 21, calc(208027));
        check('731024 → Lv38(账号1)', calc(731024).level === 38, calc(731024));
    }

    section('3. 官方表区间行为(Lv9=10000, Lv10=23800)');
    {
        const r = calc(17966);
        check('17966 → Lv9', r.level === 9, r.level);
        check('17966 → 本级 7966/13800(官方表 Lv10-Lv9)', r.current === 7966 && r.needed === 13800, r);
        const r2 = calc(10000);
        check('10000 是 Lv9 起点 → 0/13800', r2.level === 9 && r2.current === 0 && r2.needed === 13800, r2);
    }

    section('4. 低经验段(官方表 Lv1=0/Lv2=300/Lv3=700)');
    {
        // 线上真实案例: 总经验 560 → 官方表 Lv2(300<=560<700), 本级 260/400
        const r = calc(560);
        check('560 → Lv2(官方表, 不是线性外推的 Lv8)', r.level === 2, r.level);
        check('560 → 本级 260/400', r.current === 260 && r.needed === 400, r);
        const z = calc(0);
        check('0 → Lv1 0/300', z.level === 1 && z.current === 0 && z.needed === 300, z);
    }

    section('5. 畸形输入不崩');
        for (const v of [null, undefined, 'abc', -100, Number.NaN]) {
            let ok = true;
            try {
                const r = calc(v);
                ok = Number.isFinite(r.level) && r.current >= 0 && r.needed > 0;
            } catch { ok = false; }
            check(`${String(v)} → 返回合法结构`, ok);
        }

    check('BigFarmLevel.json 随仓库发布(65级)', Array.isArray(bigFarm) && bigFarm.length === 65, bigFarm && bigFarm.length);

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
