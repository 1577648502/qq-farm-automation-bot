/*

/**
 * 青酿换万金 - 酿造
 * mode: 'normal' (一次酿造)、'fine' (连续酿造 最多3次) 或 'batch' (按青梅库存批量酿造)
 */
async function performQingniangBrew(options = {}) {
    const mode = String(options.mode || 'normal');
    const isFine = mode === 'fine';
    const isBatch = mode === 'batch';
    const requestedCount = Math.max(1, Math.floor(Number(options.count) || 1));
    const count = isFine ? Math.min(requestedCount, QINGNIANG_BREW_FINE_MAX) : requestedCount;

    const activityName = String(options.activityName || QINGNIANG_ACTIVITY_NAME).trim() || QINGNIANG_ACTIVITY_NAME;
    const selection = await getActivitySelection(activityName);
    const qingmeiEntry = selection.drawEntry || selection.shopEntry || selection.dailySigninEntry;
    const activityId = toNum(options.activityId) || toNum(qingmeiEntry && qingmeiEntry.data && qingmeiEntry.data.head && qingmeiEntry.data.head.id);
    if (!activityId) throw new Error('没有找到可执行的酿造活动');

    const qingmeiState = normalizeQingmeiBody(qingmeiEntry && qingmeiEntry.data && qingmeiEntry.data.qingmei);
    let startRecord = null;
    const hasOngoingRecord = !!(qingmeiState && (qingmeiState.brewedCount > 0 || qingmeiState.brewedGold > 0));
    const brewLimit = Math.max(0, qingmeiState && qingmeiState.brewLimit || QINGNIANG_BREW_FINE_MAX);
    const brewedCount = Math.max(0, qingmeiState && qingmeiState.brewedCount || 0);
    const remainingBrewCount = brewLimit > 0 ? Math.max(0, brewLimit - brewedCount) : count;

    if (!hasOngoingRecord) {
        const userFruitCount = toNum(options.fruitCount);
        const recordFruitCount = isBatch ? 0 : (userFruitCount > 0 ? userFruitCount : Math.max(count, QINGNIANG_BREW_FINE_MAX));
        const batchItems = await buildQingmeiBatchBrewItems(options, recordFruitCount);
        const batchCount = batchItems.reduce((sum, item) => sum + item.count, 0);
        const reply = await operateActivity(activityId, ACTIVITY_OPERATE.QINGMEI_BATCH_BREW, {
            qingmei_batch_brew: {
                items: batchItems.map(item => ({
                    item_uid: toLong(item.itemUid),
                    count: toLong(item.count),
                })),
            },
        });
        const rsp = reply && reply.qingmei_batch_brew ? reply.qingmei_batch_brew : {};
        const gold = Math.max(0, toNum(rsp.gold));
        startRecord = {
            activity: normalizeActivityData(reply && reply.activity),
            gold,
            fruitsConsumed: batchCount,
            costs: batchItems.map(item => normalizeRewardItem({ id: QINGNIANG_FRUIT_ID, count: item.count, uid: item.itemUid })),
        };
        if (isBatch) {
            return {
                mode,
                requestedCount: batchCount,
                actualCount: 0,
                activity: startRecord.activity,
                awards: gold > 0 ? [normalizeRewardItem({ id: GOLD_ITEM_ID, count: gold })] : [],
                costs: startRecord.costs,
                goldAwarded: gold,
                fruitsConsumed: batchCount,
                brewRecordStarted: true,
            };
        }
    } else if (isBatch) {
        return {
            mode,
            requestedCount: 0,
            actualCount: 0,
            activity: normalizeActivityData(qingmeiEntry && qingmeiEntry.data, qingmeiEntry && qingmeiEntry.groupHead),
            awards: [],
            costs: [],
            goldAwarded: qingmeiState.brewedGold,
            fruitsConsumed: 0,
            brewRecordStarted: false,
        };
    }

    const sessions = [];
    let lastActivity = null;
    const brewCount = hasOngoingRecord ? Math.min(count, remainingBrewCount || count) : count;
    
    if (brewCount <= 0) {
        return {
            mode,
            requestedCount: count,
            actualCount: 0,
            activity: normalizeActivityData(qingmeiEntry && qingmeiEntry.data, qingmeiEntry && qingmeiEntry.groupHead),
            awards: qingmeiState && qingmeiState.brewedGold > 0 ? [normalizeRewardItem({ id: GOLD_ITEM_ID, count: qingmeiState.brewedGold })] : [],
            costs: [],
            goldAwarded: qingmeiState ? qingmeiState.brewedGold : 0,
            fruitsConsumed: 0,
            sessions: [],
            brewRecordStarted: false,
            brewCompleted: true,
        };
    }

    for (let i = 0; i < brewCount; i++) {
        const reply = await operateActivity(activityId, ACTIVITY_OPERATE.QINGMEI_BREW, {
            qingmei_brew: {},
        });
        const rsp = reply && reply.qingmei_brew ? reply.qingmei_brew : {};
        lastActivity = normalizeActivityData(reply && reply.activity);
        sessions.push({
            count: Math.max(1, toNum(rsp.brewed_count)),
            price: Math.max(0, toNum(rsp.price)),
            gold: Math.max(0, toNum(rsp.total_gold)),
            critical: !!(rsp && rsp.critical),
        });
        if (isFine && i < count - 1) await new Promise(r => setTimeout(r, 500));
    }

    const goldAwarded = sessions.length ? sessions[sessions.length - 1].gold : 0;
    const fruitsConsumed = startRecord ? startRecord.fruitsConsumed : 0;
    // 缓存最新酿造状态用于 overview 实时同步
    if (lastActivity && lastActivity.qingmei) { _latestQingmeiState = lastActivity.qingmei; _latestBrewGold = goldAwarded; savePersistedBrewGold(goldAwarded); }

    // 确保保存实际酿造累计金币
    savePersistedBrewGold(goldAwarded);

    return {
        mode,
        requestedCount: count,
        actualCount: sessions.length,
        activity: lastActivity,
        awards: goldAwarded > 0 ? [normalizeRewardItem({ id: GOLD_ITEM_ID, count: goldAwarded })] : [],
        costs: startRecord ? startRecord.costs : [],
        goldAwarded,
        fruitsConsumed,
        sessions,
        brewRecordStarted: !!startRecord,
        brewCompleted: sessions.length ? (sessions[sessions.length - 1].count >= brewLimit) : false,
        remainingBrewCount: Math.max(0, remainingBrewCount - sessions.length),
    };
}

/**
 * 青酿换万金 - 卖出酿造产物（通过活动商店兑换金币）
 */
