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
const { networkEvents } = network;
const { getShopGoodsList, purchaseShopGoods } = require('./mall');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');

// ============ 底层 RPC ============

// ============ 服务端错误码分类(2026-11-17 线上日志实测) ============
// 这些错误是"当前状态本来就不满足", 不是故障 —— 按 error 反复打日志只会刷屏,
// 还会掩盖真正的连接问题。
const RANCH_ERR = {
    BUILDING_MISSING: 1045115,   // 牧草机等建筑还没建(牧场刚开, 没摆放)
    NOTHING_TO_PRODUCE: 1045232, // 没有可生产的动物
    CANS_EMPTY: 1045234,         // 罐头桶耗尽
    RATE_LIMITED: 1045202,       // 网络繁忙(服务端限流) → 要退避
    SCENE_LOCKED: 1045002,       // 牧场场景未解锁(等级不到 25 级) → 停自动化直到重登
    NOTHING_TO_HARVEST: 1045211, // 当前没有可收取的产物(正常状态)
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
        || code === RANCH_ERR.RATE_LIMITED
        || code === RANCH_ERR.NOTHING_TO_HARVEST;
}

// 场景类型(抓包 20261116: PlayerSceneLogin 请求体 {1:1}=农场(0801), {1:2}=牧场(0802))
const FARM_SCENE_TYPE = 1;
const RANCH_SCENE_TYPE = 2;

// 场景被拒(code=1045002)时记住状态, 1 小时内不重试(避免刷屏)。
// 常见根因: 客户端版本过旧(见 config.clientVersion); 定时放行探测以便升级后自动恢复。
let sceneLocked = false;
let sceneLockedAt = 0;
const SCENE_LOCK_RETRY_MS = 60 * 60 * 1000;

/**
 * 切换到牧场场景(globalscenepb.GlobalSceneService.PlayerSceneLogin {1:2})。
 * 必须在调用任何牧场 RPC 之前执行, 否则服务端返回空数据并限流。
 * @returns {boolean} 是否成功进入(未解锁返回 false 且只报一次日志)
 */
// ⚠ 1045002「该场景还未解锁」的根因(2026-11-17 实测确认):
//   不是等级、不是场景切换顺序, 而是**客户端版本号**。
//   旧版 1.14.2.15_20260922 一律被拒; 换成抓包实测的 1.17.0.4_20261117 后,
//   同一个号「直接 0802」直接成功(见 config.clientVersion)。
//   所以这里不再做 0801 前置(那是基于抓包顺序的错误推断, 已实测否定)。
async function enterRanchScene() {
    if (sceneLocked && Date.now() - sceneLockedAt < SCENE_LOCK_RETRY_MS) return false;
    const w = protobuf.Writer.create();
    w.uint32((1 << 3) | 0).int64(toLong(RANCH_SCENE_TYPE));
    try {
        await network.sendMsgAsync(
            'gamepb.globalscenepb.GlobalSceneService', 'PlayerSceneLogin', w.finish());
        if (sceneLocked) {
            log('牧场', '牧场场景已恢复访问, 恢复牧场自动化', {
                module: 'ranch', event: '场景切换', result: 'unlocked',
            });
        }
        sceneLocked = false;
        sceneLockedAt = 0;
        return true;
    } catch (e) {
        if (parseRanchErrorCode(e) === RANCH_ERR.SCENE_LOCKED) {
            if (!sceneLocked) {
                logWarn('牧场', '牧场场景不可用(code=1045002), 暂停牧场自动化(每小时重试一次); 常见原因是客户端版本过旧', {
                    module: 'ranch', event: '场景切换', result: 'locked', code: RANCH_ERR.SCENE_LOCKED,
                });
            }
            sceneLocked = true;
            sceneLockedAt = Date.now();
            return false;
        }
        throw e;
    }
}

