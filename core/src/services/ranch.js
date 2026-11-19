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
    // ⚠ 1045202 的语义**没有实证**: 抓包/文档里都没有。
    //   之前注释写成"网络繁忙(服务端限流)"是凭字面猜的, 结果喂食 100% 报这个码时
    //   被误当成限流去"退避重试", 真正的原因被掩盖了。
    //   现在单独命名, 对外只转达服务端原文, 不再自己编解释。
    FEED_REJECTED: 1045202,      // 喂食被拒(具体原因未知, 见服务端 message)
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
        || code === RANCH_ERR.FEED_REJECTED
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
/**
 * 喂食/投喂罐头(AnimalService.FeedAnimal)。
 *
 * feed_type 语义(2026-11-18 用抓包 20261116-215723 实测确认):
 *   4 = 普通罐头(无机罐头容器 7003)
 *       · 每只动物**只能用一次**
 *       · 效果: 把 produce_at(#10) 推进 3600 秒
 *   5 = 有机罐头-短档 / 6 = 有机罐头-长档(有机罐头容器 7004)
 *       · **不限次数**
 *       · 效果: 追加罐头加成截止时刻 can_to_market_at(#11) ≈ +7206 秒
 *
 * 抓包里的请求序列也印证了这一点: 4 → 6 → 5 → 6 → 5 交替,
 * 4 只出现一次, 5/6 反复出现。
 *
 * count 不是倍率: ft=4 count=2 与 count=1 都是 +3600s 量级,
 * 它只是"一次喂几只动物"。
 *
 * @param feedType 4(普通) / 5,6(有机)
 * @param count    本次作用于几只
 */
const FEED_TYPE = {
    NORMAL_CAN: 4,       // 普通罐头: 每只一次
    ORGANIC_A: 5,        // 有机罐头: 不限次数
    ORGANIC_B: 6,
};
const FEED_TYPE_LABEL = {
    4: '普通罐头(每只一次)',
    5: '有机罐头',
    6: '有机罐头',
};

/**
 * 喂食失败时给人看的提示。
 * 两种罐头的失败原因完全不同, 混在一起说"当前无法喂食"会让人以为功能坏了。
 */
function feedFailureHint(feedType, e) {
    const code = parseRanchErrorCode(e);
    const raw = String(e && e.message || '').replace(/^[^:]*:\s*/, '').trim();
    if (code === RANCH_ERR.CANS_EMPTY) {
        return '罐头桶已用完，请先用「罐头」道具补充对应容器(普通罐头→无机容器，有机罐头→有机容器)';
    }
    if (code === RANCH_ERR.FEED_REJECTED) {
        // 语义未证实: 不编原因, 只转达服务端原文
        return `喂食被服务端拒绝(code=1045202)${raw ? `：${raw}` : ''}`;
    }
    if (Number(feedType) === FEED_TYPE.NORMAL_CAN) {
        return `普通罐头每只动物只能用一次，请改用有机罐头(可重复使用)。code=${code}${raw ? `：${raw}` : ''}`;
    }
    return `喂食失败(code=${code})${raw ? `：${raw}` : ''}`;
}

/**
 * 把背包里的「罐头」灌进罐头桶。
 *
 * ⭐ 这是喂食的前置步骤, 之前完全没实现:
 *   80021~80024(普通罐头) / 80031~80034(有机罐头) 是**道具**(itemType=109),
 *   必须先 Use 灌进对应容器(7003 无机桶 / 7004 有机桶), 桶里有时长才能喂。
 *   线上表现就是背包里明明有 72 个罐头, 喂食却一直回「罐头桶已用完(1045234)」。
 *
 * 抓包(20261103-194153)证实 Use 的真实编码是嵌套形态:
 *   {1: {1: item_id, 2: count, 6: uid}}   ← 必须带 uid
 *
 * @param {'normal'|'organic'} kind
 * @param {{maxItems?:number}} [opts]
 * @returns {Promise<{used:number, details:string[]}>}
 */
/**
 * 自动使用牧场背包里可直接使用的道具 —— 对照农场的 warehouse.autoUseBagItems。
 *
 * 为什么牧场要单独一套:
 *   牧场道具在 **GetBag{global_scene_id:2}** 里, 农场背包(ItemService.Bag)里根本没有
 *   (线上实测: 农场背包 0 个罐头, 牧场背包 4 个)。
 *   而 warehouse 的 AUTO_USE_EXCLUDED_TYPES 把 type=109(罐头) 排除掉了 ——
 *   那条注释写的就是"本仓库没有牧场模块", 现在补上了。
 *
 * 自动使用的判定与农场一致:
 *   · ItemInfo.can_use === 1
 *   · 排除"必须先选目标/走别的协议"的类型(容器/礼包/化肥/活动道具/狗粮/现金类)
 *
 * 受同一个开关控制: automation.auto_use_items
 *
 * @param {{onlyIds?:number[]}} [opts]
 * @returns {Promise<{used:number, details:string[]}>}
 */
const AUTO_USE_SCAN_INTERVAL_MS = 60 * 1000;
let ranchAutoUseLastCheckAt = 0;
const ranchAutoUseFailedIds = new Set();
// 与农场 warehouse.js 的 AUTO_USE_EXCLUDED_TYPES 保持同樣口径:
// 排除容器(2)/礼包(11,33)/化肥(7)/狗粮(9)/活动道具(23)/现金类(25,27,36)
const RANCH_AUTO_USE_EXCLUDED_TYPES = new Set([2, 7, 11, 33, 9, 23, 25, 27, 36]);

async function autoUseRanchBagItems(opts = {}) {
    const now = Date.now();
    const onlyIds = Array.isArray(opts.onlyIds) && opts.onlyIds.length
        ? new Set(opts.onlyIds.map(x => Number(x) || 0).filter(x => x > 0))
        : null;
    if (!onlyIds && now - ranchAutoUseLastCheckAt < AUTO_USE_SCAN_INTERVAL_MS) {
        return { used: 0, details: [] };
    }
    const finish = (r) => {
        if (!onlyIds) ranchAutoUseLastCheckAt = now;
        return r;
    };

    let getItemById = null;
    try { getItemById = require('../config/gameConfig').getItemById; } catch { /* 没配置就不做 */ }

    let bag;
    try {
        bag = await require('./warehouse').getRanchBagItems();
    } catch {
        return finish({ used: 0, details: [], reason: '读取牧场背包失败' });
    }

    const targets = [];
    for (const it of bag) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        const uid = toNum(it.uid);
        if (id <= 0 || count <= 0 || uid <= 0) continue;
        if (ids_contains(onlyIds, id)) continue;      // onlyIds 给了但没命中 → 跳过
        if (ranchAutoUseFailedIds.has(id)) continue;
        const info = getItemById ? getItemById(id) : null;
        if (!info || Number(info.can_use) !== 1) continue;
        const type = Number(info.type) || 0;
        if (RANCH_AUTO_USE_EXCLUDED_TYPES.has(type)) continue;
        // 罐头(type=109)不在这里用: 桶空了时由 feed 分支按需灌(避免一次性灌光背包)
        if (type === 109) continue;
        targets.push({ id, count, uid, name: info.name || `#${id}` });
    }
    if (!targets.length) return finish({ used: 0, details: [] });

    let used = 0;
    const details = [];
    for (const t of targets) {
        try {
            await useItemWithUid(t.id, t.count, t.uid);
            used += t.count;
            details.push(`${t.name}x${t.count}`);
            await sleep(300);
        } catch (e) {
            // 连续失败就记住, 别每轮刷同一条错误
            ranchAutoUseFailedIds.add(t.id);
            logWarn('牧场', `自动使用道具失败 ${t.name}: ${String(e.message || '').slice(0, 80)}`, {
                module: 'ranch', event: '自动使用道具', result: 'error', itemId: t.id,
            });
        }
    }
    // 罐头不自动灌桶。
    // ⚠ 之前这里会自动把背包里所有罐头(72 个)灌进桶, 属于破坏性操作:
    //    桶有容量上限, 灌多了是浪费; 而且用户可能想自己决定用哪种。
    //    现在只在**喂食时桶空了**才按需灌一个(见 feed 分支的 autoFillCans)。

    if (used > 0) {
        log('牧场', `已自动使用牧场背包道具: ${details.join('，')}`, {
            module: 'ranch', event: '自动使用道具', result: 'ok', count: used,
        });
    }
    return finish({ used, details });
}

/** onlyIds 为空时不过滤; 给了就只处理列表内的 */
function ids_contains(onlyIds, id) {
    return !!onlyIds && !onlyIds.has(id);
}

async function fillCanBuckets(kind = 'normal', opts = {}) {
    const result = { used: 0, details: [] };
    // 普通罐头 80021~80024 / 有机罐头 80031~80034
    const isNormal = kind !== 'organic';
    const ids = isNormal ? [80021, 80022, 80023, 80024] : [80031, 80032, 80033, 80034];

    let bag;
    try {
        bag = await require('./warehouse').getRanchBagItems();
    } catch {
        return result;
    }
    // 按"大的先灌"排序(12h → 8h → 4h → 1h): 少的次数灌进更多时长
    const cans = bag
        .filter(it => ids.includes(toNum(it.id)) && toNum(it.count) > 0 && toNum(it.uid) > 0)
        .sort((a, b) => ids.indexOf(toNum(a.id)) - ids.indexOf(toNum(b.id)));

    if (!cans.length) {
        return result;
    }

    // ⚠ 一次只灌**一个**罐头(不是把该 uid 的全部 count 灌进去)。
    //   桶有容量上限, 灌多了是浪费; 而且 useItemWithUid 的 count 是"用几个",
    //   传 can.count=27 会一口气把 27 个全用掉 —— 线上实测就是这么把 72 个罐头灌光的。
    //   maxItems 表示"最多灌几个", 由调用方按需给(喂食一次给 1~2 个就够了)。
    const maxItems = Math.max(1, toNum(opts.maxItems) || 1);
    let filled = 0;
    for (const can of cans) {
        if (filled >= maxItems) break;
        try {
            await useItemWithUid(toNum(can.id), 1, toNum(can.uid));
            result.used += 1;
            filled += 1;
            result.details.push(`#${toNum(can.id)}`);
            await sleep(300);
        } catch (e) {
            const code = parseRanchErrorCode(e);
            log('牧场', `灌罐头失败 #${toNum(can.id)}: code=${code || '?'} ${String(e.message || '').slice(0, 60)}`, {
                module: 'ranch', event: '灌罐头', result: 'error', itemId: toNum(can.id), code,
            });
            break;
        }
    }
    if (result.used > 0) {
        log('牧场', `已灌罐头 ${result.used} 个进${isNormal ? '普通' : '有机'}罐头桶: ${result.details.join('，')}`, {
            module: 'ranch', event: '灌罐头', result: 'ok', kind, count: result.used,
        });
    }
    return result;
}

/**
 * 用 uid 精确使用一个道具(抓包实测的嵌套形态)。
 * warehouse.useItem 用的是旧编码(item_id/count/land_ids), 对罐头不吃, 所以单独实现。
 * @param {number} itemId
 * @param {number} count
 * @param {number} uid
 */
async function useItemWithUid(itemId, count, uid) {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(10).fork();          // #1: item (嵌套)
    itemWriter.uint32(8).int64(toLong(toNum(itemId)));    // item.id
    itemWriter.uint32(16).int64(toLong(Math.max(1, toNum(count) || 1))); // item.count
    itemWriter.uint32(48).int64(toLong(toNum(uid)));      // item.uid (#6)
    itemWriter.ldelim();
    const body = writer.finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
    return replyBody;
}

/**
 * 牧场动物接口里的 host_gid 到底该填什么。
 *
 * ⭐ 2026-11-18 定案(两份抓包 + 线上实测):
 *   RanchInfo.host_gid 恒为 **10001** —— 这是**牧场实例 ID, 不是玩家 QQ 号**。
 *   而 feedAnimal 等接口之前用的是 userState.gid(账号3 实测 = 1244632861),
 *   拿 QQ 号去当 host_gid → 服务端一律回 1045202(文案"网络繁忙", 其实是"找不到这个牧场")。
 *
 * 抓包实证: FeedAnimal 请求 target = {1: 10001, 2: feedType}
 * 所以这里默认取牧场实例 ID; 访问好友牧场时才传好友的对应值。
 */
const RANCH_SELF_HOST_GID = 10001;

