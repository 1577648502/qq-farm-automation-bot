/**
 * 牧场等级换算 回归测试
 *
 * 线上发现(2026-11-18, 账号3): 总经验 560, 面板却显示"本级 3560/13000"
 *   —— 本级进度比总经验还大, 自相矛盾。
 *
 * 根因: 牧场等级只有 Lv9 一段是实测刻度(起点 10000, 每级 13000)。
 *   低于 10000 时按"每级 -13000"向下外推, 推出来的等级起点会是**负数**
 *   (exp=0 → Lv8, start=-3000), 于是 current = 0 - (-3000) = 3000。
 *
 * 这个测试锁住不变量:
 *   0 <= current <= min(totalExp, needed)
 * 无论经验落在哪个区间(实测段/外推段/边界)都必须成立。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'ranch-level-test');

const proto = require(`${SB}/src/utils/proto`);

proto.loadProto().then(async () => {
    const ranch = require(`${SB}/src/services/ranch`);
    const calc = ranch.__privateRanchFns.calcRanchLevel;

    section('1. 不变量: 本级进度不能超过总经验, 也不能为负');
    {
        // 覆盖外推段 / 实测段 / 边界值
        const samples = [0, 1, 560, 3560, 7000, 7966, 9999, 10000, 10001, 17966, 23000, 45999, 100000];
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

    section('2. 实测段(Lv9)行为不变');
    {
        const r = calc(17966);
        check('17966 → Lv9', r.level === 9, r.level);
        check('17966 → 本级 7966/13000', r.current === 7966 && r.needed === 13000, r);
        const r2 = calc(10000);
        check('10000 是 Lv9 起点 → 0/13000', r2.level === 9 && r2.current === 0, r2);
    }

    section('3. 外推段(低于 Lv9 起点)');
    {
        // 线上真实案例: 账号3 总经验 560
        const r = calc(560);
        check('560 → Lv8', r.level === 8, r.level);
        check('560 → 本级 560/13000(不是 3560)', r.current === 560, r.current);
        const z = calc(0);
        check('0 → 本级 0/13000(不是 3000)', z.current === 0, z.current);
    }

    section('4. 畸形输入不崩');
        for (const v of [null, undefined, 'abc', -100, Number.NaN]) {
            let ok = true;
            try {
                const r = calc(v);
                ok = Number.isFinite(r.level) && r.current >= 0 && r.needed > 0;
            } catch { ok = false; }
            check(`${String(v)} → 返回合法结构`, ok);
        }

    finish();
}).catch((e) => {
    console.error('测试异常:', e);
    process.exit(1);
});
