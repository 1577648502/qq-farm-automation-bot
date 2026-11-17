/**
 * 牧场系统 - 11-17 新玩法(农场 25 级解锁)
 *
 * 协议字段语义依据 2026-11-16 两份真实抓包逆向:
 *   wx-code-grabber/captures/20261116-215{130,723}_牧场.decoded.jsonl
 * (字段号的"推断"标注见 animalpb.proto, 未确认的枚举不猜)
 *
 * 核心玩法模型(从抓包+物品表推出):
 *   · 窝(coop)养小动物(鸡60001/兔60002…), 棚(pen)养大动物(羊70001/牛70002…)
 *   · 动物吃牧草(7001)成长; 罐头(无机7003桶/有机7004桶)可加时
 *   · 长大后周期性产出蛋/崽(1060001…) → HarvestRanch 收进背包, 可卖金券(1007)
 *   · 阶段走到顶(整鸡 2060001)可收获整只
 *   · 每日操作有次数上限(GetRanchOpTimes: 11003/11008/11009)
 */
const protobuf = require('protobufjs');
const network = require('../utils/network');
const { getShopGoodsList, purchaseShopGoods } = require('./mall');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');

// ============ 底层 RPC ============

// ============ 服务端错误码分类(2026-11-17 线上日志实测) ============
// 这些错误是"当前状态本来就不满足", 不是故障 —— 按 error 反复打日志只会刷屏,
// 还会掩盖真正的连接问题。
const RANCH_ERR = {
    BUILDING_MISSING: 1045115,   // 牧草机等建筑还没建(牧场刚开, 没摆放)
    NOTHING_TO_PRODUCE: 1045232, // 没有可生产的动物
    CANS_EMPTY: 1045234,         // 罐头桶耗尽
    RATE_LIMITED: 1045202,       // 网络繁忙(服务端限流) → 要退避
};

/** 从错误信息里提取服务端 code= 数字 */
function parseRanchErrorCode(e) {
    const m = /code=(\d+)/.exec(String((e && e.message) || e || ''));
    return m ? Number(m[1]) : 0;
}

/** 是不是"状态不满足"类错误(不重试、不算故障) */
function isExpectedRanchError(e) {
    const code = parseRanchErrorCode(e);
    return code === RANCH_ERR.BUILDING_MISSING
        || code === RANCH_ERR.NOTHING_TO_PRODUCE
        || code === RANCH_ERR.CANS_EMPTY
        || code === RANCH_ERR.RATE_LIMITED;
}

