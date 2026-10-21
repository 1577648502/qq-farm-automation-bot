/**
 * 游戏配置数据模块
 * 从 gameConfig 目录加载配置数据
 */

const fs = require('node:fs');
const path = require('node:path');
const { getResourcePath, getDataDir } = require('./runtime-paths');

// ============ 等级经验表 ============
let roleLevelConfig = null;
let levelExpTable = null;  // 累计经验表，索引为等级

// ============ 植物配置 ============
let plantConfig = null;
const plantMap = new Map();  // id -> plant
const seedToPlant = new Map();  // seed_id -> plant
const fruitToPlant = new Map();  // fruit_id -> plant (果实ID -> 植物)
let itemInfoConfig = null;
const mutantTypeMap = new Map();
let mutantTypesData = null;

/**
 * 获取变异类型配置
 */
function getMutantType(typeName) {
    return mutantTypeMap.get(typeName) || null;
}

/**
 * 根据品质获取变异类型列表
 */
function getMutantTypesByQuality(quality) {
    const result = [];
    for (const [name, cfg] of mutantTypeMap) {
        if (cfg.quality === quality) result.push({ name, ...cfg });
    }
    return result;
}

/**
 * 获取所有变异类型
 */
/**
 * 按枚举 ID 找变异(2026-09-30): plant.mutant_config_ids 与背包 mutant_types 用的是同一套枚举
 * 已知类型看 enumIds; 抓包见过但未命名的走 unknownEnumIds → 返回 "变异#id"
 */
function getMutantByEnumId(enumId) {
    const id = Number(enumId) || 0;
    if (!id) return null;
    for (const [name, cfg] of mutantTypeMap) {
        const ids = Array.isArray(cfg.enumIds) ? cfg.enumIds : [];
        if (ids.includes(id)) {
            return {
                name,
                quality: cfg.quality || '无',
                qualityRank: Number(cfg.qualityRank) || 0,
                key: name,
                effect: cfg.effect || '',
                description: cfg.description || '',
                probability: Number(cfg.probability) || 0,
                color: cfg.color || '#6B7280',
                icon: cfg.icon || '?',
                enumId: id,
            };
        }
    }
    const unknownMap = (mutantTypesData && mutantTypesData.unknownEnumIds) || {};
    const unknown = unknownMap[String(id)] || {};
    return {
        name: `变异#${id}`,
        quality: '未知',
        qualityRank: 9,
        key: `UNKNOWN_${id}`,
        effect: '效果待确认',
        description: unknown.note || '服务端下发了未收录的变异配置',
        probability: 0,
        color: '#6B7280',
        icon: '?',
        enumId: id,
    };
}

function getAllMutantTypes() {
    const result = {};
    for (const [name, cfg] of mutantTypeMap) {
        result[name] = cfg;
    }
    return result;
}

/**
 * 判断植物是否是黄金变异植物
 */
function isGoldenPlant(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant) return false;
    if (String(plant.harvestAniName || "") === "anim_harvest_gold") return true;
    if (String(plant.name || "").startsWith("黄金·")) return true;
    return false;
}

/**
 * 判断是否是黄金变异果实
 */
function isGoldenFruit(fruitId) {
    const item = itemInfoMap.get(Number(fruitId) || 0);
    if (!item) return false;
    return String(item.asset_name || "").startsWith("gold/");
}

/**
 * 解析植物变异配置 (从 mutant_effect_plant 字段)
 */
function getPlantMutantConfig(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.mutant_effect_plant) return [];
    const raw = String(plant.mutant_effect_plant).trim();
    if (!raw) return [];
    const entries = raw.split(";").filter(Boolean);
    const result = [];
    for (const entry of entries) {
        const parts = entry.split(":");
        if (parts.length >= 3) {
            result.push({
                phase: parts[0],
                targetPlantId: Number(parts[1]) || 0,
                probability: Number(parts[2]) || 1,
            });
        }
    }
    return result;
}

/**
 * 根据植物ID和目标植物ID确定变异类型名称
 */