async function sellQingniangBrew(options = {}) {
    const activityName = String(options.activityName || QINGNIANG_ACTIVITY_NAME).trim() || QINGNIANG_ACTIVITY_NAME;
    const sellType = Math.max(1, Math.floor(Number(options.sellType) || 1));

    const selection = await getActivitySelection(activityName);
    const qingmeiEntry = selection.drawEntry || selection.shopEntry || selection.dailySigninEntry;
    const activityId = toNum(options.activityId) || toNum(qingmeiEntry && qingmeiEntry.data && qingmeiEntry.data.head && qingmeiEntry.data.head.id);
    if (!activityId) throw new Error('没有找到青酿换万金活动');

    let reply = null;
    try {
        reply = await operateActivity(activityId, ACTIVITY_OPERATE.QINGMEI_SELL, {
            qingmei_sell: {
                sell_type: toLong(sellType),
            },
        });
    } catch (e) {
        if (String(e && e.message || e).includes('1034027')) {
            throw new Error('当前没有待卖出的青梅酿，请先完成一次酿造');
        }
        throw e;
    }
    const rsp = reply && reply.qingmei_sell ? reply.qingmei_sell : {};
    // 无条件保存卖出的实际金币到文件
    if (reply && reply.activity) { var _sAct = normalizeActivityData(reply.activity); if (_sAct && _sAct.qingmei) { _latestQingmeiState = _sAct.qingmei; _latestBrewGold = Math.max(0, toNum(rsp && rsp.gold)); } }
    savePersistedBrewGold(Math.max(0, toNum(rsp && rsp.gold)));
    const award = rsp && rsp.award ? normalizeRewardItem(rsp.award) : normalizeRewardItem({ id: GOLD_ITEM_ID, count: toNum(rsp && rsp.gold) });
    return {
        sellType,
        goldAwarded: Math.max(0, toNum(rsp && rsp.gold)),
        activity: normalizeActivityData(reply && reply.activity),
        awards: award && award.count > 0 ? [award] : [],
        costs: [],
    };
}

/**
 * 青酿换万金 - 分享卖出（1.5倍收益）
 */
async function shareSellQingniangBrew(options = {}) {
    const { reportShare } = require('./share');
    try {
        await reportShare();
    } catch (e) {
        log('活动', '分享上报失败（分享卖出仍继续）: ' + (e.message || e));
    }
    const result = await sellQingniangBrew({ ...options, sellType: 2 });
    return {
        ...result,
        shareBonus: true,
        shareMultiplier: 1.5,
    };
}

/**
 * 活动页聚合服务
 * 目前基于官方 ItemInfo/Plant 配置识别「荷风游记」相关道具，再叠加当前账号背包数量。
 */

const {
    formatGrowTime,
    getAllItems,
    getAllPlants,
    getItemById,
    getItemImageById,
    getPlantGrowTime,
    getSeedImageBySeedId,
} = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log } = require('../utils/utils');
const path = require('node:path');
const fs = require('node:fs');


const { claimTaskReward, getTaskInfo } = require('./task');
const { getBag, getBagItems } = require('./warehouse');

const DEFAULT_ACTIVITY_NAME = '荷风游记';
const DEFAULT_ACTIVITY_ALIASES = [
    '荷风游记',
    '荷风十里蝉初鸣',
    '荷露',
    '游记积分',
    '枕水听荷',
    '绿荫闲庭',
];
const QINGNIANG_ACTIVITY_NAME = '青酿换万金';
const QINGNIANG_ACTIVITY_ALIASES = [
    '青酿换万金',
    '青酿',
    '万金',
    '青梅',
    '青梅种子',
    '黄金·青梅',
    '酿造',
    '分享卖出',
];
const QINGNIANG_ITEM_IDS = new Set([21221, 41221, 1041221]);
const QINGNIANG_PLANT_IDS = new Set([1021221, 1121221]);
const QINGNIANG_BREW_FINE_MAX = 3;  // 精酿最多3次
const QINGNIANG_SEED_ID = 21221;    // 青梅种子ID
const QINGNIANG_FRUIT_ID = 41221;   // 青梅果实ID
const QINGNIANG_DAILY_SIGNIN_REWARD_ID = 1;
const GOLD_ITEM_ID = 1001;          // 金币ID
// 酿造/卖出操作后缓存的最新青酿活动状态，用于 overview 实时同步
let _latestQingmeiState = null;
let _latestBrewGold = 0;

function getBrewGoldFilePath() {
    var dataDir = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
    return path.join(dataDir, 'latest-qingniang-gold.json');
}

function loadPersistedBrewGold() {
    try {
        var fp = getBrewGoldFilePath();
        if (!fs.existsSync(fp)) return 0;
        var raw = fs.readFileSync(fp, 'utf8');
        if (!raw || !raw.trim()) return 0;
        var d = JSON.parse(raw);
        return Math.max(0, Number(d.gold) || 0);
    } catch (e) { return 0; }
}

function savePersistedBrewGold(gold) {
    try {
        var fp = getBrewGoldFilePath();
        var dir = path.dirname(fp);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fp, JSON.stringify({ gold: Math.max(0, Number(gold) || 0), updatedAt: Date.now() }), 'utf8');
    } catch (e) { /* ignore */ }
}




const CURRENT_ACTIVITY_CURRENCY_IDS = new Set([1018, 1019]);
const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';
const SEASON_SERVICE = 'gamepb.seasonpb.SeasonService';
const ACTIVITY_OPERATE = {
    SHOP_BUY: 1,
    DAILY_SIGNIN_CLAIM: 4,
    DRAW: 5,
    LOTTERY_DRAW: 9,
    QINGMEI_BATCH_BREW: 14,
    QINGMEI_BREW: 15,
    QINGMEI_SELL: 16,
};
const OTHER_EVENT_NAME_TERMS = [
    '南瓜乐翻天',
    '清明春耕',
    '粽香大比拼',
    '端午粽香',
    '萌宠柯基',
];

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, '');
}

function includesAny(text, terms) {
    const source = normalizeText(text);
    return terms.some(term => source.includes(normalizeText(term)));
}

function buildTerms(activityName) {
    const name = String(activityName || DEFAULT_ACTIVITY_NAME).trim();
    const terms = name.includes('青酿') || name.includes('青梅') || name.includes('万金')
        ? [...QINGNIANG_ACTIVITY_ALIASES]
        : [...DEFAULT_ACTIVITY_ALIASES];
    if (name && !terms.includes(name)) terms.unshift(name);
    return terms;
}

