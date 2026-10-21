/**
 * 新植物配置兜底回归测试
 *
 * 官方 Plant.json 偶尔落后于 ItemInfo.json。此时农场页仍应从种子物品
 * 推导名称、种子 id 和图标，背包也应能正确识别果实并允许出售。
 */
const { setupSandbox, isolateDataDir, createChecker } = require('./harness');

const SB = setupSandbox();
const { section, check, finish } = createChecker();
isolateDataDir(SB, 'plant-config-fallback');

const Long = require(`${SB}/node_modules/long`);
const gameConfig = require(`${SB}/src/config/gameConfig`);
const warehouse = require(`${SB}/src/services/warehouse`);

section('1. 茱萸使用完整兜底配置');
const plant = gameConfig.getPlantById(1020165);
check('植物 ID 可识别', plant && plant.id === 1020165, plant);
check('名称为茱萸', gameConfig.getPlantName(1020165) === '茱萸', gameConfig.getPlantName(1020165));
check('种子 ID 为 20165', plant && plant.seed_id === 20165, plant);
check('生长时间为 12 小时', gameConfig.getPlantGrowTime(1020165) === 43200, gameConfig.getPlantGrowTime(1020165));
check('经验为 1680', gameConfig.getPlantExp(1020165) === 1680, gameConfig.getPlantExp(1020165));

section('2. 森野系列全部新种子使用服务端生长时长兜底');
const activityPlants = [
    [1020525, 20525, '森野甜莓', 21600],
    [1020526, 20526, '森野白桃', 34560],
    [1020527, 20527, '森野甜橙', 25920],
    [1020528, 20528, '森野红柚', 43200],
    [1020021, 20021, '森野可可豆', 28800],
    [1021435, 21435, '森野柿子', 36000],
    [1020529, 20529, '森野芭乐', 30240],
    [1029005, 29005, '森野黄金芽', 34560],
];
for (const [plantId, seedId, name, growSec] of activityPlants) {
    const plant = gameConfig.getPlantById(plantId);
    check(`${name}种子配置可识别`, plant && plant.seed_id === seedId, plant);
    check(`${name}静态配置缺失生长时长`, gameConfig.getPlantGrowTime(plantId) === 0, gameConfig.getPlantGrowTime(plantId));
    check(
        `${name}服务端 grow_sec 可补全生长时长`,
        gameConfig.getPlantGrowTime(plantId, { grow_sec: Long.fromNumber(growSec) }) === growSec,
        gameConfig.getPlantGrowTime(plantId, { grow_sec: Long.fromNumber(growSec) }),
    );
}
const goldenBud = gameConfig.getPlantById(1029005);
check('森野黄金芽使用 2×2 兜底配置', goldenBud && goldenBud.size === 2, goldenBud);
check(
    '无 grow_sec 时可按 protobuf Long 阶段时间差补全',
    gameConfig.getPlantGrowTime(1020526, {
        phases: [
            { phase: 1, begin_time: Long.fromNumber(1792000000) },
            { phase: 2, begin_time: Long.fromNumber(1792010000) },
            { phase: 6, begin_time: Long.fromNumber(1792043200) },
        ],
    }) === 43200,
    gameConfig.getPlantGrowTime(1020526, {
        phases: [
            { phase: 1, begin_time: Long.fromNumber(1792000000) },
            { phase: 2, begin_time: Long.fromNumber(1792010000) },
            { phase: 6, begin_time: Long.fromNumber(1792043200) },
        ],
    }),
);
check(
    '已有静态生长配置优先，不被服务端值覆盖',
    gameConfig.getPlantGrowTime(1020165, { grow_sec: 1 }) === 43200,
    gameConfig.getPlantGrowTime(1020165, { grow_sec: 1 })
);

section('3. 种子反查与图标映射');
const plantBySeed = gameConfig.getPlantBySeedId(20165);
const seedImage = decodeURIComponent(gameConfig.getSeedImageBySeedId(20165));
check('种子 20165 可反查植物', plantBySeed && plantBySeed.id === 1020165, plantBySeed);
check('种子名称可反查', gameConfig.getPlantNameBySeedId(20165) === '茱萸');
check('种子图标存在', seedImage.endsWith('/20165_茱萸_Crop_165_Seed.png'), seedImage);

section('4. 其他 Plant.json 缺口由 ItemInfo 自动兜底');
const inferredPlant = gameConfig.getPlantById(1020107);
const inferredImage = decodeURIComponent(gameConfig.getSeedImageBySeedId(20107));
check('仙人掌名称可推导', gameConfig.getPlantName(1020107) === '仙人掌', gameConfig.getPlantName(1020107));
check('仙人掌种子 ID 可推导', inferredPlant && inferredPlant.seed_id === 20107, inferredPlant);
check('缺失经验字段按 0 处理', gameConfig.getPlantExp(1020107) === 0, gameConfig.getPlantExp(1020107));
check('仙人掌图标存在', inferredImage.endsWith('/20107_仙人掌_Crop_107_Seed.png'), inferredImage);

section('5. 官方配置与未知植物行为不变');
check('白萝卜仍使用官方配置', gameConfig.getPlantName(1020002) === '白萝卜', gameConfig.getPlantName(1020002));
check('未知植物仍显示占位名', gameConfig.getPlantName(1999999) === '植物1999999', gameConfig.getPlantName(1999999));

section('6. Plant.json 缺失果实可按 ItemInfo 反查');
const missingFruits = [
    [40092, 20092, 1020092, '稀世琉璃果'],
    [40107, 20107, 1020107, '仙人掌'],
    [40111, 20111, 1020111, '粉玫瑰'],
    [40113, 20113, 1020113, '栀子花'],
    [40114, 20114, 1020114, '蓝玫瑰'],
    [40118, 20118, 1020118, '水仙花'],
    [40123, 20123, 1020123, '海棠花'],
    [40130, 20130, 1020130, '琼花'],
    [40136, 20136, 1020136, '毛蟹爪莲'],
    [40165, 20165, 1020165, '茱萸'],
    [40219, 20219, 1020219, '路易十四'],
    [40265, 20265, 1020265, '朱雀花'],
    [40266, 20266, 1020266, '羊乳花'],
];
for (const [fruitId, seedId, plantId, name] of missingFruits) {
    const inferred = gameConfig.getPlantByFruitId(fruitId);
    check(`${name} ${fruitId} 可反查植物`, inferred && inferred.id === plantId && inferred.seed_id === seedId, inferred);
    check(`${name} 果实名称正确`, gameConfig.getFruitName(fruitId) === name, gameConfig.getFruitName(fruitId));
}

section('7. 背包果实分类与出售识别');
const bagDetail = warehouse.__privateWarehouseFns.buildBagDetailFromItems([
    { id: 40165, count: 2, uid: 90001 },
    { id: 80001, count: 1, uid: 90002 },
]);
const zhuyuRow = bagDetail.items.find((item) => item.id === 40165);
const fertilizerRow = bagDetail.items.find((item) => item.id === 80001);
check('茱萸在背包中归类为果实', zhuyuRow && zhuyuRow.category === 'fruit', zhuyuRow);
check('茱萸可按 103 金币出售', warehouse.getSellBlockReason(40165) === '', warehouse.getSellBlockReason(40165));
check('非果实道具仍不可出售', fertilizerRow && fertilizerRow.sellable === false && warehouse.getSellBlockReason(80001) === '不是果实', fertilizerRow);

finish();