async function getRanchDetail(hostGid = 0) {
    // ⭐ 抓包实测(20261116 21:57): 必须先 PlayerSceneLogin {1:2} 切到牧场场景,
    //    之后的 GetRanchDetail 才返回真实数据; 不切场景 → 返回"空 ranch"
    //    (没有动物、窝/棚全 0), 还会触发服务端限流(在错误场景反复调用)。
    if (toNum(hostGid) === 0) {
        const entered = await enterRanchScene().catch((e) => {
            logWarn('牧场', `进入牧场场景失败: ${e.message}`, {
                module: 'ranch', event: '场景切换', result: 'error',
            });
            return false;
        });
        if (!entered) {
            // 场景未解锁: 抛出让上层(overview/care)短路, 不再打后续请求
            throw new Error(`牧场场景未解锁(code=${RANCH_ERR.SCENE_LOCKED})`);
        }
    }
    // 抓包(20261117): 自己=空 body(`1200` 是 {2:{}} 的等价编码, 空也行);
    // 看好友 = {1:gid, 2:{}}(`08<gid>1200`)。
    const payload = toNum(hostGid) > 0
        ? { host_gid: toLong(toNum(hostGid)), host: {} }
        : {};
    const body = types.GetRanchDetailRequest.encode(
        types.GetRanchDetailRequest.create(payload),
    ).finish();
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
    // 抓包(20261117): 自己牧场 = {2:{}, 3:1}, #2 是空 msg 不带 gid。
    // 服务端从会话场景推导主人, 带 gid=0 反而和客户端行为不一致。
    const body = types.HarvestRanchRequest.encode(types.HarvestRanchRequest.create({
        host: {},
        flag: toLong(flag),
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'HarvestRanch', body);
    return types.HarvestRanchReply.decode(replyBody);
}

/**
 * 清理好友牧场(RanchService.CleanAllRanch, 20261117 抓包):
 * 产出便便(7002)的唯一来源之一, 便便是游商兑换有机罐头的货币。
 * 客户端流程: EnterHomestead{1:gid, 2:2} → CleanAllRanch{1:gid, 2:{}}
 *             → LeaveHomestead{1:gid}
 * @returns {{ok: boolean, detail: string}}
 */
/**
 * 清理自己的牧场(RanchService.CleanAllRanch)。
 * ⚠ 20261117 北栎号抓包修正: 这个接口清理的是**自己**的牧场, 请求是空 body(`1200`),
 * 服务端按当前场景推导主人 —— 之前误实现为"带 gid 清好友牧场"。
 * 自己牧场里"待清理"(便便)积累后点清理产出便便(7002)。
 * @returns {{ok: boolean}}
 */
async function cleanOwnRanch() {
    const body = types.CleanAllRanchRequest.encode(types.CleanAllRanchRequest.create({
        host: {},
    })).finish();
    await network.sendMsgAsync('gamepb.animalpb.RanchService', 'CleanAllRanch', body);
    return { ok: true };
}

/**
 * 偷好友牧场产物(AnimalService.StealProduce, 20261117 抓包)。
 * 客户端流程: EnterHomestead{1:gid, 2:2} → GetRanchDetail{1:gid, 2:{}}
 *             → [有可偷产物才发] StealProduce{1:gid} → (下家)
 * @returns {Promise<{ok: boolean, ranch: object}>}
 */
async function stealFriendProduce(hostGid) {
    const gid = toNum(hostGid);
    if (!gid) throw new Error('缺少好友 gid');
    // EnterHomesteadRequest 无 proto 定义, 手拼字节(抓包: {1:gid, 2:2} 2=牧场场景)
    const enterBody = (() => {
        const w = protobuf.Writer.create();
        w.uint32((1 << 3) | 0).int64(toLong(gid));
        w.uint32((2 << 3) | 0).int64(toLong(2));
        return w.finish();
    })();
    await network.sendMsgAsync('gamepb.visitpb.VisitService', 'EnterHomestead', enterBody);
    await sleep(300);
    try {
        const detail = await getRanchDetail(gid);
        // 可偷判定(20261117 抓包对比): 动物 feed_state(#5)==4(产物就绪) 才有可偷产物
        // 被偷的好友全部动物 f5=4/f6=2; 没得偷的 f5=3(产出中)/1(成长中)
        const animals = (detail.ranch && detail.ranch.animals) || [];
        const hasStealable = animals.some(a => toNum(a.feed_state) === 4);
        if (!hasStealable) return { ok: false, reason: 'nothing_to_steal', gid };
        const stealBody = types.StealProduceRequest.encode(types.StealProduceRequest.create({
            host_gid: toLong(gid),
        })).finish();
        const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'StealProduce', stealBody);
        return { ok: true, gid, ranch: types.StealProduceReply.decode(replyBody).ranch };
    } finally {
        await sleep(300);
        const leaveBody = (() => {
            const w = protobuf.Writer.create();
            w.uint32((1 << 3) | 0).int64(toLong(gid));
            return w.finish();
        })();
        await network.sendMsgAsync('gamepb.visitpb.VisitService', 'LeaveHomestead', leaveBody).catch(() => {});
    }
}

// ============ 栏舍动物操作(2026-11-17 官方文档) ============
// ⚠ 实测(2026-11-17 对照实验): 文档里的 CollectProduce / HarvestAnimal 在服务端**不存在**
//   —— 发空 body 返回的 1020002「网络繁忙」与编造的假方法名完全相同(方法未找到的伪装码)。
//   同理 PutHazard 也待验证。真正可用的单只收获路径待抓包补齐。
//   下面的函数保留定义(便于未来验证), 但 operateRanch 不再暴露这些操作。
// 见 docs/mc-ranch/栏舍动物交互界面功能文档.md
// 与 HarvestRanch(一键全场)区分: 这里都是单个槽位/单个动物的操作。

/** 幼崽入栏: 把背包里的幼崽放进窝/棚的空位 */
async function placeAnimal(cubItemId, count = 1, slot = 0, hostGid = 0) {
    const gid = toNum(hostGid) || toNum(network.getUserState().gid);
    const body = types.PlaceAnimalRequest.encode(types.PlaceAnimalRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
        cub_item_id: toLong(toNum(cubItemId)),
        count: toLong(Math.max(1, toNum(count) || 1)),
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'PlaceAnimal', body);
    return types.PlaceAnimalReply.decode(replyBody);
}

/** 收取副产品(单槽, 动物留栏) */
async function collectProduce(slot = 0, hostGid = 0) {
    const gid = toNum(hostGid) || toNum(network.getUserState().gid);
    const body = types.CollectProduceRequest.encode(types.CollectProduceRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
        count: toLong(1),
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'CollectProduce', body);
    return types.CollectProduceReply.decode(replyBody);
}

/** 收获出栏(成熟动物整只收走, 栏位空出) */
async function harvestAnimal(slot = 0, hostGid = 0) {
    const gid = toNum(hostGid) || toNum(network.getUserState().gid);
    const body = types.HarvestAnimalRequest.encode(types.HarvestAnimalRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'HarvestAnimal', body);
    return types.HarvestAnimalReply.decode(replyBody);
}

/** 出售动物(DonateAnimal): 卖栏里的动物换金券 */
async function donateAnimal(slot, hostGid = 0) {
    const gid = toNum(hostGid) || toNum(network.getUserState().gid);
    const body = types.DonateAnimalRequest.encode(types.DonateAnimalRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'DonateAnimal', body);
    return types.DonateAnimalReply.decode(replyBody);
}

/** 清理单个 hazard(蚊子等); CleanAllRanch 是全场版 */
async function cleanRanch(slot = 0, hostGid = 0) {
    const gid = toNum(hostGid) || toNum(network.getUserState().gid);
    const body = types.CleanRanchRequest.encode(types.CleanRanchRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.RanchService', 'CleanRanch', body);
    return types.CleanRanchReply.decode(replyBody);
}

/** 放蚊子(使坏好友牧场) */
async function putHazard(hostGid, slot = 0) {
    const gid = toNum(hostGid);
    if (!gid) throw new Error('缺少好友 gid');
    // PutHazard 结构与 CleanRanch 对称; 无 proto 定义, 手拼 {1:{1:gid,2:slot}}
    const w = protobuf.Writer.create();
    const tw = w.uint32((1 << 3) | 2).fork();
    tw.uint32((1 << 3) | 0).int64(toLong(gid));
    tw.uint32((2 << 3) | 0).int64(toLong(toNum(slot)));
    tw.ldelim();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.RanchService', 'PutHazard', w.finish());
    return replyBody;
}

/** 用罐头桶加速(FeedAnimal) —— 与"喂食"同一接口, 语义是投喂罐头桶 */
async function useFeedBucket(slot, count = 1, hostGid = 0) {
    return feedAnimal(4, count, hostGid);
}

// ============ 牧场等级(独立于农场 RoleLevel) ============
// ⚠ 20261118 实测反推(游戏内截图 + 抓包对照):
//   游戏内牧场界面: Lv9 / 7396 / 1.3万
//   抓包物品 1102(牧场经验累计) = 17396
//   17396 - 7396 = 10000  → Lv9 的累计起点
//   1.3万(13000)          → Lv9 本级需要的经验(current/needed = 7396/13000)
//   即 Lv9 区间 [10000, 23000), 跨度 13000。
// 只有 Lv9 这一段是实测的, 其余等级按"每级 +13000"外推(待更多样本校正)。
const RANCH_LEVEL_BASE = 10000;     // Lv9 累计起点
const RANCH_LEVEL_STEP = 13000;     // 每级跨度(实测 7396/13000)
const RANCH_LEVEL_BASE_LEVEL = 9;   // 实测起点等级

/**
 * 由牧场经验累计值算等级与进度。
 * @param {number} totalExp 物品 1102 的值
 * @returns {{level:number, current:number, needed:number}}
 */
function calcRanchLevel(totalExp) {
    const exp = Math.max(0, toNum(totalExp));
    if (exp < RANCH_LEVEL_BASE) {
        // 低于实测起点: 保守按每级 3000 向下推
        const lv = Math.max(1, RANCH_LEVEL_BASE_LEVEL - Math.ceil((RANCH_LEVEL_BASE - exp) / RANCH_LEVEL_STEP));
        const start = RANCH_LEVEL_BASE - (RANCH_LEVEL_BASE_LEVEL - lv) * RANCH_LEVEL_STEP;
        return { level: lv, current: exp - start, needed: RANCH_LEVEL_STEP };
    }
    const lv = RANCH_LEVEL_BASE_LEVEL + Math.floor((exp - RANCH_LEVEL_BASE) / RANCH_LEVEL_STEP);
    const start = RANCH_LEVEL_BASE + (lv - RANCH_LEVEL_BASE_LEVEL) * RANCH_LEVEL_STEP;
    return { level: lv, current: exp - start, needed: RANCH_LEVEL_STEP };
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
/**
 * 生长阶段文案。stage 实测就是 1..6(2026-11-17 真号: 槽1=4 槽2=5 槽3=6)。
 * 成年以 grown_flag(#18) 为准(stage 到 6 也是成年, 两个信号一致时更稳)。
 */
function getStageText(stage, grownFlag) {
    const s = toNum(stage);
    if (toNum(grownFlag) === 1 && s >= 6) return '成年';
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
        const readyAt = toNum(a.trigger_ready_at);
        const grownFlag = toNum(a.grown_flag);
        // ⭐⭐ 2026-11-17 线上实测(账号1真实回包)修正语义:
        //   produce_at(#10) = **上次产出**时刻(已过去), 不是下次!
        //   trigger_ready_at(#25) = **下次可产出**时刻。
        //   证据: 4 只兔子 produce_at 距今 -3141s, f25 = produce_at + 7212s = 正好 2.003 小时。
        //   之前把 produce_at 当"下次产出"→ 永远算成已过期 → 面板一直"可收获" →
        //   点收获服务端回 1045211「当前没有可收取的产物」。(用户现场就是这个)
        const nextReadyMs = readyAt > 0 ? readyAt : (produceAt > 0 ? produceAt + 2 * 3600 * 1000 : 0);
        const harvestInSec = nextReadyMs > 0 ? Math.round((nextReadyMs - nowMs) / 1000) : null;
        const harvestable = harvestInSec !== null && harvestInSec <= 0;
        const animals_entry = {
            slot: toNum(a.slot),
            animalId,
            name: getAnimalName(animalId),
            stage: toNum(a.stage),
            stageText: getStageText(a.stage, grownFlag),
            feedState: toNum(a.feed_state),
            grown: grownFlag === 1,
            // 副产物就绪 → 可以"收获"(CollectProduce)
            harvestable,
            // 距下次产出秒数; null = 还没进入产出周期(幼年/未开轮)
            harvestInSec,
            // 兼容旧字段, 语义与 harvestInSec 一致
            produceInSec: harvestInSec === null ? null : Math.max(0, harvestInSec),
            // 催产就绪 = 确实到了下次产出时刻
            canProduce: harvestable,
            hungry: toNum(a.feed_state) === 1,
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
// 建筑槽: 10000=留言板(装饰) 10001=窝 10002=喂食机(牧草机)
// ⚠ 棚不是固定槽位, 它的实例号在 AllCells 里(如 inst=3, buildingId=6002001)
const FACILITY_SLOTS = [10000, 10001, 10002];

/** 查询任意建筑实例详情(棚的 instId 不固定, 只能从 AllCells 拿) */
async function getFacilityDetailByInstance(instId) {
    const w = protobuf.Writer.create();
    w.uint32((1 << 3) | 0).int64(toLong(toNum(instId)));
    const { body: replyBody } = await network.sendMsgAsync(
        'gamepb.homesteadpb.HomesteadService', 'GetFacilityDetail', w.finish());
    return parseFeedMachineReply(replyBody);
}
// 建筑配置 → 用途(ItemInfo: 3601001=牧场窝 target 6001001, 3602001=牧场棚 target 6002001, 3702001=喂食机 target 7001001)
const BUILDING_KINDS = {
    6001001: 'coop', 6001002: 'coop', 6001003: 'coop',
    6002001: 'pen',  6002002: 'pen',  6002003: 'pen',
    7001001: 'feed', 7001002: 'feed', 7001003: 'feed',
};
function buildingKind(buildingId) {
    return BUILDING_KINDS[Number(buildingId)] || '';
}

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
            // ⭐ 先切牧场场景(必须, 否则所有牧场接口返回空/被限流), 再并发查询
            await enterRanchScene().catch(() => {});
            const [detailReply, opTimesReply, facilities, ranchExpReal] = await Promise.all([
                getRanchDetail(),
                getRanchOpTimes().catch(() => null),
                getFacilities().catch(() => []),
                require('./warehouse').getRanchExp().catch(() => 0),
            ]);
            const view = toRanchView(detailReply);
            // ⭐ 牧场经验/等级: 用物品 1102 的真实累计值(GetRanchDetailReply#2 实测不返回, 是假的 30)
            if (toNum(ranchExpReal) > 0) {
                view.ranchExp = toNum(ranchExpReal);
                const lvInfo = calcRanchLevel(ranchExpReal);
                view.ranchLevel = lvInfo.level;
                view.ranchLevelExp = lvInfo.current;
                view.ranchLevelNeeded = lvInfo.needed;
            }

            view.opLimits = (opTimesReply && opTimesReply.limits || []).map(l => ({
                opId: toNum(l.op_id),
                used: toNum(l.used),
                limit: toNum(l.limit),
            }));
            view.facilities = facilities;
            // 建筑升级状态(窝/棚/牧草机): 数据来自 AllCells.buildings,
            // 按实例号 10000/10001/10002 对应到 facilities 上, 面板可显示"升级中"
            try {
                const facilitySvc = require('./ranch-facility');
                const all = await facilitySvc.getAllCells();
                view.buildings = all.buildings;
                const byInst = new Map(all.buildings.map(b => [b.instId, b]));
                for (const f of view.facilities) {
                    const b = byInst.get(toNum(f.slot));
                    if (b) {
                        f.upgradeLevel = b.level;
                        f.upgrading = b.status === 1;
                        f.buildingId = b.buildingId;
                        f.buildingKind = buildingKind(b.buildingId);
                    } else {
                        f.upgrading = false;
                    }
                }
                // ⭐ 真实建筑清单(棚不在固定槽位里, 只能从 AllCells 拿):
                //   ItemInfo: 3601001=牧场窝(target 6001001) / 3602001=牧场棚(6002001) / 3702001=喂食机(7001001)
                view.buildings = all.buildings.map(b => ({
                    instId: b.instId,
                    buildingId: b.buildingId,
                    level: b.level,
                    status: b.status,
                    kind: buildingKind(b.buildingId),
                }));
                view.coopBuildings = view.buildings.filter(b => b.kind === 'coop');
                view.penBuildings = view.buildings.filter(b => b.kind === 'pen');
                view.feedBuildings = view.buildings.filter(b => b.kind === 'feed');

                // 地块进度(解锁/占用配额): 面板要显示"已解锁 x/y、占用 z"。
                // 注意 AllCells 只给状态不给倒计时 —— 解锁是否在进行中无法从协议判断,
                // 所以这里只如实给 status/容量, 不编倒计时。
                view.cells = (all.cells || []).map(c => ({
                    regionId: c.regionId,
                    cellType: c.cellType,
                    seq: c.seq,
                    unlocked: c.status === 2,
                    instId: c.instId,
                    capacity: c.capacity,
                }));
                view.regionOccupied = toNum(all.occupied);
                view.regionQuota = toNum(all.quota);
                view.regionSpeedUp = all.speedUp || [];

                // ⭐ 从没进过牧场的号: GetRanchDetail 返回空 RanchInfo(窝0棚0牧草0),
                //   但 AllCells / GetFacilityDetail 里的建筑是真实的。
                //   用真实建筑的 capacity 兜底(不猜数值), 避免面板一片空白。
                if (!view.coopCount && !view.penCount) {
                    view.emptyRanchInfo = true;
                    const coopFac = view.facilities.find(f => f.slot === 10001);
                    view.coopCount = toNum(coopFac && coopFac.capacity) || view.coopBuildings.length;
                    // 棚的 instId 不固定(实测 inst=3), 用真实实例查容量
                    const penB = view.penBuildings[0];
                    if (penB) {
                        try {
                            const pf = await getFacilityDetailByInstance(penB.instId);
                            view.penCount = toNum(pf.capacity) || 0;
                            if (view.penCount > 0) {
                                view.facilities.push({
                                    slot: penB.instId, kind: 'pen', name: '棚',
                                    level: toNum(pf.level), stored: 0,
                                    capacity: view.penCount, buildingId: penB.buildingId,
                                    buildingKind: 'pen', upgrading: false,
                                });
                            }
                        } catch { view.penCount = 0; }
                    }
                }
            } catch {
                view.buildings = [];
            }
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
    // 场景未解锁(等级不够): 本进程内已确认过的直接短路, 不打任何 RPC
    if (sceneLocked) return { skipped: true, reason: 'scene_locked' };
    const result = {
        harvested: 0, produced: 0, fed: 0, sold: 0, earned: 0,
        boughtCubs: 0, feedMachineAdded: 0, rotationBought: 0, cleanedFriends: 0, ranchTasksClaimed: 0, buildingsCompleted: 0, buildingsUpgraded: 0, regionsCompleted: 0, regionsUnlocked: 0,
        details: [],
    };

    // 各步骤之间的最小间隔: 一轮原来 20ms 内打完 10 个 RPC,
    // 服务端会把这种"突发"当异常, 是掉线的直接原因之一。
    const STEP_GAP_MS = Math.max(200, toNum(opts.stepGapMs) || 800);
    const gap = () => sleep(STEP_GAP_MS);

    // 0. 牧草机补草(任务"给牧草机添加牧草"也靠它驱动)
    if (opts.feedMachine !== false && isAutomationOn('ranch_feedmachine')) {
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
    if (isAutomationOn('ranch_harvest')) try {
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
    if (isAutomationOn('ranch_produce')) try {
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
    // ⚠ 20261117 抓包: 真实客户端全程没调 FeedAnimal —— 动物吃牧草机里的草是自动的,
    //   这个接口是手动"投喂罐头"用的(消耗罐头 80021+)。自动巡牧场默认不发,
    //   需要 runRanchCare({ feedType: 4 }) 显式传入才执行。
    if (opts.feedType && opts.feedType !== 0) {
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
            let careView = null;
            try { careView = await getRanchOverview(); } catch { careView = null; }
            const r = await autoBuyCubs({ ...opts, view: careView });
            result.boughtCubs = r.bought;
            if (r.bought > 0) result.details.push(`买${r.details.join('/')}`);
        } catch (e) {
            logWarn('牧场', `买幼崽失败: ${e.message}`, { module: 'ranch', event: '买幼崽', result: 'error' });
        }
    }

    await gap();

    // 5.5a 清理自己的牧场(20261117 抓包: CleanAllRanch 清自己, 产便便 → 游商货币)
    if (opts.cleanOwn !== false && isAutomationOn('ranch_clean')) {
        try {
            const r = await autoCleanOwnRanch();
            result.cleanedFriends += r.cleaned;   // 沿用统计字段
            if (r.cleaned > 0) result.details.push('清理牧场');
        } catch (e) {
            logWarn('牧场', `清理牧场失败: ${e.message}`, { module: 'ranch', event: '清理牧场', result: 'error' });
        }
    }

    await gap();

    // 5.5b 偷好友牧场产物(20261117 抓包: StealProduce{gid}, feed_state==4 才偷)
    if (opts.stealFriends !== false && isAutomationOn('ranch_steal')) {
        try {
            const r = await autoStealFriendProduce(opts);
            result.stolenFriends = r.cleaned;
            if (r.cleaned > 0) result.details.push(`偷${r.cleaned}家`);
        } catch (e) {
            logWarn('牧场', `偷好友产物失败: ${e.message}`, { module: 'ranch', event: '偷好友产物', result: 'error' });
        }
    }

    await gap();

    // 5.6 建筑升级 / 地块解锁(2026-11-17 官方文档)
    let facility;
    try {
        facility = require('./ranch-facility');
    } catch { facility = null; }

    if (facility && opts.upgradeBuildings !== false && isAutomationOn('ranch_upgrade')) {
        try {
            const r = await facility.autoUpgradeBuildings(opts);
            result.buildingsCompleted = r.completed;
            result.buildingsUpgraded = r.upgraded;
            if (r.completed > 0 || r.upgraded > 0) {
                result.details.push(`建筑竣工${r.completed}/升级${r.upgraded}`);
            }
        } catch (e) {
            logWarn('牧场', `建筑升级失败: ${e.message}`, { module: 'ranch', event: '建筑升级', result: 'error' });
        }
    }

    await gap();

    if (facility && opts.unlockRegions !== false && isAutomationOn('ranch_unlock')) {
        try {
            const r = await facility.autoUnlockRegions(opts);
            result.regionsCompleted = r.completed;
            result.regionsUnlocked = r.unlocked;
            if (r.completed > 0 || r.unlocked > 0) {
                result.details.push(`地块竣工${r.completed}/发起${r.unlocked}`);
            }
        } catch (e) {
            logWarn('牧场', `地块解锁失败: ${e.message}`, { module: 'ranch', event: '地块解锁', result: 'error' });
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

    // 7. 牧场任务领取
    // ⚠ 修正: 牧场任务与农场任务完全独立, 必须用 TaskInfo{scene_id:2} 拉列表
    //   (见 docs/mc-ranch/牧场任务系统功能文档.md); 之前调 checkAndClaimTasks()
    //   拉的是农场任务列表, 牧场任务从来没领过。
    if (isAutomationOn('ranch_task')) {   // 统一由开关决定(原来 checkRanch 传 claimTasks:false 导致永不执行)
        try {
            const { checkAndClaimRanchTasks } = require('./task');
            const r = await checkAndClaimRanchTasks();
            result.ranchTasksClaimed = r.claimed;
            if (r.claimed > 0) result.details.push(`任务${r.claimed}`);
        } catch (e) {
            logWarn('牧场', `牧场任务领取失败: ${e.message}`, { module: 'ranch', event: '牧场任务', result: 'error' });
        }
    }

    return result;
}

// ============ 巡牧场循环(对照农场 checkFarm/startFarmCheckLoop 架构) ============
// 牧场节奏是分钟级的(产出间隔约 180 分钟, 每日操作有次数上限),
// 不能像巡田那样 3 秒一轮 —— 上一版挂在 farm tick 里每轮 8~10 个 RPC,
// 直接把连接打掉线了(面板进牧场页掉线就是这么叠加出来的)。

const RANCH_CHECK_INTERVAL_MIN_MS = 5 * 60 * 1000;   // 正常轮询间隔 5~8 分钟
const RANCH_CHECK_INTERVAL_MAX_MS = 8 * 60 * 1000;
const RANCH_PUSH_THROTTLE_MS = 60 * 1000;            // 推送触发最少间隔(1 分钟)
// 失败退避: 连续失败时按 2^N 拉长间隔, 上限 60 分钟
const RANCH_BACKOFF_MAX_MS = 60 * 60 * 1000;

const ranchScheduler = createScheduler('ranch');
let isCheckingRanch = false;
let ranchLoopRunning = false;
let externalRanchSchedulerMode = false;
let ranchFailStreak = 0;
let lastRanchPushAt = 0;

function randomRanchIntervalMs() {
    const minSec = RANCH_CHECK_INTERVAL_MIN_MS / 1000;
    const maxSec = RANCH_CHECK_INTERVAL_MAX_MS / 1000;
    return (minSec + Math.floor(Math.random() * (maxSec - minSec + 1))) * 1000;
}

/** 下次巡牧场的延迟: 正常随机 5-8 分钟; 连续失败按 2^N 退避 */
function nextRanchDelayMs() {
    const base = randomRanchIntervalMs();
    if (ranchFailStreak <= 0) return base;
    return Math.min(RANCH_BACKOFF_MAX_MS, base * Math.min(2 ** ranchFailStreak, 64));
}

function scheduleNextRanchCheck(delayMs) {
    if (externalRanchSchedulerMode) return;
    if (!ranchLoopRunning) return;
    ranchScheduler.setTimeoutTask('ranch_check_loop', Math.max(0, delayMs), async () => {
        if (!ranchLoopRunning) return;
        await checkRanch();
        if (!ranchLoopRunning) return;
        scheduleNextRanchCheck(nextRanchDelayMs());
    });
}

/**
 * 巡牧场一轮(自动模式入口, 对照农场 checkFarm):
 * 防重入 + ranch_auto 开关闸门 + 汇总日志 + 统计。
 * @returns {Promise<boolean>} 本轮有没有实际干活
 */
async function checkRanch() {
    if (isCheckingRanch) return false;
    if (!isAutomationOn('ranch_auto')) return false;
    isCheckingRanch = true;
    try {
        const result = await runRanchCare({ claimTasks: false });
        if (result && result.skipped === 'scene_locked') return false;

        // 统计(对照农场 recordOperation)
        if (result.harvested > 0) recordOperation('ranchHarvest', result.harvested);
        if (result.produced > 0) recordOperation('ranchProduce', result.produced);
        if (result.fed > 0) recordOperation('ranchFeed', result.fed);

        // 限流算一次失败 → 退避; 否则清零
        if (result.rateLimited) {
            ranchFailStreak += 1;
        } else {
            ranchFailStreak = 0;
        }

        // 一行汇总日志(对照农场 `[收:2 草:1] → 收获15/催产2` 格式)
        const parts = [];
        if (result.harvested > 0) parts.push(`收:${result.harvested}`);
        if (result.produced > 0) parts.push(`产:${result.produced}`);
        if (result.fed > 0) parts.push(`喂:${result.fed}`);
        if (result.feedMachineAdded > 0) parts.push(`草:${result.feedMachineAdded}`);
        if (result.sold > 0) parts.push(`卖:${result.sold}`);
        if (result.boughtCubs > 0) parts.push(`崽:${result.boughtCubs}`);
        if (result.rotationBought > 0) parts.push(`商:${result.rotationBought}`);
        if (parts.length > 0) {
            log('牧场', `[${parts.join(' ')}] ${result.details.join('/')}`, {
                module: 'ranch', event: '巡牧场', result: 'ok', actions: parts,
            });
        }
        return parts.length > 0;
    } catch (e) {
        ranchFailStreak += 1;
        logWarn('牧场', `巡牧场失败(连续第 ${ranchFailStreak} 次): ${e.message}`, {
            module: 'ranch', event: '巡牧场', result: 'error',
        });
        return false;
    } finally {
        isCheckingRanch = false;
    }
}

/**
 * FacilitiesNotify 推送触发(对照农场 landsChanged → onLandsChangedPush):
 * 动物产出/牧草机状态变化时服务端会推, 节流 1 分钟后插队巡一轮。
 */
function onRanchFacilitiesChanged() {
    if (!ranchLoopRunning) return;
    if (!isAutomationOn('ranch_auto')) return;
    if (isCheckingRanch) return;
    const now = Date.now();
    if (now - lastRanchPushAt < RANCH_PUSH_THROTTLE_MS) return;
    lastRanchPushAt = now;
    log('牧场', '收到建筑推送, 1 分钟后巡牧场', {
        module: 'ranch', event: '建筑推送通知', result: 'trigger_check',
    });
    ranchScheduler.setTimeoutTask('ranch_push_check', RANCH_PUSH_THROTTLE_MS, async () => {
        if (!isCheckingRanch) await checkRanch();
    });
}

function startRanchCheckLoop(options = {}) {
    if (ranchLoopRunning) return;
    externalRanchSchedulerMode = !!options.externalScheduler;
    ranchLoopRunning = true;
    ranchFailStreak = 0;
    sceneLocked = false;        // 场景锁定状态是 per-connection 的, 新连接重新探测
    sceneLockedAt = 0;
    networkEvents.on('ranchFacilitiesChanged', onRanchFacilitiesChanged);
    if (!externalRanchSchedulerMode) {
        scheduleNextRanchCheck(randomRanchIntervalMs());
    }
}

function stopRanchCheckLoop() {
    ranchLoopRunning = false;
    externalRanchSchedulerMode = false;
    ranchScheduler.clearAll();
    networkEvents.removeListener('ranchFacilitiesChanged', onRanchFacilitiesChanged);
}

/**
 * 插队巡一轮(worker 统一调度器用): 挂到外部队列时由 worker 决定节奏,
 * 这里只保留防重入与开关闸门。
 */
async function runRanchTick() {
    if (!ranchLoopRunning) return false;
    return checkRanch();
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
/**
 * 游商购买(ShopService.RotationBuyGoods, 20261117 北栎号抓包 byte-exact):
 * 请求 {1:uid, 2:数量, 3:刷新时间戳(秒), 4:1}。
 * @returns {{ok: boolean, items: Array<{id:number,count:number}>}}
 */
async function purchaseRotationGoods(uid, count = 1, refreshAtSec = 0) {
    const body = types.RotationBuyGoodsRequest.encode(types.RotationBuyGoodsRequest.create({
        uid: toLong(toNum(uid)),
        num: toLong(count),
        refresh_at: toLong(Math.floor(refreshAtSec / 1000) || 0),
        flag: 1,
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.shoppb.ShopService', 'RotationBuyGoods', body);
    const reply = types.RotationBuyGoodsReply.decode(replyBody);
    const items = (reply.get_items || []).map(it => ({ id: toNum(it.id), count: toNum(it.count) }));
    log('游商', `购买成功: ${items.map(i => `#${i.id}x${i.count}`).join('，') || '(无物品回执)'}`, {
        module: 'ranch', event: '游商购买', result: 'ok', uid: toNum(uid), count,
    });
    return { ok: true, items };
}

/**
 * 游商购买失败是否属于"当前不可买"的正常业务状态。
 *
 * 1004012 是线上实际返回的错误码(含义未知, 但出现在 RotationBuyGoods 上),
 * 从商品带"最低等级"限制来看, 大概率是等级/限购/刷新条件不满足。
 * 这类情况每轮都会发生, 不该当故障刷 error 日志。
 */
function isRotationNotPurchasable(e) {
    const msg = String((e && e.message) || '');
    // 已知的"买不了"错误码: 1004012(线上实际) + 1019 系列(限购/库存)
    return /code=1004012|code=1004019|code=1004020/.test(msg)
        || /限购|已售罄|未达|等级不足/.test(msg);
}

/** 给"不可购买"一个可读原因, 便于日志里一眼看出该做什么 */
function rotationErrorHint(e) {
    const msg = String((e && e.message) || '');
    if (/code=1004012/.test(msg)) return '等级不足或限购已满';
    if (/限购|已售罄/.test(msg)) return '限购已满';
    return msg.replace(/^.*code=\d+\s*/, '').trim() || '当前不可购买';
}

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
                else if (f2 === 12 && w2 === 2) {
                    // 限制条件: {1: "最低等级", 2: "5"} —— 等级不够时服务端拒绝购买(1004012)
                    const cond = {};
                    for (const [f3, , v3] of walkWire(v2)) {
                        if (f3 === 1) cond.name = v3.toString('utf8');
                        else if (f3 === 2) cond.value = v3.toString('utf8');
                    }
                    g.condition = cond;
                } else if (f2 === 13) g.uid = Number(v2);
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
/**
 * 自动清理自己的牧场(产出便便 → 游商货币)。
 * 每轮巡牧场发一次 CleanAllRanch(空 body); 没东西可清时服务端拒绝, 静默跳过。
 * ⚠ 20261117 抓包修正: CleanAllRanch 清的是自己的牧场, 不是好友的。
 */
async function autoCleanOwnRanch() {
    try {
        await cleanOwnRanch();
        return { cleaned: 1, details: ['清理完成'] };
    } catch (e) {
        // 没有待清理内容 = 正常状态, 静默
        return { cleaned: 0, details: [] };
    }
}

/**
 * 自动偷好友牧场产物(AnimalService.StealProduce, 20261117 抓包)。
 * 流程: EnterHomestead{gid,2} → GetRanchDetail{gid,2:{}} → feed_state==4 才发 StealProduce{gid}。
 * 节流: 每个好友每天偷一次(内存记录; 偷过的产物有冷却, 服务端也有每日上限)。
 * @returns {{cleaned: number, details: string[]}} cleaned = 偷到的次数(沿用字段名)
 */
const _stealToday = new Map();   // gid -> dateKey
async function autoStealFriendProduce(opts = {}) {
    const result = { cleaned: 0, details: [] };
    const maxPerRound = Math.max(1, toNum(opts.maxStealPerRound) || 10);
    const todayKey = new Date().toDateString();

    const { getFriendsList } = require('./friend');
    const friends = await getFriendsList().catch(() => []);
    if (!Array.isArray(friends) || friends.length === 0) return result;

    for (const f of friends.slice(0, 40)) {
        if (result.cleaned >= maxPerRound) break;
        const gid = toNum(f && f.gid);
        if (!gid) continue;
        if (_stealToday.get(gid) === todayKey) continue;
        try {
            const r = await stealFriendProduce(gid);
            _stealToday.set(gid, todayKey);
            if (r.ok) {
                result.cleaned += 1;
                result.details.push(f.name || gid);
            }
            await sleep(800);
        } catch (e) {
            // 偷失败(没得偷/权限不足)也标记今天, 别每轮都撞
            _stealToday.set(gid, todayKey);
            await sleep(500);
        }
    }
    if (result.cleaned > 0) {
        log('牧场', `偷好友产物 x${result.cleaned}: ${result.details.slice(0, 6).join('，')}`, {
            module: 'ranch', event: '偷好友产物', result: 'ok', count: result.cleaned,
        });
    }
    return result;
}

async function autoBuyRotationShop(opts = {}) {
    const result = { bought: 0, details: [], reason: '' };
    const shop = await getRotationShop();
    if (!shop.open) {
        result.reason = '集市未营业';
        log('游商', '兑换集市未营业, 跳过', { module: 'ranch', event: '游商', result: 'skip' });
        return result;
    }
    // 只考虑便便计价的商品
    const targets = shop.goods.filter(g => g.currencyId === 7002 && g.price > 0);
    if (targets.length === 0) {
        result.reason = '游商没有便便计价的商品';
        return result;
    }

    // ⚠ 商品可能带等级门槛({1:"最低等级", 2:"5"}), 不够时服务端直接拒绝(1004012)。
    //   以前不看这个字段, 于是每轮都发一次必然失败的请求并刷一条 error 日志。
    //   玩家等级从 userState 取(登录时就有), 取不到时不拦(交给服务端判定)。
    let playerLevel = 0;
    try {
        const { getUserState } = require('../utils/network');
        playerLevel = Number((getUserState() || {}).level) || 0;
    } catch { /* 取不到就不做本地拦截 */ }

    const blockedByLevel = [];
    const eligible = targets.filter((g) => {
        const cond = g.condition;
        if (!cond || !cond.name || !cond.value) return true;
        if (!/等级/.test(String(cond.name))) return true;
        const need = Number(cond.value) || 0;
        if (need <= 0 || playerLevel <= 0) return true;
        if (playerLevel < need) {
            blockedByLevel.push(`${g.condition.name} ${need}`);
            return false;
        }
        return true;
    });
    if (blockedByLevel.length) {
        // 只记一条汇总(不是每个商品一条), 且用 info 级别 —— 这是"暂时买不了", 不是故障
        log('游商', `跳过 ${blockedByLevel.length} 个未达等级要求的商品(需 ${[...new Set(blockedByLevel)].join('/')}，当前 Lv${playerLevel})`, {
            module: 'ranch', event: '游商', result: 'skip', count: blockedByLevel.length, playerLevel,
        });
    }
    if (eligible.length === 0) {
        result.reason = `商品都需要等级要求（当前 Lv${playerLevel}）`;
        return result;
    }

    // 背包里的便便数量
    const { getRanchBagDetail } = require('./warehouse');
    const bag = await getRanchBagDetail();
    const poop = bag.items.find(it => Number(it.id) === 7002);
    let poopCount = poop ? Number(poop.count) : 0;
    if (poopCount <= 0) {
        result.reason = '没有便便可兑换';
        log('游商', '没有便便可兑换', { module: 'ranch', event: '游商', result: 'skip' });
        return result;
    }

    for (const g of eligible) {
        if (poopCount < g.price) continue;
        // 限购次数
        const maxByLimit = g.limit > 0 ? g.limit : 99;
        const affordable = Math.floor(poopCount / g.price);
        const count = Math.min(maxByLimit, affordable);
        if (count <= 0) continue;
        try {
            // ⚠ 20261117 抓包修正: 游商购买的真实接口是 RotationBuyGoods,
            //   请求 {1:uid, 2:数量, 3:刷新时间戳, 4:1} —— 不是 MallService.Purchase
            const r = await purchaseRotationGoods(g.uid, count, shop.refreshAt);
            if (r && (r.ok !== false)) {
                poopCount -= g.price * count;
                result.bought += count;
                result.details.push(`#${g.itemId}x${count}(便便${g.price * count})`);
            }
        } catch (e) {
            // 1004012 等"当前买不了"(等级/限购/已过期)属正常业务状态, 不是故障:
            // 记 info 而不是 warn, 否则每轮刷一条 error 日志。
            if (isRotationNotPurchasable(e)) {
                log('游商', `商品 #${g.itemId} 当前不可购买(${rotationErrorHint(e)})，跳过`, {
                    module: 'ranch', event: '游商购买', result: 'skip', itemId: g.itemId,
                });
            } else {
                logWarn('游商', `购买失败 #${g.itemId}: ${e.message}`, {
                    module: 'ranch', event: '游商购买', result: 'error', itemId: g.itemId,
                });
            }
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
                else if (f2 === 5 && w2 === 0) out.moduleType = Number(v2);  // 模块类型(牧草机=8), NOT 等级
                else if (f2 === 6 && w2 === 2) {
                    const inner = walkWire(v2);
                    const id = inner.find(x => x[1] === 1);
                    const amt = inner.find(x => x[1] === 2);
                    out.upgradeCost = { itemId: id ? Number(id[3]) : 0, amount: amt ? Number(amt[3]) : 0 };
                }
                // ⚠ 2026-11-17 线上实测 + 官方配置表(MCFacilityConfig)确认:
                //   #4/#8 = buildingId(配置 id); **等级从它还末位推**:
                //     牧草机 7001001=Lv1 / 7001002=Lv2 / 7001003=Lv3
                //   #5 = module_type(FEED_MACHINE=8) —— 曾被误当等级 → 面板显示 Lv8(实际 Lv1)
                //   #9 = 建筑类型, #10 = ?, #13 = 占位数, #14 = 容量
                //   #21 = {4:-1,7:1,8:1} 不含存量! 牧草存量在 RanchInfo.grass(#5)
                else if (f2 === 8 && w2 === 0) out.buildingId = Number(v2);
                else if (f2 === 9 && w2 === 0) out.buildingType = Number(v2);
                else if (f2 === 10 && w2 === 0) out.level2 = Number(v2);
                else if (f2 === 13 && w2 === 0) out.used = Number(v2);
                else if (f2 === 14 && w2 === 0) out.capacity = Number(v2);
                else if (f2 === 21 && w2 === 2) {
                    for (const [f3, w3, v3] of walkWire(v2)) {
                        if (f3 === 1 && w3 === 0) out.stored = Number(v3);
                        else if (f3 === 2 && w3 === 0) out.remainingSecs = Number(v3);
                    }
                }
            }
        }
    }
    // 等级 = buildingId 末位(官方配置表: 7001001=Lv1 / 7001002=Lv2 / 7001003=Lv3)
    if (out.buildingId > 0) out.level = out.buildingId % 10;
    return out;
}

/** 给牧草机添加牧草(从背包把牧草 7001 加进去) */
/**
 * 给牧草机投草(AddFeed, 20261117 抓包 + 官方文档 6.2)。
 * 请求: {1: instance_id, 2: add_count, 3: use_gold, 4: host_gid}
 *   use_gold = 仓库牧草不足时用金币补齐(自动补草默认 false, 不乱花钱)
 *   host_gid = 0 表示自己; 非 0 是给好友的牧草机赠送
 */
async function addFeedToMachine(count = 100, opts = {}) {
    const useGold = opts.useGold === true;
    const hostGid = toNum(opts.hostGid) || 0;
    const w = protobuf.Writer.create();
    w.uint32((1 << 3) | 0).int64(toLong(FEED_MACHINE_ID));
    w.uint32((2 << 3) | 0).int64(toLong(count));
    w.uint32((3 << 3) | 0).int64(toLong(useGold ? 1 : 0));
    w.uint32((4 << 3) | 0).int64(toLong(hostGid));
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
    const { getRanchBagDetail } = require('./warehouse');
    const bag = await getRanchBagDetail();
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
        // 剩余可买: 0 = 已售罄; null = 不限购(前端按 99 封顶)
        remaining: toNum(g.limit_count) > 0
            ? Math.max(0, toNum(g.limit_count) - toNum(g.bought_num))
            : null,
        unlocked: !!g.unlocked,
        currencyId: toNum(g.price_id) || 1007,
        // 收益比 = 整只回收 / 幼崽成本
        valueRatio: GROWN_VALUE[toNum(g.item_id)]
            ? GROWN_VALUE[toNum(g.item_id)] / Math.max(1, toNum(g.price))
            : 0,
    })).sort((a, b) => b.valueRatio - a.valueRatio);
}

/**
 * 读取金券余额(1007)。
 * 金券在**农场背包**里(不是牧场背包), 所以走 ItemService.Bag 而不是 GetBag{scene:2}。
 * @returns {Promise<number|null>} 余额; 读不到返回 null, 由调用方决定是拦下还是放行
 */
async function getVoucherBalance() {
    try {
        const warehouse = require('./warehouse');
        const bag = await warehouse.getBag();
        for (const it of warehouse.getBagItems(bag)) {
            if (toNum(it && it.id) === 1007) return toNum(it.count);
        }
        return 0;
    } catch {
        return null;
    }
}

/**
 * 按指定数量买某一种幼崽(面板加购用)。
 * 与 autoBuyCubs 的区别: 那个是"按收益比自动挑", 这里是"用户点哪个买哪个、买几只"。
 *
 * @param {number} goodsId 商品 id(ShopInfo 里的 GoodsInfo.id)
 * @param {number} count 购买数量
 * @param {{price?:number}} [opts] price 不传则现查一次商店拿单价
 * @returns {Promise<{ok:boolean, bought:number, spent:number, name:string, price:number}>}
 */
async function buyCubByGoods(goodsId, count, opts = {}) {
    const want = Math.max(1, Math.floor(toNum(count) || 1));
    const shop = await getCubShop();
    const goods = shop.find(g => g.goodsId === toNum(goodsId));
    if (!goods) {
        return { ok: false, bought: 0, spent: 0, name: '', price: 0, error: '商店里没有这个幼崽' };
    }
    if (!goods.unlocked) {
        return { ok: false, bought: 0, spent: 0, name: goods.name, price: goods.price, error: '该幼崽尚未解锁' };
    }
    if (goods.price <= 0) {
        return { ok: false, bought: 0, spent: 0, name: goods.name, price: 0, error: '价格异常' };
    }

    // 限购余量: remaining=null 表示不限购
    let quantity = want;
    if (goods.remaining !== null && goods.remaining !== undefined) {
        if (goods.remaining <= 0) {
            return { ok: false, bought: 0, spent: 0, name: goods.name, price: goods.price, error: '已达限购' };
        }
        quantity = Math.min(quantity, goods.remaining);
    }

    // 余额校验: 读不到余额时不拦(交给服务端判定), 读到则提前挡住, 避免必然失败的请求
    const price = toNum(opts.price) > 0 ? toNum(opts.price) : goods.price;
    const balance = await getVoucherBalance();
    if (balance !== null) {
        const affordable = Math.floor(balance / price);
        if (affordable <= 0) {
            return {
                ok: false, bought: 0, spent: 0, name: goods.name, price,
                error: `金券不足(需 ${price}, 现有 ${balance})`,
            };
        }
        quantity = Math.min(quantity, affordable);
    }

    if (quantity <= 0) {
        return { ok: false, bought: 0, spent: 0, name: goods.name, price, error: '可买数量为 0' };
    }

    try {
        const reply = await purchaseShopGoods(goods.goodsId, quantity, price);
        const costItems = (reply && reply.cost_items) || [];
        const spentThis = costItems.reduce((s, it) => s + toNum(it.count), 0) || price * quantity;
        log('牧场', `购买幼崽: ${goods.name}x${quantity} (花费 ${spentThis} 金券)`, {
            module: 'ranch', event: '买幼崽', result: 'ok',
            animalId: goods.animalId, count: quantity, spent: spentThis,
        });
        return {
            ok: true, bought: quantity, spent: spentThis, name: goods.name, price,
            // 实际买到的可能被服务端限购/余额削减, 如实返回
            requested: want,
        };
    } catch (e) {
        logWarn('牧场', `买幼崽失败 ${goods.name}x${quantity}: ${e.message}`, {
            module: 'ranch', event: '买幼崽', result: 'error',
            animalId: goods.animalId, count: quantity,
        });
        return { ok: false, bought: 0, spent: 0, name: goods.name, price, error: e.message };
    }
}

/**
 * 自动买幼崽: 按收益比从高到低, 优先买还有空槽能养、收益比最高的。
 * @param {object} [opts]
 * @param {number} [opts.maxSpend] 本次最多花多少金券(默认 5000)
 * @param {number} [opts.slots] 空槽位数(默认从牧场详情算)
 * @returns {Promise<{bought:number, spent:number, details:string[]}>} 本次购买结果
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
            // ⚠ 必须用带兜底的 view(AllCells 补容量), 不能用裸 getRanchDetail:
            //   从没进过牧场的号 RanchInfo 是空的(coop/pen 全 0) → slots=0 → 永远不买幼崽。
            const view = opts.view || await getRanchOverview();
            slots = Math.max(0, (toNum(view.coopCount) + toNum(view.penCount)) - (view.animals || []).length);
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
    const { getRanchBagDetail, sellItems } = require('./warehouse');
    const bag = await getRanchBagDetail();
    const products = bag.items.filter(it => Number(it.itemType) === PRODUCE_ITEM_TYPE && Number(it.count) > 0);
    if (products.length === 0) return result;

    const payload = [];
    for (const it of products) {
        // ⚠ 必须带 uid: 牧场产物出售接口缺 uid 会返回 1000020 请求参数错误(实测)
        payload.push({ id: toNum(it.id), count: toNum(it.count), uid: toNum(it.uid) });
        result.sold += toNum(it.count);
        result.details.push(`${getAnimalName(toNum(it.id)) || it.id}x${toNum(it.count)}`);
    }
    try {
        const reply = await sellItems(payload, { skipFarmFilter: true });   // 牧场产物不走农场果实白名单
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
    // 兼容错误的调用形态(opts 被传成字符串), 并在未知 op 时把收到的参数打进错误里,
    // 便于定位"半更新"部署下 admin/worker 版本不一致的问题
    if (typeof opts === 'string') opts = { op: opts };
    const op = String((opts && opts.op) || '').trim();
    if (op && !['harvest', 'produce', 'feed', 'feedmachine', 'buycub', 'rotation', 'clean', 'steal', 'place', 'collect', 'harvestanimal', 'donate', 'hazard', 'upgrade', 'unlock', 'batch'].includes(op)) {
        logWarn('牧场', `收到未知操作: ${JSON.stringify(opts).slice(0, 200)}`, {
            module: 'ranch', event: '操作牧场', result: 'unknown_op', op,
        });
    }
    const slot = toNum(opts.slot) || 0;
    const feedType = toNum(opts.feedType) || 4;
    const count = toNum(opts.count) || 1;

    switch (op) {
        case 'harvest': {
            // 有槽位 = 单只收获(收副产物, 动物留栏); 无槽位 = 全场一键(自动流程用)
            if (slot > 0) {
                // ⚠ CollectProduce / HarvestAnimal 服务端不存在(2026-11-17 对照实验证实),
                //   单只收获暂时只能走全场 HarvestRanch。这里明确告知而不是发一个必然失败的请求。
                return {
                    ok: false,
                    action: '收获',
                    error: '单只收获接口服务端未开放，请用自动收获（设置里的「自动收获」开关）',
                    slot,
                };
            }
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
            try {
                const r = await triggerProduce(slot);
                let produced = 0;
                for (const pr of (r.receipts || [])) produced += toNum(pr.count);
                return { ok: true, action: '催产', detail: `${produced} 个产物` };
            } catch (e) {
                if (isExpectedRanchError(e)) {
                    return { ok: false, action: '催产', error: '该动物当前不能催产(产出冷却中或未开轮)' };
                }
                throw e;
            }
        }
        case 'feed': {
            await feedAnimal(feedType, count);
            return { ok: true, action: '喂食', detail: `方式${feedType}x${count}` };
        }
        case 'feedmachine': {
            // 给牧草机补草(默认拉满 100, 实际受背包存量限制)
            const r = await addFeedToMachine(toNum(opts.count) || 100);   // count 默认 1, 不能写 count || 100
            return { ok: true, action: '牧草机加草', detail: `存量 ${r.stored}` };
        }
        case 'buycub': {
            // 用户指定了 goodsId + count(面板加购) → 精确买; 否则走"按收益比自动挑"
            if (toNum(opts.goodsId) > 0) {
                const r = await buyCubByGoods(opts.goodsId, opts.count, { price: opts.price });
                if (!r.ok) {
                    return { ok: false, action: '买幼崽', error: r.error, name: r.name };
                }
                return {
                    ok: true,
                    action: '买幼崽',
                    detail: `${r.name}x${r.bought} / 花 ${r.spent} 金券`,
                    bought: r.bought,
                    spent: r.spent,
                };
            }
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
            // 把"为什么没买到"说清楚, 而不是一律"集市未营业或没有便便"
            let detail;
            if (r.bought > 0) {
                detail = r.details.join('，');
            } else if (r.reason) {
                detail = r.reason;
            } else {
                detail = '集市未营业或没有便便';
            }
            return { ok: true, action: '游商兑换', detail };
        }
        case 'clean': {
            // 清理自己的牧场(20261117 抓包修正: CleanAllRanch 只清自己)
            const r = await autoCleanOwnRanch();
            return {
                ok: true,
                action: '清理牧场',
                detail: r.cleaned > 0 ? '清理完成' : '没有待清理的内容',
            };
        }
        case 'place': {
            // 幼崽入栏(opts.cubItemId / opts.count / opts.slot)
            const cub = toNum(opts.cubItemId);
            if (!cub) throw new Error('缺少幼崽物品 id');
            const r = await placeAnimal(cub, toNum(opts.count) || 1, slot);
            const animals = (r.ranch && r.ranch.animals) || [];
            return { ok: true, action: '幼崽入栏', detail: `当前在养 ${animals.length} 只` };
        }
        case 'collect': {
            // ⚠ CollectProduce 服务端不存在(对照实验证实), 不要发请求
            return { ok: false, action: '收取产物', error: '该接口服务端未开放，请用「收获」批量收取' };
            let n = 0;
            for (const g of (r.gains || [])) for (const it of (g.items || [])) n += toNum(it.count);
            return { ok: true, action: '收取产物', detail: `槽${slot} → ${n} 个` };
        }
        case 'harvestanimal': {
            // ⚠ HarvestAnimal 服务端不存在(对照实验证实), 不要发请求
            return { ok: false, action: '收获出栏', error: '该接口服务端未开放，请用「收获」批量收取' };
            let n = 0;
            for (const g of (r.gains || [])) for (const it of (g.items || [])) n += toNum(it.count);
            return { ok: true, action: '收获出栏', detail: `槽${slot} → ${n} 个` };
        }
        case 'donate': {
            if (!slot) throw new Error('需要指定槽位');
            const r = await donateAnimal(slot);
            const gains = (r.gains || []).map(i => `#${toNum(i.id)}x${toNum(i.count)}`).join('，');
            return { ok: true, action: '出售动物', detail: gains || `槽${slot}` };
        }
        case 'hazard': {
            // 放蚊子(使坏) —— opts.gid 指定好友
            if (!opts.gid) throw new Error('需要指定好友 gid');
            await putHazard(toNum(opts.gid), slot);
            return { ok: true, action: '放蚊子', detail: `gid=${toNum(opts.gid)}` };
        }
        case 'batch': {
            // 批量操作(对照农场"整田操作"): harvest/produce/clean/feed
            const sub = String(opts.batch || '').trim();
            if (sub === 'harvest') {
                const r = await harvestRanch(1);
                const items = [];
                for (const g of (r.gains || [])) for (const it of (g.items || [])) {
                    const id = toNum(it.item_id);
                    if (id === 1102) continue;
                    items.push(`${getAnimalName(id) || id}x${toNum(it.count)}`);
                }
                return { ok: true, action: '全场收获', detail: items.join('，') || '没有可收的' };
            }
            if (sub === 'produce') {
                const r = await triggerProduce(0);
                let n = 0;
                for (const p2 of (r.receipts || [])) n += toNum(p2.count);
                return { ok: true, action: '全场催产', detail: `${n} 个产物` };
            }
            if (sub === 'clean') {
                const r = await autoCleanOwnRanch();
                return { ok: true, action: '全场清理', detail: r.cleaned > 0 ? '清理完成' : '没有待清理的' };
            }
            if (sub === 'feed') {
                const r = await feedAnimal(4, toNum(opts.count) || 1);
                return { ok: true, action: '全场喂罐头', detail: '已投喂' };
            }
            throw new Error(`不支持的批量操作: ${sub}`);
        }
        case 'upgrade': {
            const f = require('./ranch-facility');
            if (opts.instId) {
                if (opts.complete) {
                    const r = await f.completeBuildingUpgrade(toNum(opts.instId));
                    return { ok: true, action: '领取竣工', detail: `#${toNum(opts.instId)} → Lv${r.facility ? r.facility.level : '?'}` };
                }
                const r = await f.upgradeBuilding(toNum(opts.instId));
                return { ok: true, action: '建筑升级', detail: `#${toNum(opts.instId)} → Lv${r.level}` };
            }
            // 不带 instId 有两种意图, 用 opts.list 区分(不要悄悄改掉旧行为):
            //   opts.list=true  → 只读: 返回建筑清单(排查用, 原来就是这个行为)
            //   其他            → 一键: 先领竣工再升级(面板「建筑升级」按钮走这里)
            // ⚠ autoUpgradeBuildings 只认 maxPerRound, 领竣工是它内部的第一步, 没有别的开关。
            if (!opts.list) {
                const r = await f.autoUpgradeBuildings({ maxPerRound: toNum(opts.maxPerRound) || 3 });
                return {
                    ok: true,
                    action: '建筑升级',
                    detail: (r.details && r.details.length) ? r.details.join('，') : '没有可升级/可领取的建筑',
                };
            }
            // GetBuildingList 返回的是"未放置的建筑背包"(实测为空),
            // 已放置建筑在 AllCells.buildings 里
            const all = await f.getAllCells();
            return {
                ok: true,
                action: '建筑列表',
                detail: all.buildings.map(b => `#${b.instId} Lv${b.level}${b.status === 1 ? '(升级中)' : ''}`).join('，') || '暂无建筑',
            };
        }
        case 'unlock': {
            // 地块解锁: 一键解到底(自动流程里由 ranch_unlock 开关控制, 这里是手动入口)
            const f = require('./ranch-facility');
            const r = await f.autoUnlockRegions({});
            return {
                ok: true,
                action: '地块解锁',
                detail: (r.details && r.details.length) ? r.details.join('，') : '没有可解锁的地块',
            };
        }
        case 'steal': {
            // 偷好友牧场产物(opts.gid 指定单个好友; 不传则批量)
            if (opts.gid) {
                const r = await stealFriendProduce(toNum(opts.gid));
                return {
                    ok: r.ok,
                    action: '偷产物',
                    detail: r.ok ? '偷取成功' : '该好友没有可偷的产物',
                };
            }
            const r = await autoStealFriendProduce(opts);
            return {
                ok: true,
                action: '偷好友产物',
                detail: r.cleaned > 0 ? `偷了${r.cleaned}家: ${r.details.slice(0, 6).join('，')}` : '今天没有可偷的好友',
            };
        }
        default:
            throw new Error(`不支持的操作: ${JSON.stringify(op)} (收到参数: ${JSON.stringify(opts).slice(0, 300)})`);
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
    checkRanch,
    startRanchCheckLoop,
    stopRanchCheckLoop,
    runRanchTick,
    getNextRanchDelayMs: nextRanchDelayMs,
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
    buyCubByGoods,
    getVoucherBalance,
    autoSellRanchProducts,
    placeAnimal,
    collectProduce,
    harvestAnimal,
    donateAnimal,
    cleanRanch,
    putHazard,
    useFeedBucket,
    cleanOwnRanch,
    stealFriendProduce,
    autoStealFriendProduce,
    purchaseRotationGoods,
    getRanchWeightScore,
    __privateRanchFns: {
        calcRanchLevel, parseRotationShopReply, parseFeedMachineReply, walkWire, isEmptyRanchView,
        // 游商: 供测试验证"等级不够就不发购买请求 + 不刷 error 日志"
        autoBuyRotationShop, isRotationNotPurchasable, rotationErrorHint,
    },
};