function isQingniangActivity(activityName) {
    const name = String(activityName || '').trim();
    return name.includes('青酿') || name.includes('青梅') || name.includes('万金');
}

function getItemText(item) {
    if (!item || typeof item !== 'object') return '';
    return [
        item.name,
        item.desc,
        item.effectDesc,
        item.asset_name,
    ].map(v => String(v || '')).join(' ');
}

function belongsToOtherEventByName(item) {
    const name = String(item && item.name || '');
    return OTHER_EVENT_NAME_TERMS.some(term => name.includes(term));
}

function isDirectActivityItem(item, terms) {
    const id = toNum(item && item.id);
    if (CURRENT_ACTIVITY_CURRENCY_IDS.has(id)) return true;

    const name = String(item && item.name || '');
    const desc = String(item && item.desc || '');
    const effectDesc = String(item && item.effectDesc || '');
    const text = getItemText(item);

    if (desc.includes('游记积分')) return true;
    if (includesAny(name, terms)) return true;
    if (belongsToOtherEventByName(item)) return false;
    return includesAny(`${desc} ${effectDesc} ${text}`, terms);
}

function getPriceUnit(priceId) {
    const id = toNum(priceId);
    if (id === 1005) return '金豆豆';
    if (id === 1002) return '点券';
    if (id === 1001 || id === 1 || id === 0) return '金币';
    const info = getItemById(id);
    return info && info.name ? String(info.name) : `物品#${id}`;
}

function buildBagCounts(rawItems) {
    const counts = new Map();
    for (const it of (rawItems || [])) {
        const id = toNum(it && it.id);
        const count = toNum(it && it.count);
        if (id <= 0 || count <= 0) continue;
        counts.set(id, (counts.get(id) || 0) + count);
    }
    return counts;
}

function itemCategory(item, context) {
    const id = toNum(item && item.id);
    if (CURRENT_ACTIVITY_CURRENCY_IDS.has(id) || Number(item && item.type) === 19 || Number(item && item.type) === 24) {
        return 'currency';
    }
    if (context.seedIds.has(id)) return 'seed';
    if (context.fruitIds.has(id)) return 'fruit';
    if (Number(item && item.type) === 11) return 'gift';
    if (Number(item && item.type) === 18 || Number(item && item.type) === 10) return 'reward';
    return 'item';
}

function buildItemCard(item, bagCounts, category) {
    const id = toNum(item && item.id);
    const desc = String((item && (item.desc || item.effectDesc)) || '');
    const price = Number(item && item.price) || 0;
    const priceId = Number(item && item.price_id) || 0;
    return {
        id,
        name: String(item && item.name || `物品#${id}`),
        category,
        count: bagCounts.get(id) || 0,
        image: getItemImageById(id),
        description: desc,
        type: Number(item && item.type) || 0,
        assetName: String(item && item.asset_name || ''),
        price,
        priceId,
        priceUnit: getPriceUnit(priceId),
    };
}

function buildCropCard(plant, bagCounts) {
    const seedId = toNum(plant && plant.seed_id);
    const fruitId = toNum(plant && plant.fruit && plant.fruit.id);
    const seedInfo = seedId > 0 ? getItemById(seedId) : null;
    const fruitInfo = fruitId > 0 ? getItemById(fruitId) : null;
    const growSeconds = getPlantGrowTime(toNum(plant && plant.id));
    const priceId = Number(fruitInfo && fruitInfo.price_id) || 0;
    return {
        plantId: toNum(plant && plant.id),
        name: String(plant && plant.name || `植物#${toNum(plant && plant.id)}`),
        seedId,
        seedName: seedInfo && seedInfo.name ? String(seedInfo.name) : (seedId > 0 ? `种子#${seedId}` : ''),
        seedCount: seedId > 0 ? (bagCounts.get(seedId) || 0) : 0,
        fruitId,
        fruitName: fruitInfo && fruitInfo.name ? String(fruitInfo.name) : (fruitId > 0 ? `果实#${fruitId}` : ''),
        fruitCount: fruitId > 0 ? (bagCounts.get(fruitId) || 0) : 0,
        image: seedId > 0 ? (getSeedImageBySeedId(seedId) || getItemImageById(seedId)) : getItemImageById(fruitId),
        fruitImage: getItemImageById(fruitId),
        size: Math.max(1, Number(plant && plant.size) || 1),
        requiredLevel: Math.max(0, Number(plant && plant.land_level_need) || 0),
        seasons: Math.max(1, Number(plant && plant.seasons) || 1),
        harvestCount: Math.max(0, Number(plant && plant.fruit && plant.fruit.count) || 0),
        growSeconds,
        growTimeText: growSeconds > 0 ? formatGrowTime(growSeconds) : '',
        exp: Math.max(0, Number(plant && plant.exp) || 0),
        price: Number(fruitInfo && fruitInfo.price) || 0,
        priceId,
        priceUnit: getPriceUnit(priceId),
    };
}

function buildActivityCatalog(activityName, rawItems) {
    const terms = buildTerms(activityName);
    const isQingniang = isQingniangActivity(activityName);
    const bagCounts = buildBagCounts(rawItems);
    const allItems = getAllItems();
    const allPlants = getAllPlants();
    const directActivityItemIds = new Set(
        allItems
            .filter(item => isQingniang ? QINGNIANG_ITEM_IDS.has(toNum(item && item.id)) : isDirectActivityItem(item, terms))
            .map(item => toNum(item && item.id))
            .filter(Boolean),
    );

    const plants = allPlants.filter((plant) => {
        if (isQingniang) return QINGNIANG_PLANT_IDS.has(toNum(plant && plant.id));
        const seedId = toNum(plant && plant.seed_id);
        const fruitId = toNum(plant && plant.fruit && plant.fruit.id);
        return (seedId > 0 && directActivityItemIds.has(seedId))
            || (fruitId > 0 && directActivityItemIds.has(fruitId));
    });

    const seedIds = new Set(plants.map(p => toNum(p && p.seed_id)).filter(Boolean));
    const fruitIds = new Set(plants.map(p => toNum(p && p.fruit && p.fruit.id)).filter(Boolean));
    const activityItemIds = new Set([...directActivityItemIds, ...seedIds, ...fruitIds]);
    const itemContext = { seedIds, fruitIds };

    const categoryOrder = new Map([
        ['currency', 0],
        ['seed', 1],
        ['fruit', 2],
        ['gift', 3],
        ['reward', 4],
        ['item', 5],
    ]);
    const itemCards = Array.from(activityItemIds)
        .map(id => getItemById(id))
        .filter(Boolean)
        .map((item) => buildItemCard(item, bagCounts, itemCategory(item, itemContext)))
        .sort((a, b) => {
            const ca = categoryOrder.get(a.category) ?? 99;
            const cb = categoryOrder.get(b.category) ?? 99;
            if (ca !== cb) return ca - cb;
            if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
            return (a.id || 0) - (b.id || 0);
        });

    const cropCards = plants
        .map(plant => buildCropCard(plant, bagCounts))
        .sort((a, b) => {
            if ((b.seedCount || 0) !== (a.seedCount || 0)) return (b.seedCount || 0) - (a.seedCount || 0);
            if ((b.fruitCount || 0) !== (a.fruitCount || 0)) return (b.fruitCount || 0) - (a.fruitCount || 0);
            return (a.plantId || 0) - (b.plantId || 0);
        });

    return {
        activity: {
            name: activityName || DEFAULT_ACTIVITY_NAME,
            aliases: terms,
        },
        updatedAt: Date.now(),
        currencies: itemCards.filter(item => item.category === 'currency'),
        crops: cropCards,
        items: itemCards.filter(item => item.category !== 'currency'),
        seedPriorityIds: cropCards.map(crop => crop.seedId).filter(Boolean),
        summary: {
            currencyCount: itemCards.filter(item => item.category === 'currency').length,
            cropCount: cropCards.length,
            itemCount: itemCards.length,
            heldKinds: itemCards.filter(item => Number(item.count || 0) > 0).length,
        },
    };
}