async function getRanchDetail(hostGid = 0) {
    const state = network.getUserState();
    const gid = toNum(hostGid) || toNum(state.gid);
    // 抓包: 请求体是 {2: 空 msg} 的形态, #2 是 host 引用(结构未定, 空 msg 也能拿到全量)
    const body = types.GetRanchDetailRequest.encode(types.GetRanchDetailRequest.create({
        host: { host_gid: toLong(gid) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'GetRanchDetail', body);
    return types.GetRanchDetailReply.decode(replyBody);
}

async function getRanchOpTimes() {
    // 抓包请求体是 `0a00` = {1: 空消息}, 空字节可能被服务端当参数错误
    const body = types.GetRanchOpTimesRequest.encode(
        types.GetRanchOpTimesRequest.create({ field1: {} }),
    ).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.RanchService', 'GetRanchOpTimes', body);
    return types.GetRanchOpTimesReply.decode(replyBody);
}

/**
 * 喂食。
 * @param feedType 喂食方式(抓包出现 4/5/6; 具体枚举待更多抓包, 原样透传)
 * @param count    喂食数量(抓包见 1/2)
 */
async function feedAnimal(feedType, count = 1, hostGid = 0) {
    const state = network.getUserState();
    const gid = toNum(hostGid) || toNum(state.gid);
    const body = types.FeedAnimalRequest.encode(types.FeedAnimalRequest.create({
        target: { host_gid: toLong(gid), feed_type: toLong(feedType) },
        count: toLong(count),
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'FeedAnimal', body);
    return types.FeedAnimalReply.decode(replyBody);
}

/**
 * 催产。slot 传 0 表示全部(抓包里空请求也返回产出)。
 */
async function triggerProduce(slot = 0, hostGid = 0) {
    const state = network.getUserState();
    const gid = toNum(hostGid) || toNum(state.gid);
    const payload = {};
    if (slot > 0) payload.target = { host_gid: toLong(gid), slot: toLong(slot) };
    const body = types.TriggerProduceRequest.encode(types.TriggerProduceRequest.create(payload)).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'TriggerProduce', body);
    return types.TriggerProduceReply.decode(replyBody);
}

/**
 * 收获牧场(产物/整只)。
 * @param flag 抓包恒 1, 原样透传
 */
async function harvestRanch(flag = 1, hostGid = 0) {
    const state = network.getUserState();
    const gid = toNum(hostGid) || toNum(state.gid);
    const body = types.HarvestRanchRequest.encode(types.HarvestRanchRequest.create({
        host: { host_gid: toLong(gid) },
        flag: toLong(flag),
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'HarvestRanch', body);
    return types.HarvestRanchReply.decode(replyBody);
}

// ============ 展示层: 面板用的视图 ============

const ANIMAL_NAMES = {
    60001: '鸡', 60002: '兔子', 60003: '鹅', 60004: '猫', 60005: '乌龟',
    60006: '龙猫', 60007: '松鼠', 60008: '波斯猫', 60009: '鼹鼠', 60010: '刺猬',
    60011: '貂', 60012: '狐狸',
    70001: '羊', 70002: '牛', 70003: '猴子', 70004: '迷你猪', 70005: '袋鼠',
    70006: '驴', 70007: '梅花鹿', 70008: '羚羊', 70009: '长颈鹿', 70010: '鸵鸟',
    70011: '牦牛', 70012: '浣熊',
};
// 产物/整只 ID → 名字。命名规则: 幼崽 60xxx → 产物 106xxxx(窝) / 107xxxx(棚),
// 整只 206xxxx(窝) / 207xxxx(棚), 偏移 1000000; 逐个抄一遍太长, 用前缀生成。
for (const [id, name] of Object.entries(ANIMAL_NAMES)) {
    const n = Number(id);
    const isPen = n >= 70001;                       // 棚动物
    const base = n - (isPen ? 70000 : 60000);
    const produceId = (isPen ? 1070000 : 1060000) + base;   // 蛋/崽
    const grownId = (isPen ? 2070000 : 2060000) + base;     // 整只
    ANIMAL_NAMES[produceId] = name + (isPen ? '产物' : '蛋/崽');
    ANIMAL_NAMES[grownId] = '整' + name;
}
ANIMAL_NAMES[1102] = '牧场经验';

function getAnimalName(animalId) {
    return ANIMAL_NAMES[toNum(animalId)] || `动物#${toNum(animalId)}`;
}

/** 动物成长阶段名(抓包 stage 1..6; 语义按"幼年→成年"近似, 后续按游戏内文案校正) */
function getStageText(stage) {
    const s = toNum(stage);
    if (s <= 1) return '幼年';
    if (s >= 6) return '成年';
    return `成长中(${s}/6)`;
}

/** 把 proto 的 RanchInfo 转成面板直接可渲染的对象 */
function toRanchView(reply) {
    const ranch = reply.ranch || {};
    const nowMs = Date.now();
    const animals = [];
    for (const a of (ranch.animals || [])) {
        const animalId = toNum(a.animal_id);
        if (!animalId) continue; // 空槽占位
        const produceAt = toNum(a.produce_at);
        const animals_entry = {
            slot: toNum(a.slot),
            animalId,
            name: getAnimalName(animalId),
            stage: toNum(a.stage),
            stageText: getStageText(a.stage),
            feedState: toNum(a.feed_state),
            produceInSec: produceAt > 0 ? Math.max(0, Math.round((produceAt - nowMs) / 1000)) : 0,
            sellCost: a.sell_cost ? { itemId: toNum(a.sell_cost.item_id), amount: toNum(a.sell_cost.amount) } : null,
            mutant: !!(a.mutant && toNum(a.mutant.field_1) > 0),
        };
        animals.push(animals_entry);
    }
    return {
        hostGid: toNum(ranch.host_gid),
        coopCount: toNum(ranch.coop_count),
        penCount: toNum(ranch.pen_count),
        grassCount: ranch.grass ? toNum(ranch.grass.grass_count) : 0,
        ranchExp: toNum(reply.ranch_exp),
        animals,
        // 原始字段(调试/后续扩展用)
        building: ranch.building ? {
            type: toNum(ranch.building.type),
            stored: toNum(ranch.building.stored),
        } : null,
    };
}

/** 是不是"空 ranch"(懒初始化未完成): 全部关键字段都为 0 且没有动物 */
function isEmptyRanchView(view) {
    return !view
        || (!view.hostGid && !view.coopCount && !view.penCount
            && (view.animals || []).length === 0);
}

// ============ 饲养重量档位(GetRanchWeightScoreV2) ============
// 抓包: 响应 #3=当前状态?, #4=[{1:档位, 2:所需重量, 3:[{物品ID,数量}]}]
// 档位 1~N 需要全服饲养重量达标(公告"兴牧庆典"), 奖励 1002 点券/80023 罐头等
async function getRanchWeightScore() {
    const { body: replyBody } = await network.sendMsgAsync(
        'gamepb.illustratedpb.IllustratedService', 'GetRanchWeightScoreV2', Buffer.alloc(0));
    const buf = Buffer.isBuffer(replyBody) ? replyBody : Buffer.from(replyBody || []);
    const out = { tiers: [] };
    for (const [f, w, v] of walkWire(buf)) {
        if (f === 4 && w === 2) {
            const tier = {};
            const rewards = [];
            for (const [f2, w2, v2] of walkWire(v)) {
                if (f2 === 1 && w2 === 0) tier.level = Number(v2);
                else if (f2 === 2 && w2 === 0) tier.requiredWeight = Number(v2);
                else if (f2 === 3 && w2 === 2) {
                    const r = {};
                    for (const [f3, , v3] of walkWire(v2)) {
                        if (f3 === 1) r.itemId = Number(v3);
                        else if (f3 === 2) r.count = Number(v3);
                    }
                    if (r.itemId) rewards.push(r);
                }
            }
            tier.rewards = rewards;
            out.tiers.push(tier);
        }
    }
    return out;
}

// ============ 面板 API ============

// 面板 overview 节流: 同一账号 10s 内的重复请求直接复用上一次结果。
// 背景: 面板挂载/切账号/操作后都会 refresh, 叠加后台自动化时会把连接打掉线。
const OVERVIEW_THROTTLE_MS = 10 * 1000;
let overviewCache = { at: 0, accountId: '', promise: null };

/**
 * 拉取牧场建筑列表(窝/棚/牧草机)。
 * 实例槽位号固定: 10000=? 10001=窝 10002=牧草机(抓包实测 GetFacilityDetail(10002) 名称="牧草机")
 * 从 FacilitiesNotify 推送观察: 10001→实例6001001(窝), 10002→7001001(棚类), 10000→11001001
 */
const FACILITY_SLOTS = [10000, 10001, 10002];

async function getFacilities() {
    const facilities = [];
    for (const slot of FACILITY_SLOTS) {
        try {
            const w = protobuf.Writer.create();
            w.uint32((1 << 3) | 0).int64(toLong(slot));
            const { body: replyBody } = await network.sendMsgAsync('gamepb.homesteadpb.HomesteadService', 'GetFacilityDetail', w.finish());
            const f = parseFeedMachineReply(replyBody);
            if (!f.name && !f.capacity && !f.level) continue;
            // 建筑类型: 10001=窝(小动物), 10002=棚/牧草机(大动物/饲料), 10000=装饰位
            facilities.push({ slot, kind: slot === 10001 ? 'coop' : (slot === 10002 ? 'pen' : 'decor'), ...f });
        } catch (e) {
            // 1045115 建筑不存在 = 该槽位没建筑, 正常跳过
            if (parseRanchErrorCode(e) !== RANCH_ERR.BUILDING_MISSING) {
                logWarn('牧场', `建筑#${slot} 查询失败: ${e.message}`, {
                    module: 'ranch', event: '建筑查询', result: 'error', slot,
                });
            }
        }
        await sleep(150);
    }
    return facilities;
}

async function getRanchOverview(accountId = '') {
    const key = String(accountId || process.env.FARM_ACCOUNT_ID || '');
    const now = Date.now();
    if (overviewCache.promise && overviewCache.accountId === key && now - overviewCache.at < OVERVIEW_THROTTLE_MS) {
        return overviewCache.promise;
    }
    const promise = (async () => {
        try {
            const [detailReply, opTimesReply, facilities] = await Promise.all([
                getRanchDetail(),
                getRanchOpTimes().catch(() => null),
                getFacilities().catch(() => []),
            ]);
            const view = toRanchView(detailReply);

            view.opLimits = (opTimesReply && opTimesReply.limits || []).map(l => ({
                opId: toNum(l.op_id),
                used: toNum(l.used),
                limit: toNum(l.limit),
            }));
            view.facilities = facilities;
            return view;
        } catch (e) {
            logWarn('牧场', `获取牧场详情失败: ${e.message}`, {
                module: 'ranch', event: '获取牧场详情', result: 'error',
            });
            throw e;
        }
    })();
    overviewCache = { at: now, accountId: key, promise };
    return promise;
}

/**
 * 一键巡牧场: 收获可收的 → 催产 → 喂食。
 * 顺序有讲究: 先收获腾出产出位, 再催产, 最后喂食让动物恢复生产。
 * @returns {{harvested: number, produced: number, fed: number, details: string[]}}
 */
async function runRanchCare(opts = {}) {
    const result = {
        harvested: 0, produced: 0, fed: 0, sold: 0, earned: 0,
        boughtCubs: 0, feedMachineAdded: 0, rotationBought: 0,
        details: [],
    };

    // 各步骤之间的最小间隔: 一轮原来 20ms 内打完 10 个 RPC,
    // 服务端会把这种"突发"当异常, 是掉线的直接原因之一。
    const STEP_GAP_MS = Math.max(200, toNum(opts.stepGapMs) || 800);
    const gap = () => sleep(STEP_GAP_MS);

    // 0. 牧草机补草(任务"给牧草机添加牧草"也靠它驱动)
    if (opts.feedMachine !== false) {
        try {
            const fm = await autoFeedMachine(opts);
            result.feedMachineAdded = fm.fed;
            if (fm.fed > 0) result.details.push(`牧草机+${fm.fed}`);
        } catch (e) {
            // 1045115 建筑不存在 = 牧场还没摆放牧草机, 每轮都报一遍只会刷屏
            if (!isExpectedRanchError(e)) {
                logWarn('牧场', `牧草机检查失败: ${e.message}`, { module: 'ranch', event: '牧草机加草', result: 'error' });
            }
        }
    }
    await gap();

    // 1. 收获(蛋/崽/整只; 任务"完成1次收获""收获鸡蛋N个""收获整鸡N次"靠它驱动)
    try {
        const harvestReply = await harvestRanch(1);
        for (const gain of (harvestReply.gains || [])) {
            for (const item of (gain.items || [])) {
                const itemId = toNum(item.item_id);
                if (itemId === 1102) continue; // 牧场经验不算收获物
                result.harvested += toNum(item.count);
                result.details.push(`${getAnimalName(itemId) || itemId}x${toNum(item.count)}`);
            }
        }
        if (result.harvested > 0) {
            log('牧场', `收获完成: ${result.details.slice(0, 6).join('，')}`, {
                module: 'ranch', event: '收获牧场', result: 'ok', count: result.harvested,
            });
        }
    } catch (e) {
        // 1045202 = 服务端限流("网络繁忙"): 本轮直接放弃, 别再打后续请求火上浇油
        if (parseRanchErrorCode(e) === RANCH_ERR.RATE_LIMITED) {
            result.rateLimited = true;
            log('牧场', '收获被服务端限流(网络繁忙), 本轮巡牧场提前结束', {
                module: 'ranch', event: '收获牧场', result: 'rate_limited',
            });
            return result;
        }
        if (!isExpectedRanchError(e)) {
            logWarn('牧场', `收获失败: ${e.message}`, { module: 'ranch', event: '收获牧场', result: 'error' });
        }
    }
    await gap();

    // 2. 催产(空请求 = 全部槽位; 任务"生产N次"靠它驱动)
    try {
        const produceReply = await triggerProduce(0);
        for (const r of (produceReply.receipts || [])) {
            result.produced += toNum(r.count);
        }
        if (result.produced > 0) {
            log('牧场', `催产完成: 共催出 ${result.produced} 个产物`, {
                module: 'ranch', event: '催产', result: 'ok', count: result.produced,
            });
        }
    } catch (e) {
        // 1045232 没有可生产的动物 = 正常状态(产出冷却中), 不算故障
        if (parseRanchErrorCode(e) === RANCH_ERR.RATE_LIMITED) {
            result.rateLimited = true;
            log('牧场', '催产被服务端限流, 本轮巡牧场提前结束', {
                module: 'ranch', event: '催产', result: 'rate_limited',
            });
            return result;
        }
        if (!isExpectedRanchError(e)) {
            logWarn('牧场', `催产失败: ${e.message}`, { module: 'ranch', event: '催产', result: 'error' });
        }
    }
    await gap();

    // 3. 喂食(任务"饲养幼崽N个"靠它驱动)
    if (opts.feedType !== 0) {
        const feedType = toNum(opts.feedType) || 4;
        try {
            await feedAnimal(feedType, 1);
            result.fed += 1;
        } catch (e) {
            // 1045234 罐头耗尽 = 正常状态(等用户买罐头/加牧草)
            if (parseRanchErrorCode(e) === RANCH_ERR.RATE_LIMITED) {
                result.rateLimited = true;
                log('牧场', '喂食被服务端限流, 本轮巡牧场提前结束', {
                    module: 'ranch', event: '喂食', result: 'rate_limited',
                });
                return result;
            }
            if (!isExpectedRanchError(e)) {
                logWarn('牧场', `喂食失败: ${e.message}`, { module: 'ranch', event: '喂食', result: 'error' });
            }
        }
    }

    await gap();

    // 4. 出售产物(任务"出售鸡蛋"靠它驱动; type=107 的蛋/崽)
    if (opts.sell !== false && isAutomationOn('ranch_sell')) {
        try {
            const r = await autoSellRanchProducts(opts);
            result.sold = r.sold;
            result.earned = r.earned;
            if (r.sold > 0) result.details.push(`卖出${r.sold}→金券${r.earned}`);
        } catch (e) {
            logWarn('牧场', `出售产物失败: ${e.message}`, { module: 'ranch', event: '出售产物', result: 'error' });
        }
    }

    await gap();

    // 5. 买幼崽(任务"领养鸡幼崽N个"靠它驱动; 按收益比优先)
    if (opts.buyCubs !== false && isAutomationOn('ranch_buy_cubs')) {
        try {
            const r = await autoBuyCubs(opts);
            result.boughtCubs = r.bought;
            if (r.bought > 0) result.details.push(`买${r.details.join('/')}`);
        } catch (e) {
            logWarn('牧场', `买幼崽失败: ${e.message}`, { module: 'ranch', event: '买幼崽', result: 'error' });
        }
    }

    await gap();

    // 6. 游商兑换(便便换有机化肥, 纯赚)
    if (opts.rotationShop !== false && isAutomationOn('ranch_rotation')) {
        try {
            const r = await autoBuyRotationShop(opts);
            result.rotationBought = r.bought;
            if (r.bought > 0) result.details.push(`游商x${r.bought}`);
        } catch (e) {
            logWarn('牧场', `游商兑换失败: ${e.message}`, { module: 'ranch', event: '游商购买', result: 'error' });
        }
    }

    // 7. 主线任务奖励领取(牧场任务 300xxx/400xxx 都在 tasks 列表, 复用任务模块的扫描)
    if (opts.claimTasks !== false) {
        try {
            const { checkAndClaimTasks } = require('./task');
            await checkAndClaimTasks();
        } catch (e) {
            logWarn('牧场', `任务领取失败: ${e.message}`, { module: 'ranch', event: '任务领取', result: 'error' });
        }
    }

    return result;
}

// ============ 游商(兑换集市, RotationShop 7) ============
// 公告: 金豆豆可兑换牧场道具、松果币可兑换农场道具, 每日限时营业。
// 抓包: RotationShopInfo(1=7) → {1:营业, 3:刷新时间戳, 5:[分组], 6:[商品]}
//   商品 = {1:分组, 2:序号, 3:物品ID, 5:货币ID(7002便便/1008松果币), 6:原价, 7:折后价,
//           8/9:折扣时段, 10:限购, 13:唯一序号}
// 抓包里没有"购买游商商品"的请求 —— 商品挂在 mall slot 7 下, 用 MallService.Purchase 买。
const ROTATION_SHOP_ID = 7;
const ROTATION_MALL_SLOT = 7;

/** 查询游商(兑换集市)状态与商品 */
async function getRotationShop() {
    const body = types.GetRanchDetailRequest.encode(types.GetRanchDetailRequest.create({})).finish();
    void body; // RotationShopInfo 的请求体就是 {1:7}, 不依赖 ranch proto
    const reqBody = protobuf.Writer.create().uint32((1 << 3) | 0).int64(toLong(ROTATION_SHOP_ID)).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.shoppb.ShopService', 'RotationShopInfo', reqBody);
    // RotationShopInfoReply 尚无 proto 定义, 用通用 wire 解析提取关键字段
    return parseRotationShopReply(replyBody);
}

/** 通用解析 RotationShopInfoReply(等抓包补齐 proto 后再换强类型) */
function parseRotationShopReply(bodyBytes) {
    const buf = Buffer.isBuffer(bodyBytes) ? bodyBytes : Buffer.from(bodyBytes || []);
    const out = { open: false, refreshAt: 0, groups: [], goods: [] };
    const top = walkWire(buf);
    for (const [f, w, v] of top) {
        if (f === 1 && w === 0) out.open = v === 1n;
        else if (f === 3 && w === 0) out.refreshAt = Number(v) * 1000;
        else if (f === 5 && w === 2) {
            const g = {};
            for (const [f2, , v2] of walkWire(v)) {
                if (f2 === 1) g.id = Number(v2);
                else if (f2 === 2) g.name = v2.toString('utf8');
                else if (f2 === 3) g.limit = Number(v2);
            }
            out.groups.push(g);
        } else if (f === 6 && w === 2) {
            const g = {};
            for (const [f2, w2, v2] of walkWire(v)) {
                if (f2 === 1) g.group = Number(v2);
                else if (f2 === 2) g.seq = Number(v2);
                else if (f2 === 3) g.itemId = Number(v2);
                else if (f2 === 5) g.currencyId = Number(v2);
                else if (f2 === 6) g.price = Number(v2);
                else if (f2 === 7) g.discountPrice = Number(v2);
                else if (f2 === 8) g.discountFrom = Number(v2) * 1000;
                else if (f2 === 9) g.discountTo = Number(v2) * 1000;
                else if (f2 === 10) g.limit = Number(v2);
                else if (f2 === 13) g.uid = Number(v2);
            }
            out.goods.push(g);
        }
    }
    return out;
}

/** 通用 protobuf wire 解析(无 proto 定义时兜底) */
function walkWire(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
        let tag = 0, shift = 0;
        while (true) {
            if (i >= buf.length) return out;
            const b = buf[i++];
            tag += (b & 0x7f) * 2 ** shift;
            shift += 7;
            if (!(b & 0x80)) break;
        }
        const field = tag >> 3, wire = tag & 7;
        if (wire === 0) {
            let v = 0n; shift = 0n;
            while (true) {
                if (i >= buf.length) return out;
                const b = buf[i++];
                v += BigInt(b & 0x7f) * (2n ** shift);
                shift += 7n;
                if (!(b & 0x80)) break;
            }
            out.push([field, 0, v]);
        } else if (wire === 1) {
            if (i + 8 > buf.length) return out;
            out.push([field, 1, buf.readBigUInt64LE(i)]);
            i += 8;
        } else if (wire === 2) {
            let len = 0; shift = 0;
            while (true) {
                if (i >= buf.length) return out;
                const b = buf[i++];
                len += (b & 0x7f) * 2 ** shift;
                shift += 7;
                if (!(b & 0x80)) break;
            }
            if (i + len > buf.length) return out;
            out.push([field, 2, buf.subarray(i, i + len)]);
            i += len;
        } else if (wire === 5) {
            if (i + 4 > buf.length) return out;
            out.push([field, 5, buf.readUInt32LE(i)]);
            i += 4;
        } else return out;
    }
    return out;
}

/**
 * 自动购买游商商品。
 * 策略: 只买"用便便(7002)换有机化肥"的档 —— 便便是清理牧场获得的副产品,
 * 换化肥纯赚; 松果币(1008)来源未知, 不自动花。
 * @returns {{bought: number, details: string[]}}
 */
async function autoBuyRotationShop(opts = {}) {
    const result = { bought: 0, details: [] };
    const shop = await getRotationShop();
    if (!shop.open) {
        log('游商', '兑换集市未营业, 跳过', { module: 'ranch', event: '游商', result: 'skip' });
        return result;
    }
    // 只考虑便便计价的商品
    const targets = shop.goods.filter(g => g.currencyId === 7002 && g.price > 0);
    if (targets.length === 0) return result;

    // 背包里的便便数量
    const { getBagDetail } = require('./warehouse');
    const bag = await getBagDetail();
    const poop = bag.items.find(it => Number(it.id) === 7002);
    let poopCount = poop ? Number(poop.count) : 0;
    if (poopCount <= 0) {
        log('游商', '没有便便可兑换', { module: 'ranch', event: '游商', result: 'skip' });
        return result;
    }

    for (const g of targets) {
        if (poopCount < g.price) continue;
        // 限购次数
        const maxByLimit = g.limit > 0 ? g.limit : 99;
        const affordable = Math.floor(poopCount / g.price);
        const count = Math.min(maxByLimit, affordable);
        if (count <= 0) continue;
        try {
            // 游商商品挂在 mall slot 7; 用 Purchase(商品唯一序号 uid 走 goodsId 通道)
            const r = await purchaseCatalogGoods(g.uid, count, ROTATION_MALL_SLOT, 'mall');
            if (r && (r.ok !== false)) {
                poopCount -= g.price * count;
                result.bought += count;
                result.details.push(`#${g.itemId}x${count}(便便${g.price * count})`);
            }
        } catch (e) {
            logWarn('游商', `购买失败 #${g.itemId}: ${e.message}`, {
                module: 'ranch', event: '游商购买', result: 'error', itemId: g.itemId,
            });
        }
        await sleep(300);
    }
    if (result.bought > 0) {
        log('游商', `兑换完成: ${result.details.join('，')}`, {
            module: 'ranch', event: '游商购买', result: 'ok', count: result.bought,
        });
    }
    return result;
}

// ============ 牧草机(homesteadpb) ============
// 抓包: GetFacilityDetail(1=10002) → {2:"牧草机", 5:等级8, 6:{1007金券,6000升级价}, 14:100容量, 21:{1:当前,2:54}}
//       FeedMachineService.AddFeed(1=10002, 2=数量) → {1:当前, 2:剩余?, ...}
// 10001/10002/10000 = 设备实例 ID(窝/牧草机/棚?)
const FEED_MACHINE_ID = 10002;

async function getFeedMachine() {
    const w = protobuf.Writer.create();
    w.uint32((1 << 3) | 0).int64(toLong(FEED_MACHINE_ID));
    const { body: replyBody } = await network.sendMsgAsync('gamepb.homesteadpb.HomesteadService', 'GetFacilityDetail', w.finish());
    return parseFeedMachineReply(replyBody);
}

/**
 * 解析建筑详情(GetFacilityDetail 回包 #1)。
 * 抓包实测(牧草机 10002): #2 名称 #4 实例ID #5 等级 #6 升级价 #9 数量?
 * #10 容量(窝=10/棚=7) #12/#13 未知 #14 容量(牧草机=100) #21 {2:当前量,7,8}
 * 字段 #8/#10 与 #14 谁是容量随建筑类型而异, 都带出来由前端按类型展示。
 */
function parseFeedMachineReply(bodyBytes) {
    const buf = Buffer.isBuffer(bodyBytes) ? bodyBytes : Buffer.from(bodyBytes || []);
    const out = { name: '', level: 0, stored: 0, capacity: 0, instanceId: 0, upgradeCost: null };
    const top = walkWire(buf);
    for (const [f, w, v] of top) {
        if (f === 1 && w === 2) {
            for (const [f2, w2, v2] of walkWire(v)) {
                if (f2 === 2 && w2 === 2) out.name = v2.toString('utf8');
                else if (f2 === 4 && w2 === 0) out.instanceId = Number(v2);
                else if (f2 === 5 && w2 === 0) out.level = Number(v2);
                else if (f2 === 6 && w2 === 2) {
                    const inner = walkWire(v2);
                    const id = inner.find(x => x[1] === 1);
                    const amt = inner.find(x => x[1] === 2);
                    out.upgradeCost = { itemId: id ? Number(id[3]) : 0, amount: amt ? Number(amt[3]) : 0 };
                }
                else if (f2 === 8 && w2 === 0) out.stored = Number(v2);
                else if (f2 === 10 && w2 === 0) out.capacity = Number(v2);
                else if (f2 === 14 && w2 === 0) out.capacity = Number(v2);
                else if (f2 === 21 && w2 === 2) {
                    for (const [f3, w3, v3] of walkWire(v2)) {
                        if (f3 === 2 && w3 === 0) out.stored = Number(v3);
                    }
                }
            }
        }
    }
    return out;
}

/** 给牧草机添加牧草(从背包把牧草 7001 加进去) */
async function addFeedToMachine(count = 100) {
    const w = protobuf.Writer.create();
    w.uint32((1 << 3) | 0).int64(toLong(FEED_MACHINE_ID));
    w.uint32((2 << 3) | 0).int64(toLong(count));
    const { body: replyBody } = await network.sendMsgAsync('gamepb.homesteadpb.FeedMachineService', 'AddFeed', w.finish());
    // 响应 {1:加完后的存量, 2:剩余?}
    const top = walkWire(Buffer.from(replyBody));
    let stored = 0;
    for (const [f, , v] of top) {
        if (f === 1) { stored = Number(v); break; }
    }
    log('牧场', `牧草机添加牧草 x${count} → 存量 ${stored}`, {
        module: 'ranch', event: '牧草机加草', result: 'ok', count, stored,
    });
    return { ok: true, stored };
}

/** 牧草机缺草时自动从背包补(留 20 余量防清空) */
async function autoFeedMachine(opts = {}) {
    const threshold = Math.max(1, toNum(opts.threshold) || 20);
    const machine = await getFeedMachine();
    if (machine.stored > threshold) return { fed: 0, stored: machine.stored };
    // 背包里的散装牧草
    const { getBagDetail } = require('./warehouse');
    const bag = await getBagDetail();
    const grass = bag.items.find(it => Number(it.id) === 7001);
    const have = grass ? Number(grass.count) : 0;
    if (have <= 0) {
        log('牧场', `牧草机存量 ${machine.stored} 但背包没有牧草`, {
            module: 'ranch', event: '牧草机加草', result: 'skip',
        });
        return { fed: 0, stored: machine.stored };
    }
    const add = Math.min(have, machine.capacity > 0 ? Math.max(0, machine.capacity - machine.stored) : have, 100);
    if (add <= 0) return { fed: 0, stored: machine.stored };
    const r = await addFeedToMachine(add);
    return { fed: add, stored: r.stored };
}

// ============ 买幼崽(收益最大) ============
// 幼崽商店 = ShopInfo(5); 价格货币 = 金券(1007)
// 收益模型(由物品表 price 推出, 单位金券):
//   鸡   幼崽 2    产蛋 3/个   整鸡 6
//   兔   幼崽 1080 产物 54      整兔 2160
//   鹅   幼崽 2712  产物 135     整鹅 5424
//   猫   幼崽 4068  产物 203     整猫 8136
//   乌龟 幼崽 5640  产物 338     整龟 13536
//   龙猫 幼崽 6768  产物 507     整龙猫 20304
//   羊   幼崽 5640  羊毛 36      整羊 1440
//   牛   幼崽 10152 牛奶 54      整牛 2160
// "利益最大"按 每金券投入的整只回收率 排序: 整只价 / 幼崽价。
// 鸡 = 6/2 = 3.0 最高(且鸡蛋 3×N 持续产出), 兔 = 2.0, 鹅 = 2.0, 其余更低。
const CUB_SHOP_ID = 5;
const GROWN_VALUE = {
    60001: 6, 60002: 2160, 60003: 5424, 60004: 8136, 60005: 13536, 60006: 20304,
    70001: 1440, 70002: 2160,
};

/** 幼崽商店列表(带收益比) */
async function getCubShop() {
    const goods = await getShopGoodsList(CUB_SHOP_ID);
    return goods.map(g => ({
        goodsId: toNum(g.id),
        animalId: toNum(g.item_id),
        name: getAnimalName(toNum(g.item_id)),
        price: toNum(g.price),
        limit: toNum(g.limit_count),
        bought: toNum(g.bought_num),
        unlocked: !!g.unlocked,
        currencyId: toNum(g.price_id) || 1007,
        // 收益比 = 整只回收 / 幼崽成本
        valueRatio: GROWN_VALUE[toNum(g.item_id)]
            ? GROWN_VALUE[toNum(g.item_id)] / Math.max(1, toNum(g.price))
            : 0,
    })).sort((a, b) => b.valueRatio - a.valueRatio);
}

/**
 * 自动买幼崽: 按收益比从高到低, 优先买还有空槽能养、收益比最高的。
 * @param opts.maxSpend 本次最多花多少金券(默认 5000)
 * @param opts.slots 空槽位数(默认从牧场详情算)
 */
async function autoBuyCubs(opts = {}) {
    const result = { bought: 0, spent: 0, details: [] };
    const shop = await getCubShop();
    const usable = shop.filter(g => g.unlocked && g.price > 0 && g.valueRatio > 0);
    if (usable.length === 0) {
        log('牧场', '幼崽商店没有可买的(未解锁或价格为 0)', { module: 'ranch', event: '买幼崽', result: 'skip' });
        return result;
    }

    // 空槽 = 窝+棚 总位 - 已养数
    let slots = toNum(opts.slots) || 0;
    if (slots <= 0) {
        try {
            const view = toRanchView(await getRanchDetail());
            slots = Math.max(0, (view.coopCount + view.penCount) - view.animals.length);
        } catch { slots = 0; }
    }
    if (slots <= 0) {
        log('牧场', '没有空槽位, 跳过买幼崽', { module: 'ranch', event: '买幼崽', result: 'skip' });
        return result;
    }

    const maxSpend = Math.max(0, toNum(opts.maxSpend) || 5000);
    let spend = 0;
    for (const g of usable) {
        if (result.bought >= slots || spend >= maxSpend) break;
        // 限购余量
        const remain = g.limit > 0 ? Math.max(0, g.limit - g.bought) : 99;
        if (remain <= 0) continue;
        const affordable = Math.floor((maxSpend - spend) / g.price);
        const count = Math.min(slots - result.bought, remain, affordable);
        if (count <= 0) continue;
        try {
            const reply = await purchaseShopGoods(g.goodsId, count, g.price);
            const costItems = (reply && reply.cost_items) || [];
            const spentThis = costItems.reduce((s, it) => s + toNum(it.count), 0);
            spend += spentThis || g.price * count;
            result.bought += count;
            result.details.push(`${g.name}x${count}`);
            log('牧场', `购买幼崽: ${g.name}x${count} (收益比 ${g.valueRatio.toFixed(2)}, 花费 ${spentThis || g.price * count} 金券)`, {
                module: 'ranch', event: '买幼崽', result: 'ok',
                animalId: g.animalId, count, ratio: g.valueRatio,
            });
        } catch (e) {
            logWarn('牧场', `买幼崽失败 ${g.name}: ${e.message}`, {
                module: 'ranch', event: '买幼崽', result: 'error', animalId: g.animalId,
            });
            break;
        }
        await sleep(300);
    }
    result.spent = spend;
    if (result.bought > 0) {
        log('牧场', `买幼崽完成: ${result.details.join('，')}，共 ${result.bought} 只 / ${spend} 金券`, {
            module: 'ranch', event: '买幼崽', result: 'ok', count: result.bought, spent: spend,
        });
    }
    return result;
}

// ============ 自动出售牧场产物 ============
// 抓包: ItemService.Sell {1:{1:1060001, 2:15, 6:uid}} → 金券
// 产物 = type 107(蛋/崽); 整只(type 106)留不吃(任务要"收获整鸡", 出售整只也行)
const PRODUCE_ITEM_TYPE = 107;

async function autoSellRanchProducts(opts = {}) {
    const result = { sold: 0, earned: 0, details: [] };
    const { getBagDetail, sellItems } = require('./warehouse');
    const bag = await getBagDetail();
    const products = bag.items.filter(it => Number(it.itemType) === PRODUCE_ITEM_TYPE && Number(it.count) > 0);
    if (products.length === 0) return result;

    const payload = [];
    for (const it of products) {
        payload.push({ id: toNum(it.id), count: toNum(it.count) });
        result.sold += toNum(it.count);
        result.details.push(`${getAnimalName(toNum(it.id)) || it.id}x${toNum(it.count)}`);
    }
    try {
        const reply = await sellItems(payload);
        for (const it of (reply && reply.get_items) || []) {
            if (toNum(it.id) === 1007) result.earned += toNum(it.count);
        }
        log('牧场', `出售产物: ${result.details.join('，')} → 金券 ${result.earned}`, {
            module: 'ranch', event: '出售产物', result: 'ok', count: result.sold, earned: result.earned,
        });
    } catch (e) {
        logWarn('牧场', `出售产物失败: ${e.message}`, {
            module: 'ranch', event: '出售产物', result: 'error',
        });
    }
    return result;
}

// 单槽喂食/催产(面板手动操作)
async function operateRanch(opts = {}) {
    const op = String(opts.op || '').trim();
    const slot = toNum(opts.slot) || 0;
    const feedType = toNum(opts.feedType) || 4;
    const count = toNum(opts.count) || 1;

    switch (op) {
        case 'harvest': {
            const r = await harvestRanch(1);
            const items = [];
            for (const gain of (r.gains || [])) {
                for (const item of (gain.items || [])) {
                    const id = toNum(item.item_id);
                    if (id === 1102) continue;
                    items.push(`${getAnimalName(id) || id}x${toNum(item.count)}`);
                }
            }
            return { ok: true, action: '收获', detail: items.join('，') || '没有可收的' };
        }
        case 'produce': {
            const r = await triggerProduce(slot);
            let produced = 0;
            for (const pr of (r.receipts || [])) produced += toNum(pr.count);
            return { ok: true, action: '催产', detail: `${produced} 个产物` };
        }
        case 'feed': {
            await feedAnimal(feedType, count);
            return { ok: true, action: '喂食', detail: `方式${feedType}x${count}` };
        }
        case 'feedmachine': {
            // 给牧草机补草(默认拉满 100, 实际受背包存量限制)
            const r = await addFeedToMachine(count || 100);
            return { ok: true, action: '牧草机加草', detail: `存量 ${r.stored}` };
        }
        case 'buycub': {
            // 买幼崽(利益最大: 按 整只回收/幼崽成本 收益比排序)
            const r = await autoBuyCubs({ maxSpend: toNum(opts.maxSpend) || 5000 });
            return {
                ok: true,
                action: '买幼崽',
                detail: r.bought > 0 ? `${r.details.join('，')} / 花 ${r.spent} 金券` : '没有空槽或可买幼崽',
            };
        }
        case 'rotation': {
            const r = await autoBuyRotationShop(opts);
            return {
                ok: true,
                action: '游商兑换',
                detail: r.bought > 0 ? r.details.join('，') : '集市未营业或没有便便',
            };
        }
        default:
            throw new Error('不支持的操作: ' + op);
    }
}

module.exports = {
    getRanchDetail,
    getRanchOpTimes,
    feedAnimal,
    triggerProduce,
    harvestRanch,
    getRanchOverview,
    runRanchCare,
    operateRanch,
    toRanchView,
    getAnimalName,
    ANIMAL_NAMES,
    getRotationShop,
    autoBuyRotationShop,
    getFeedMachine,
    addFeedToMachine,
    autoFeedMachine,
    getCubShop,
    autoBuyCubs,
    autoSellRanchProducts,
    getRanchWeightScore,
    __privateRanchFns: { parseRotationShopReply, parseFeedMachineReply, walkWire, isEmptyRanchView },
};