// ⭐ 2026-11-19: 窝/棚是两个**不同实例**(窝 10001, 棚 10003, 见 GetRanchDetailReply 的
//   repeated RanchInfo)。所有动物接口(target#1)用的 host_gid 就是 ranch_inst_id。
//   以前写死 10001, 于是养殖棚动物(羊/牛…)时服务端回"动物不存在" —— 它在 10003 那个栏舍里。
//   这里缓存最近一次 GetRanchDetail 拿到的实例, 让 feedAnimal 等接口能选对栏舍。
let lastRanchInstIds = [];

/** 记录最近一次详情里的栏舍实例(窝/棚) */
function rememberRanchInstIds(view) {
    if (!view) return;
    const ids = [];
    for (const g of (view.coops || [])) if (toNum(g.ranchInstId) > 0) ids.push(toNum(g.ranchInstId));
    for (const g of (view.pens || [])) if (toNum(g.ranchInstId) > 0) ids.push(toNum(g.ranchInstId));
    if (ids.length) lastRanchInstIds = Array.from(new Set(ids));
}

/**
 * 解析本次要用的 host_gid: 显式传入优先, 否则按 runtime 记住的栏舍实例。
 *
 * @param {number} hostGid 显式 host_gid(0 = 自动)
 * @param {number} [husbandryType] 1=窝 2=棚; 传了就挑对应类型的实例
 */
function resolveRanchHostGid(hostGid, husbandryType = 0) {
    const explicit = toNum(hostGid);
    if (explicit > 0) return explicit;
    const ht = toNum(husbandryType);
    if (ht > 0) {
        // 栏舍实例按大小排序: 窝通常是 10001, 棚是 10003(不写死, 以服务端为准)
        const ids = lastRanchInstIds.slice().sort((a, b) => a - b);
        if (ht === 2 && ids.length > 1) return ids[ids.length - 1];
        if (ids.length) return ids[0];
    }
    if (lastRanchInstIds.length) return lastRanchInstIds[0];
    return RANCH_SELF_HOST_GID;
}

async function feedAnimal(feedType, count = 1, hostGid = 0) {
    const gid = resolveRanchHostGid(hostGid);
    const body = types.FeedAnimalRequest.encode(types.FeedAnimalRequest.create({
        target: { host_gid: toLong(gid), feed_type: toLong(feedType) },
        count: toLong(count),
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'FeedAnimal', body);
    const _reply = types.FeedAnimalReply.decode(replyBody)
    invalidateRanchOverviewCache();
    return _reply;
}

/**
 * 催产。slot 传 0 表示全部(抓包里空请求也返回产出)。
 */
async function triggerProduce(slot = 0, hostGid = 0) {
    const gid = resolveRanchHostGid(hostGid);
    const payload = {};
    if (slot > 0) payload.target = { host_gid: toLong(gid), slot: toLong(slot) };
    const body = types.TriggerProduceRequest.encode(types.TriggerProduceRequest.create(payload)).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'TriggerProduce', body);
    const _reply = types.TriggerProduceReply.decode(replyBody)
    invalidateRanchOverviewCache();
    return _reply;
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
    const _reply = types.HarvestRanchReply.decode(replyBody)
    invalidateRanchOverviewCache();
    return _reply;
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
        // 可偷判定: 用**服务端给的权威位**, 不再自己从 stage 猜。
        //   动物级: can_harvest(#7)
        //   产物架: ShelfInfo.can_steal(#6) —— 这才是"这家的产物可偷"的直接信号
        const ranches = detail.ranches || [];
        const animals = ranches.flatMap(r => r.animals || []);
        const shelves = ranches.flatMap(r => r.shelves || []);
        const hasStealable = shelves.some(s => toNum(s.can_steal) === 1)
            || animals.some(a => toNum(a.can_harvest) === 1);
        if (!hasStealable) return { ok: false, reason: 'nothing_to_steal', gid };
        const stealBody = types.StealProduceRequest.encode(types.StealProduceRequest.create({
            host_gid: toLong(gid),
        })).finish();
        const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'StealProduce', stealBody);
        return { ok: true, gid, ranches: types.StealProduceReply.decode(replyBody).ranches || [] };
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
/**
 * 幼崽入栏(AnimalService.PlaceAnimal)。
 *
 * ⭐ 2026-11-18 抓包(20261118-165223_入栏)定案, 推翻旧实现:
 *   真实请求 = {1: {1: host_gid, 2: cub_item_id}}
 *   · 幼崽物品 id 放在 target 的 #2 (AnimalTarget.slot 的字段位置)
 *   · **没有**独立的 cub_item_id / count 字段
 *   · 一次只放一只; 客户端连发 4 条连续入 4 只(抓包实测)
 *   · slot 由服务端自己挑空位(请求里没有 slot)
 *   旧实现把 60001 填进 cub_item_id(#2)、target.slot=0,
 *   服务端读到的 cub_item_id=0 → 拒绝(1045205)。
 *
 * @param cubItemId 幼崽物品 id(60001 鸡 / 60002 兔 …)
 */
async function placeAnimal(cubItemId, hostGid = 0) {
    const gid = resolveRanchHostGid(hostGid);
    const body = types.PlaceAnimalRequest.encode(types.PlaceAnimalRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(cubItemId)) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'PlaceAnimal', body);
    const _reply = types.PlaceAnimalReply.decode(replyBody)
    invalidateRanchOverviewCache();
    return _reply;
}

/** 收取副产品(单槽, 动物留栏) */
async function collectProduce(slot = 0, hostGid = 0) {
    const gid = resolveRanchHostGid(hostGid);
    const body = types.CollectProduceRequest.encode(types.CollectProduceRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
        count: toLong(1),
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'CollectProduce', body);
    const _reply = types.CollectProduceReply.decode(replyBody)
    invalidateRanchOverviewCache();
    return _reply;
}

/** 收获出栏(成熟动物整只收走, 栏位空出) */
async function harvestAnimal(slot = 0, hostGid = 0) {
    const gid = resolveRanchHostGid(hostGid);
    const body = types.HarvestAnimalRequest.encode(types.HarvestAnimalRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'HarvestAnimal', body);
    return types.HarvestAnimalReply.decode(replyBody);
}

/**
 * 牧场幼崽购买策略标签(供面板展示)。
 * 与农场的 PLANTING_STRATEGY_LABELS 是两套, 互不影响。
 */
/**
 * 牧场幼崽策略标签。
 * 与农场 PLANTING_STRATEGY_LABELS 一一对应(只是把"作物"换成"幼崽"):
 *   max_profit  ↔ max_profit   最大净利润
 *   max_level   ↔ level        最高等级
 *   bag_priority↔ bag_priority 背包优先
 */
const RANCH_CUB_STRATEGY_LABELS = {
    max_profit: '收益比最高(整只回收 ÷ 幼崽成本)',
    max_level: '等级最高(优先高级动物)',
    bag_priority: '背包幼崽优先',
};

/** 第二优先策略的标签(不含 bag_priority —— 它没有"回退"语义) */
const RANCH_CUB_FALLBACK_LABELS = {
    max_profit: '收益比最高',
    max_level: '等级最高',
};

/**
 * 按"主策略 + 第二策略"给候选幼崽排序 —— 结构对齐农场的 applyPlantingStrategy:
 *   1) 先按主策略(max_profit / max_level / bag_priority)排出优先顺序
 *   2) 主策略选不出来的(比如 bag_priority 列表里没有的), 用第二策略排
 *
 * 农场的实现里, bag_priority 的"第二优先策略"就是靠 bagSeedFallbackStrategy 完成的;
 * 这里保持一致, 不自己发明"背包优先开关"那种另一套东西。
 *
 * @param {Array<object>} cubs 已过滤过(解锁/有价/收益比>0)的候选
 * @param {object} [opts] strategy / priority / fallback(测试或手动覆盖)
 * @returns {Array<object>} 排序后的候选
 */
function applyCubStrategy(cubs, opts = {}) {
    let strategy = String(opts.strategy || '').trim();
    let priority = Array.isArray(opts.priority) ? opts.priority : null;
    let fallback = String(opts.fallback || '').trim();

    if (!strategy || !priority || !fallback) {
        try {
            const store = require('../models/store');
            const accountId = process.env.FARM_ACCOUNT_ID || '';
            if (!strategy && typeof store.getRanchCubStrategy === 'function') {
                strategy = store.getRanchCubStrategy(accountId);
            }
            if (!priority && typeof store.getRanchCubPriority === 'function') {
                priority = store.getRanchCubPriority(accountId) || [];
            }
            if (!fallback && typeof store.getRanchCubFallbackStrategy === 'function') {
                fallback = store.getRanchCubFallbackStrategy(accountId);
            }
        } catch { /* 读不到配置就用默认 */ }
    }
    if (!RANCH_CUB_STRATEGY_LABELS[strategy]) strategy = 'max_profit';
    if (!RANCH_CUB_FALLBACK_LABELS[fallback]) fallback = 'max_level';

    // 各策略的排序函数(数值小的优先)
    const byProfit = (a, b) => (b.valueRatio - a.valueRatio) || (a.cost - b.cost);
    const byLevel = (a, b) => (b.animalId - a.animalId) || (b.valueRatio - a.valueRatio);

    const list = [...cubs];

    // 主策略是 bag_priority: 列表内的按顺序在前, 列表外的用第二策略排
    if (strategy === 'bag_priority' && Array.isArray(priority) && priority.length) {
        const indexMap = new Map(priority.map((id, i) => [Number(id), i]));
        list.sort((a, b) => {
            const ai = indexMap.has(a.animalId) ? indexMap.get(a.animalId) : Number.MAX_SAFE_INTEGER;
            const bi = indexMap.has(b.animalId) ? indexMap.get(b.animalId) : Number.MAX_SAFE_INTEGER;
            if (ai !== bi) return ai - bi;
            // 都不在列表里 → 第二策略
            return fallback === 'max_profit' ? byProfit(a, b) : byLevel(a, b);
        });
        return list;
    }

    // 主策略是 bag_priority 但列表为空 → 直接走第二策略(农场也是这个行为)
    const mainSort = strategy === 'max_level' ? byLevel : byProfit;
    if (strategy === 'bag_priority') {
        list.sort(fallback === 'max_profit' ? byProfit : byLevel);
        return list;
    }
    list.sort(mainSort);
    return list;
}

/**
 * 自动把背包里的幼崽放进空栏位。
 *
 * 为什么必须单独做这一步:
 *   线上事故(2026-11-18): BuyGoods 的 auto_add 只把幼崽放进**背包**, 不会入栏。
 *   机器人以为"买了 = 养上了", 但 slots 数字没变, 于是每轮巡检都再买 4 只,
 *   实测背包堆了 1242 只鸡幼崽 / 1195 只成品鸡。
 *   抓包证实客户端买完会调 AnimalService.PlaceAnimal 逐个入栏(10001 槽 + 60001 幼崽)。
 *
 * @param {{maxPerRound?:number, view?:object}} [opts]
 * @returns {Promise<{placed:number, details:string[]}>}
 */