function normalizeHead(head) {
    if (!head) return null;
    return {
        id: toNum(head.id),
        groupId: toNum(head.group_id),
        type: toNum(head.type),
        name: String(head.name || ''),
        description: String(head.desc || ''),
        startTime: toNum(head.start_time),
        endTime: toNum(head.end_time),
        clientId: toNum(head.client_id),
        status: toNum(head.status),
        hasRedDot: !!head.has_red_dot,
    };
}

function normalizeRewardItem(item) {
    const id = toNum(item && item.id);
    const info = id > 0 ? getItemById(id) : null;
    return {
        id,
        name: info && info.name ? String(info.name) : (id > 0 ? `物品#${id}` : ''),
        count: Math.max(0, toNum(item && item.count)),
        uid: toNum(item && item.uid),
        expireTime: toNum(item && item.expire_time),
        image: id > 0 ? getItemImageById(id) : '',
    };
}

function normalizeShopItem(item) {
    const id = toNum(item && item.id);
    const info = id > 0 ? getItemById(id) : null;
    return {
        id,
        name: info && info.name ? String(info.name) : (id > 0 ? `物品#${id}` : ''),
        count: Math.max(0, toNum(item && item.count)),
        image: id > 0 ? getItemImageById(id) : '',
    };
}

function normalizeLotteryPreviewGoods(goods) {
    return {
        goodsId: toNum(goods && goods.goods_id),
        quality: toNum(goods && goods.quality),
        poolType: toNum(goods && goods.pool_type),
        displayUpTag: !!(goods && goods.is_display_up_tag),
        displayUpTagValue: String(goods && goods.display_up_tag_value || ''),
        items: (goods && Array.isArray(goods.items) ? goods.items : []).map(normalizeRewardItem),
    };
}

function normalizeLottery(lottery) {
    if (!lottery) return null;
    const freeRemaining = Math.max(0, toNum(lottery.free_draw_remaining));
    const freeDailyLimit = Math.max(0, toNum(lottery.free_draw_daily_limit));
    const paidRemaining = Math.max(0, toNum(lottery.paid_draw_remaining));
    const paidDailyLimit = Math.max(0, toNum(lottery.paid_draw_daily_limit));
    const paidCostId = toNum(lottery.paid_draw_cost_id);
    const costInfo = paidCostId > 0 ? getItemById(paidCostId) : null;
    return {
        freeRemaining,
        freeDailyLimit,
        paidRemaining,
        paidDailyLimit,
        totalRemaining: freeRemaining + paidRemaining,
        totalLimit: freeDailyLimit + paidDailyLimit,
        paidCostId,
        paidCostName: costInfo && costInfo.name ? String(costInfo.name) : (paidCostId > 0 ? `物品#${paidCostId}` : ''),
        paidCostImage: paidCostId > 0 ? getItemImageById(paidCostId) : '',
        paidCostCount: Math.max(0, toNum(lottery.paid_draw_cost_count)),
        paidDiamondCost: Math.max(0, toNum(lottery.paid_draw_diamond_cost)),
        previewGoods: (Array.isArray(lottery.preview_goods) ? lottery.preview_goods : []).map(normalizeLotteryPreviewGoods),
    };
}

function normalizeQingmeiBody(qingmei) {
    if (!qingmei) return null;
    const normalizeCounts = (value) => {
        if (Array.isArray(value)) return value.map(toNum).filter(v => v >= 0);
        return Object.values(value || {}).map(toNum).filter(v => v >= 0);
    };
    return {
        brewedGold: Math.max(0, toNum(qingmei.brewed_gold)),
        brewedCount: Math.max(0, toNum(qingmei.brewed_count)),
        brewLimit: Math.max(0, toNum(qingmei.brew_limit)),
        hasCritical: !!qingmei.has_critical,
        minPrice: Math.max(0, toNum(qingmei.min_price)),
        maxPrice: Math.max(0, toNum(qingmei.max_price)),
        costItemIds: (Array.isArray(qingmei.cost_item_ids) ? qingmei.cost_item_ids : []).map(toNum).filter(Boolean),
        brewPriceCounts: normalizeCounts(qingmei.brew_price_counts),
        brewGoldCounts: normalizeCounts(qingmei.brew_gold_counts),
    };
}

function normalizeShopGoods(goods) {
    const item = (Array.isArray(goods && goods.item) ? goods.item : []).map(normalizeShopItem);
    const cost = (Array.isArray(goods && goods.cost) ? goods.cost : []).map(normalizeShopItem);
    const purchaseLimit = Math.max(0, toNum(goods && goods.purchase_limit));
    const purchasedCount = Math.max(0, toNum(goods && goods.purchased_count));
    const remaining = purchaseLimit > 0 ? Math.max(0, purchaseLimit - purchasedCount) : null;
    return {
        id: toNum(goods && goods.id),
        name: String(goods && goods.name || (item[0] && item[0].name) || `商品#${toNum(goods && goods.id)}`),
        description: String(goods && goods.desc || ''),
        item,
        cost,
        purchaseLimit,
        purchasedCount,
        remaining,
        soldOut: remaining === 0,
        order: toNum(goods && goods.order),
        diamondCostCount: Math.max(0, toNum(goods && goods.diamond_cost_count)),
        backgroundType: toNum(goods && goods.background_type),
        restrictionType: toNum(goods && goods.restriction_type),
    };
}