function determineMutationType(sourcePlantId, targetPlantId, sourceName, targetName) {
    if (!targetName && !sourceName) return null;
    const name = targetName || sourceName || "";
    const srcName = sourceName || "";

    // 月华 mutation - target name contains 月华
    if (name.includes("月华") || srcName.includes("月华")) return "月华";
    
    // 塔塔 mutation - target/source related to 塔
    if (name.includes("塔") || srcName.includes("塔") || srcName.includes("哈哈")) return "塔塔";
    
    // 荷华 mutation - plants that mutate to 荷花
    if (name.includes("荷花") || name.includes("荷") || srcName.includes("荷花") || srcName.includes("荷")) {
        return "荷华";
    }
    
    // 黄金 mutation - golden plants
    if (name.startsWith("黄金·") || srcName.startsWith("黄金·")) {
        return "黄金";
    }

    return null;
}

/**
 * 确定变异品质等级
 */
function determineMutationQuality(mutationType, plantLevel) {
    if (mutationType === "月华" || mutationType === "塔塔") return "天工";
    if (mutationType === "荷华") {
        // High-level lotus -> 珍品, lower -> 稀有
        if (plantLevel >= 100) return "珍品";
        return "稀有";
    }
    if (mutationType === "黄金") {
        if (plantLevel >= 200) return "天工";
        if (plantLevel >= 100) return "珍品";
        return "稀有";
    }
    return "无";
}

/**
 * 根据果实ID获取变异类型
 */
function getMutationTypeByFruitId(fruitId) {
    if (isGoldenFruit(fruitId)) {
        const item = itemInfoMap.get(Number(fruitId) || 0);
        const level = Number(item && item.level) || 0;
        const quality = level >= 200 ? "天工" : (level >= 100 ? "珍品" : "稀有");
        return { type: "黄金", quality };
    }
    return null;
}

/**
 * 综合解析变异信息 - 主入口
 */
function resolveMutationInfo(plantId, mutantConfigIds, phases) {
    const plant = plantMap.get(plantId);
    const plantName = plant ? plant.name : "";
    const configs = getPlantMutantConfig(plantId);
    const isGolden = isGoldenPlant(plantId);
    const confidence = [];
    const normalizedIds = [];
    const appendId = (value) => {
        const id = value && typeof value.toNumber === 'function' ? value.toNumber() : Number(value);
        if (Number(id) > 0 && !normalizedIds.includes(Number(id))) normalizedIds.push(Number(id));
    };

    if (Array.isArray(mutantConfigIds)) {
        for (const id of mutantConfigIds) appendId(id);
    }
    if (Array.isArray(phases)) {
        for (const phase of phases) {
            if (!phase || !Array.isArray(phase.mutants)) continue;
            for (const mutant of phase.mutants) {
                if (mutant && mutant.mutant_config_id !== undefined && mutant.mutant_config_id !== null) {
                    appendId(mutant.mutant_config_id);
                }
            }
        }
    }

    // Check each possible mutation target
    for (const cfg of configs) {
        const targetPlant = plantMap.get(cfg.targetPlantId);
        const targetName = targetPlant ? targetPlant.name : "";
        const mType = determineMutationType(plantId, cfg.targetPlantId, plantName, targetName);
        if (mType) {
            const q = determineMutationQuality(mType, targetPlant ? Number(targetPlant.exp) || 0 : 0);
            const mKey = mType === "荷华" || mType === "黄金" ? `${mType}_${q}` : mType;
            confidence.push({
                mutationType: mType,
                mutationKey: mKey,
                quality: q,
                targetPlantId: cfg.targetPlantId,
                targetName,
                phase: cfg.phase,
                weight: cfg.probability,
            });
        }
    }

    // Also check if this plant itself is a golden/mutant plant
    let selfType = null;
    let selfQuality = null;
    if (isGolden) {
        selfType = "黄金";
        selfQuality = determineMutationQuality(selfType, plant ? Number(plant.exp) || 0 : 0);
    } else if (plantName.includes("月华")) {
        selfType = "月华";
        selfQuality = "天工";
    } else if (plantName.includes("塔")) {
        selfType = "塔塔";
        selfQuality = "天工";
    } else if (plantName === "荷花") {
        selfType = "荷华";
        selfQuality = determineMutationQuality(selfType, plant ? Number(plant.exp) || 0 : 0);
    }

    // 枚举 ID 是服务端下发的实际变异, 优先级高于植物名称/目标植物启发式。
    // 阶段级 mutant_config_id 与 plant.mutant_config_ids 使用同一套枚举。
    const enumMutations = normalizedIds
        .map(id => getMutantByEnumId(id))
        .filter(Boolean)
        .sort((a, b) => (a.qualityRank - b.qualityRank) || (a.enumId - b.enumId));
    const primaryEnumMutation = enumMutations[0] || null;
    const confidenceMutation = confidence[0] || null;

    const displayType = primaryEnumMutation
        ? primaryEnumMutation.name
        : (selfType || (confidenceMutation && confidenceMutation.mutationType) || null);
    const displayQuality = primaryEnumMutation
        ? primaryEnumMutation.quality
        : (selfQuality || (confidenceMutation && confidenceMutation.quality) || null);
    const displayKey = primaryEnumMutation
        ? primaryEnumMutation.key
        : (confidenceMutation && confidenceMutation.mutationKey) || displayType;
    const resolvedIsGolden = isGolden || String(displayType || '').startsWith('黄金');

    return {
        isMutant: normalizedIds.length > 0 || !!selfType,
        isGolden: resolvedIsGolden,
        mutationType: displayType,
        mutationQuality: displayQuality,
        mutationKey: displayKey,
        mutationEffect: primaryEnumMutation ? primaryEnumMutation.effect : (displayType === '黄金' ? '黄金果实' : null),
        mutationIcon: primaryEnumMutation ? primaryEnumMutation.icon : (displayType === '黄金' ? '⭐' : null),
        mutationColor: primaryEnumMutation ? primaryEnumMutation.color : (displayType === '黄金' ? '#FF6B35' : null),
        mutationDescription: primaryEnumMutation ? primaryEnumMutation.description : null,
        mutations: enumMutations,
        confidence,
        mutantConfigIds: normalizedIds,
    };
}