async function autoPlaceCubs(opts = {}) {
    const result = { placed: 0, details: [] };
    // 场景被锁(1045002)时不要再发请求, 否则只会刷错误
    if (sceneLocked && Date.now() - sceneLockedAt < SCENE_LOCK_RETRY_MS) return result;

    // 1. 找出背包里的幼崽(itemType=105)与它们的数量
    let bag;
    try {
        bag = await require('./warehouse').getRanchBagItems();
    } catch {
        return result;
    }
    const cubs = [];
    let getItemById = null;
    try { getItemById = require('../config/gameConfig').getItemById; } catch { /* 没配置就跳过类型判断 */ }
    for (const it of bag) {
        const info = getItemById ? getItemById(toNum(it.id)) : null;
        if (info && Number(info.type) === 105 && toNum(it.count) > 0) {
            cubs.push({ id: toNum(it.id), count: toNum(it.count), name: info.name || `#${it.id}` });
        }
    }
    if (!cubs.length) return result;

    // 2. 找空栏位(窝/棚的容量 - 在养数)
    //    ⚠ 必须读**最新**数据: 调用方(巡查)通常刚收获过, 若拿到收获前的缓存,
    //      会把"刚清空的栏位"判成 4/4 已满, 于是 317 只幼崽一只都放不进去。
    //      所以这里**忽略 opts.view**(调用方传的可能是几分钟前的快照),
    //      一律重拉; getRanchOverview 自身有 10s 缓存, 但写操作都会让它失效。
    let view;
    try {
        view = await getRanchOverview();
    } catch {
        return result;
    }
    const countAnimals = (v) => (v && v.animals ? v.animals.length : 0);
    const countCapacity = (v) => (toNum(v && v.coopCount) || 0) + (toNum(v && v.penCount) || 0);
    let animals = view.animals || [];
    let capacity = countCapacity(view);
    let free = Math.max(0, capacity - animals.length);
    // 没有空槽时不直接放弃: 背包里堆着幼崽却进不来, 通常是因为**成熟的动物还没收**。
    // 先收获一次(全场 HarvestRanch)腾位置, 再重新算空槽。
    if (free <= 0 && opts.harvestFirst !== false) {
        try {
            await harvestRanch(1);
            // ⚠ 2026-11-19 线上事故: "收获完成: 整鸡x1 x4" 之后仍报 "栏位已满(4/4)"。
            //   两个原因叠加:
            //     ① getRanchOverview 有 10 秒缓存, 读到的是收获前的快照 → 已修(harvestRanch 里失效)
            //     ② 服务端出栏状态有短暂延迟, 立刻重查仍可能是满的
            //   所以这里**轮询重查**几次, 而不是读一次就下结论。
            let fresh = null;
            for (let attempt = 0; attempt < 4; attempt++) {
                await sleep(attempt === 0 ? 500 : 800);
                try {
                    fresh = await getRanchOverview();
                } catch {
                    continue;
                }
                const n = countAnimals(fresh);
                const cap = countCapacity(fresh);
                free = Math.max(0, cap - n);
                if (free > 0) {
                    animals = fresh.animals || [];
                    capacity = cap;
                    break;
                }
            }
            if (free > 0) {
                log('牧场', `收获后腾出 ${free} 个空栏位, 准备入栏背包里的幼崽`, {
                    module: 'ranch', event: '幼崽入栏', result: 'ok', free,
                });
                view = fresh;
            }
        } catch { /* 收获失败就按原来的 free=0 返回 */ }
    }
    if (free <= 0) {
        // 明确说明是"没空位", 而不是默默不动
        log('牧场', `栏位已满(${animals.length}/${capacity}), 背包里 ${cubs.reduce((n, c) => n + c.count, 0)} 只幼崽暂无法入栏`, {
            module: 'ranch', event: '幼崽入栏', result: 'skip', used: animals.length, capacity,
        });
        return result;
    }

    const maxPerRound = Math.max(1, toNum(opts.maxPerRound) || 8);
    free = Math.min(free, maxPerRound);

    // 3. 连续入栏。
    // ⚠ 抓包定案: 请求里**没有 slot**, 服务端自己挑空位 —— 所以不用算空槽号,
    //   直接连发(客户端抓包就是连发 4 条), 每条放一只。
    for (let i = 0; i < free; i++) {
        // 轮转使用背包里的幼崽
        const cub = cubs[i % cubs.length];
        if (!cub || cub.count <= 0) continue;
        try {
            await placeAnimal(cub.id);
            result.placed += 1;
            result.details.push(`${cub.name}`);
            cub.count -= 1;
            await sleep(300);
        } catch (e) {
            const code = parseRanchErrorCode(e);
            // 1045205 = 服务端拒绝(栏满/动物状态不允许)。栏满时反复尝试只会刷这个错,
            // 所以记一条 skip 而不是 error —— 等收获腾出位置后下一轮自然成功。
            if (code === 1045205) {
                log('牧场', `入栏被拒(栏位满或动物状态不允许): 背包还有 ${cubs.reduce((n, c) => n + c.count, 0)} 只未入栏`, {
                    module: 'ranch', event: '幼崽入栏', result: 'skip', code,
                });
            } else if (!isExpectedRanchError(e)) {
                logWarn('牧场', `幼崽入栏失败 ${cub.name}: ${e.message}`, {
                    module: 'ranch', event: '幼崽入栏', result: 'error', itemId: cub.id,
                });
            }
            break;
        }
    }

    if (result.placed > 0) {
        log('牧场', `幼崽入栏 ${result.placed} 只: ${result.details.join('，')}`, {
            module: 'ranch', event: '幼崽入栏', result: 'ok', count: result.placed,
        });
    }
    return result;
}

/** 出售动物(DonateAnimal): 卖栏里的动物换金券 */
async function donateAnimal(slot, hostGid = 0) {
    const gid = resolveRanchHostGid(hostGid);
    const body = types.DonateAnimalRequest.encode(types.DonateAnimalRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'DonateAnimal', body);
    const _reply = types.DonateAnimalReply.decode(replyBody)
    invalidateRanchOverviewCache();
    return _reply;
}