function normalizeShop(shop) {
    if (!shop) return null;
    return {
        goods: (Array.isArray(shop.goods) ? shop.goods : [])
            .map(normalizeShopGoods)
            .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.id || 0) - (b.id || 0)),
    };
}

function normalizeDailySignin(dailySignin) {
    if (!dailySignin) return null;
    return {
        claimedToday: !!dailySignin.claimed_today,
        inferred: false,
        rewards: (Array.isArray(dailySignin.rewards) ? dailySignin.rewards : []).map((reward) => ({
            id: toNum(reward && reward.id),
            description: String(reward && reward.desc || ''),
            items: (Array.isArray(reward && reward.item) ? reward.item : []).map(normalizeRewardItem),
        })),
    };
}

function normalizeActivityData(data, groupHead = null) {
    if (!data) return null;
    const activity = {
        head: normalizeHead(data.head),
        group: normalizeHead(groupHead),
        lottery: normalizeLottery(data.lottery),
        qingmei: normalizeQingmeiBody(data.qingmei),
        shop: normalizeShop(data.shop),
        dailySignin: normalizeDailySignin(data.daily_signin),
    };
    activity.bodyType = activity.lottery ? 'lottery'
        : activity.qingmei ? 'qingmei'
            : activity.shop ? 'shop'
                : activity.dailySignin ? 'dailySignin'
                    : data.draw ? 'draw'
                        : data.rand_shop ? 'randShop'
                            : 'other';
    return activity;
}

function activityText(data, groupHead = null) {
    const head = data && data.head;
    return [
        head && head.name,
        head && head.desc,
        groupHead && groupHead.name,
        groupHead && groupHead.desc,
    ].map(v => String(v || '')).join(' ');
}

function shopUsesCurrentCurrency(shop) {
    const goods = Array.isArray(shop && shop.goods) ? shop.goods : [];
    return goods.some((g) => {
        const costs = Array.isArray(g && g.cost) ? g.cost : [];
        return costs.some(cost => CURRENT_ACTIVITY_CURRENCY_IDS.has(toNum(cost && cost.id)));
    });
}

function shopUsesQingniangFruit(shop) {
    const goods = Array.isArray(shop && shop.goods) ? shop.goods : [];
    return goods.some((g) => {
        const costs = Array.isArray(g && g.cost) ? g.cost : [];
        return costs.some(cost => toNum(cost && cost.id) === QINGNIANG_FRUIT_ID);
    });
}

function activityMatchesTerms(data, terms, groupHead = null) {
    const text = activityText(data, groupHead);
    if (includesAny(text, terms)) return true;
    if (data && data.shop && shopUsesCurrentCurrency(data.shop)) return true;
    return false;
}

function childActivityText(entry) {
    const head = entry && entry.data && entry.data.head;
    return [head && head.name, head && head.desc].map(v => String(v || '')).join(' ');
}

function childActivityName(entry) {
    const head = entry && entry.data && entry.data.head;
    return String(head && head.name || '');
}

function entryIncludes(entry, terms) {
    return includesAny(childActivityText(entry), terms);
}

function entryNameIncludes(entry, terms) {
    return includesAny(childActivityName(entry), terms);
}

function isQingniangDailySigninEntry(entry) {
    if (!entry || !entry.data) return false;
    if (entry.data.daily_signin) return true;
    if (entry.data.qingmei) return false;
    return entryNameIncludes(entry, ['每日种子', '青梅种子', '领取种子', '活动赠礼']);
}

function isQingniangDrawEntry(entry) {
    if (!entry || !entry.data) return false;
    if (entry.data.qingmei) return true;
    if (entry.data.draw) return true;
    return entryIncludes(entry, ['酿造', '精酿']);
}

function isQingniangShopEntry(entry) {
    if (!entry || !entry.data) return false;
    if (entry.data.shop && shopUsesQingniangFruit(entry.data.shop)) return true;
    return entry.data.shop && entryIncludes(entry, ['卖出', '兑换', '分享卖出']);
}

function buildQingniangDailySigninFallback() {
    return {
        claimedToday: false,
        inferred: true,
        rewards: [{
            id: QINGNIANG_DAILY_SIGNIN_REWARD_ID,
            description: '青梅种子',
            items: [normalizeRewardItem({ id: QINGNIANG_SEED_ID, count: 1 })],
        }],
    };
}

async function buildQingmeiBatchBrewItems(options = {}, desiredCount = 0) {
    const explicitUid = Math.max(0, toNum(options.itemUid || options.uid));
    const explicitCount = Math.max(0, Math.floor(Number(options.fruitCount || options.batchCount || 0)));
    if (explicitUid && explicitCount) {
        return [{ itemUid: explicitUid, count: desiredCount > 0 ? Math.min(explicitCount, desiredCount) : explicitCount }];
    }

    const bagReply = await getBag();
    const bagItems = getBagItems(bagReply);
    const qingmeiItems = (Array.isArray(bagItems) ? bagItems : [])
        .map(item => ({
            itemUid: toNum(item && item.uid),
            count: Math.max(0, toNum(item && item.count)),
            id: toNum(item && item.id),
        }))
        .filter(item => item.id === QINGNIANG_FRUIT_ID && item.itemUid > 0 && item.count > 0);

    if (!qingmeiItems.length) {
        throw new Error('背包里没有可用于酿造的青梅');
    }
    if (desiredCount <= 0) {
        return qingmeiItems.map(item => ({ itemUid: item.itemUid, count: item.count }));
    }

    let remaining = desiredCount;
    const selected = [];
    for (const item of qingmeiItems) {
        if (remaining <= 0) break;
        const count = Math.min(item.count, remaining);
        selected.push({ itemUid: item.itemUid, count });
        remaining -= count;
    }
    if (remaining > 0) {
        throw new Error(`青梅数量不足，还差 ${remaining} 个`);
    }
    return selected;
}

function flattenActivityGroups(reply) {
    const entries = [];
    for (const group of (Array.isArray(reply && reply.groups) ? reply.groups : [])) {
        for (const child of (Array.isArray(group && group.children) ? group.children : [])) {
            entries.push({ data: child, groupHead: group.head || null });
        }
    }
    return entries;
}

