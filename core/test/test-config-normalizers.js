/**
 * 账号配置归一化表 回归测试
 *
 * 背景:
 *   applyConfigSnapshot 原本是 228 行、50 多个结构完全相同的
 *   `if (cfg.x != null) next.x = 归一化(cfg.x)` 分支, 新增一个设置项要复制
 *   4 行样板, 且很容易漏掉判空导致写入 undefined。
 *   现已改为"字段 → 归一化函数"的规格表(ACCOUNT_CONFIG_NORMALIZERS)。
 *
 *   这个测试守两件事:
 *   1. 归一化语义与重构前逐字段等价(越界裁剪 / 非法值回落 / 0 的特殊含义)
 *   2. 规格表不会悄悄漏掉已经存在的字段
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
const ACC = 'norm-test';
process.env.FARM_ACCOUNT_ID = ACC;
isolateDataDir(SB, 'norm-test');

const store = require(`${SB}/src/models/store`);
const apply = (cfg) => store.applyConfigSnapshot(cfg, { accountId: ACC, persist: false });

section('1. 越界值被裁剪到合法区间');
{
    check('stealDelaySeconds 超上限 → 300', apply({ stealDelaySeconds: 500 }).stealDelaySeconds === 300);
    check('stealDelaySeconds 负数 → 0', apply({ stealDelaySeconds: -5 }).stealDelaySeconds === 0);
    check('plantDelaySeconds 超上限 → 60', apply({ plantDelaySeconds: 999 }).plantDelaySeconds === 60);
    check('stealthOnlineMinMinutes 超上限 → 180', apply({ stealthOnlineMinMinutes: 1000 }).stealthOnlineMinMinutes === 180);
    check('robMaxPerRun 超上限 → 20', apply({ robMaxPerRun: 99 }).robMaxPerRun === 20);
    check('robDailyLimit 负数 → 0', apply({ robDailyLimit: -1 }).robDailyLimit === 0);
    check('fireworkCount 超上限 → 20', apply({ fireworkCount: 100 }).fireworkCount === 20);
    check('fertilizerBuyOrganicCount 超上限 → 10000', apply({ fertilizerBuyOrganicCount: 99999 }).fertilizerBuyOrganicCount === 10000);
    check('fertilizerBuyNormalThresholdHours 超上限 → 990', apply({ fertilizerBuyNormalThresholdHours: 5000 }).fertilizerBuyNormalThresholdHours === 990);
    check('milkTeaSeedBuyCount 0 → 1', apply({ milkTeaSeedBuyCount: 0 }).milkTeaSeedBuyCount === 1);
}

section('2. 非法值回落到安全默认, 且不抛错');
{
    let threw = null;
    try { apply({ stealDelaySeconds: 'abc', robMaxPerRun: {}, fireworkCount: [], milkTeaHireDuration: 'zz' }); }
    catch (e) { threw = e; }
    check('非法值不抛异常', threw === null, threw && threw.message);
    check('非法 fireworkMode → self', apply({ fireworkMode: 'nonsense' }).fireworkMode === 'self');
    check('合法 fireworkMode 保留', apply({ fireworkMode: 'friend' }).fireworkMode === 'friend');
}

section('3. 0 的特殊含义按字段分别保留');
{
    // 检测间隔原本是 `Number(x) || 30`: 0 会被当成"没填"落到 30
    check('检测间隔 0 → 30(falsy 回落, 与原实现一致)',
        apply({ fertilizerBuyCheckIntervalMinutes: 0 }).fertilizerBuyCheckIntervalMinutes === 30);
    check('检测间隔 5 原样保留', apply({ fertilizerBuyCheckIntervalMinutes: 5 }).fertilizerBuyCheckIntervalMinutes === 5);
    // 而 stealDelaySeconds 原本是 Number(x) || 0, 0 就是合法的 0
    check('偷取延迟 0 保留为 0', apply({ stealDelaySeconds: 0 }).stealDelaySeconds === 0);
}

section('4. 布尔/数组/文本字段');
{
    check('plantOrderRandom 1 → true', apply({ plantOrderRandom: 1 }).plantOrderRandom === true);
    check('stealthEnabled 0 → false', apply({ stealthEnabled: 0 }).stealthEnabled === false);
    check('数组过滤非数字与负数',
        JSON.stringify(apply({ plantBlacklist: [1, 2, 'x', -3] }).plantBlacklist) === '[1,2]',
        apply({ plantBlacklist: [1, 2, 'x', -3] }).plantBlacklist);
    check('字符串数字数组转成数字',
        JSON.stringify(apply({ plantSeedExclude: ['5', 6] }).plantSeedExclude) === '[5,6]');
    check('门店名截断到 20 字',
        apply({ milkTeaStoreName: 'x'.repeat(50) }).milkTeaStoreName.length === 20);
    check('雇主 GID 去空格',
        apply({ milkTeaEmployerGid: '  abc  ' }).milkTeaEmployerGid === 'abc');
}

section('5. null / undefined 不会被写入');
{
    const before = apply({}).adGiftEnabled;
    const after = apply({ adGiftEnabled: null });
    check('null 不改变原值', after.adGiftEnabled === before, { before, after: after.adGiftEnabled });
    const b2 = apply({}).plantSeedExclude;
    check('null 数组字段不改变原值',
        JSON.stringify(apply({ plantSeedExclude: null }).plantSeedExclude) === JSON.stringify(b2));
}

section('6. automation 子对象仍然逐键处理');
{
    const r = apply({ automation: { farm: 0, auto_use_items: 1 } });
    check('automation 布尔键正确写入', r.automation.farm === false && r.automation.auto_use_items === true, r.automation);
    const r2 = apply({ automation: { fertilizer: 'nonsense' } });
    check('非法 fertilizer 策略被忽略', r2.automation.fertilizer !== 'nonsense', r2.automation.fertilizer);
    const r3 = apply({ automation: { not_a_real_key: true } });
    check('未知 automation 键不写入', r3.automation.not_a_real_key === undefined);
}

section('7. 规格表覆盖了所有已知的可保存字段');
{
    // 这些字段在设置面板/README 里有, 必须都在归一化表里(或在显式分支里)
    const EXPECTED = [
        'stealDelaySeconds', 'plantDelaySeconds', 'plantOrderRandom', 'preferredSeedId',
        'stealthEnabled', 'stealthOnlineMinMinutes', 'stealthOfflineMaxMinutes', 'stealthWakeForRipe',
        'robTreasureIntervalMinutes', 'robMaxPerRun', 'robDailyLimit', 'buyBookEnabled', 'buyBookCount',
        'fireworkMode', 'fireworkCount', 'milkTeaHireDuration', 'milkTeaSeedBuyCount',
        'fertilizerBuyOrganicCount', 'fertilizerBuyCheckIntervalMinutes',
    ];
    const snap = apply({});
    const missing = EXPECTED.filter(k => snap[k] === undefined);
    check('所有已知字段都能读回', missing.length === 0, missing);
}

finish();
