/**
 * 土地变异解析回归测试
 *
 * 覆盖服务端下发的植物级/阶段级 mutant_config_id，确保基础效果变异
 * (冰冻/爱心/暗化/湿润)与品质变异都能映射到名称、品质、效果和展示元数据。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'mutation-resolution');

const gameConfig = require(`${SB}/src/config/gameConfig`);
const PLANT_ID = 1020165;

const expected = [
    [1, '冰冻', '无', '果实售价×3'],
    [2, '爱心', '无', '果实数量×3'],
    [3, '暗化', '无', '果实售价×2'],
    [4, '湿润', '无', '果实数量×2'],
    [5, '黄金_天工', '天工', '黄金果实'],
    [6, '黄金_珍品', '珍品', '黄金果实'],
    [7, '黄金_稀有', '稀有', '黄金果实'],
    [8, '荷华_珍品', '珍品', '荷花'],
    [9, '荷华_稀有', '稀有', '荷花'],
    [10, '月华', '天工', '装扮'],
    [11, '塔塔', '天工', '装扮'],
];

section('1. 已知变异枚举均返回完整展示信息');
for (const [id, name, quality, effect] of expected) {
    const meta = gameConfig.getMutantByEnumId(id);
    const info = gameConfig.resolveMutationInfo(PLANT_ID, [id]);
    check(`#${id} 名称为 ${name}`, meta && meta.name === name, meta);
    check(`#${id} 品质为 ${quality}`, info && info.mutationQuality === quality, info);
    check(`#${id} 效果为 ${effect}`, info && info.mutationEffect === effect, info);
    check(`#${id} 有图标/颜色/说明`, !!(info && info.mutationIcon && info.mutationColor && info.mutationDescription), info);
}

section('2. 阶段级 mutant_config_id 与植物级 ID 会合并去重');
const phaseOnly = gameConfig.resolveMutationInfo(PLANT_ID, [], [
    { mutants: [{ mutant_config_id: 4 }] },
]);
check('仅阶段级 ID 也能识别湿润', phaseOnly.mutationType === '湿润', phaseOnly);
check('阶段级 ID 效果正确', phaseOnly.mutationEffect === '果实数量×2', phaseOnly);
check('阶段级 ID 被记录', phaseOnly.mutantConfigIds.length === 1 && phaseOnly.mutantConfigIds[0] === 4, phaseOnly);

const merged = gameConfig.resolveMutationInfo(PLANT_ID, [{ toNumber: () => 1 }], [
    { mutants: [{ mutant_config_id: 1 }, { mutant_config_id: 2 }] },
]);
check('植物级/阶段级 ID 合并去重', merged.mutantConfigIds.join(',') === '1,2', merged.mutantConfigIds);
check('多效果均被保留', merged.mutations.length === 2, merged.mutations);
check('主效果按品质和枚举顺序稳定', merged.mutationType === '冰冻' && merged.mutationEffect === '果实售价×3', merged);

section('3. 未知枚举不丢失，显示待确认效果');
const unknown = gameConfig.resolveMutationInfo(PLANT_ID, [14]);
check('未知枚举仍有类型', unknown.mutationType === '变异#14', unknown);
check('未知枚举标记为变异', unknown.isMutant === true, unknown);
check('未知枚举有占位效果', unknown.mutationEffect === '效果待确认', unknown);
check('未知枚举有说明', !!unknown.mutationDescription, unknown);

const unseen = gameConfig.getMutantByEnumId(99);
check('未列入配置的新 ID 也返回占位信息', unseen && unseen.name === '变异#99', unseen);

section('4. 无变异数据保持普通作物');
const plain = gameConfig.resolveMutationInfo(1020002, []);
check('普通作物不是变异', plain.isMutant === false, plain);
check('普通作物没有变异类型', plain.mutationType === null, plain);

finish();