function selectActivityEntries(reply, activityName = DEFAULT_ACTIVITY_NAME) {
    const terms = buildTerms(activityName);
    const isQingniang = isQingniangActivity(activityName);
    const entries = flattenActivityGroups(reply);
    const exact = entries.filter(entry => activityMatchesTerms(entry.data, terms, entry.groupHead));
    const source = exact.length ? exact : entries;

    // Fallback: find entry by head name matching terms
    const findEntryByName = (entryList) => entryList.find(entry =>
        entry.data && entry.data.head && entry.data.head.name &&
        typeof entry.data.head.name === 'string' &&
        includesAny(entry.data.head.name, terms)
    ) || null;

    const lotteryEntry = source.find(entry => entry.data && entry.data.lottery)
        || entries.find(entry => entry.data && entry.data.lottery)
        || findEntryByName(entries)
        || null;
    const shopEntry = isQingniang
        ? (source.find(isQingniangShopEntry) || entries.find(isQingniangShopEntry) || null)
        : source.find(entry => entry.data && entry.data.shop && shopUsesCurrentCurrency(entry.data.shop))
        || source.find(entry => entry.data && entry.data.shop)
        || entries.find(entry => entry.data && entry.data.shop && shopUsesCurrentCurrency(entry.data.shop))
        || entries.find(entry => entry.data && entry.data.shop)
        || null;
    const dailySigninEntry = isQingniang
        ? (source.find(isQingniangDailySigninEntry) || entries.find(isQingniangDailySigninEntry) || null)
        : source.find(entry => entry.data && entry.data.daily_signin)
        || entries.find(entry => entry.data && entry.data.daily_signin)
        || findEntryByName(entries)
        || null;
    const drawEntry = isQingniang
        ? (source.find(isQingniangDrawEntry) || entries.find(isQingniangDrawEntry) || findEntryByName(entries))
        : source.find(entry => entry.data && entry.data.draw)
        || entries.find(entry => entry.data && entry.data.draw)
        || findEntryByName(entries)
        || null;

    return {
        entries,
        matched: exact,
        lotteryEntry,
        shopEntry,
        dailySigninEntry,
        drawEntry,
    };
}

function normalizeBattlePassLevel(level) {
    return {
        level: toNum(level && level.level),
        freeRewards: (Array.isArray(level && level.free_rewards) ? level.free_rewards : []).map(normalizeRewardItem),
        premiumRewards: (Array.isArray(level && level.premium_rewards) ? level.premium_rewards : []).map(normalizeRewardItem),
        isKeyLevel: !!(level && level.is_key_level),
        levelTag: String(level && level.level_tag || ''),
    };
}

function normalizeBattlePass(battlepass) {
    if (!battlepass) return null;
    const level = Math.max(0, toNum(battlepass.level));
    const freeClaimedLevel = Math.max(0, toNum(battlepass.free_claimed_level));
    const premiumClaimedLevel = Math.max(0, toNum(battlepass.premium_claimed_level));
    const levels = (Array.isArray(battlepass.levels) ? battlepass.levels : []).map(normalizeBattlePassLevel);
    const claimableFreeLevels = levels.filter(item => item.level > freeClaimedLevel && item.level <= level);
    const claimablePremiumLevels = battlepass.is_premium
        ? levels.filter(item => item.level > premiumClaimedLevel && item.level <= level)
        : [];
    return {
        battlepassId: toNum(battlepass.battlepass_id),
        name: String(battlepass.name || ''),
        description: String(battlepass.desc || ''),
        level,
        totalExp: Math.max(0, toNum(battlepass.total_exp)),
        currentLevelExp: Math.max(0, toNum(battlepass.current_level_exp)),
        nextLevelNeedExp: Math.max(0, toNum(battlepass.next_level_need_exp)),
        maxLevel: Math.max(0, toNum(battlepass.max_level)),
        isPremium: !!battlepass.is_premium,
        freeClaimedLevel,
        premiumClaimedLevel,
        premiumPrice: Math.max(0, toNum(battlepass.premium_price)),
        premiumPurchaseWarning: !!battlepass.premium_purchase_warning,
        claimableFreeLevels,
        claimablePremiumLevels,
        claimableCount: claimableFreeLevels.length + claimablePremiumLevels.length,
        levels,
    };
}

function normalizeSeasonInfo(season) {
    if (!season) return null;
    return {
        seasonId: toNum(season.season_id),
        name: String(season.season_name || ''),
        phase: toNum(season.phase),
        preheatStartTime: toNum(season.preheat_start_time),
        activeStartTime: toNum(season.active_start_time),
        activeEndTime: toNum(season.active_end_time),
        serverTime: toNum(season.server_time),
        activities: (Array.isArray(season.activities) ? season.activities : []).map(activity => ({
            id: toNum(activity && activity.activity_id),
            type: toNum(activity && activity.activity_type),
            name: String(activity && activity.activity_name || ''),
            startTime: toNum(activity && activity.start_time),
            endTime: toNum(activity && activity.end_time),
        })),
        battlePass: normalizeBattlePass(season.battlepass),
    };
}

function normalizeActivityList(reply, activityName) {
    const selection = selectActivityEntries(reply, activityName);
    const isQingniang = isQingniangActivity(activityName);
    const normalizeSelectedDailySignin = (entry) => {
        const activity = entry ? normalizeActivityData(entry.data, entry.groupHead) : null;
        if (activity && isQingniang && !activity.dailySignin && isQingniangDailySigninEntry(entry)) {
            activity.dailySignin = buildQingniangDailySigninFallback();
            activity.bodyType = 'dailySignin';
        }
        return activity;
    };
    return {
        summaries: (Array.isArray(reply && reply.all_activities) ? reply.all_activities : []).map(item => ({
            id: toNum(item && item.id),
            name: String(item && item.name || ''),
            startTime: toNum(item && item.start_time),
            endTime: toNum(item && item.end_time),
        })),
        activities: selection.entries.map(entry => normalizeActivityData(entry.data, entry.groupHead)).filter(Boolean),
        matchedActivities: selection.matched.map(entry => normalizeActivityData(entry.data, entry.groupHead)).filter(Boolean),
        lotteryActivity: selection.lotteryEntry ? normalizeActivityData(selection.lotteryEntry.data, selection.lotteryEntry.groupHead) : null,
        shopActivity: selection.shopEntry ? normalizeActivityData(selection.shopEntry.data, selection.shopEntry.groupHead) : null,
        dailySigninActivity: normalizeSelectedDailySignin(selection.dailySigninEntry),
        drawActivity: selection.drawEntry ? normalizeActivityData(selection.drawEntry.data, selection.drawEntry.groupHead) : null,
    };
}