/** 清理单个 hazard(蚊子等); CleanAllRanch 是全场版 */
async function cleanRanch(slot = 0, hostGid = 0) {
    const gid = resolveRanchHostGid(hostGid);
    const body = types.CleanRanchRequest.encode(types.CleanRanchRequest.create({
        target: { host_gid: toLong(gid), slot: toLong(toNum(slot)) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.RanchService', 'CleanRanch', body);
    const _reply = types.CleanRanchReply.decode(replyBody)
    invalidateRanchOverviewCache();
    return _reply;
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
 *
 * ⚠ 只有 Lv9 这一段的真实刻度是实测的(起点 10000, 跨度 13000)。
 *   低于 10000 时按"每级 -13000"向下外推, 但外推出的等级起点可能是**负数**
 *   (例如 exp=0 → lv=8, start=-3000), 那样 current = 0-(-3000) = 3000,
 *   会显示"本级已获得 3000 经验", 而账号实际总经验只有 0 —— 自相矛盾。
 *   所以这里把 current 夹到 [0, needed], 保证"本级进度"永远不超过总经验。
 *
 * @param {number} totalExp 物品 1102 的值
 * @returns {{level:number, current:number, needed:number}} 等级 / 本级已得 / 本级所需
 */
function calcRanchLevel(totalExp) {
    // ⚠ toNum('abc') 会原样返回字符串(它只处理 Long/数字), 直接进 Math.max 得到 NaN。
    //   这里显式转数字, 非数字一律当 0。
    const n = Number(toNum(totalExp));
    const exp = Math.max(0, Number.isFinite(n) ? n : 0);
    let level;
    let start;
    if (exp < RANCH_LEVEL_BASE) {
        // 低于实测起点: 按"每级 -13000"向下外推
        level = Math.max(1, RANCH_LEVEL_BASE_LEVEL - Math.ceil((RANCH_LEVEL_BASE - exp) / RANCH_LEVEL_STEP));
        start = RANCH_LEVEL_BASE - (RANCH_LEVEL_BASE_LEVEL - level) * RANCH_LEVEL_STEP;
    } else {
        level = RANCH_LEVEL_BASE_LEVEL + Math.floor((exp - RANCH_LEVEL_BASE) / RANCH_LEVEL_STEP);
        start = RANCH_LEVEL_BASE + (level - RANCH_LEVEL_BASE_LEVEL) * RANCH_LEVEL_STEP;
    }
    // 夹紧: 外推出的 start 可能是负数, 不能让 current 超过总经验
    const current = Math.max(0, Math.min(RANCH_LEVEL_STEP, exp - Math.max(0, start)));
    return { level, current, needed: RANCH_LEVEL_STEP };
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

/**
 * 动物阶段文案。
 *
 * ⭐ 2026-11-18 终案 —— 语义来自官方客户端解码器, 不再猜:
 *   mcboot/game.js 里的 AnimalInfo 解码器把每个 wire 号都命名了:
 *     #1 ranch_inst_id  #2 slot_index  #3 animal_inst_id  #4 animal_id  #5 stage
 *     #6 produce_count  #7 can_harvest
 *     #10 grow_ready_at_ms  #11 produce_ready_at_ms  #12 grass_blocked
 *     #14 infant_ready_at_ms #15 producing #16 can_deliver #17 delivering_until_ms
 *     #18 can_feed #19 limited_can_used #20 can_donate
 *     #21 expected_harvest_exp #22 expected_harvest_sells
 *     #23 expected_produce_exp #24 expected_produce_sells #25 mature_ready_at_ms
 *     #30 mutation
 *
 * 所以旧实现里 `feed_state(#5)` / `grown_flag(#18)` / `produce_at(#10)` /
 * `trigger_ready_at(#25)` / `sell_cost(#22)` 全是错的 —— #5 是 stage, #18 是 can_feed,
 * #10 是「成长就绪时刻」, #25 是「成熟就绪时刻」, #22 是「收获预计所得」。
 * 这是之前倒计时一会儿 0、一会儿几小时、阶段永远"成年"的真正原因。
 *
 * 四阶段(官方 AnimalStageShow: 幼崽→成长→生产→成熟)按服务端给的时刻判:
 *   幼崽期  infant_ready_at_ms  未到
 *   成长期  infant_ready_at_ms 已到, grow_ready_at_ms 未到
 *   生产期  grow_ready_at_ms   已到, producing=true
 *   成熟期  其余(can_harvest=true 时可收)
 */
// ⭐ 2026-11-19 用入栏抓包时间线实测修正: stage 是 **1..5**, 不是 1..4。
//   t+0.3s 入栏   stage=1  infant=+4s grow=+8s
//   t+11s  催产   stage=3  deliver=+1s mature=+9s
//   t+16s  收产物 stage=4  mature=+3s
//   t+22s  成熟   stage=5  can_harvest=1 mature=-2s
// 之前只写 1..4, 于是 stage=5 落到 fallback, 面板显示"阶段5"。
const STAGE_TEXT = ['', '幼崽期', '成长期', '生产期', '成熟期', '可收获'];

function getStageText(stage) {
    const s = Number(toNum(stage)) || 0;
    if (s >= 0 && s < STAGE_TEXT.length && STAGE_TEXT[s]) return STAGE_TEXT[s];
    return s > 0 ? `阶段${s}` : '未知';
}

/** 把 proto 的 RanchInfo(repeated: 窝 + 棚)转成面板直接可渲染的对象 */
function toRanchView(reply) {
    const ranches = (reply && reply.ranches) || [];
    const nowMs = Date.now();
    const animals = [];
    const coops = [];
    const pens = [];
    for (const ranch of ranches) {
        const ranchInstId = toNum(ranch.ranch_inst_id);
        const husbandryType = toNum(ranch.husbandry_type);   // 1=窝 2=棚
        const capacity = toNum(ranch.capacity);
        const animalCount = toNum(ranch.animal_count);
        const group = { ranchInstId, husbandryType, capacity, animalCount, animals: [] };
        (husbandryType === 2 ? pens : coops).push(group);

        for (const a of (ranch.animals || [])) {
            const animalId = toNum(a.animal_id);
            if (!animalId) continue; // 空槽占位
            const stage = toNum(a.stage);
            const msDelta = (t) => {
                const v = toNum(t);
                return v > 0 ? Math.round((v - nowMs) / 1000) : null;
            };
            const infantInSec = msDelta(a.infant_ready_at_ms);    // 幼崽期结束
            const growInSec = msDelta(a.grow_ready_at_ms);        // 成长期结束
            const produceInSec = msDelta(a.produce_ready_at_ms);  // 本次产出就绪
            const matureInSec = msDelta(a.mature_ready_at_ms);    // 成熟就绪
            const deliveringInSec = msDelta(a.delivering_until_ms);// 交付倒计时(气泡用)
            const canHarvest = !!toNum(a.can_harvest);
            const producing = !!toNum(a.producing);
            const canDeliver = !!toNum(a.can_deliver);
            const grassBlocked = !!toNum(a.grass_blocked);
            // 当前阶段的主倒计时: 只取"未到且与本阶段相关"的那一个
            let countdownSec = null;
            let countdownKind = '';
            if (stage === 1 && infantInSec !== null && infantInSec > 0) {
                countdownSec = infantInSec; countdownKind = '幼崽期';
            } else if (stage === 2 && growInSec !== null && growInSec > 0) {
                countdownSec = growInSec; countdownKind = '成长期';
            } else if (stage === 3) {
                if (produceInSec !== null && produceInSec > 0) {
                    countdownSec = produceInSec; countdownKind = '生产期';
                } else if (deliveringInSec !== null && deliveringInSec > 0) {
                    countdownSec = deliveringInSec; countdownKind = '交付中';
                }
            } else if (stage === 4 && matureInSec !== null && matureInSec > 0) {
                countdownSec = matureInSec; countdownKind = '成熟期';
            } else if (stage === 5) {
                // stage=5 是"产物已长好、等成熟出栏"(抓包: can_harvest=1, mature 已过)。
                // 若服务端还没置 can_harvest, 用 mature_ready_at_ms 兜底显示。
                if (!canHarvest && matureInSec !== null && matureInSec > 0) {
                    countdownSec = matureInSec; countdownKind = '可收获';
                }
            }
            // 兼容旧前端的字段名, 语义重新对齐:
            //   harvestInSec  = 距"可收获"的秒数
            //   deliverInSec  = 同 harvestInSec
            //   stageEndInSec = 当前阶段剩余秒数
            const harvestInSec = canHarvest ? 0 : (countdownSec !== null ? countdownSec : null);
            animals.push({
                slot: toNum(a.slot_index),
                animalId,
                name: getAnimalName(animalId),
                ranchInstId,
                husbandryType,
                stage,
                stageText: getStageText(stage),
                // 旧前端按 feedState 分支出倒计时, 这里把 stage 原样给出
                feedState: stage,
                // 官方权威位
                canHarvest,
                harvestable: canHarvest,
                producing,
                canDeliver,
                canProduce: canDeliver,
                grassBlocked,
                hungry: grassBlocked,
                canFeed: !!toNum(a.can_feed),
                canDonate: !!toNum(a.can_donate),
                limitedCanUsed: !!toNum(a.limited_can_used),
                produceCount: toNum(a.produce_count),
                // 倒计时(秒, 负数=已过)
                infantInSec,
                growInSec,
                produceInSec,
                matureInSec,
                deliveringInSec,
                harvestInSec,
                deliverInSec: harvestInSec,
                stageEndInSec: countdownSec,
                countdownKind,
                produceUnknownReason: canHarvest
                    ? ''
                    : (producing ? 'producing'
                        : (stage === 1 ? 'infant'
                            : (stage === 2 ? 'growing'
                                : (stage === 5 ? 'awaiting_harvest'
                                    : (grassBlocked ? 'hungry' : 'idle'))))),
                // 预计收获所得(#22 expected_harvest_sells) — 旧代码当成 sell_cost
                expectedHarvestExp: toNum(a.expected_harvest_exp),
                expectedProduceExp: toNum(a.expected_produce_exp),
                sellCost: (a.expected_harvest_sells && a.expected_harvest_sells[0])
                    ? {
                        itemId: toNum(a.expected_harvest_sells[0].item_id),
                        amount: toNum(a.expected_harvest_sells[0].amount),
                    }
                    : null,
                mutant: !!(a.mutation && toNum(a.mutation.mutation_type) > 0),
            });
            group.animals.push(animals[animals.length - 1]);
        }
    }
    const coopAnimals = coops.reduce((n, g) => n + g.animalCount, 0);
    const penAnimals = pens.reduce((n, g) => n + g.animalCount, 0);
    return {
        // 兼容旧字段: 窝的实例 ID + 窝/棚的容量
        hostGid: coops.length ? coops[0].ranchInstId : (ranches[0] ? toNum(ranches[0].ranch_inst_id) : 0),
        coopCount: coops.reduce((n, g) => n + g.capacity, 0),
        penCount: pens.reduce((n, g) => n + g.capacity, 0),
        coopAnimals,
        penAnimals,
        // 新结构: 前端按栏舍分组渲染(每组的 husbandryType / capacity 都是服务端原值)
        coops,
        pens,
        grassCount: ranches[0] && ranches[0].grass ? toNum(ranches[0].grass.grass_count) : 0,
        ranchExp: toNum(reply && reply.ranch_exp),
        animals,
    };
}

/** 是不是"空 ranch"(懒初始化未完成) */
function isEmptyRanchView(view) {
    return !view
        || (!(view.coops || []).length && !(view.pens || []).length
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
 * 让 overview 缓存失效。
 *
 * ⚠ 2026-11-19 线上事故: 收获后紧接着入栏, autoPlaceCubs 里 `await getRanchOverview()`
 *   拿到的还是**收获前**的 10 秒缓存 → 判定 "栏位已满(4/4)" → 317 只幼崽一只都放不进去。
 *   凡是会改变牧场状态的 RPC 之后都必须调用它, 否则后续读到的都是旧快照。
 */
function invalidateRanchOverviewCache() {
    overviewCache = { at: 0, accountId: '', promise: null };
}

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
// 建筑 kind 映射。
// 11001001 是槽位 10000 上的装饰建筑(留言板), 线上三个账号实测都出现, 归为 decor。
const BUILDING_KINDS = {
    6001001: 'coop', 6001002: 'coop', 6001003: 'coop',
    6002001: 'pen',  6002002: 'pen',  6002003: 'pen',
    7001001: 'feed', 7001002: 'feed', 7001003: 'feed',
    11001001: 'decor',
};
function buildingKind(buildingId) {
    return BUILDING_KINDS[Number(buildingId)] || '';
}

/**
 * 建筑 status 语义(2026-11-18 线上三账号实测)。
 *
 * ⚠ 已知事实:
 *   · 实测取值是 9 / 10 / 11, **不是** 1(地块的"锁定"标志)
 *   · 三个账号同一 instId 的取值完全一致且稳定:
 *       10000(装饰/留言板)→9, 10001(窝)→11, 10002(牧草机)→10, 3(棚)→11
 *   · 因此它更像"建筑类型/槽位标记"而不是"升级状态", 但**没有权威来源**证实
 *
 * 所以这里不做语义翻译(不编"升级中"), 只原样透传 —— 页面显示原始状态码,
 * 需要时再根据真实抓包补定义。强行起中文名反而会误导排查。
 */
function buildingStatusText(status) {
    return `状态${Number(status) || 0}`;
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
                        // ⚠ 不能写 b.status === 1: 建筑 status 实测是 9/10/11(不是地块的 1/2),
                        //   那样判断永远为 false, "升级中"从来不会显示。
                        //   目前没有可靠字段能判断升级中, 所以如实置 false 并保留原始状态码,
                        //   由页面显示 status, 不做臆断。
                        f.upgrading = false;
                        f.status = b.status;
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
            // ⭐ 倒计时到点 → 立即安排下一轮, 不等随机巡查间隔。
            //   服务端给了 infant/grow/produce/mature_ready_at_ms, 到期就能干活的
            //   直接插队; 失败也不影响返回(调度是旁路)。
            // 记住本次的栏舍实例(窝/棚), 后续 feedAnimal 等要用它当 host_gid
            try { rememberRanchInstIds(view); } catch { /* 旁路 */ }
            try { scheduleRanchFromCountdowns(view); } catch { /* 旁路, 不影响概览 */ }
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
        boughtCubs: 0, cubsPlaced: 0, illustratedClaimed: 0, feedMachineAdded: 0, rotationBought: 0, cleanedFriends: 0, ranchTasksClaimed: 0, buildingsCompleted: 0, buildingsUpgraded: 0, regionsCompleted: 0, regionsUnlocked: 0,
        details: [],
    };

    // 各步骤之间的最小间隔: 一轮原来 20ms 内打完 10 个 RPC,
    // 服务端会把这种"突发"当异常, 是掉线的直接原因之一。
    const STEP_GAP_MS = Math.max(200, toNum(opts.stepGapMs) || 800);
    const gap = () => sleep(STEP_GAP_MS);

    // 分组执行: 自动巡查按组各自调度(对照农场的 农场/帮助/偷菜 三套独立间隔),
    // 不再"一轮把 15 个步骤全跑一遍"。手动「一键巡牧场」不传 groups = 全组。
    const wantGroups = Array.isArray(opts.groups) && opts.groups.length
        ? new Set(opts.groups.map(String))
        : null;
    const want = (group) => !wantGroups || wantGroups.has(group);
    const step = async (group, opts2, fn) => {
        if (!want(group)) return undefined;
        return fn();
    };

    // 0. 自动使用牧场背包道具(与农场 automation.auto_use_items 同一个开关)
    //    罐头(80021~80034)灌进桶也在这里发生 —— 桶有时长才能喂。
    if (want('feed') && opts.autoUseItems !== false && isAutomationOn('auto_use_items')) {
        try {
            const r = await autoUseRanchBagItems();
            if (r.used > 0) result.details.push(`用道具${r.used}`);
        } catch (e) {
            if (!isExpectedRanchError(e)) {
                logWarn('牧场', `自动使用道具失败: ${e.message}`, { module: 'ranch', event: '自动使用道具', result: 'error' });
            }
        }
    }

    await gap();

    // 0. 牧草机补草(任务"给牧草机添加牧草"也靠它驱动)
    if (want('feed') && opts.feedMachine !== false && isAutomationOn('ranch_feedmachine')) {
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
    //    ⭐ 官方操作顺序: 收副产物(CollectProduce, 架上的蛋) → 催产 → 收获(HarvestRanch)
    //    只发 HarvestRanch 收不到架上的蛋(鹅 feed=3/#6≥1 就是蛋在架上)
    if (want('core') && isAutomationOn('ranch_harvest')) try {
        for (const s of [1, 2, 3, 4, 5, 6]) {
            try {
                await collectProduce(s);
                await sleep(200);
            } catch { /* 槽空/未就绪, 静默 */ }
        }
        await triggerProduce(0).catch(() => null);
        await gap();
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
        // 1045202 语义未证实(见 RANCH_ERR 注释): 遇到就中止本轮, 别连着打请求
        if (parseRanchErrorCode(e) === RANCH_ERR.FEED_REJECTED) {
            result.rateLimited = true;
            log('牧场', `收获被服务端拒绝(code=1045202), 本轮巡牧场提前结束`, {
                module: 'ranch', event: '收获牧场', result: 'rejected',
            });
            return result;
        }
        if (!isExpectedRanchError(e)) {
            logWarn('牧场', `收获失败: ${e.message}`, { module: 'ranch', event: '收获牧场', result: 'error' });
        }
    }
    await gap();

    // 2. 催产(空请求 = 全部槽位; 任务"生产N次"靠它驱动)
    if (want('core') && isAutomationOn('ranch_produce')) try {
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
        if (parseRanchErrorCode(e) === RANCH_ERR.FEED_REJECTED) {
            result.rateLimited = true;
            log('牧场', '催产被服务端拒绝(code=1045202), 本轮巡牧场提前结束', {
                module: 'ranch', event: '催产', result: 'rejected',
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
    if (want('feed') && opts.feedType && opts.feedType !== 0) {
        const feedType = toNum(opts.feedType) || 4;
        try {
            await feedAnimal(feedType, 1);
            result.fed += 1;
        } catch (e) {
            // 1045234 罐头耗尽 = 正常状态(等用户买罐头/加牧草)
            if (parseRanchErrorCode(e) === RANCH_ERR.FEED_REJECTED) {
                result.rateLimited = true;
                log('牧场', '喂食被服务端拒绝(code=1045202), 本轮巡牧场提前结束', {
                    module: 'ranch', event: '喂食', result: 'rejected',
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
    if (want('daily') && opts.sell !== false && isAutomationOn('ranch_sell')) {
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

    // 5. 幼崽入栏(必须在买幼崽之前!)
    // ⚠ 线上事故(2026-11-18): BuyGoods 的 auto_add **不会**把幼崽放进栏舍,
    //   幼崽只是进了背包(itemType=105)。不补这一步, 槽位永远算作"空",
    //   于是每轮巡检都再买 4 只 → 实测背包里堆了 1242 只鸡。
    //   抓包证实: 客户端买完后会调 AnimalService.PlaceAnimal 入栏。
    if (want('core') && opts.placeCubs !== false) {
        try {
            const placed = await autoPlaceCubs(opts);
            result.cubsPlaced = placed.placed;
            if (placed.placed > 0) result.details.push(`入栏${placed.placed}只`);
        } catch (e) {
            if (!isExpectedRanchError(e)) {
                logWarn('牧场', `幼崽入栏失败: ${e.message}`, { module: 'ranch', event: '幼崽入栏', result: 'error' });
            }
        }
    }

    await gap();

    // 6. 买幼崽(任务"领养鸡幼崽N个"靠它驱动; 按收益比优先)
    if (want('core') && opts.buyCubs !== false && isAutomationOn('ranch_buy_cubs')) {
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
    if (want('daily') && opts.cleanOwn !== false && isAutomationOn('ranch_clean')) {
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
    if (want('steal') && opts.stealFriends !== false && isAutomationOn('ranch_steal')) {
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
    //   归属 daily 组: 与农场的"每日任务"同层 —— 建筑/地块是长周期操作,
    //   不该跟着 core 巡查每 20 秒打一遍。
    let facility;
    try {
        facility = require('./ranch-facility');
    } catch { facility = null; }

    if (want('daily') && facility && opts.upgradeBuildings !== false && isAutomationOn('ranch_upgrade')) {
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

    if (want('daily') && facility && opts.unlockRegions !== false && isAutomationOn('ranch_unlock')) {
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
    if (want('daily') && opts.rotationShop !== false && isAutomationOn('ranch_rotation')) {
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
    if (want('daily') && isAutomationOn('ranch_task')) {   // 统一由开关决定(原来 checkRanch 传 claimTasks:false 导致永不执行)
        try {
            const { checkAndClaimRanchTasks } = require('./task');
            const r = await checkAndClaimRanchTasks();
            result.ranchTasksClaimed = r.claimed;
            if (r.claimed > 0) result.details.push(`任务${r.claimed}`);
        } catch (e) {
            logWarn('牧场', `牧场任务领取失败: ${e.message}`, { module: 'ranch', event: '牧场任务', result: 'error' });
        }
    }

    await gap();

    // 手册(图鉴)领奖: 之前只在手动 API 里有, 巡检从不调用 → "手册的领奖没加"
    if (want('daily') && opts.illustrated !== false && isAutomationOn('ranch_task')) {
        try {
            const ill = require('./illustrated');
            const r = await ill.claimIllustratedRewards();
            const claimed = toNum(r && r.claimed) || 0;
            result.illustratedClaimed = claimed;
            if (claimed > 0) result.details.push(`手册${claimed}`);
        } catch (e) {
            logWarn('牧场', `手册领奖失败: ${e.message}`, { module: 'ranch', event: '手册领奖', result: 'error' });
        }
    }

    return result;
}

// ============ 牧场巡查(三套独立节奏, 对照农场的 农场/帮助/偷菜) ============
//
// 用农场那套模型重做:
//   农场 → farmMin/farmMax | 帮助 → helpMin/helpMax | 偷菜 → stealMin/stealMax
//   牧场 → ranchMin/ranchMax 拆成三组, 各自独立计时:
//     core   收蛋/催产/入栏/买幼崽/牧草机 (分钟级, 最频繁)
//     daily  任务/游商/清理/建筑/地块/出售 (低频, 默认 10 分钟)
//     steal  偷好友牧场产物 (与好友偷菜同频)
//
// 以前是一轮把 15 个步骤全跑一遍: 一次巡查发 20+ 个 RPC, 既容易被服务端当
// 突发流量, 也让每一组都被最慢的那一步拖着。分组后谁到点谁跑。
//
// 除了按间隔, 每组还会按**服务端给的时刻**提前安排一次:
//   幼崽/成长/生产/成熟 到点 → core 组立即跑
//   牧草机耗尽 → feed 组立即跑
// 倒计时到点就走, 不用等下一轮巡查。

const RANCH_CHECK_INTERVAL_MIN_MS = 5 * 60 * 1000;   // 兜底轮询间隔 5~8 分钟
const RANCH_CHECK_INTERVAL_MAX_MS = 8 * 60 * 1000;
const RANCH_PUSH_THROTTLE_MS = 60 * 1000;            // 推送触发最少间隔(1 分钟)
// 失败退避: 连续失败时按 2^N 拉长间隔, 上限 60 分钟
const RANCH_BACKOFF_MAX_MS = 60 * 60 * 1000;

/** 巡查分组: 每组有自己的间隔与开关 */
const RANCH_GROUPS = {
    core: { key: 'core', label: '牧场巡查', minKey: 'ranchMin', maxKey: 'ranchMax' },
    daily: { key: 'daily', label: '牧场日常', minKey: 'ranchDailyMin', maxKey: 'ranchDailyMax' },
    steal: { key: 'steal', label: '牧场偷取', minKey: 'ranchStealMin', maxKey: 'ranchStealMax' },
};

const ranchScheduler = createScheduler('ranch');
// 每组的下次执行时刻(ms), 供面板显示倒计时
const nextRanchGroupAt = { core: 0, daily: 0, steal: 0 };
let nextRanchCheckAt = 0;      // 兼容旧字段: 取三组里最早的
let isCheckingRanch = false;
let isCheckingRanchGroup = {}; // 每组防重入(三组可并行, 单组不重叠)
let ranchLoopRunning = false;
let externalRanchSchedulerMode = false;
let ranchFailStreak = 0;
let lastRanchPushAt = 0;
// 倒计时到期去重: 用动作指纹 + 冷却时间, 不能用绝对时间戳(会让去重永不生效)
let lastDueFingerprint = '';
let lastDueNotBeforeAt = 0;

function randomRanchIntervalMs(groupKey = 'core') {
    const { minSec, maxSec } = ranchIntervalRangeSec(groupKey);
    return (minSec + Math.floor(Math.random() * (maxSec - minSec + 1))) * 1000;
}

/** 下次巡牧场的延迟: 正常随机; 连续失败按 2^N 退避 */
function nextRanchDelayMs(groupKey = 'core') {
    const base = randomRanchIntervalMs(groupKey);
    if (ranchFailStreak <= 0) return base;
    return Math.min(RANCH_BACKOFF_MAX_MS, base * Math.min(2 ** ranchFailStreak, 64));
}

/** 读某个分组的间隔配置(秒) */
function ranchIntervalRangeSec(groupKey = 'core') {
    const g = RANCH_GROUPS[groupKey] || RANCH_GROUPS.core;
    const fallback = groupKey === 'daily' ? { min: 600, max: 900 } : { min: 20, max: 25 };
    let minSec = fallback.min;
    let maxSec = fallback.max;
    try {
        // ⚠ 2026-11-19 修: 这里原来用 store.getAccountConfigSnapshot(), 但那个函数
        //   **没有导出**(store 内部私有), 于是 typeof 判断永远为假 → 一直用默认
        //   5~8 分钟, 用户在设置里填 20 秒也完全不生效。改用导出的 getIntervals()。
        const store = require('../models/store');
        const iv = typeof store.getIntervals === 'function'
            ? store.getIntervals(process.env.FARM_ACCOUNT_ID || '')
            : null;
        // 优先用本组自己的键; 老配置没有这些键时回落到农场的对应值,
        // 保证升级后行为不会突然变成"五分钟才巡一次"。
        let lo = Number(iv && iv[g.minKey]) || 0;
        let hi = Number(iv && iv[g.maxKey]) || 0;
        if (!(lo > 0 && hi > 0)) {
            if (groupKey === 'daily') {
                lo = Number(iv && iv.ranchMin) || 0;
                hi = Number(iv && iv.ranchMax) || 0;
            } else if (groupKey === 'steal') {
                lo = Number(iv && iv.stealMin) || 0;
                hi = Number(iv && iv.stealMax) || 0;
            }
        }
        if (lo > 0 && hi > 0) {
            if (lo > hi) [lo, hi] = [hi, lo];
            minSec = Math.max(5, lo);
            maxSec = Math.max(minSec, hi);
        }
    } catch { /* 读不到就用默认 */ }
    return { minSec, maxSec };
}

function refreshNextRanchAt() {
    const vals = Object.values(nextRanchGroupAt).filter(v => v > 0);
    nextRanchCheckAt = vals.length ? Math.min(...vals) : 0;
}

/**
 * 把"已到期"的判定修正成"到点即跑":
 * worker 的统一 tick 最短 1 秒一次, 但可能因为别的分组在跑而推迟。
 * 这里额外挂一个只针对**最近到期时刻**的定时器, 到点立即触发对应分组,
 * 不用等下一轮统一 tick(也不会因为统一 tick 被 farm/help/steal 拖住而迟到)。
 */
function armRanchDeadlineTimer() {
    if (externalRanchSchedulerMode) {
        // 外部调度模式: 由 worker 的 1 秒 tick 负责; 但仍把时刻算好
        return;
    }
    ranchScheduler.clear('ranch_deadline');
    if (!ranchLoopRunning) return;
    const now = Date.now();
    let soonestKey = '';
    let soonestAt = Infinity;
    for (const [k, at] of Object.entries(nextRanchGroupAt)) {
        const t = Number(at) || 0;
        if (t > 0 && t < soonestAt) { soonestAt = t; soonestKey = k; }
    }
    if (!soonestKey || !Number.isFinite(soonestAt)) return;
    const delay = Math.max(0, soonestAt - now);
    if (delay > 30 * 60 * 1000) return;   // 太远就不挂精确定时器
    ranchScheduler.setTimeoutTask('ranch_deadline', delay, async () => {
        if (!ranchLoopRunning) return;
        // ⭐ 到点只做对应动作(收产物/催产/收获/补草), 不跑整套巡检。
        //   用户要求: "倒计时结束后立刻触发收获, 不要再是整个巡检的一套"。
        if (soonestKey === 'core') {
            await runRanchDueTick();
        } else {
            await checkRanchGroup(soonestKey);
        }
        if (!ranchLoopRunning) return;
        armRanchDeadlineTimer();
    });
}

function scheduleRanchGroup(groupKey, delayMs) {
    if (!ranchLoopRunning) return;
    const g = RANCH_GROUPS[groupKey];
    if (!g) return;
    const delay = Math.max(0, delayMs);
    nextRanchGroupAt[groupKey] = Date.now() + delay;
    refreshNextRanchAt();
    ranchScheduler.setTimeoutTask(`ranch_group_${groupKey}`, delay, async () => {
        if (!ranchLoopRunning) return;
        // core 组: 先尝试"只做到点动作"(轻量), 没干成就退回整组巡检。
        //   "没干成"包括: 没有到点动作 / 有动作但服务端没给东西(可收位失效等)。
        if (groupKey === 'core') {
            const r = await runRanchDueTick();
            if (!r.ran) await checkRanchGroup('core');
        } else {
            await checkRanchGroup(groupKey);
        }
        if (!ranchLoopRunning) return;
        scheduleRanchGroup(groupKey, nextRanchDelayMs(groupKey));
    });
    // 自驱模式下由自己续期; 统一调度器模式下由 worker 轮询
    if (externalRanchSchedulerMode) {
        ranchScheduler.clear(`ranch_group_${groupKey}`);
    } else {
        armRanchDeadlineTimer();
    }
}

function scheduleNextRanchCheck(delayMs, groupKey = 'core') {
    if (externalRanchSchedulerMode) return;
    if (!ranchLoopRunning) return;
    scheduleRanchGroup(groupKey, delayMs);
}

/**
 * 执行某个分组的巡查(防重入 + 开关闸门 + 汇总日志 + 统计)。
 * @param {'core'|'daily'|'steal'} groupKey
 * @returns {Promise<boolean>} 本轮有没有实际干活
 */
async function checkRanchGroup(groupKey) {
    const g = RANCH_GROUPS[groupKey] || RANCH_GROUPS.core;
    const key = g.key;
    if (isCheckingRanchGroup[key]) return false;
    if (!isAutomationOn('ranch_auto')) return false;
    isCheckingRanchGroup[key] = true;
    isCheckingRanch = true;
    try {
        const result = await runRanchCare({ claimTasks: false, groups: [key] });
        if (result && result.skipped === 'scene_locked') return false;

        // 统计(对照农场 recordOperation)
        if (result.harvested > 0) recordOperation('ranchHarvest', result.harvested);
        if (result.produced > 0) recordOperation('ranchProduce', result.produced);
        if (result.fed > 0) recordOperation('ranchFeed', result.fed);

        // 限流算一次失败 → 退避; 否则清零
        if (result.rateLimited) ranchFailStreak += 1;
        else ranchFailStreak = 0;

        const parts = [];
        if (result.harvested > 0) parts.push(`收:${result.harvested}`);
        if (result.produced > 0) parts.push(`产:${result.produced}`);
        if (result.fed > 0) parts.push(`喂:${result.fed}`);
        if (result.feedMachineAdded > 0) parts.push(`草:${result.feedMachineAdded}`);
        if (result.sold > 0) parts.push(`卖:${result.sold}`);
        if (result.boughtCubs > 0) parts.push(`崽:${result.boughtCubs}`);
        if (result.cubsPlaced > 0) parts.push(`栏:${result.cubsPlaced}`);
        if (result.rotationBought > 0) parts.push(`商:${result.rotationBought}`);
        if (result.cleanedFriends > 0) parts.push(`清:${result.cleanedFriends}`);
        if (result.stolenFriends > 0) parts.push(`偷:${result.stolenFriends}`);
        if (result.ranchTasksClaimed > 0) parts.push(`任:${result.ranchTasksClaimed}`);
        if (parts.length > 0) {
            log('牧场', `[${g.label}] [${parts.join(' ')}] ${result.details.join('/')}`, {
                module: 'ranch', event: g.label, result: 'ok', actions: parts,
            });
        }
        // 干完活重新拉一次详情, 用服务端最新的 *_ready_at_ms 把下一轮提前到
        // "下一个真正能干的时刻"(getRanchOverview 内部会调 scheduleRanchFromCountdowns)。
        // 有 10 秒缓存, 不会额外打请求。
        try { await getRanchOverview(); } catch { /* 旁路 */ }
        return parts.length > 0;
    } catch (e) {
        ranchFailStreak += 1;
        logWarn('牧场', `${g.label}失败(连续第 ${ranchFailStreak} 次): ${e.message}`, {
            module: 'ranch', event: g.label, result: 'error',
        });
        return false;
    } finally {
        isCheckingRanchGroup[key] = false;
        isCheckingRanch = false;
    }
}

/**
 * 按最新牧场状态算出"现在到点了、该做哪一件具体的事"。
 *
 * 用户要求(2026-11-19): 倒计时结束后**只执行对应的那一步**, 不要再把整套巡检
 * 跑一遍。这里返回动作清单, 由 runRanchDueActions() 逐条执行。
 *
 * 判定全部来自服务端字段(不是猜的):
 *   can_harvest(#7)   → 收获(HarvestRanch)
 *   can_deliver(#16) / producing 结束 → 催产(TriggerProduce)(催产后会接着收获)
 *   can_feed(#18)     且 grass_blocked(#12) → 补草
 *
 * @param {object} view getRanchOverview() 的返回
 * @returns {string[]} 形如 ['collect','trigger','harvest','feed']
 */
function planRanchDueActions(view) {
    const animals = (view && view.animals) || [];
    if (!animals.length) return [];
    const actions = [];
    if (animals.some(a => a.canHarvest)) {
        // 有可收的: 先收架上的产物(CollectProduce), 再一键收获
        actions.push('collect', 'harvest');
    }
    if (animals.some(a => a.canDeliver && !a.canHarvest)) {
        // 可以开始新一轮生产; 催完之后立刻收一次(用户要求"催产后触发收获")
        if (!actions.includes('trigger')) actions.push('trigger');
        if (!actions.includes('harvest')) actions.push('harvest');
    }
    if (animals.some(a => a.grassBlocked)) actions.push('feed');
    return actions;
}

/**
 * 执行"到点动作"——只跑 planRanchDueActions 算出来的那几步,
 * 不碰入栏/买幼崽/游商/任务这些与倒计时无关的东西。
 * @returns {Promise<{actions:string[], harvested:number, produced:number, details:string[]}>}
 */
async function runRanchDueActions(view, opts = {}) {
    const out = { actions: [], harvested: 0, produced: 0, details: [] };
    const plan = Array.isArray(opts.plan) && opts.plan.length ? opts.plan : planRanchDueActions(view);
    if (!plan.length) return out;
    const gapMs = Math.max(200, toNum(opts.stepGapMs) || 600);

    for (const action of plan) {
        out.actions.push(action);
        try {
            if (action === 'collect') {
                for (const s of [1, 2, 3, 4, 5, 6]) {
                    try { await collectProduce(s); await sleep(200); } catch { /* 槽空, 静默 */ }
                }
            } else if (action === 'trigger') {
                if (!isAutomationOn('ranch_produce')) continue;
                const r = await triggerProduce(0);
                for (const rc of (r.receipts || [])) out.produced += toNum(rc.count);
            } else if (action === 'harvest') {
                if (!isAutomationOn('ranch_harvest')) continue;
                const reply = await harvestRanch(1);
                for (const gain of (reply.gains || [])) {
                    for (const item of (gain.items || [])) {
                        const itemId = toNum(item.item_id);
                        if (itemId === 1102) continue;
                        out.harvested += toNum(item.count);
                        out.details.push(`${getAnimalName(itemId) || itemId}x${toNum(item.count)}`);
                    }
                }
            } else if (action === 'feed') {
                if (!isAutomationOn('ranch_feedmachine')) continue;
                const fm = await autoFeedMachine(opts);
                if (fm.fed > 0) out.details.push(`牧草机+${fm.fed}`);
            }
        } catch (e) {
            // 单步失败不影响其它步骤, 也不刷 error(这类"状态已变"很常见)
            if (!isExpectedRanchError(e)) {
                logWarn('牧场', `到点动作 ${action} 失败: ${e.message}`, {
                    module: 'ranch', event: '倒计时动作', result: 'error', action,
                });
            }
        }
        await sleep(gapMs);
    }
    return out;
}

/** 兼容旧入口: 全组跑一遍(手动一键巡牧场 / 老调用方) */
async function checkRanch() {
    const keys = Object.keys(RANCH_GROUPS);
    let any = false;
    for (const k of keys) {
        if (await checkRanchGroup(k)) any = true;
    }
    return any;
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
    isCheckingRanchGroup = {};
    lastDueFingerprint = '';
    lastDueNotBeforeAt = 0;
    sceneLocked = false;        // 场景锁定状态是 per-connection 的, 新连接重新探测
    sceneLockedAt = 0;
    networkEvents.on('ranchFacilitiesChanged', onRanchFacilitiesChanged);
    for (const k of Object.keys(RANCH_GROUPS)) {
        // 外部调度模式也要把各组的下次时刻设出来, 否则 worker 永远判不到期
        if (externalRanchSchedulerMode) {
            nextRanchGroupAt[k] = Date.now() + randomRanchIntervalMs(k);
        } else {
            scheduleRanchGroup(k, randomRanchIntervalMs(k));
        }
    }
    refreshNextRanchAt();
    armRanchDeadlineTimer();
}

function stopRanchCheckLoop() {
    ranchLoopRunning = false;
    externalRanchSchedulerMode = false;
    ranchScheduler.clearAll();
    for (const k of Object.keys(nextRanchGroupAt)) nextRanchGroupAt[k] = 0;
    nextRanchCheckAt = 0;
    networkEvents.removeListener('ranchFacilitiesChanged', onRanchFacilitiesChanged);
}

/**
 * 插队跑一轮(worker 统一调度器用)。
 * @param {string} [groupKey] 指定分组; 不传 = 全部三组
 */
async function runRanchTick(groupKey = '') {
    if (!ranchLoopRunning) return false;
    if (!groupKey) return checkRanch();
    try {
        // core 组: 优先只做"到点动作"; 没干成就立刻整组巡检接手,
        // 不等下一轮(入栏/买幼崽/牧草机都挂在整组里)。
        if (groupKey === 'core') {
            const r = await runRanchDueTick();
            if (r.ran) return true;
        }
        return await checkRanchGroup(groupKey);
    } finally {
        // 外部调度模式下没有自己的 timer, 由这里续期下次时刻。
        // 注意这里取 min: "倒计时到点"可能已经把时刻提前, 提前的那个优先;
        // 否则就回到正常随机间隔(含失败退避)。
        if (externalRanchSchedulerMode) {
            const nowMs = Date.now();
            const cur = Number(nextRanchGroupAt[groupKey]) || 0;
            const next = nowMs + nextRanchDelayMs(groupKey);
            nextRanchGroupAt[groupKey] = (cur > nowMs && cur < next) ? cur : next;
            refreshNextRanchAt();
        }
    }
}

/** 各分组下次执行时刻(ms), 供 worker/面板显示倒计时 */
function getRanchNextRunAt() {
    return { ...nextRanchGroupAt, any: nextRanchCheckAt };
}

/** 该分组是否到点 */
function isRanchGroupDue(groupKey, nowMs = Date.now()) {
    const at = Number(nextRanchGroupAt[groupKey] || 0);
    return at > 0 && nowMs >= at;
}

/**
 * 把某组的下次执行时刻提前到 atMs(用于"倒计时到点立即执行")。
 * 只提前不推后, 且同一到期点只安排一次。
 */
function pullRanchGroupForward(groupKey, atMs, reason = '') {
    if (!ranchLoopRunning) return false;
    if (!RANCH_GROUPS[groupKey]) return false;
    const at = Number(atMs) || 0;
    if (at <= 0) return false;
    // 最多提前 30 分钟, 避免把"很久以后"的到期点也塞进队列
    const guard = 30 * 60 * 1000;
    const when = Math.min(at, Date.now() + guard);
    const cur = Number(nextRanchGroupAt[groupKey] || 0);
    if (cur > 0 && cur <= when) return false;
    nextRanchGroupAt[groupKey] = when;
    refreshNextRanchAt();
    if (!externalRanchSchedulerMode) {
        scheduleRanchGroup(groupKey, Math.max(0, when - Date.now()));
    } else {
        // 外部模式下时刻已写入 nextRanchGroupAt, worker 1 秒 tick 会立刻看到;
        // 这里不重挂 timer, 但仍刷新聚合时刻供面板显示。
    }
    if (reason) {
        log('牧场', `${RANCH_GROUPS[groupKey].label} 提前到 ${new Date(when).toLocaleTimeString()} (${reason})`, {
            module: 'ranch', event: '倒计时到期', result: 'schedule', when,
        });
    }
    return true;
}

/**
 * 按服务端时刻安排下一次巡查: 倒计时到点就走, 不等下一轮随机间隔。
 * 数据来源是 GetRanchDetail 里官方字段(不是猜的):
 *   infant/grow/produce/mature_ready_at_ms → core 组
 *   grass_blocked / 牧草机状态              → feed(core) 组
 * @param {object} view getRanchOverview() 的返回
 */
function scheduleRanchFromCountdowns(view) {
    if (!ranchLoopRunning || !view) return;
    const now = Date.now();
    const dueTimes = [];
    for (const a of (view.animals || [])) {
        // 每个阶段的"到点"都在服务端字段里; 只取未来的
        for (const sec of [a.infantInSec, a.growInSec, a.produceInSec, a.matureInSec, a.deliveringInSec]) {
            if (typeof sec === 'number' && sec > 0) dueTimes.push(now + sec * 1000);
        }
        // 已经可收/可催产 = 现在就该跑
        if (a.canHarvest || a.canProduce) dueTimes.push(now + 1000);
    }
    if (!dueTimes.length) return;
    const soonest = Math.min(...dueTimes);
    // ⚠ 去重不能用绝对时间戳: 已可收/可催产的动物每次都算出 `now+1000`,
    //   这个值每秒都不同, 于是"去重"永不生效, core 组被反复提到"现在",
    //   整组巡检永远轮不到 → 入栏彻底不执行(2026-11-19 线上事故)。
    // 改成按"动作内容 + 冷却窗口"去重: 同样的动作集合在冷却期内不再重复提前。
    const plan = planRanchDueActions(view);
    const fp = plan.join('+');
    const now2 = Date.now();
    if (fp && fp === lastDueFingerprint && now2 < lastDueNotBeforeAt) return;
    lastDueFingerprint = fp;
    // 真正"已到点"的动作立即执行; 否则按剩余秒数排
    const hasActionableNow = plan.length > 0 && dueTimes.some(t => t <= now2 + 1500);
    lastDueNotBeforeAt = hasActionableNow ? now2 + 15 * 1000 : now2 + 5 * 1000;
    pullRanchGroupForward('core', soonest + 1500, '动物倒计时到点');
    // 牧草断了也要尽快补
    if ((view.animals || []).some(a => a.grassBlocked)) {
        pullRanchGroupForward('core', now + 1500, '牧草断了');
    }
    // 记下此刻"到点该做什么", 到点后只跑这几步(不跑整套巡检)
    dueActionPlan = { at: soonest, actions: planRanchDueActions(view) };
}

// 倒计时到点时缓存的"具体动作"(见 planRanchDueActions)
let dueActionPlan = { at: 0, actions: [] };

/**
 * 倒计时到点的执行入口(worker / deadline timer 用):
 * **只做与到点相关的那几件事**(收产物/催产/收获/补草), 不跑入栏/买幼崽/游商/任务。
 *
 * 用户明确要求: "倒计时结束后会立刻触发收获吗... 不要再是整个巡检的一套"。
 *
 * @returns {Promise<{ran:boolean, actions:string[], harvested:number, produced:number, details:string[]}>}
 */
async function runRanchDueTick() {
    if (!ranchLoopRunning) return { ran: false, actions: [], harvested: 0, produced: 0, details: [] };
    if (!isAutomationOn('ranch_auto')) return { ran: false, actions: [], harvested: 0, produced: 0, details: [] };
    if (isCheckingRanchGroup.core_due) return { ran: false, actions: [], harvested: 0, produced: 0, details: [] };
    isCheckingRanchGroup.core_due = true;
    try {
        // 1. 用当前状态重新规划(缓存可能已过期 —— 状态会变)
        let view = null;
        try { view = await getRanchOverview(); } catch { view = null; }
        let plan = planRanchDueActions(view);
        // 2. 数据不可用时退回缓存里的动作(仍只跑那几步)
        if (!plan.length && dueActionPlan.actions.length) plan = dueActionPlan.actions;
        if (!plan.length) return { ran: false, actions: [], harvested: 0, produced: 0, details: [] };

        // 3. 只执行这几步
        const out = await runRanchDueActions(view, { plan });
        if (out.harvested > 0) recordOperation('ranchHarvest', out.harvested);
        if (out.produced > 0) recordOperation('ranchProduce', out.produced);
        if (out.actions.length) {
            const parts = [];
            if (out.harvested > 0) parts.push(`收:${out.harvested}`);
            if (out.produced > 0) parts.push(`产:${out.produced}`);
            log('牧场', `[到点] ${out.actions.join('→')}${parts.length ? ` [${parts.join(' ')}]` : ''}${out.details.length ? ` ${out.details.slice(0, 6).join('/')}` : ''}`, {
                module: 'ranch', event: '倒计时动作', result: 'ok', actions: out.actions,
            });
        }
        // 4. 干完立刻按最新状态重排下一次
        try { await getRanchOverview(); } catch { /* 旁路 */ }
        // ⚠ ran 必须是"真的收到东西了", 不能只看 plan 里有动作:
        //   可收位还亮着但服务端拒绝/已失效时, 若返回 true 会永久挡住整组巡检,
        //   入栏/买幼崽/牧草机就再也不执行了(2026-11-19 线上: 一直刷 [到点] collect→harvest)。
        const didWork = out.harvested > 0 || out.produced > 0 || out.details.length > 0;
        return { ran: didWork, ...out };
    } catch (e) {
        logWarn('牧场', `到点动作失败: ${e.message}`, { module: 'ranch', event: '倒计时动作', result: 'error' });
        return { ran: false, actions: [], harvested: 0, produced: 0, details: [] };
    } finally {
        isCheckingRanchGroup.core_due = false;
    }
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
    const grass = bag.items.find(it => Number(it.id) === GRASS_ITEM_ID);
    let have = grass ? Number(grass.count) : 0;

    // 背包没草 → 自动去牧场商店买(2026-11-18 抓包实证: shop6 / goods 10001 / 单价 60)
    // 受 automation.ranch_buy_grass 控制(默认开), 避免有人不想花金券
    if (have <= 0 && opts.buyGrass !== false && isAutomationOn('ranch_buy_grass')) {
        const capacityLeft = machine.capacity > 0 ? Math.max(0, machine.capacity - machine.stored) : 100;
        const wantCount = Math.min(Math.max(1, toNum(opts.buyGrassCount) || 10), Math.max(1, capacityLeft));
        const r = await buyGrass(wantCount).catch(() => null);
        if (r && r.ok) {
            // 买完 auto_add=1 已直接进牧草机, 不用再 AddFeed
            const after = await getFeedMachine().catch(() => null);
            const stored = after ? after.stored : machine.stored;
            log('牧场', `牧草断了 → 自动买 ${r.bought} 个(花 ${r.spent}), 牧草机现在 ${stored}`, {
                module: 'ranch', event: '牧草机加草', result: 'ok', bought: r.bought, spent: r.spent, stored,
            });
            return { fed: r.bought, stored };
        }
        log('牧场', `牧草断了且自动购买失败: ${r && r.error ? r.error : '未知原因'}`, {
            module: 'ranch', event: '牧草机加草', result: 'error',
        });
    }

    if (have <= 0) {
        log('牧场', `牧草机存量 ${machine.stored} 但背包没有牧草(自动购买未开启或失败)`, {
            module: 'ranch', event: '牧草机加草', result: 'skip',
        });
        return { fed: 0, stored: machine.stored };
    }
    const add = Math.min(have, machine.capacity > 0 ? Math.max(0, machine.capacity - machine.stored) : have, 100);
    if (add <= 0) return { fed: 0, stored: machine.stored };
    const r = await addFeedToMachine(add);
    return { fed: add, stored: r.stored };
}

/**
 * 买牧草(牧场商店 shop 6 的 goods 10001)。
 *
 * 2026-11-18 抓包实证(20261118-160756_购买牧草):
 *   BuyGoods {1: 10001, 2: 10, 3: 60} → 买 10 个, 单价 60
 *   响应 {1:{1:10001, 3:60, 6:7001(牧草), 7:1}}
 *   auto_add=1 时买完直接进牧草机, 不需要额外 AddFeed。
 *
 * @param {number} count 买几个
 * @returns {Promise<{ok:boolean, bought:number, spent:number, error?:string}>}
 */
async function buyGrass(count = 10) {
    const want = Math.max(1, Math.floor(toNum(count) || 1));
    // 先查一次商店拿单价与限购(auto_add 场景下 price 必须与服务端一致)
    let goods = null;
    try {
        const list = await getShopGoodsList(FEED_SHOP_ID);
        goods = (list || []).find(g => toNum(g.id) === GRASS_GOODS_ID) || null;
    } catch { /* 查不到就走默认单价 */ }
    const price = goods ? toNum(goods.price) : 60;

    let quantity = want;
    const limit = goods ? toNum(goods.limit_count) : 0;
    const boughtNum = goods ? toNum(goods.bought_num) : 0;
    if (limit > 0) {
        const remain = Math.max(0, limit - boughtNum);
        if (remain <= 0) return { ok: false, bought: 0, spent: 0, error: '牧草已达限购' };
        quantity = Math.min(quantity, remain);
    }
    if (quantity <= 0) return { ok: false, bought: 0, spent: 0, error: '可买数量为 0' };

    try {
        await purchaseShopGoods(GRASS_GOODS_ID, quantity, price);
        log('牧场', `买牧草 ${quantity} 个(单价 ${price})`, {
            module: 'ranch', event: '买牧草', result: 'ok', count: quantity, price,
        });
        return { ok: true, bought: quantity, spent: price * quantity };
    } catch (e) {
        const code = parseRanchErrorCode(e);
        const raw = String(e.message || '').replace(/^[^:]*:\s*/, '').trim();
        logWarn('牧场', `买牧草失败(code=${code || '?'}): ${raw}`, {
            module: 'ranch', event: '买牧草', result: 'error', count: quantity, code, raw,
        });
        return { ok: false, bought: 0, spent: 0, error: raw || `买牧草失败(code=${code})` };
    }
}

/**
 * 牧场商城(道具 + 幼崽) —— 分类聚合, 供面板展示与手动购买。
 *
 * 商店分工(2026-11-18 抓包实证):
 *   shop 5 = 牧场幼崽(goods 10002~10029 → item 60001~60016)
 *   shop 6 = 牧场道具(goods 10001 → item 7001 牧草, 单价 60)
 *
 * @param {'all'|'item'|'cub'} category
 * @returns {Promise<{category:string, items:Array<object>}>}
 */
async function getRanchShop(category = 'all') {
    const wantItem = category === 'all' || category === 'item';
    const wantCub = category === 'all' || category === 'cub';

    let getItemById = null;
    try { getItemById = require('../config/gameConfig').getItemById; } catch { /* 没配置就退化 */ }

    const out = [];
    if (wantItem) {
        try {
            for (const g of await getShopGoodsList(FEED_SHOP_ID)) {
                const itemId = toNum(g.item_id);
                const info = getItemById ? getItemById(itemId) : null;
                out.push({
                    category: 'item',
                    goodsId: toNum(g.id),
                    itemId,
                    name: (info && info.name) || (itemId === GRASS_ITEM_ID ? '牧草' : `道具#${itemId}`),
                    price: toNum(g.price),
                    currencyId: toNum(g.price_id) || 1007,
                    limit: toNum(g.limit_count),
                    bought: toNum(g.bought_num),
                    remaining: toNum(g.limit_count) > 0
                        ? Math.max(0, toNum(g.limit_count) - toNum(g.bought_num)) : null,
                    unlocked: !!g.unlocked,
                });
            }
        } catch { /* 单个商店失败不影响另一类 */ }
    }
    if (wantCub) {
        try {
            for (const g of await getCubShop()) {
                out.push({ category: 'cub', ...g });
            }
        } catch { /* 同上 */ }
    }
    return { category, items: out };
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
// 牧场商店(饲料/牧草) —— 2026-11-18 抓包 20261118-160756 实证:
//   牧草 = shopId 6 的 goods_id 10001, item_id 7001, 单价 60
//   BuyGoods {1:10001(商品id), 2:数量, 3:单价} + auto_add=1 → 直接进牧草机
const FEED_SHOP_ID = 6;
const GRASS_GOODS_ID = 10001;
const GRASS_ITEM_ID = 7001;
const GROWN_VALUE = {
    60001: 6, 60002: 2160, 60003: 5424, 60004: 8136, 60005: 13536, 60006: 20304,
    70001: 1440, 70002: 2160,
};

/** 幼崽商店列表(带收益比) */
async function getCubShop() {
    const goods = await getShopGoodsList(CUB_SHOP_ID);
    // 统一用 ranch-analytics 的推导(从 ItemInfo 的成品动物价算),
    // 不再依赖下面这张手工维护的 GROWN_VALUE 表 —— 两者曾经对不上。
    let grownValueOf = null;
    try {
        grownValueOf = require('./ranch-analytics').getGrownValue;
    } catch { /* 拿不到就回退到静态表 */ }

    return goods.map(g => {
        const animalId = toNum(g.item_id);
        const price = Math.max(1, toNum(g.price));
        const grown = grownValueOf ? grownValueOf(animalId) : (GROWN_VALUE[animalId] || 0);
        return {
            goodsId: toNum(g.id),
            animalId,
            name: getAnimalName(animalId),
            price: toNum(g.price),
            limit: toNum(g.limit_count),
            bought: toNum(g.bought_num),
            // 剩余可买: 0 = 已售罄; null = 不限购(前端按 99 封顶)
            remaining: toNum(g.limit_count) > 0
                ? Math.max(0, toNum(g.limit_count) - toNum(g.bought_num))
                : null,
            unlocked: !!g.unlocked,
            currencyId: toNum(g.price_id) || 1007,
            // 整只回收价 + 收益比 + 单只净赚(前端排序/展示都用)
            grownValue: grown,
            valueRatio: grown > 0 ? grown / price : 0,
            profit: grown > 0 ? grown - toNum(g.price) : null,
        };
    }).sort((a, b) => b.valueRatio - a.valueRatio);
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
    let usable = shop.filter(g => g.unlocked && g.price > 0 && g.valueRatio > 0);
    if (usable.length === 0) {
        log('牧场', '幼崽商店没有可买的(未解锁或价格为 0)', { module: 'ranch', event: '买幼崽', result: 'skip' });
        return result;
    }

    // 按用户配置的策略挑幼崽(对照农场 plantingStrategy, 但牧场完全独立)
    usable = applyCubStrategy(usable);
    if (usable.length === 0) {
        log('牧场', '按当前幼崽策略没有可选目标', { module: 'ranch', event: '买幼崽', result: 'skip' });
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
    // ⚠ 单轮购买上限: 线上事故(2026-11-18)里机器人每轮都买 4 只,
    //   因为 buyGoods 的 auto_add 没把幼崽放进栏舍, 幼崽堆在背包里(实测 1242 只鸡),
    //   下一轮 slots 仍然是 4 → 又买 4 只 → 无限购买。
    //   加硬上限: 每轮最多买 slots 只, 且不超过 MAX_CUBS_PER_ROUND。
    const MAX_CUBS_PER_ROUND = 4;
    const buyBudget = Math.min(slots, MAX_CUBS_PER_ROUND);

    // 背包里已有的幼崽: 如果买来没入栏, 先别买了 —— 应该去"放置", 不是继续买
    // (幼崽 itemType=105, 每只 uid 不同, 这里只统计数量)
    let bagCubs = 0;
    try {
        const warehouse = require('./warehouse');
        const bag = await warehouse.getRanchBagItems();
        for (const it of bag) {
            const info = (() => {
                try { return require('../config/gameConfig').getItemById(toNum(it.id)); } catch { return null; }
            })();
            if (info && Number(info.type) === 105) bagCubs += toNum(it.count);
        }
    } catch { /* 读不到背包就不做这个保护, 交给上限兜底 */ }

    // 背包优先 = 主策略里的 bag_priority(与农场一致), 不是另设一个开关。
    // 该策略下"买"让位给入栏, 由 autoPlaceCubs 负责。
    const strategyNow = (() => {
        try {
            const store = require('../models/store');
            return typeof store.getRanchCubStrategy === 'function'
                ? store.getRanchCubStrategy(process.env.FARM_ACCOUNT_ID || '')
                : 'max_profit';
        } catch { return 'max_profit'; }
    })();

    if (bagCubs > 0 && (strategyNow === 'bag_priority' || bagCubs >= buyBudget)) {
        log('牧场', `背包里已有 ${bagCubs} 只幼崽未入栏, 暂停买幼崽(应先入栏, 不是继续买)`, {
            module: 'ranch', event: '买幼崽', result: 'skip', bagCubs, strategy: strategyNow,
        });
        return result;
    }

    let spend = 0;
    for (const g of usable) {
        if (result.bought >= buyBudget || spend >= maxSpend) break;
        // 限购余量
        const remain = g.limit > 0 ? Math.max(0, g.limit - g.bought) : 99;
        if (remain <= 0) continue;
        const affordable = Math.floor((maxSpend - spend) / g.price);
        const count = Math.min(buyBudget - result.bought, remain, affordable);
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
                        // ⭐ 官方操作顺序(文档 6.2 RPC 一览 + 入栏抓包 t+17~t+36):
            //   收取副产物(CollectProduce) → 催产(TriggerProduce) → 收获(HarvestRanch)
            //   之前只发 HarvestRanch: 架上有蛋(feed=3/#6≥1)时收不到 → 一直 1045211。
            //   CollectProduce 按槽收(鹅/鸡的蛋在架上); slot=0 尝试全场。
            let collectedText = '';
            for (const s of [1, 2, 3, 4, 5, 6]) {
                try {
                    const cr = await collectProduce(s);
                    const got = ((cr.items || cr.get_items || []).map(it => `${toNum(it.id)}x${toNum(it.count)}`)).join(',');
                    if (got) collectedText += (collectedText ? '，' : '') + `槽${s}:${got}`;
                    await sleep(200);
                } catch (e) {
                    const code = parseRanchErrorCode(e);
                    if (!isExpectedRanchError(e) && code !== 1045211) {
                        logWarn('牧场', `收副产物槽${s}失败: ${e.message}`, { module: 'ranch', event: '收副产物', result: 'error', slot: s });
                    }
                }
            }
            if (collectedText) result.details.push(`副产物${collectedText}`);
            // 催产(给冷却到点的动物开新一轮; 失败不阻断)
            try {
                await triggerProduce(0).catch(() => null);
                await sleep(400);
            } catch { /* 催产失败继续尝试收获 */ }
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
                // 同上: 催产也要按动物所在栏舍选实例, 否则棚里的动物报"动物不存在"
                let produceGid = 0;
                if (slot > 0) {
                    try {
                        const v = await getRanchOverview();
                        const a = (v.animals || []).find(x => toNum(x.slot) === slot);
                        if (a) produceGid = toNum(a.ranchInstId) || 0;
                    } catch { /* 回落默认 */ }
                }
                const r = await triggerProduce(slot, produceGid);
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
            // ⚠ 1045202「网络繁忙」是服务端限流: 自动化巡检刚打完一轮请求时点"喂罐头"
            //   很容易撞上。这不是故障, 应该退避后重试一次, 而不是直接把错误抛给用户。
            //
            // 两种罐头的限制不同(抓包实测):
            //   4 普通罐头 —— 每只动物只能用一次, 重复喂会被服务端拒绝
            //   5/6 有机罐头 —— 不限次数
            const feedLabel = FEED_TYPE_LABEL[feedType] || `方式${feedType}`;
            // ⭐ 2026-11-19 修"动物不存在": 按被操作动物的栏舍实例选 host_gid。
            //   FeedAnimal 请求里**没有槽位字段**(抓包证实), 服务端按 target#1 的
            //   ranch_inst_id 定位栏舍。窝=10001 / 棚=10003, 写死 10001 时
            //   喂棚里的动物就会报"动物不存在"。
            let feedHostGid = 0;
            if (slot > 0) {
                try {
                    const v = await getRanchOverview();
                    const a = (v.animals || []).find(x => toNum(x.slot) === slot);
                    if (a) feedHostGid = toNum(a.ranchInstId) || 0;
                } catch { /* 拿不到就回落默认实例 */ }
            }
            // 桶空时先自动灌罐头(80021+ → 容器 7003/7004), 再重试一次。
            // 之前缺这一步: 背包有 72 个罐头, 喂食却一直回 1045234「罐头桶已用完」。
            const doFeed = async () => feedAnimal(feedType, count, feedHostGid);
            try {
                await doFeed();
                return { ok: true, action: '喂食', detail: `${feedLabel} x${count}` };
            } catch (e) {
                const code = parseRanchErrorCode(e);
                if (code === RANCH_ERR.CANS_EMPTY && opts.autoFillCans !== false) {
                    const kind = Number(feedType) === FEED_TYPE.NORMAL_CAN ? 'normal' : 'organic';
                    const filled = await fillCanBuckets(kind, { maxItems: 2 });
                    if (filled.used > 0) {
                        try {
                            await doFeed();
                            return {
                                ok: true, action: '喂食',
                                detail: `${feedLabel} x${count}(自动灌入 ${filled.used} 个罐头)`,
                            };
                        } catch (e2) {
                            return { ok: false, action: '喂食', error: feedFailureHint(feedType, e2) };
                        }
                    }
                    return {
                        ok: false, action: '喂食',
                        error: `罐头桶已空，且背包里没有${kind === 'normal' ? '普通' : '有机'}罐头可灌。请在商城购买罐头(80021~80034)`,
                    };
                }
                if (code === RANCH_ERR.FEED_REJECTED) {
                    // 1045202 实测 100% 稳定复现(不是偶发), 不做"退避重试" ——
                    // 重试只会再失败一次, 还把真实原因藏起来。服务端 message 原样带出。
                    const raw = String(e.message || '').replace(/^[^:]*:\s*/, '').trim();
                    logWarn('牧场', `喂食被拒(code=1045202): ${raw || '(服务端无额外说明)'}`, {
                        module: 'ranch', event: '喂食', result: 'rejected',
                        feedType, count, raw,
                    });
                    return {
                        ok: false, action: '喂食',
                        error: `喂食被服务端拒绝(code=1045202)${raw ? `：${raw}` : ''}`,
                    };
                }
                if (isExpectedRanchError(e) || code > 0) {
                    return { ok: false, action: '喂食', error: feedFailureHint(feedType, e) };
                }
                throw e;
            }
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
            // 一次放一只(抓包定案); 想放多只就多调几次
            const times = Math.max(1, Math.min(toNum(opts.count) || 1, 8));
            let placedN = 0;
            let lastAnimals = 0;
            for (let i = 0; i < times; i++) {
                const r = await placeAnimal(cub);
                placedN += 1;
                lastAnimals = (r.ranches || []).reduce((n, x) => n + (x.animals || []).length, 0);
                await sleep(300);
            }
            return { ok: true, action: '幼崽入栏', detail: `已放 ${placedN} 只，当前在养 ${lastAnimals} 只` };
        }
        case 'collect': {
            // 收取副产品(官方文档 RPC 一览明确存在; 旧对照实验的"不存在"是参数错误)
            // 一次一只, 指定槽; 客户端语义: 收走架上产物, 动物留栏
            try {
                const cr = await collectProduce(slot);
                const got = ((cr.items || cr.get_items || [])).map(it => `${toNum(it.id)}x${toNum(it.count)}`).join(',');
                return { ok: true, action: '收取产物', detail: `槽${slot} ${got || '(成功)'}`, raw: got };
            } catch (e) {
                const code = parseRanchErrorCode(e);
                return { ok: false, action: '收取产物', error: `槽${slot} code=${code}: ${String(e.message).slice(0, 80)}` };
            }
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
                // feedType: 4=普通罐头(每只一次) / 5,6=有机罐头(不限次数)。
                // 批量默认用有机罐头(5): 普通罐头对多数动物已用过, 全喂必然大面积失败。
                const ft = toNum(opts.feedType) || FEED_TYPE.ORGANIC_A;
                try {
                    await feedAnimal(ft, toNum(opts.count) || 1);
                    return { ok: true, action: '全场喂罐头', detail: FEED_TYPE_LABEL[ft] || `方式${ft}` };
                } catch (e) {
                    const code = parseRanchErrorCode(e);
                    // 桶空 → 先灌罐头再重试(与单只路径一致)
                    if (code === RANCH_ERR.CANS_EMPTY && opts.autoFillCans !== false) {
                        const kind = ft === FEED_TYPE.NORMAL_CAN ? 'normal' : 'organic';
                        const filled = await fillCanBuckets(kind, { maxItems: 2 });
                        if (filled.used > 0) {
                            try {
                                await feedAnimal(ft, toNum(opts.count) || 1);
                                return { ok: true, action: '全场喂罐头', detail: `自动灌入 ${filled.used} 个罐头后喂食成功` };
                            } catch (e2) {
                                return { ok: false, action: '全场喂罐头', error: feedFailureHint(ft, e2) };
                            }
                        }
                        return {
                            ok: false, action: '全场喂罐头',
                            error: `罐头桶已空，且背包里没有${kind === 'normal' ? '普通' : '有机'}罐头可灌`,
                        };
                    }
                    // 1045202 不再当"限流"重试(实测 100% 复现, 重试必失败)
                    if (code === RANCH_ERR.FEED_REJECTED) {
                        const raw = String(e.message || '').replace(/^[^:]*:\s*/, '').trim();
                        logWarn('牧场', `全场喂罐头被拒(code=1045202): ${raw || '(无额外说明)'}`, {
                            module: 'ranch', event: '全场喂罐头', result: 'rejected', feedType: ft, raw,
                        });
                        return {
                            ok: false, action: '全场喂罐头',
                            error: `喂食被服务端拒绝(code=1045202)${raw ? `：${raw}` : ''}`,
                        };
                    }
                    return { ok: false, action: '全场喂罐头', error: feedFailureHint(ft, e) };
                }
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
                detail: all.buildings.map(b => `#${b.instId} Lv${b.level} ${buildingStatusText(b.status)}`).join('，') || '暂无建筑',
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
    checkRanchGroup,
    getNextRanchDelayMs: nextRanchDelayMs,
    getNextRanchCheckAt: () => nextRanchCheckAt,
    // 分组巡查: worker 按组各自计时(对照农场的 农场/帮助/偷菜 三套独立间隔)
    RANCH_GROUPS,
    getRanchNextRunAt,
    isRanchGroupDue,
    // 倒计时到点: 只做收产物/催产/收获/补草, 不跑整套巡检
    runRanchDueTick,
    planRanchDueActions,
    runRanchDueActions,
    pullRanchGroupForward,
    scheduleRanchFromCountdowns,
    ranchIntervalRangeSec,
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
    autoUseRanchBagItems,
    getRanchShop,
    buyGrass,
    fillCanBuckets,
    useItemWithUid,
    getRanchWeightScore,
    __privateRanchFns: {
        calcRanchLevel, parseRotationShopReply, parseFeedMachineReply, walkWire, isEmptyRanchView,
        // 幼崽: 供测试验证"背包已有幼崽就不再买 + 单轮上限"
        autoBuyCubs, autoPlaceCubs, applyCubStrategy,
        // 游商: 供测试验证"等级不够就不发购买请求 + 不刷 error 日志"
        autoBuyRotationShop, isRotationNotPurchasable, rotationErrorHint,
        // 喂食: 供测试验证两种罐头的 feed_type 与失败提示
        feedAnimal, feedFailureHint, FEED_TYPE, resolveRanchHostGid, RANCH_SELF_HOST_GID,
        // 缓存: 供测试验证"写操作后 overview 必须失效"(收获后入栏读到满栏的事故)
        invalidateRanchOverviewCache,
        // 栏舍实例: 供测试验证"棚动物要用 10003 而不是写死的 10001"
        rememberRanchInstIds, resolveRanchHostGid,
        planRanchDueActions, runRanchDueActions,
    },
};