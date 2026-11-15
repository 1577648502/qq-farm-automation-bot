/**
 * 土地等级/类型映射 回归测试
 *
 * 背景: 这套"等级 → 类型 → 中文名"原本散在后端 farm.js、前端 LandCard.vue、
 * 前端 Settings.vue 三处。2026-11 新增"蓝晶土地(6级)"时三处都要改,
 * 漏一处就会"设置里能勾蓝晶、地块卡片却显示空白"。
 * 现在唯一来源是 core/src/config/land-types.js, 前端通过 /api/game-version 取。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'land-types-test');

const lt = require(`${SB}/src/config/land-types`);

section('1. 等级 → 类型');
{
    check('0 级 → normal', lt.getLandTypeByLevel(0) === 'normal');
    check('1 级 → normal(黄土地归入普通档, 用于施肥范围)', lt.getLandTypeByLevel(1) === 'normal');
    check('2 级 → red', lt.getLandTypeByLevel(2) === 'red');
    check('3 级 → black', lt.getLandTypeByLevel(3) === 'black');
    check('4 级 → gold', lt.getLandTypeByLevel(4) === 'gold');
    check('5 级 → amethyst', lt.getLandTypeByLevel(5) === 'amethyst');
    check('6 级 → blue', lt.getLandTypeByLevel(6) === 'blue');
    check('超过 6 级也归 blue(上限档)', lt.getLandTypeByLevel(9) === 'blue');
    check('undefined → normal', lt.getLandTypeByLevel(undefined) === 'normal');
}

section('2. 类型 → 名称(长/短两套)');
{
    check('normal 长名 = 普通土地', lt.getLandTypeLabel('normal') === '普通土地');
    check('normal 短名 = 普通', lt.getLandTypeShortLabel('normal') === '普通');
    check('blue 长名 = 蓝晶土地', lt.getLandTypeLabel('blue') === '蓝晶土地');
    check('未知类型返回空串', lt.getLandTypeLabel('nope') === '');
}

section('3. 施肥范围勾选项');
{
    const opts = lt.getLandTypeOptions();
    check('共 6 项', opts.length === 6, opts);
    check('顺序为高等级在前', opts.map(o => o.value).join(',') === 'blue,amethyst,gold,black,red,normal',
        opts.map(o => o.value));
    check('每项都有中文名', opts.every(o => o.label && o.label.length > 0), opts);
}

section('4. 地块卡片的"等级 → 名称"表(含 1 级黄土地)');
{
    const levels = lt.getLandLevelLabels();
    check('共 7 档(0~6)', levels.length === 7, levels);
    check('按等级升序', levels.map(l => l.level).join(',') === '0,1,2,3,4,5,6', levels.map(l => l.level));
    const byLevel = Object.fromEntries(levels.map(l => [l.level, l.name]));
    check('0 级叫「普通」', byLevel[0] === '普通', byLevel);
    check('1 级叫「黄土地」', byLevel[1] === '黄土地', byLevel);
    check('5 级叫「紫晶土地」', byLevel[5] === '紫晶土地', byLevel);
    check('6 级叫「蓝晶土地」', byLevel[6] === '蓝晶土地', byLevel);
}

section('5. 施肥范围 key 与类型表保持一致');
{
    // LAND_TYPE_KEYS 必须都能查到名字, 否则前端勾选框会出现空 label
    const missing = lt.LAND_TYPE_KEYS.filter(k => !lt.getLandTypeLabel(k));
    check('每个施肥 key 都有名字', missing.length === 0, missing);
}

finish();