async function getActivityList() {
    const body = types.ActivityListRequest.encode(types.ActivityListRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'List', body);
    return types.ActivityListReply.decode(replyBody);
}

async function getSeasonInfo(skipUpdateNotifiedLevel = true) {
    const body = types.GetSeasonInfoRequest.encode(types.GetSeasonInfoRequest.create({
        skip_update_notified_level: !!skipUpdateNotifiedLevel,
    })).finish();
    const { body: replyBody } = await sendMsgAsync(SEASON_SERVICE, 'GetSeasonInfo', body);
    return types.GetSeasonInfoReply.decode(replyBody);
}

async function getActivityLiveState(options = {}) {
    const activityName = String(options.activityName || DEFAULT_ACTIVITY_NAME).trim() || DEFAULT_ACTIVITY_NAME;
    const live = {
        updatedAt: Date.now(),
        activity: null,
        season: null,
        errors: [],
    };

    try {
        const reply = await getActivityList();
        live.activity = normalizeActivityList(reply, activityName);
        // 用操作缓存的最新青酿状态覆盖，避免游戏服 List 接口延迟导致金额显示旧数据
        if (_latestQingmeiState && live.activity && live.activity.drawActivity) {
            live.activity.drawActivity.qingmei = _latestQingmeiState;
            // 用实际酿造累计金币覆盖，优先文件持久化的值（重启后也能恢复）
            var _persistedGold = loadPersistedBrewGold();
            if (_persistedGold > 0) live.activity.drawActivity.qingmei.brewedGold = _persistedGold;
            else if (_latestBrewGold > 0) live.activity.drawActivity.qingmei.brewedGold = _latestBrewGold;
        }
    } catch (e) {
        live.errors.push({ scope: 'activity', message: e && e.message ? e.message : String(e) });
    }

    try {
        const reply = await getSeasonInfo(true);
        live.season = normalizeSeasonInfo(reply && reply.current_season);
    } catch (e) {
        live.errors.push({ scope: 'season', message: e && e.message ? e.message : String(e) });
    }

    return live;
}

async function getActivitySelection(activityName = DEFAULT_ACTIVITY_NAME) {
    const reply = await getActivityList();
    return selectActivityEntries(reply, activityName);
}

async function operateActivity(activityId, cmd, payload = {}) {
    const req = {
        id: toLong(toNum(activityId)),
        cmd: toLong(cmd),
        ...payload,
    };
    const body = types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create(req)).finish();
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'Operate', body);
    return types.ActivityOperateReply.decode(replyBody);
}

async function drawLottery(options = {}) {
    const activityName = String(options.activityName || DEFAULT_ACTIVITY_NAME).trim() || DEFAULT_ACTIVITY_NAME;
    const mode = String(options.mode || 'free');
    const count = Math.max(1, Math.floor(Number(options.count) || 1));
    if (mode !== 'free' && !options.allowPaid) {
        throw new Error('付费奇遇需要显式确认，本次未执行');
    }

    const selection = await getActivitySelection(activityName);
    const lotteryEntry = selection.lotteryEntry;
    const activityId = toNum(options.activityId) || toNum(lotteryEntry && lotteryEntry.data && lotteryEntry.data.head && lotteryEntry.data.head.id);
    if (!activityId) throw new Error('没有找到奇遇礼莲活动');

    const lottery = normalizeLottery(lotteryEntry && lotteryEntry.data && lotteryEntry.data.lottery);
    const available = mode === 'free' ? Math.max(0, lottery && lottery.freeRemaining) : Math.max(0, lottery && lottery.paidRemaining);
    const drawCount = Math.min(count, available || 0);
    if (drawCount <= 0) {
        throw new Error(mode === 'free' ? '今日免费奇遇次数已用完' : '今日付费奇遇次数已用完');
    }

    const reply = await operateActivity(activityId, ACTIVITY_OPERATE.LOTTERY_DRAW, {
        lottery_draw: {
            free_count: toLong(mode === 'free' ? drawCount : 0),
            paid_count: toLong(mode === 'free' ? 0 : drawCount),
        },
    });
    const rsp = reply && reply.lottery_draw ? reply.lottery_draw : {};
    return {
        mode,
        requestedCount: count,
        drawCount,
        activity: normalizeActivityData(reply && reply.activity),
        results: (Array.isArray(rsp.results) ? rsp.results : []).map(result => ({
            goodsId: toNum(result && result.goods_id),
            quality: toNum(result && result.quality),
            isGuarantee: !!(result && result.is_guarantee),
            items: (Array.isArray(result && result.items) ? result.items : []).map(normalizeRewardItem),
        })),
        rewards: (Array.isArray(rsp.total_rewards) ? rsp.total_rewards : []).map(normalizeRewardItem),
        costs: (Array.isArray(rsp.costs) ? rsp.costs : []).map(normalizeRewardItem),
        partialSuccess: !!rsp.partial_success,
        errorCode: toNum(rsp.error_code),
        errorMessage: String(rsp.error_msg || ''),
    };
}

async function drawActivity(options = {}) {
    const activityName = String(options.activityName || QINGNIANG_ACTIVITY_NAME).trim() || QINGNIANG_ACTIVITY_NAME;
    const count = Math.max(1, Math.floor(Number(options.count) || 1));
    const selection = await getActivitySelection(activityName);
    const drawEntry = selection.drawEntry;
    const activityId = toNum(options.activityId) || toNum(drawEntry && drawEntry.data && drawEntry.data.head && drawEntry.data.head.id);
    if (!activityId) throw new Error('没有找到可执行的酿造活动');

    const reply = await operateActivity(activityId, ACTIVITY_OPERATE.DRAW, {
        draw: {
            count: toLong(count),
        },
    });
    const rsp = reply && reply.draw ? reply.draw : {};
    return {
        count,
        activity: normalizeActivityData(reply && reply.activity),
        awards: (Array.isArray(rsp.awards) ? rsp.awards : []).map(normalizeRewardItem),
        costs: (Array.isArray(rsp.costs) ? rsp.costs : []).map(normalizeRewardItem),
    };
}

