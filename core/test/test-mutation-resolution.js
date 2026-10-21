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
    [6, '哈哈小南瓜', '珍品', '变异为哈哈小南瓜'],
    [7, '哈哈南瓜塔', '天工', '变异为哈哈南瓜塔'],
    [8, '荷花', '珍品', '变异为荷花'],
    [9, '月华宝荷', '天工', '变异为月华宝荷'],
    [10, '绵绵糖果', '稀有', '变异为绵绵糖果'],
    [11, '蝶梦星铃', '天工', '变异为蝶梦星铃'],
    [15, '闪电', '无', '闪电变异'],
    [16, '比熊棉花糖', '天工', '变异为比熊棉花糖'],
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

const lightning = gameConfig.resolveMutationInfo(PLANT_ID, [15]);
check('茱萸闪电变异识别为闪电', lightning.mutationType === '闪电', lightning);
check('闪电变异效果已确认', lightning.mutationEffect === '闪电变异', lightning);
check('闪电变异品质已确认', lightning.mutationQuality === '无', lightning);

const unseen = gameConfig.getMutantByEnumId(99);
check('未列入配置的新 ID 也返回占位信息', unseen && unseen.name === '变异#99', unseen);

section('4. 无变异数据保持普通作物');
const plain = gameConfig.resolveMutationInfo(1020002, []);
check('普通作物不是变异', plain.isMutant === false, plain);
check('普通作物没有变异类型', plain.mutationType === null, plain);

finish();
