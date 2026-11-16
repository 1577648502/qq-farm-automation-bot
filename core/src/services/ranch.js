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
const network = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');

// ============ 底层 RPC ============

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
    const body = types.GetRanchOpTimesRequest.encode(types.GetRanchOpTimesRequest.create({})).finish();
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

// ============ 面板 API ============

async function getRanchOverview() {
    try {
        const [detailReply, opTimesReply] = await Promise.all([
            getRanchDetail(),
            getRanchOpTimes().catch(() => null),
        ]);
        const view = toRanchView(detailReply);
        view.opLimits = (opTimesReply && opTimesReply.limits || []).map(l => ({
            opId: toNum(l.op_id),
            used: toNum(l.used),
            limit: toNum(l.limit),
        }));
        return view;
    } catch (e) {
        logWarn('牧场', `获取牧场详情失败: ${e.message}`, {
            module: 'ranch', event: '获取牧场详情', result: 'error',
        });
        throw e;
    }
}

/**
 * 一键巡牧场: 收获可收的 → 催产 → 喂食。
 * 顺序有讲究: 先收获腾出产出位, 再催产, 最后喂食让动物恢复生产。
 * @returns {{harvested: number, produced: number, fed: number, details: string[]}}
 */
async function runRanchCare(opts = {}) {
    const result = { harvested: 0, produced: 0, fed: 0, details: [] };
    try {
        // 1. 收获
        const harvestReply = await harvestRanch(1);
        for (const gain of (harvestReply.gains || [])) {
            for (const item of (gain.items || [])) {
                const itemId = toNum(item.item_id);
                if (itemId === 1102) continue; // 牧场经验不算收获物
                result.harvested += toNum(item.count);
                const name = getAnimalName(itemId) || `物品#${itemId}`;
                result.details.push(`${name}x${toNum(item.count)}`);
            }
        }
        if (result.harvested > 0) {
            log('牧场', `收获完成: ${result.details.join('，')}`, {
                module: 'ranch', event: '收获牧场', result: 'ok', count: result.harvested,
            });
        }

        // 2. 催产(空请求 = 全部槽位; 抓包确认空请求也有效)
        const produceReply = await triggerProduce(0);
        for (const r of (produceReply.receipts || [])) {
            result.produced += toNum(r.count);
        }
        if (result.produced > 0) {
            log('牧场', `催产完成: 共催出 ${result.produced} 个产物`, {
                module: 'ranch', event: '催产', result: 'ok', count: result.produced,
            });
        }

        // 3. 喂食(方式枚举待确认, 默认按抓包最常见的 4; 数量 1)
        if (opts.feedType !== 0) {
            const feedType = toNum(opts.feedType) || 4;
            const feedReply = await feedAnimal(feedType, 1);
            if (feedReply && feedReply.receipt) {
                result.fed += 1;
            }
        }
    } catch (e) {
        logWarn('牧场', `巡牧场失败: ${e.message}`, {
            module: 'ranch', event: '巡牧场', result: 'error',
        });
        throw e;
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
};