async function exchangeShopGoods(options = {}) {
    const activityName = String(options.activityName || DEFAULT_ACTIVITY_NAME).trim() || DEFAULT_ACTIVITY_NAME;
    const goodsId = Math.max(0, toNum(options.goodsId));
    const count = Math.max(1, Math.floor(Number(options.count) || 1));
    if (!goodsId) throw new Error('缺少兑换商品 ID');

    const selection = await getActivitySelection(activityName);
    const shopEntry = selection.shopEntry;
    const activityId = toNum(options.activityId) || toNum(shopEntry && shopEntry.data && shopEntry.data.head && shopEntry.data.head.id);
    if (!activityId) throw new Error('没有找到荷露商店活动');

    const reply = await operateActivity(activityId, ACTIVITY_OPERATE.SHOP_BUY, {
        shop_buy: {
            goods_id: toLong(goodsId),
            count: toLong(count),
        },
    });
    const rsp = reply && reply.shop_buy ? reply.shop_buy : {};
    return {
        goodsId,
        count,
        activity: normalizeActivityData(reply && reply.activity),
        awards: (Array.isArray(rsp.awards) ? rsp.awards : []).map(normalizeRewardItem),
        costs: (Array.isArray(rsp.costs) ? rsp.costs : []).map(normalizeRewardItem),
    };
}

async function claimDailySignin(options = {}) {
    const activityName = String(options.activityName || DEFAULT_ACTIVITY_NAME).trim() || DEFAULT_ACTIVITY_NAME;
    const selection = await getActivitySelection(activityName);
    const dailyEntry = selection.dailySigninEntry;
    const activityId = toNum(options.activityId) || toNum(dailyEntry && dailyEntry.data && dailyEntry.data.head && dailyEntry.data.head.id);
    if (!activityId) throw new Error('没有找到活动赠礼');

    let daily = normalizeDailySignin(dailyEntry && dailyEntry.data && dailyEntry.data.daily_signin);
    if (!daily && isQingniangActivity(activityName) && isQingniangDailySigninEntry(dailyEntry)) {
        daily = buildQingniangDailySigninFallback();
    }
    if (daily && daily.claimedToday) throw new Error('今日活动赠礼已领取');
    const rewardId = toNum(options.rewardId) || toNum(daily && daily.rewards && daily.rewards[0] && daily.rewards[0].id);
    if (!rewardId) throw new Error('没有可领取的活动赠礼');

    const reply = await operateActivity(activityId, ACTIVITY_OPERATE.DAILY_SIGNIN_CLAIM, {
        daily_signin_claim: {
            reward_id: toLong(rewardId),
        },
    });
    const rsp = reply && reply.daily_signin_claim ? reply.daily_signin_claim : {};
    return {
        rewardId,
        activity: normalizeActivityData(reply && reply.activity),
        awards: (Array.isArray(rsp.awards) ? rsp.awards : []).map(normalizeRewardItem),
    };
}

async function claimBattlePassRewards() {
    const body = types.ClaimBattlePassRewardsRequest.encode(types.ClaimBattlePassRewardsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync(SEASON_SERVICE, 'ClaimBattlePassRewards', body);
    const reply = types.ClaimBattlePassRewardsReply.decode(replyBody);
    return {
        rewards: (Array.isArray(reply && reply.rewards) ? reply.rewards : []).map(normalizeRewardItem),
        claimedLevels: (Array.isArray(reply && reply.claimed_levels) ? reply.claimed_levels : []).map(toNum),
        battlePass: normalizeBattlePass(reply && reply.battlepass),
        bagOverflow: !!(reply && reply.bag_overflow),
    };
}

function isClaimableTask(task) {
    const progress = toNum(task && task.progress);
    const total = toNum(task && task.total_progress);
    return !!(task && task.is_unlocked) && !task.is_claimed && total > 0 && progress >= total;
}

function taskLooksActivityRelated(task, activityItemIds, terms) {
    const rewards = Array.isArray(task && task.rewards) ? task.rewards : [];
    if (rewards.some(item => activityItemIds.has(toNum(item && item.id)))) return true;
    return includesAny(String(task && task.desc || ''), terms);
}

async function claimActivityTasks(options = {}) {
    const activityName = String(options.activityName || DEFAULT_ACTIVITY_NAME).trim() || DEFAULT_ACTIVITY_NAME;
    const catalog = await getActivityOverview({ activityName, includeLive: false });
    const activityItemIds = new Set([
        ...(catalog.currencies || []).map(item => item.id),
        ...(catalog.items || []).map(item => item.id),
        ...(catalog.crops || []).flatMap(crop => [crop.seedId, crop.fruitId]),
    ].filter(Boolean));
    const terms = buildTerms(activityName);
    const taskReply = await getTaskInfo();
    const info = taskReply && taskReply.task_info ? taskReply.task_info : {};
    const tasks = [
        ...(Array.isArray(info.daily_tasks) ? info.daily_tasks : []),
        ...(Array.isArray(info.tasks) ? info.tasks : []),
        ...(Array.isArray(info.growth_tasks) ? info.growth_tasks : []),
    ];
    const claimable = tasks.filter(task => isClaimableTask(task) && taskLooksActivityRelated(task, activityItemIds, terms));
    const claimed = [];
    const rewards = [];
    for (const task of claimable) {
        const taskId = toNum(task && task.id);
        try {
            const reply = await claimTaskReward(taskId, false);
            const items = (Array.isArray(reply && reply.items) ? reply.items : []).map(normalizeRewardItem);
            claimed.push({
                id: taskId,
                description: String(task && task.desc || `任务#${taskId}`),
                rewards: items,
            });
            rewards.push(...items);
        } catch (e) {
            log('活动', `活动任务#${taskId} 领取失败: ${e && e.message ? e.message : e}`);
        }
    }
    return {
        claimableCount: claimable.length,
        claimedCount: claimed.length,
        claimed,
        rewards,
    };
}

async function getActivityOverview(options = {}) {
    const activityName = String(options.activityName || DEFAULT_ACTIVITY_NAME).trim() || DEFAULT_ACTIVITY_NAME;
    const bagReply = await getBag();
    const rawItems = getBagItems(bagReply);
    const catalog = buildActivityCatalog(activityName, rawItems);
    if (options.includeLive === false) return catalog;
    try {
        catalog.live = await getActivityLiveState({ activityName });
    } catch (e) {
        catalog.live = {
            updatedAt: Date.now(),
            activity: null,
            season: null,
            errors: [{ scope: 'live', message: e && e.message ? e.message : String(e) }],
        };
    }
    return catalog;
}

module.exports = {
    __testing: {
        buildQingmeiBatchBrewItems,
        normalizeActivityList,
        selectActivityEntries,
    },
    DEFAULT_ACTIVITY_NAME,
    buildActivityCatalog,
    claimActivityTasks,
    claimBattlePassRewards,
    claimDailySignin,
    drawActivity,
    drawLottery,
    exchangeShopGoods,
    getActivityList,
    getActivityLiveState,
    getActivityOverview,
    getSeasonInfo,
    performQingniangBrew,
    sellQingniangBrew,
    shareSellQingniangBrew,
};