const itemInfoMap = new Map();  // item_id -> item
const seedItemMap = new Map();  // seed_id -> item(type=5)
const seedImageMap = new Map(); // seed_id -> image url
const seedAssetImageMap = new Map(); // asset_name (Crop_xxx) -> image url

/**
 * 加载配置文件
 */
function loadConfigs() {
    const configDir = getResourcePath('gameConfig');
    
    // 加载等级经验配置
    try {
        const roleLevelPath = path.join(configDir, 'RoleLevel.json');
        if (fs.existsSync(roleLevelPath)) {
            roleLevelConfig = JSON.parse(fs.readFileSync(roleLevelPath, 'utf8'));
            // 构建累计经验表
            levelExpTable = [];
            for (const item of roleLevelConfig) {
                levelExpTable[item.level] = item.exp;
            }
            console.warn(`[配置] 已加载等级经验表 (${roleLevelConfig.length} 级)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 RoleLevel.json 失败:', e.message);
    }
    
    // 加载植物配置
    try {
        const plantPath = path.join(configDir, 'Plant.json');
        if (fs.existsSync(plantPath)) {
            plantConfig = JSON.parse(fs.readFileSync(plantPath, 'utf8'));
            plantMap.clear();
            seedToPlant.clear();
            fruitToPlant.clear();
            for (const plant of plantConfig) {
                plantMap.set(plant.id, plant);
                if (plant.seed_id) {
                    seedToPlant.set(plant.seed_id, plant);
                }
                if (plant.fruit && plant.fruit.id) {
                    fruitToPlant.set(plant.fruit.id, plant);
                }
            }
            console.warn(`[配置] 已加载植物配置 (${plantConfig.length} 种)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 Plant.json 失败:', e.message);
    }


        // 加载变异类型配置
    try {
        const mutantTypesPath = path.join(configDir, 'MutantTypes.json');
        if (fs.existsSync(mutantTypesPath)) {
            mutantTypesData = JSON.parse(fs.readFileSync(mutantTypesPath, 'utf8'));
            const types = mutantTypesData && mutantTypesData.mutationTypes;
            if (types) {
                mutantTypeMap.clear();
                for (const [typeName, typeConfig] of Object.entries(types)) {
                    mutantTypeMap.set(typeName, typeConfig);
                }
                console.warn(`[配置] 已加载变异类型配置 (${mutantTypeMap.size} 种)`);
            }
        }
    } catch (e) {
        console.warn('[配置] 加载 MutantTypes.json 失败:', e.message);
    }
    
    // 加载物品配置（含种子/果实价格）
    try {
        const itemInfoPath = path.join(configDir, 'ItemInfo.json');
        if (fs.existsSync(itemInfoPath)) {
            itemInfoConfig = JSON.parse(fs.readFileSync(itemInfoPath, 'utf8'));
            itemInfoMap.clear();
            seedItemMap.clear();
            for (const item of itemInfoConfig) {
                const id = Number(item && item.id) || 0;
                if (id <= 0) continue;
                itemInfoMap.set(id, item);
                if (Number(item.type) === 5) {
                    seedItemMap.set(id, item);
                }
            }
            console.warn(`[配置] 已加载物品配置 (${itemInfoConfig.length} 项)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 ItemInfo.json 失败:', e.message);
    }

    // 物品名覆盖表 (ItemInfo.json 未收录的新物品, 避免界面显示"物品#id")
    // 支持两处: 内置 gameConfig/ItemNameOverrides.json (随版本维护) + data/gameConfig/ItemNameOverrides.json (用户自补)
    try {
        const overridePaths = [
            path.join(configDir, 'ItemNameOverrides.json'),
            path.join(getDataDir(), 'gameConfig', 'ItemNameOverrides.json'),
        ];
        let overridden = 0;
        for (const p of overridePaths) {
            if (!fs.existsSync(p)) continue;
            let data;
            try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
            for (const [k, name] of Object.entries(data || {})) {
                const id = Number(k);
                if (!(id > 0) || typeof name !== 'string' || !name) continue;
                const existing = itemInfoMap.get(id);
                if (existing) {
                    if (!existing.name) { existing.name = name; overridden += 1; }
                } else {
                    const item = { id, name, type: 0, price: 0, level: 0, asset_name: '', __override: true };
                    itemInfoMap.set(id, item);
                    overridden += 1;
                }
            }
        }
        if (overridden > 0) console.warn(`[配置] 已应用物品名覆盖 ${overridden} 项`);
    } catch (e) {
        console.warn('[配置] 加载物品名覆盖表失败:', e.message);
    }

    // 合并同步目录(data/gameConfig)里新增的植物：内置 Plant.json 的等级数据经过人工校正，
    // 因此只追加内置缺少的新植物，不覆盖已有条目；
    // 同步源的 land_level_need 不准，新植物用 ItemInfo 种子物品的 level 校正
    try {
        const syncedPlantPath = path.join(getDataDir(), 'gameConfig', 'Plant.json');
        if (fs.existsSync(syncedPlantPath)) {
            const syncedPlants = JSON.parse(fs.readFileSync(syncedPlantPath, 'utf8'));
            let added = 0;
            for (const plant of syncedPlants) {
                if (!plant || !plant.id || plantMap.has(plant.id)) continue;
                const seedItem = plant.seed_id ? seedItemMap.get(Number(plant.seed_id)) : null;
                if (seedItem && Number(seedItem.level) > 0) {
                    plant.land_level_need = Number(seedItem.level);
                }
                plantMap.set(plant.id, plant);
                if (plant.seed_id && !seedToPlant.has(plant.seed_id)) {
                    seedToPlant.set(plant.seed_id, plant);
                }
                if (plant.fruit && plant.fruit.id && !fruitToPlant.has(plant.fruit.id)) {
                    fruitToPlant.set(plant.fruit.id, plant);
                }
                if (Array.isArray(plantConfig)) plantConfig.push(plant);
                added++;
            }
            if (added > 0) {
                console.warn(`[配置] 已合并同步目录新增植物 (${added} 种)`);
            }
        }
    } catch (e) {
        console.warn('[配置] 合并同步 Plant.json 失败:', e.message);
    }

    // 加载种子图片映射（seed_images_named）
    try {
        const seedImageDir = path.join(configDir, 'seed_images_named');
        seedImageMap.clear();
        seedAssetImageMap.clear();
        if (fs.existsSync(seedImageDir)) {
            const files = fs.readdirSync(seedImageDir);
            for (const file of files) {
                const filename = String(file || '');
                const fileUrl = `/game-config/seed_images_named/${encodeURIComponent(file)}`;

                // 1) id_..._Seed.png 命名，按 id 建立映射
                const byId = filename.match(/^(\d+)_.*\.(?:png|jpg|jpeg|webp|gif)$/i);
                if (byId) {
                    const seedId = Number(byId[1]) || 0;
                    if (seedId > 0 && !seedImageMap.has(seedId)) {
                        seedImageMap.set(seedId, fileUrl);
                    }
                }

                // 2) ...Crop_xxx_Seed.png 命名，按 asset_name 建立映射
                const byAsset = filename.match(/(Crop_\d+)_Seed\.(?:png|jpg|jpeg|webp|gif)$/i);
                if (byAsset) {
                    const assetName = byAsset[1];
                    if (assetName && !seedAssetImageMap.has(assetName)) {
                        seedAssetImageMap.set(assetName, fileUrl);
                    }
                }
            }
            console.warn(`[配置] 已加载种子图片映射 (${seedImageMap.size} 项)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 seed_images_named 失败:', e.message);
    }
}

// ============ 等级经验相关 ============

/**
 * 获取等级经验表
 */
function getLevelExpTable() {
    return levelExpTable;
}

/**
 * 计算当前等级的经验进度
 * @param {number} level - 当前等级
 * @param {number} totalExp - 累计总经验
 * @returns {{ current: number, needed: number }} 当前等级经验进度
 */
function getLevelExpProgress(level, totalExp) {
    if (!levelExpTable || level <= 0) return { current: 0, needed: 0 };
    
    const currentLevelStart = levelExpTable[level] || 0;
    const nextLevelStart = levelExpTable[level + 1] || (currentLevelStart + 100000);
    
    const currentExp = Math.max(0, totalExp - currentLevelStart);
    const neededExp = nextLevelStart - currentLevelStart;
    
    return { current: currentExp, needed: neededExp };
}

// ============ 植物配置相关 ============

/**
 * 根据植物ID获取植物信息
 * @param {number} plantId - 植物ID
 */
function getPlantById(plantId) {
    return plantMap.get(plantId) || getFallbackPlantById(plantId);
}

/**
 * 根据种子ID获取植物信息
 * @param {number} seedId - 种子ID
 */
function getPlantBySeedId(seedId) {
    return seedToPlant.get(seedId) || getFallbackPlantBySeedId(seedId);
}

/**
 * 获取植物名称
 * @param {number} plantId - 植物ID
 */
function getPlantName(plantId) {
    const plant = plantMap.get(plantId) || getFallbackPlantById(plantId);
    return plant ? plant.name : `植物${plantId}`;
}

/**
 * 根据种子ID获取植物名称
 * @param {number} seedId - 种子ID
 */
function getPlantNameBySeedId(seedId) {
    const id = Number(seedId) || 0;
    const plant = seedToPlant.get(id) || getFallbackPlantBySeedId(id);
    if (plant && plant.name) return plant.name;
    // 图鉴用的是果实id(4xxxx)，按果实id反查植物名
    const byFruit = getPlantByFruitId(id);
    if (byFruit && byFruit.name) return byFruit.name;
    const seedItem = seedItemMap.get(id);
    if (seedItem && seedItem.name) return String(seedItem.name).replace(/种子$/, '');
    const info = itemInfoMap.get(id);
    if (info && info.name) return String(info.name).replace(/种子$/, '');
    return `种子${id}`;
}

/**
 * 获取植物的生长时间（秒）
 * 静态配置缺失时，使用服务端下发的 grow_sec 或阶段时间差兜底。
 * @param {number} plantId - 植物ID
 * @param {object} runtimePlant - 服务端 PlantInfo
 */
function getPlantGrowTime(plantId, runtimePlant) {
    const plant = plantMap.get(plantId) || getFallbackPlantById(plantId);
    if (plant && plant.grow_phases) {
        // 解析 "种子:30;发芽:30;成熟:0;" 格式
        const phases = plant.grow_phases.split(';').filter(p => p);
        let totalSeconds = 0;
        for (const phase of phases) {
            const match = phase.match(/:(\d+)/);
            if (match) {
                totalSeconds += Number.parseInt(match[1]);
            }
        }
        if (totalSeconds > 0) return totalSeconds;
    }

    if (!runtimePlant) return 0;
    const growSec = toPositiveSeconds(runtimePlant.grow_sec);
    if (growSec > 0) return growSec;

    const phases = Array.isArray(runtimePlant.phases) ? runtimePlant.phases : [];
    if (phases.length < 2) return 0;
    const beginTimes = phases
        .map(phase => toPositiveSeconds(phase && phase.begin_time))
        .filter(Boolean);
    if (beginTimes.length < 2) return 0;

    const firstBegin = Math.min(...beginTimes);
    const maturePhase = phases.find(phase => Number(phase && phase.phase) === 6);
    const matureBegin = toPositiveSeconds(maturePhase && maturePhase.begin_time);
    const lastBegin = Math.max(...beginTimes);
    const growTime = (matureBegin || lastBegin) - firstBegin;
    return growTime > 0 ? growTime : 0;
}

function toPositiveSeconds(value) {
    const number = value && typeof value.toNumber === 'function' ? value.toNumber() : Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.floor(number > 1e12 ? number / 1000 : number);
}

/**
 * 格式化时间
 * @param {number} seconds - 秒数
 */
function formatGrowTime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}

/**
 * 获取植物的收获经验
 * @param {number} plantId - 植物ID
 */
function getPlantExp(plantId) {
    const plant = plantMap.get(plantId) || getFallbackPlantById(plantId);
    return plant ? (Number(plant.exp) || 0) : 0;
}

/**
 * 根据果实ID获取植物名称
 * @param {number} fruitId - 果实ID
 */
function getFruitName(fruitId) {
    const plant = getPlantByFruitId(fruitId);
    return plant ? plant.name : `果实${fruitId}`;
}

/**
 * 根据果实ID获取植物信息
 * @param {number} fruitId - 果实ID
 */
function getPlantByFruitId(fruitId) {
    const id = Number(fruitId) || 0;
    const configured = fruitToPlant.get(id);
    if (configured) return configured;

    const fallback = getFallbackPlantByFruitId(id);
    if (fallback) fruitToPlant.set(id, fallback);
    return fallback;
}

/**
 * 获取所有种子信息（用于备选）
 */
function getAllSeeds() {
    return Array.from(seedToPlant.values()).map(p => ({
        seedId: p.seed_id,
        name: p.name,
        requiredLevel: Number(p.land_level_need) || 0,
        price: getSeedPrice(p.seed_id),
        image: getSeedImageBySeedId(p.seed_id),
    }));
}

function getMappedSeedImage(targetId) {
    const id = Number(targetId) || 0;
    if (id <= 0) return '';

    const direct = seedImageMap.get(id);
    if (direct) return direct;

    const item = itemInfoMap.get(id);
    const assetName = item && item.asset_name ? String(item.asset_name).trim() : '';
    if (!assetName) return '';

    return seedAssetImageMap.get(assetName) || '';
}

function getSeedImageBySeedId(seedId) {
    return getMappedSeedImage(seedId);
}

function getItemImageById(itemId) {
    const id = Number(itemId) || 0;
    if (id <= 0) return '';

    // 内部函数：根据 ID 获取图片
    const getImg = (targetId) => {
        // 1. 优先按物品ID命中（如 20003_胡萝卜_Crop_3_Seed.png）
        const direct = seedImageMap.get(targetId);
        if (direct) return direct;

        // 2. 其次按 ItemInfo.asset_name 命中（如 Crop_3_Seed.png）
        const item = itemInfoMap.get(targetId);
        const assetName = item && item.asset_name ? String(item.asset_name) : '';
        if (assetName) {
            const byAsset = seedAssetImageMap.get(assetName);
            if (byAsset) return byAsset;
        }
        return '';
    };

    // 1. 尝试直接获取
    let img = getImg(id);
    if (img) return img;

    // 2. 如果是果实，尝试获取对应的种子图片
    const plant = getPlantByFruitId(id);
    if (plant && plant.seed_id) {
        img = getImg(plant.seed_id);
        if (img) return img;
    }

    return '';
}

/**
 * 官方表暂未收录、但活动里确实在用的物品（只做兜底、不覆盖官方数据）
 *
 * 来源：2026-10-15「奶茶热销中」抓包的种子商店列表(名称是服务端下发的, 可信) + 背包核实
 *   · 货币/道具: 1041 奶茶券(背包 3000, 商店 15 件商品用它计价) / 1042 宣传喇叭
 *   · 森野系列活动种子(商店 301~308) 与 金币果/经验蘑菇(309/310)
 *   · 缤纷奶茶系列装扮(商店 311~323) 与 头像框(331)
 * 等官方 ItemInfo 收录后, 这里的条目会自动被官方数据覆盖(仅作 fallback)。
 */
const ACTIVITY_ITEM_FALLBACK = new Map([
    [1041, { id: 1041, name: '奶茶券', type: 2 }],
    [1042, { id: 1042, name: '宣传喇叭', type: 2 }],
    // 森野系列种子(奶茶热销中)
    [20525, { id: 20525, name: '森野甜莓种子', type: 5 }],
    [20526, { id: 20526, name: '森野白桃种子', type: 5 }],
    [20527, { id: 20527, name: '森野甜橙种子', type: 5 }],
    [20528, { id: 20528, name: '森野红柚种子', type: 5 }],
    [20021, { id: 20021, name: '森野可可豆种子', type: 5 }],
    [21435, { id: 21435, name: '森野柿子种子', type: 5 }],
    [20529, { id: 20529, name: '森野芭乐种子', type: 5 }],
    [29005, { id: 29005, name: '森野黄金芽种子', type: 5 }],
    // 森野系列**果实**(制作奶茶的原料; 果实名沿用植物名, type=6 与官方一致)
    [40525, { id: 40525, name: '森野甜莓', type: 6 }],
    [40526, { id: 40526, name: '森野白桃', type: 6 }],
    [40527, { id: 40527, name: '森野甜橙', type: 6 }],
    [40528, { id: 40528, name: '森野红柚', type: 6 }],
    [40021, { id: 40021, name: '森野可可豆', type: 6 }],
    [41435, { id: 41435, name: '森野柿子', type: 6 }],
    [40529, { id: 40529, name: '森野芭乐', type: 6 }],
    [49005, { id: 49005, name: '森野黄金芽', type: 6 }],
    // 缤纷奶茶系列装扮 + 头像框
    [208012, { id: 208012, name: '缤纷奶茶围栏', type: 4 }],
    [206011, { id: 206011, name: '缤纷奶茶仓库', type: 4 }],
    [202011, { id: 202011, name: '缤纷奶茶木牌', type: 4 }],
    [203012, { id: 203012, name: '缤纷奶茶栅栏', type: 4 }],
    [205011, { id: 205011, name: '缤纷奶茶狗屋', type: 4 }],
    [207012, { id: 207012, name: '缤纷奶茶街道', type: 4 }],
    [210031, { id: 210031, name: '屋顶套装', type: 4 }],
    [210032, { id: 210032, name: '门套装', type: 4 }],
    [210033, { id: 210033, name: '窗套装', type: 4 }],
    [210034, { id: 210034, name: '墙面套装', type: 4 }],
    [210035, { id: 210035, name: '地板套装', type: 4 }],
    [210036, { id: 210036, name: '桌椅套装', type: 4 }],
    [210037, { id: 210037, name: '装饰套装', type: 4 }],
    [2163, { id: 2163, name: '缤纷奶茶头像框', type: 4 }],
]);

/**
 * 官方 Plant.json 暂未收录的活动植物（奶茶热销中 森野系列，名称取自商店下发）
 * id 规则: 植物 id 带 10 前缀(1020525), 种子 id = 去掉前缀(20525)
 * 仅做兜底: 官方收录后自动被真实数据覆盖。缺生长时间等字段(官方未下发), 界面会显示 '-'
 */
const ACTIVITY_PLANT_FALLBACK = new Map([
    [1020525, { id: 1020525, seed_id: 20525, name: '森野甜莓', fruit: { id: 40525, count: 1 } }],
    [1020526, { id: 1020526, seed_id: 20526, name: '森野白桃', fruit: { id: 40526, count: 1 } }],
    [1020527, { id: 1020527, seed_id: 20527, name: '森野甜橙', fruit: { id: 40527, count: 1 } }],
    [1020528, { id: 1020528, seed_id: 20528, name: '森野红柚', fruit: { id: 40528, count: 1 } }],
    [1020021, { id: 1020021, seed_id: 20021, name: '森野可可豆', fruit: { id: 40021, count: 1 } }],
    [1021435, { id: 1021435, seed_id: 21435, name: '森野柿子', fruit: { id: 41435, count: 1 } }],
    [1020529, { id: 1020529, seed_id: 20529, name: '森野芭乐', fruit: { id: 40529, count: 1 } }],
    // ⚠ 森野黄金芽是 **2×2** 作物(用户确认; 同官方表里 黄金·爱心果/黄金·哈哈南瓜 等 size=2 的写法):
    //    plantSeeds 会读 plant.size → plantSize>1 时 auto_slave=true, 只提交主地块让服务端补齐副地块;
    //    缺 size 时会按 1×1 提交 → 服务端返回 1001052「选择错误的地块格子」(实际报过)
    [1029005, { id: 1029005, seed_id: 29005, name: '森野黄金芽', size: 2, fruit: { id: 49005, count: 1 } }],
    // 官方 ItemInfo 已收录种子，但 Plant.json 仍缺条目；字段取自游戏配置缓存。
    [1020165, {
        id: 1020165,
        mutant_effect_plant: '5:1120165:1',
        name: '茱萸',
        seed_id: 20165,
        seasons: 1,
        grow_phases: '种子:8640;发芽:8640;小叶子:8640;大叶子:8640;初熟:8640;成熟:0;',
        exp: 1680,
        size: 1,
        fruit: { id: 40165, count: 48 },
    }],
]);

/**
 * 部分新植物的 ItemInfo 已更新、Plant.json 仍滞后。
 * 按既有 id 规则从种子物品生成最小展示配置，避免农场页退化成"植物N"且无图标。
 */
function getFallbackPlantById(plantId) {
    const id = Number(plantId) || 0;
    if (!id) return undefined;

    const configured = ACTIVITY_PLANT_FALLBACK.get(id);
    if (configured) return configured;

    const seedId = id >= 1000000 ? id - 1000000 : 0;
    const seedItem = seedItemMap.get(seedId);
    if (!seedId || !seedItem || Number(seedItem.type) !== 5) return undefined;

    const fruitId = seedId + 20000;
    const fruitItem = itemInfoMap.get(fruitId);
    const hasFruit = fruitItem && Number(fruitItem.type) === 6;
    return {
        id,
        seed_id: seedId,
        name: String(seedItem.name || '').replace(/种子$/, '') || `植物${id}`,
        size: 1,
        ...(hasFruit ? { fruit: { id: fruitId, count: 1 } } : {}),
    };
}

/** 按种子 id(20525) 找兜底植物 */
function getFallbackPlantBySeedId(seedId) {
    const id = Number(seedId) || 0;
    if (!id) return undefined;
    return getFallbackPlantById(id + 1000000);
}

/**
 * Plant.json 缺新植物时，按 ItemInfo 的果实/种子类型做严格反查。
 * 果实 id(4xxxx) -> 种子 id(2xxxx) -> 植物 id(10xxxxx)，且必须能形成完整映射。
 */
function getFallbackPlantByFruitId(fruitId) {
    const id = Number(fruitId) || 0;
    if (!id) return undefined;

    const fruitItem = getItemById(id);
    if (!fruitItem || Number(fruitItem.type) !== 6) return undefined;

    const seedId = id - 20000;
    if (seedId <= 0) return undefined;
    const plant = getFallbackPlantById(seedId + 1000000);
    if (!plant || Number(plant.seed_id) !== seedId) return undefined;
    if (!plant.fruit || Number(plant.fruit.id) !== id) return undefined;
    return plant;
}

function getItemById(itemId) {
    const id = Number(itemId) || 0;
    return itemInfoMap.get(id) || ACTIVITY_ITEM_FALLBACK.get(id);
}

function getSeedPrice(seedId) {
    const item = seedItemMap.get(Number(seedId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getFruitPrice(fruitId) {
    const item = itemInfoMap.get(Number(fruitId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getAllPlants() {
    return Array.from(plantMap.values());
}

function getAllItems() {
    return Array.from(itemInfoMap.values());
}

// 启动时加载配置
loadConfigs();

module.exports = {
    loadConfigs,
    getAllItems,
    getAllPlants,
    getAllSeeds,
    // 等级经验
    getLevelExpTable,
    getLevelExpProgress,
    // 植物配置
    getPlantById,
    getPlantBySeedId,
    getPlantName,
    getPlantNameBySeedId,
    getPlantGrowTime,
    getPlantExp,
    formatGrowTime,
    // 果实配置
    getFruitName,
    getPlantByFruitId,
    getItemById,
    getItemImageById,
    getSeedPrice,
    getFruitPrice,
    getSeedImageBySeedId,
    // 变异配置
    getMutantType,
    getMutantTypesByQuality,
    getAllMutantTypes,
    getMutantByEnumId,
    isGoldenPlant,
    isGoldenFruit,
    getPlantMutantConfig,
    resolveMutationInfo,
    determineMutationType,
    getMutationTypeByFruitId,
};
