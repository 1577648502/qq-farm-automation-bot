
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
const { createFailureBreaker } = require('../utils/failure-breaker');
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
    // ⭐ 2026-11-20 线上日志定案(抓包 20261120-001457 + 生产环境):
    ANIMAL_MISSING: 1045207,     // 动物不存在 —— StrokeAnimal 的 target#2 传了槽位而不是 animal_inst_id
    HAZARD_ENOUGH: 1045230,      // 这里的蚊子已经够多啦 —— 同一栏舍连放太多次, 要换栏舍/换好友
    STROKE_ALREADY: 1045246,     // 你已经照料过这只动物啦 —— 每只动物每天只能照料一次
    STROKE_MUTANT: 1045244,      // 已经巨大化的动物不能再照料啦 —— 变异/巨大化不可照料
    STEAL_TOLD_STOP: 1045221,    // 别拿啦，给我留点吧！—— 该好友产物已被偷完/达偷取上限(正常业务态)
};

/** 日志用短错误(去掉 gamepb.xxx 前缀, 超 40 字截断) —— 与 milk-tea 的 shortErr 同款 */
function shortErr(msg, maxLen = 40) {
    let t = String(msg || '');
    t = t.replace(/^gamepb\.[\w.]+\s*错误:\s*/, '').replace(/\s+/g, ' ').trim();
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

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
        || code === RANCH_ERR.NOTHING_TO_HARVEST
        || code === RANCH_ERR.ANIMAL_MISSING
        || code === RANCH_ERR.HAZARD_ENOUGH
        || code === RANCH_ERR.STROKE_ALREADY
        || code === RANCH_ERR.STROKE_MUTANT
        || code === RANCH_ERR.STEAL_TOLD_STOP;
}

// 场景类型(抓包 20261116: PlayerSceneLogin 请求体 {1:1}=农场(0801), {1:2}=牧场(0802))
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
/**
 * 对外暴露的场景切换(牧场背包用道具前必须先切到牧场场景)。
 * 与内部 enterRanchScene 相同的语义, 只是给它一个稳定的导出名。
 */
async function enterRanchSceneForApi() {
    return enterRanchScene();
}

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
 * 按槽位查出该动物的 animal_inst_id(服务端 AnimalInfo#3)。
 * FeedAnimal / TriggerProduce 的 target#2 用的就是它, 不是槽位号也不是动物物品 ID。
 * @returns {Promise<number>} 0 = 找不到
 */
async function resolveAnimalInstIdBySlot(slot, hostGid = 0) {
    const want = toNum(slot);
    if (!want) return 0;
    try {
        const view = await getRanchOverview();
        const gid = toNum(hostGid);
        const list = (view.animals || []).filter(a => !gid || toNum(a.ranchInstId) === gid);
        const hit = list.find(a => toNum(a.slot) === want);
        return hit ? toNum(hit.animalInstId) : 0;
    } catch {
        return 0;
    }
}

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
/**
 * FeedAnimal 的 target#2 **不是罐头类型**, 而是**目标动物的 animal_inst_id**。
 *
 * ⭐⭐ 2026-11-19 用官方抓包(20261119-091627_罐头)定案, 推翻之前所有猜测:
 *
 *   单独喂(指定某只):
 *     0a06 08914e 10c009 1002   → target={1:10001, 2:1216}, count=2
 *     0a06 08914e 10c009 1001   → target={1:10001, 2:1216}, count=1
 *     1216 = 槽位1那只动物的 animal_inst_id(= AnimalInfo#3)
 *
 *   批量喂(全场):
 *     0a03 08914e 1002          → target={1:10001},        count=2
 *     0a03 08914e 1001          → target={1:10001},        count=1
 *
 *   count = 投入的罐头桶数量(1 或 2), 影响桶剩余秒数与经验。
 *
 * 之前把 #2 当成 feed_type 并硬编码 4/5/6 —— 服务端拿 4/5/6 去找动物,
 * 找不到就回 1045207「动物不存在」。这就是"点有机罐头报动物不存在"的根因。
 */
const FEED_TYPE = {
    NORMAL_CAN: 4,       // 普通罐头: 仅用于 UI/失败提示分流, **不再发给服务端**
    ORGANIC_A: 5,
    ORGANIC_B: 6,
};
const FEED_TYPE_LABEL = {
    4: '普通罐头',
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
/**
 * 罐头自动使用(2026-11-22 用户定案"直接全部一次使用完"): 背包罐头(普通+有机)按 大罐优先,
 * 每格一条 Use {id, count=整格数量, uid} 一次性灌进对应桶。桶满报错 → 该格留在背包跳过。
 * @returns {Promise<{used:number, details:string[]}>}
 */
async function autoFillCansToWatermark() {
    const out = { used: 0, details: [] };
    const wh = require('./warehouse');

    // 背包罐头: 农场背包 + 牧场背包合并(与 fillCanBuckets 同口径)
    const all = [];
    try {
        const farmReply = await wh.getBag();
        all.push(...(wh.getBagItems(farmReply) || []).map(it => ({ id: toNum(it.id), count: toNum(it.count), uid: toNum(it.uid) })));
    } catch { }
    try {
        all.push(...(await wh.getRanchBagItems()).map(it => ({ id: toNum(it.id), count: toNum(it.count), uid: toNum(it.uid) })));
    } catch { }

    // ⭐ 2026-11-23 抓包/线上实测定案(1003002 整格被拒事故):
    //   服务端罐头容器有**总时长上限 1,000,000 秒(≈277.8h)** —— 整格一条 Use count=N
    //   若灌完会超上限, 整单被拒(1003002), 一个都不进桶。所以必须**分批**:
    //   按桶余量算 headroom → 每批 min(整格, headroom/单罐时长) → 灌到桶满为止。
    //   (acc1 实测: 7004 在 992.3h 时 count=1 的 8h 罐都被拒, headroom<8h; 上限=1000000s)
    const CAN_BUCKET_CAP_SEC = 1000000;
    for (const kind of ['organic', 'normal']) {
        const isNormal = kind === 'normal';
        const ids = isNormal ? [80021, 80022, 80023, 80024] : [80031, 80032, 80033, 80034];
        const cans = all
            .filter(it => ids.includes(it.id) && it.count > 0 && it.uid > 0)
            .sort((a, b) => (CAN_ITEM_HOURS[b.id] || 0) - (CAN_ITEM_HOURS[a.id] || 0));
        let bucketSec = null;
        try {
            const secs = await readCanBucketSecs();
            bucketSec = kind === 'normal' ? secs.normalSec : secs.organicSec;
            if (bucketSec === null || bucketSec === undefined) bucketSec = -1;
        } catch { bucketSec = -1; }
        for (const can of cans) {
            if (bucketSec >= 0 && bucketSec >= CAN_BUCKET_CAP_SEC) break;   // 桶满
            // 本格想灌 can.count 个; 桶能吃下的 = floor(headroom / 单罐秒数)
            let n = can.count;
            if (bucketSec >= 0) {
                const hours = CAN_ITEM_HOURS[can.id] || 0;
                const headroom = CAN_BUCKET_CAP_SEC - bucketSec;
                const maxByCap = hours > 0 ? Math.floor(headroom / (hours * 3600)) : 0;
                if (maxByCap <= 0) {
                    // 这个罐单只都灌不下 → 换更小的罐(排序已是大的先, 后面的更小)
                    continue;
                }
                n = Math.min(n, maxByCap);
            }
            try {
                await useItemWithUid(can.id, n, can.uid);
                out.used += n;
                out.details.push(`${CAN_ITEM_HOURS[can.id] || can.id}h罐x${n}`);
                if (bucketSec >= 0) bucketSec += (CAN_ITEM_HOURS[can.id] || 0) * 3600 * n;
            } catch (e) {
                // 1003002=容器上限(理论不会到, 分批已防) / 其他错误 → 该格跳过
                const code = parseRanchErrorCode(e);
                if (code === 1003002) break;   // 桶满, 这一类不用再试
                log('牧场', `罐头分批灌入失败 #${can.id}x${n}: ${String(e.message || '').slice(0, 60)}`, {
                    module: 'ranch', event: '罐头自动灌桶', result: 'skip', itemId: can.id,
                });
            }
            await sleep(250);
        }
    }
    if (out.used > 0) {
        log('牧场', `罐头自动使用(分批灌桶): ${out.details.join('，')}, 共 ${out.used} 个`, {
            module: 'ranch', event: '罐头自动灌桶', result: 'ok', used: out.used,
        });
    }
    if (out.used > 0) invalidateCanBucketCache();
    return out;
}

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
        // 罐头(type=109)单独走整格灌桶 autoFillCansToWatermark(2026-11-22 定案"一次用完"), 不混进普通 targets
        if (type === 109) continue;
        targets.push({ id, count, uid, name: info.name || `#${id}` });
    }
    if (!targets.length) {
        // ⭐ 普通道具没有可用的 ≠ 没活干: 背包可能全是罐头(type=109 被上面 continue 跳过),
        //   自动灌桶仍要跑(2026-11-22 线上实测: acc3 无机桶 3.8h < 水位却没灌, 就是这里提前 return 了)
        const canR = await autoFillCansToWatermark().catch(() => ({ used: 0, details: [] }));
        return finish({ used: canR.used, details: canR.details });
    }

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
    // ⭐ 罐头自动灌桶(2026-11-22 用户定案: "背包有可用的道具也是要自动使用, 跟农场一样"):
    //   罐头 Use 的服务端语义就是进桶(不存在直达动物的接口), 所以"自动使用罐头"="自动灌桶"。
    //   2026-11-22 再定案"直接全部一次使用完": 每格一条 Use count=整格, 桶满报错自然止损。
    try {
        const canR = await autoFillCansToWatermark();
        if (canR.used > 0) {
            used += canR.used;
            details.push(...canR.details);
        }
    } catch (e) {
        logWarn('牧场', `罐头自动灌桶失败: ${String(e.message || '').slice(0, 80)}`, {
            module: 'ranch', event: '罐头自动灌桶', result: 'error',
        });
    }

    if (used > 0) {
        log('牧场', `已自动使用牧场背包道具: ${details.join('，')}`, {
            module: 'ranch', event: '自动使用道具', result: 'ok', count: used,
        });
    }
    return finish({ used, details });
}

// 罐头桶自动灌桶相关常量(模块级, fillCanBuckets/useCanFillBucket/autoUseRanchBagItems 共用):
// 罐头道具 id → 单罐时长(小时)。ItemInfo desc 权威: 80021=1h 80022=4h 80023=8h 80024=12h(有机同构)。
const CAN_ITEM_HOURS = {
    80021: 1, 80022: 4, 80023: 8, 80024: 12,
    80031: 1, 80032: 4, 80033: 8, 80034: 12,
};
// (旧水位控制已删: 2026-11-22 用户定案"直接全部一次使用完", 桶满由服务端报错自然止损)

/** onlyIds 为空时不过滤; 给了就只处理列表内的 */
function ids_contains(onlyIds, id) {
    return !!onlyIds && !onlyIds.has(id);
}

async function fillCanBuckets(kind = 'normal', opts = {}) {
    const result = { used: 0, details: [], bucketSec: null };
    // 普通罐头 80021~80024 / 有机罐头 80031~80034
    const isNormal = kind !== 'organic';
    const ids = isNormal ? [80021, 80022, 80023, 80024] : [80031, 80032, 80033, 80034];
    const bucketId = isNormal ? CAN_BUCKET_NORMAL : CAN_BUCKET_ORGANIC;

    // ⭐ 2026-11-20 线上修复: 桶(7003/7004)在**农场背包**(ItemService.Bag)里,
    //   不在牧场背包。之前从牧场背包读 → 永远读不到 → 永远认为桶空 → 报错。
    //   罐头(80021+)两个背包都找(实测可能落在任意一侧)。
    const wh = require('./warehouse');

    // 农场背包: 桶(7003/7004) + 罐头(80021~80034)
    let farmItems = [];
    try {
        const farmReply = await wh.getBag();
        farmItems = wh.getBagItems(farmReply) || [];
    } catch { farmItems = []; }

    // 牧场背包: 罐头可能也在这(与农场背包不重复)
    let ranchItems = [];
    try {
        ranchItems = await wh.getRanchBagItems();
    } catch { ranchItems = []; }

    // 合并两处物品, 取桶和罐头
    const all = [
        ...farmItems.map(it => ({ id: toNum(it.id), count: toNum(it.count), uid: toNum(it.uid) })),
        ...ranchItems.map(it => ({ id: toNum(it.id), count: toNum(it.count), uid: toNum(it.uid) })),
    ];

    // 桶当前余量(秒)。7003/7004 的 count 就是剩余秒数。
    const bucket = all.find(it => toNum(it.id) === bucketId);
    const bucketSec = bucket ? Math.max(0, toNum(bucket.count)) : 0;
    result.bucketSec = bucketSec;

    // ⭐ onlyIfBucketEmpty: 只在目标桶**没有余量**时才灌。
    //   FeedAnimal 请求不带罐头类型, 服务端按"哪桶有剩余"扣 ——
    //   目标桶还有余量时再灌只是浪费(桶还有上限)。
    if (opts.onlyIfBucketEmpty && bucketSec > 0) {
        return result;
    }
    const cans = all
        .filter(it => ids.includes(toNum(it.id)) && toNum(it.count) > 0 && toNum(it.uid) > 0)
        .sort((a, b) => {
            // preferUid: 用户点"使用"的那个格子排最前(语义: 用我点的这罐)
            const pu = toNum(opts.preferUid) || 0;
            if (pu > 0) {
                if (toNum(a.uid) === pu && toNum(b.uid) !== pu) return -1;
                if (toNum(b.uid) === pu && toNum(a.uid) !== pu) return 1;
            }
            // ⭐ 修复: 注释一直写"大的先灌", 旧实现用 ids.indexOf 升序 = 实际 1h 先灌。
            //   按单罐时长降序才是注释的语义。
            return (CAN_ITEM_HOURS[toNum(b.id)] || 0) - (CAN_ITEM_HOURS[toNum(a.id)] || 0);
        });

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
        invalidateCanBucketCache();   // 桶余量变了, 让总览显示立即刷新
    }
    return result;
}

/**
 * 手动"使用"罐头 = **纯灌桶**(2026-11-22 用户定案: 点"用"应该进罐头桶,
 * 喂动物由喂食按钮/自动喂食负责 —— 旧实现直接 FeedAnimal 是错误语义)。
 *
 * 服务端协议事实: 罐头(80021~80034) Use/BatchUse 的效果就是把对应桶的时长加上,
 * 不存在"罐头直达动物"的接口; 喂动物走 FeedAnimal 从桶扣。
 * 所以"用罐头"的正确行为就是把罐头灌进对应类型的桶。
 *
 * @param {number} itemId 罐头 id(80021~80034)
 * @param {number} count  用几个(默认 1; 传 0/负数用全部 → count=该格 count 由调用方传)
 * @param {number} uid    道具格 uid
 * @returns {Promise<{ok:boolean, action:string, detail:string, used?:number, error?:string}>}
 */
async function useCanFillBucket(itemId, count = 1, uid = 0) {
    const id = toNum(itemId);
    const isNormal = id >= 80021 && id <= 80024;
    const isOrganic = id >= 80031 && id <= 80034;
    if (!isNormal && !isOrganic) {
        return { ok: false, error: `不是罐头道具(${id})` };
    }
    const n = Math.max(1, toNum(count) || 1);
    // ⭐ 分批灌入(2026-11-23 线上实锤): 服务端容器上限 1,000,000 秒(≈277.8h),
    //   一条 Use count=N 灌完会超上限时**整单被拒**(1003002), 一个都不进。
    //   按桶余量算 headroom, 每批 min(剩余, floor(headroom/单罐秒)) 灌到桶满。
    const CAN_BUCKET_CAP_SEC = 1000000;
    const kind = isNormal ? 'normal' : 'organic';
    const hours = CAN_ITEM_HOURS[id] || 0;
    let remaining = n;
    let used = 0;
    while (remaining > 0) {
        let batch = remaining;
        try {
            const secs = await readCanBucketSecs(true);   // force: 每批后桶秒数在变
            const cur = kind === 'normal' ? secs.normalSec : secs.organicSec;
            if (cur !== null && cur !== undefined && hours > 0) {
                const maxByCap = Math.floor((CAN_BUCKET_CAP_SEC - cur) / (hours * 3600));
                if (maxByCap <= 0) {
                    return {
                        ok: false,
                        error: `罐头桶已接近上限(当前 ${Math.round(cur / 3600)}h, 上限约 ${Math.round(CAN_BUCKET_CAP_SEC / 3600)}h), 这格 ${n - used} 个灌不进去`,
                        used,
                    };
                }
                batch = Math.min(batch, maxByCap);
            }
            await useItemWithUid(id, batch, toNum(uid) || 0);
            used += batch;
            remaining -= batch;
            if (remaining <= 0) break;
            await sleep(250);
        } catch (e) {
            if (used > 0) {
                invalidateCanBucketCache();
                log('牧场', `罐头入桶(分批): ${isNormal ? '普通' : '有机'}罐头 x${used}/${n}, 剩余未灌: ${String(e.message || '').slice(0, 50)}`, {
                    module: 'ranch', event: '罐头入桶', result: 'partial', itemId: id, used,
                });
                return { ok: true, action: '灌桶', detail: `${isNormal ? '普通' : '有机'}罐头桶 +${used} 罐(剩 ${remaining} 个未灌)`, used };
            }
            return { ok: false, error: `灌桶失败: ${e.message || '未知原因'}` };
        }
    }
    invalidateCanBucketCache();
    log('牧场', `罐头入桶: ${isNormal ? '普通' : '有机'}罐头 x${used}(点用)`, {
        module: 'ranch', event: '罐头入桶', result: 'ok', itemId: id, used,
    });
    return { ok: true, action: '灌桶', detail: `${isNormal ? '普通' : '有机'}罐头桶 +${used} 罐`, used };
}

/**
 * 一键把罐头用到动物上(旧入口, 保留兼容)。
 *
 * 背景: 服务端没有"罐头直达动物"的接口 —— 官方流程是两步:
 *   背包点罐头 = 装填桶(BatchUse/Use, 桶余量+)
 *   喂动物    = FeedAnimal(从桶扣)
 * 用户期望点一下就直接生效到动物, 所以这里把两步串起来:
 *   1. 按罐头类型(80021~24=普通/无机, 80031~34=有机)确定目标桶
 *   2. 桶没余量 → 先灌 1 个
 *   3. 挑一只可喂的动物(can_feed=1 优先)发 FeedAnimal
 *
 * @param {number} itemId 罐头物品 id(80021~80034)
 * @param {number} count  数量(当前固定 1, 与官方单次喂一致)
 * @param {number} uid    道具格 uid
 */
async function useCanOnAnimal(itemId, _count = 1, uid = 0) {
    const id = toNum(itemId);
    const isNormal = id >= 80021 && id <= 80024;
    const isOrganic = id >= 80031 && id <= 80034;
    if (!isNormal && !isOrganic) {
        return { ok: false, error: `不是罐头道具(${id})` };
    }
    const kind = isNormal ? 'normal' : 'organic';
    const feedType = isNormal ? FEED_TYPE.NORMAL_CAN : FEED_TYPE.ORGANIC_A;

    // 1. 桶没余量 → 先灌(与喂食按钮同一套预灌逻辑)
    const pre = await fillCanBuckets(kind, { maxItems: 1, onlyIfBucketEmpty: true, preferUid: uid })
        .catch(() => ({ used: 0 }));
    if (pre.used > 0) {
        log('牧场', `使用罐头: 先把 1 个${isNormal ? '普通' : '有机'}罐头灌进桶`, {
            module: 'ranch', event: '灌罐头', result: 'ok', kind,
        });
    }

    // 2. 挑一只可喂的动物(can_feed=1 优先, 其次任意在场动物)
    const view = await getRanchOverview();
    const animals = view.animals || [];
    if (!animals.length) {
        return { ok: false, error: '牧场里没有动物可喂' };
    }
    const target = animals.find(a => a.canFeed) || animals[0];
    const hostGid = toNum(target.ranchInstId) || RANCH_SELF_HOST_GID;
    const instId = toNum(target.animalInstId) || 0;

    // 3. FeedAnimal(⭐ #2 是喂食方式不是数量: 普通→2 / 有机→1)
    try {
        await feedAnimal(kind, hostGid, instId);
        invalidateRanchOverviewCache();
        return {
            ok: true,
            action: '喂食',
            detail: `${target.name}(槽${target.slot})${pre.used > 0 ? '，已自动灌桶' : ''}`,
        };
    } catch (e) {
        const code = parseRanchErrorCode(e);
        return { ok: false, error: feedFailureHint(feedType, e), code };
    }
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
 * 抓包实证: FeedAnimal 请求 {1:{1:10001, 2:animal_inst_id(可省略)}, 2:feed_type}
 * ⭐ 2026-11-21 定案(20261119-091627_罐头 4 帧): 顶层 #2 是喂食方式(1=有机/2=普通),
 *   不是数量; target#2 才是 animal_inst_id, 缺省=全场每只一条 receipt。
 * 所以这里默认取牧场实例 ID; 访问好友牧场时才传好友的对应值。
 */
const RANCH_SELF_HOST_GID = 10001;

/**
 * GetRanchOpTimes 的三个操作 ID(2026-11-20 抓包定案):
 *   11003 = 使坏(PutHazard), 每日上限 100
 *   11009 = 照顾/摸动物(StrokeAnimal), 每日上限 10
 *   11008 = 上限 20, 本抓包没被消耗, 语义待定(不在自动流程里用)
 */
const RANCH_OP_ID_HAZARD = 11003;
const RANCH_OP_ID_STROKE = 11009;

/**
 * 罐头桶: 7003 普通(无机) / 7004 有机。
 * 它们会作为**背包条目**下发, count = 桶里剩余秒数。
 * FeedAnimal 请求只带 host_gid/animal_inst_id/count, **不带罐头类型**,
 * 服务端按"哪个桶有剩余时长"扣(抓包回包 #5.#11={1:7003,2:3596} 证实)。
 */
const CAN_BUCKET_NORMAL = 7003;
const CAN_BUCKET_ORGANIC = 7004;

/**
 * 读两个罐头桶的余量(秒), 给面板总览头部显示。
 * 桶(7003/7004)在农场背包, count=剩余秒数; 背包无该条目 = 0(空桶)。
 * 60s 小缓存: overview 被 10s 节流后仍会被巡检频繁触发, 不让它每次多打一个 Bag RPC。
 * 灌桶/喂食成功后会调 invalidateCanBucketCache() 立即失效。
 */
let _canBucketCache = { at: 0, normalSec: null, organicSec: null };
async function readCanBucketSecs(force = false) {
    const now = Date.now();
    if (!force && _canBucketCache.at > 0 && now - _canBucketCache.at < 60 * 1000) {
        return { normalSec: _canBucketCache.normalSec, organicSec: _canBucketCache.organicSec };
    }
    try {
        const wh = require('./warehouse');
        const farmReply = await wh.getBag();
        const items = wh.getBagItems(farmReply) || [];
        const norm = items.find(it => toNum(it.id) === CAN_BUCKET_NORMAL);
        const org = items.find(it => toNum(it.id) === CAN_BUCKET_ORGANIC);
        const out = {
            normalSec: norm ? Math.max(0, toNum(norm.count)) : 0,
            organicSec: org ? Math.max(0, toNum(org.count)) : 0,
        };
        _canBucketCache = { at: now, ...out };
        return out;
    } catch {
        return { normalSec: null, organicSec: null };
    }
}
function invalidateCanBucketCache() {
    _canBucketCache.at = 0;
}

// ⭐ 2026-11-19: 窝/棚是两个**不同实例**(窝 10001, 棚 10003, 见 GetRanchDetailReply 的
//   repeated RanchInfo)。所有动物接口(target#1)用的 host_gid 就是 ranch_inst_id。
//   以前写死 10001, 于是养殖棚动物(羊/牛…)时服务端回"动物不存在" —— 它在 10003 那个栏舍里。
//   这里缓存最近一次 GetRanchDetail 拿到的实例, 让 feedAnimal 等接口能选对栏舍。
let lastRanchInstIds = [];
// ⭐ 2026-11-22 修"喂棚的有机罐头喂到窝去了": 实例缓存必须带栏舍类型。
//   旧的 lastRanchInstIds 只是无类型 gid 数组, resolveRanchHostGid(0) 永远取
//   排序最小(窝 10001) —— 一键喂/全场喂罐头因此**只喂窝**, 棚根本没喂到。
let lastRanchInsts = [];

/** 记录最近一次详情里的栏舍实例(窝/棚, 带 husbandry_type: 1=窝 2=棚) */
function rememberRanchInstIds(view) {
    if (!view) return;
    const list = [];
    for (const g of (view.coops || [])) {
        const gid = toNum(g.ranchInstId);
        if (gid > 0) list.push({ gid, ht: 1 });
    }
    for (const g of (view.pens || [])) {
        const gid = toNum(g.ranchInstId);
        // pens 数组本身语义就是棚(toRanchView 只把 husbandryType===2 的放进来);
        // 条目没带字段时按 2 兜底, 别把棚实例错标成窝
        if (gid > 0) list.push({ gid, ht: g.husbandryType ? (toNum(g.husbandryType) === 2 ? 2 : 1) : 2 });
    }
    if (list.length) {
        const seen = new Set();
        lastRanchInsts = list.filter(x => (seen.has(x.gid) ? false : (seen.add(x.gid), true)));
        lastRanchInstIds = lastRanchInsts.map(x => x.gid);
    }
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
        // 按详情里的 husbandry_type 精确挑(窝/棚实例号不写死, 以服务端为准)
        const hit = lastRanchInsts.find(x => x.ht === ht);
        if (hit) return hit.gid;
    }
    if (lastRanchInstIds.length) return lastRanchInstIds[0];
    return RANCH_SELF_HOST_GID;
}

/**
 * 全场喂罐头: 对**每个栏舍实例**(窝+棚)各发一次 FeedAnimal(target{1:gid}, 无 target#2)。
 * FeedAnimal 的"全场"语义 = 指定 host_gid 那个栏舍的全部动物 —— 官方客户端一次只喂一个栏舍,
 * 所以喂全场必须逐栏舍发。旧的只发 lastRanchInstIds[0](窝), 有机罐头全喂到窝(2026-11-22 用户报障)。
 * 桶 7003/7004 是全局的(农场背包), 窝/棚共扣同一个桶。
 * @returns {Promise<{fed:number, gids:number[], errors:string[]}>}
 */
async function feedAllFacilities(kind, _opts = {}) {
    const out = { fed: 0, gids: [], errors: [] };
    // 实例缓存为空时先拉一次总览(rememberRanchInstIds 在 overview 内部会被调用)
    if (!lastRanchInsts.length) {
        try { await getRanchOverview(); } catch { /* 拿不到就按旧默认实例喂 */ }
    }
    const gids = lastRanchInsts.length ? lastRanchInsts.map(x => x.gid) : [RANCH_SELF_HOST_GID];
    for (const gid of gids) {
        try {
            await feedAnimal(kind, gid);
            out.fed += 1;
            out.gids.push(gid);
        } catch (e) {
            // 某个栏舍没动物/桶空等 → 记下来继续喂下一个栏舍
            out.errors.push(`${gid}:${String(e.message || '').slice(0, 40)}`);
            if (!isExpectedRanchError(e)) {
                logWarn('牧场', `喂栏舍 ${gid} 失败: ${e.message}`, { module: '牧场', event: '喂食', result: 'error', gid });
            }
        }
        await sleep(300);
    }
    return out;
}

/**
 * 喂食/投喂罐头(AnimalService.FeedAnimal)。
 *
 * 请求结构(官方抓包 20261119-091627_罐头 逐字节核对):
 *   {1: {1: host_gid[, 2: animal_inst_id]}, 2: count}
 *     · 指定某只 → target#2 = 该动物的 animal_inst_id(AnimalInfo#3)
 *     · 全场批量 → **不写** target#2
 *     · count    = 投入的罐头数(1 或 2)
 *
 * @param {number} count        罐头数量
 * @param {number} hostGid      栏舍实例(默认按缓存的 ranch_inst_id)
 * @param {number} animalInstId 目标动物实例 ID; 0 = 全场
 */
/**
 * 喂食(AnimalService.FeedAnimal)。
 * ⭐ 2026-11-21 抓包定案(20261119-091627_罐头, 官方 4 帧):
 *   请求 {1:{1:host_gid, 2:animal_inst_id(可省略)}, 2:type}
 *   #2 **不是数量, 是喂食方式**: 1=有机罐头(服务端扣 7004) / 2=普通罐头(扣 7003)。
 *   target#2 缺省 = 全场所有动物(每只一条 receipt)。
 *   官方实证: {target:{1:10001,2:1216},2:2} → 回执 #11={7003,3596};
 *            {target:{1:10001,2:1216},2:1} → 回执 #11={7004,3593}。
 *   旧实现把"罐头个数"塞进 #2 → 点普通罐头也走有机路径扣 7004,
 *   有机桶一空就报 1045234, 普通桶灌得再多也没用。
 * @param kind 'normal' | 'organic' (或 4/5/6, 自动归类)
 */
async function feedAnimal(kind, hostGid = 0, animalInstId = 0) {
    const isNormal = kind === 'normal' || Number(kind) === FEED_TYPE.NORMAL_CAN;
    const serverType = isNormal ? 2 : 1;   // 服务端 #2: 2=普通(7003) / 1=有机(7004)
    const gid = resolveRanchHostGid(hostGid);
    const w = protobuf.Writer.create();
    const tw = w.uint32((1 << 3) | 2).fork();
    tw.uint32((1 << 3) | 0).int64(toLong(gid));
    if (toNum(animalInstId) > 0) tw.uint32((2 << 3) | 0).int64(toLong(animalInstId));
    tw.ldelim();
    w.uint32((2 << 3) | 0).int64(toLong(serverType));
    const body = w.finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'FeedAnimal', body);
    const _reply = types.FeedAnimalReply.decode(replyBody)
    invalidateRanchOverviewCache();
    invalidateCanBucketCache();   // 喂食扣桶, 让总览的桶余量显示立即刷新
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
async function harvestRanch(flag = 1, _hostGid = 0) {
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
 * @returns {Promise<{ok: boolean, gid: number, gains: Array<{itemId: number, name: string, count: number}>}>}
 *          gains = 偷到的物品明细(偷前/偷后产物架差值, ShelfStealDetail.item_id 是产物模板)
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
        // ⭐ 2026-11-21 抓包(20261117-162604)根因修复, 推翻旧判定:
        //   旧代码 gate = `can_steal===1 && remain_num>0`, 但真实协议里 ShelfInfo
        //   **根本不下发 can_steal 字段**(旧 proto 还把 #2 wire type 弄错导致整字段
        //   被 decode 跳过) → gate 永假 → 偷牧场一次都没成功过。
        //   官方客户端的判定就是看到架上有货(remain_num>0)直接发 StealProduce
        //   (抓包: remain 27/29/27, 无任何 can_steal 位, StealProduce 返回 err=0)。
        const ranches = detail.ranches || [];
        const shelves = ranches.flatMap(r => r.shelves || []);
        const hasStealable = shelves.some(s => toNum(s.remain_num) > 0);
        if (!hasStealable) return { ok: false, reason: 'nothing_to_steal', gid };
        // 偷前快照(按产物模板聚合): 用于偷后差值算"偷到了啥"
        const beforeRemain = new Map();
        for (const s of shelves) {
            const tpl = toNum(s.detail && s.detail.item_id);
            if (tpl) beforeRemain.set(tpl, (beforeRemain.get(tpl) || 0) + toNum(s.remain_num));
        }
        const stealBody = types.StealProduceRequest.encode(types.StealProduceRequest.create({
            host_gid: toLong(gid),
        })).finish();
        const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.AnimalService', 'StealProduce', stealBody);
        const afterRanches = types.StealProduceReply.decode(replyBody).ranches || [];
        // 偷到明细 = 偷前 remain - 偷后 remain, 按产物模板聚合
        const gainMap = new Map();
        for (const r of afterRanches) {
            for (const s of (r.shelves || [])) {
                const tpl = toNum(s.detail && s.detail.item_id);
                if (!tpl) continue;
                const got = (beforeRemain.get(tpl) || 0) - toNum(s.remain_num);
                if (got > 0) gainMap.set(tpl, (gainMap.get(tpl) || 0) + got);
            }
        }
        if (gainMap.size === 0) {
            // 兜底: 架上没有 detail(拿不到产物模板)时按总量差值报"产物"
            const beforeTotal = [...beforeRemain.values()].reduce((a, b) => a + b, 0);
            const afterTotal = afterRanches.flatMap(r => r.shelves || []).reduce((a, s) => a + toNum(s.remain_num), 0);
            if (beforeTotal - afterTotal > 0) gainMap.set(0, beforeTotal - afterTotal);
        }
        const getItemById = (() => { try { return require('../config/gameConfig').getItemById; } catch { return null; } })();
        const gains = [...gainMap.entries()].map(([tpl, n]) => {
            const info = tpl && getItemById ? getItemById(tpl) : null;
            return { itemId: tpl, name: (info && info.name) || (tpl ? `物品#${tpl}` : '产物'), count: n };
        });
        return { ok: gains.length > 0, gid, gains };
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
    // ⭐ 2026-11-23: 幼崽必须放进**对应栏舍** —— 60xxx=窝(小动物) 70xxx=棚(大动物),
    //   写死/默认窝会把棚幼崽发进窝(服务端 1045xxx 拒收)。
    //   线上实测(2026-11-23): 服务端 BuyGoods auto_add 也会自动挑对栏舍,
    //   但背包优先策略的 PlaceAnimal 是我们自己发的, 必须自己选对。
    let gid = toNum(hostGid);
    if (gid <= 0) {
        const cubId = toNum(cubItemId);
        const wantHt = cubId >= 70000 && cubId < 80000 ? 2 : 1;
        gid = resolveRanchHostGid(0, wantHt);
    }
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
// ⭐ 与农场 plantingStrategyOptions **逐项同构**(用户要求: 农场有的牧场都要有)
const RANCH_CUB_STRATEGY_LABELS = {
    max_level: '最高等级动物',
    max_exp: '最大经验/时',
    max_fert_exp: '最大普通肥经验/时',
    max_profit: '最大净利润/时',
    max_fert_profit: '最大普通肥净利润/时',
    bag_priority: '背包幼崽优先',
};

/** 第二优先策略的标签(不含 bag_priority —— 它没有"回退"语义) */
const RANCH_CUB_FALLBACK_LABELS = {
    max_level: '最高等级动物',
    max_exp: '最大经验/时',
    max_fert_exp: '最大普通肥经验/时',
    max_profit: '最大净利润/时',
    max_fert_profit: '最大普通肥净利润/时',
};

// ============ 背包幼崽排外 + 入栏顺序(对齐农场) ============
// 农场: plantSeedExclude(排外) + bagSeedPriority(顺序) + plantFromBagSeeds(按序种)
// 牧场: ranchCubExclude(排外) + ranchCubPriority(顺序) + autoPlaceCubs(按序入栏)
function getRanchCubExcludeSet() {
    try {
        const store = require('../models/store');
        if (typeof store.getRanchCubExclude === 'function') {
            return new Set((store.getRanchCubExclude(process.env.FARM_ACCOUNT_ID || '') || [])
                .map(Number).filter(n => n > 0));
        }
    } catch { /* 读不到就当没有排外 */ }
    return new Set();
}

/**
 * 按农场 plantFromBagSeeds 的规则给**背包幼崽**排入栏顺序:
 *   1) 用户在优先级列表里排过的按列表顺序
 *   2) 其余(列表里没有的)排在后面, 等级高的优先(农场用 plantSize/requiredLevel 做同类兜底)
 *   3) 排外的一律剔除
 *
 * 与农场唯一的形式差异: 农场作物有"2x2 占地"的合并约束, 牧场一只幼崽占一个栏位,
 * 所以兜底排序用"等级 + animalId", 落点与农场一致(等级高的先占位)。
 *
 * @param {Array<{id:number,count:number,name:string}>} bagCubs
 * @param {{priority?:number[], exclude?:number[]}} [opts]
 */
function sortBagCubsForPlacing(bagCubs, opts = {}) {
    let priority = Array.isArray(opts.priority) ? opts.priority : null;
    let exclude = Array.isArray(opts.exclude) ? opts.exclude : null;
    if (!priority || !exclude) {
        try {
            const store = require('../models/store');
            const accountId = process.env.FARM_ACCOUNT_ID || '';
            if (!priority && typeof store.getRanchCubPriority === 'function') {
                priority = store.getRanchCubPriority(accountId) || [];
            }
            if (!exclude && typeof store.getRanchCubExclude === 'function') {
                exclude = store.getRanchCubExclude(accountId) || [];
            }
        } catch { /* 读不到就用默认 */ }
    }
    const ex = new Set((exclude || []).map(Number).filter(n => n > 0));
    const indexMap = new Map();
    (priority || []).forEach((id, i) => {
        const n = Number(id);
        if (n > 0) indexMap.set(n, i);
    });
    const getItemById = (() => {
        try { return require('../config/gameConfig').getItemById; } catch { return null; }
    })();
    const levelOf = (id) => {
        const info = getItemById ? getItemById(Number(id)) : null;
        return Number(info && info.level) || 0;
    };

    return [...(Array.isArray(bagCubs) ? bagCubs : [])]
        .filter(c => !ex.has(Number(c.id)))
        .sort((a, b) => {
            const ai = indexMap.has(a.id) ? indexMap.get(a.id) : Number.MAX_SAFE_INTEGER;
            const bi = indexMap.has(b.id) ? indexMap.get(b.id) : Number.MAX_SAFE_INTEGER;
            if (ai !== bi) return ai - bi;
            const al = levelOf(a.id);
            const bl = levelOf(b.id);
            if (al !== bl) return bl - al;
            return Number(a.id) - Number(b.id);
        });
}

/**
 * 按"主策略 + 第二策略"给**商店候选**幼崽排序。
 *
 * ⚠ 2026-11-19 对齐农场重做:
 *   农场 bag_priority 的语义是"**背包里有什么就用什么**, 按用户拖拽的顺序,
 *   排外的跳过; 背包用完了, 剩下的空地才按第二优先策略去商店买"
 *   (farm.js plantFromBagSeeds → fallbackAllowed → plantFromShop)。
 *   牧场之前把这条做成了"拿商店幼崽列表当优先级直接买", 是错的 ——
 *   用户设的优先级是**背包顺序**, 不是购买顺序。
 *
 * 因此这里的 bag_priority 分支只负责"没有背包幼崽可用时, 用第二策略挑买哪只":
 *   · 背包幼崽的取用/入栏顺序在 sortBagCubsForPlacing() 里, 与农场同构
 *   · 排外列表 ranchCubExclude 在两侧都生效(不买、也不入栏)
 *
 * @param {Array<object>} cubs 已过滤过(解锁/有价/收益比>0)的候选
 * @param {object} [opts] strategy / priority / fallback / exclude(测试或手动覆盖)
 * @returns {Array<object>} 排序后的候选
 */
function applyCubStrategy(cubs, opts = {}) {
    let strategy = String(opts.strategy || '').trim();
    let priority = Array.isArray(opts.priority) ? opts.priority : null;
    let fallback = String(opts.fallback || '').trim();
    const exclude = Array.isArray(opts.exclude) ? opts.exclude : null;

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

    // 各策略的排序函数(与农场四项指标同构; 数值大的优先)
    //   没有对应指标的幼崽一律排到最后(null 不参与比较)
    // ⭐ 指标缺失时的兜底: 统一退回"收益比"排序。
    //
    // 线上问题(2026-11-19): 策略选 max_profit, 预览显示 Lv3 兔子, 实际却买了鸡。
    // 根因是**所有幼崽的净利/时都是 null**(周期样本还没采集到),
    // 两边对"全 null"的处理不同:
    //   · 预览(前端 → /api/ranch/analytics?sort=profit) 走 getCubRankings,
    //     全 null 时保持输入顺序, 而输入是按收益比排过的 → 选收益比最高的
    //   · 购买(applyCubStrategy) 全 null 时返回 0(视为相等), 保持原始顺序,
    //     而原始顺序是商城返回顺序 → 可能选中鸡
    // 现在统一: 主指标全缺时按收益比挑, 与预览一致, 也不会选到"什么都算不上"的。
    const bigger = (get, fallback) => (a, b) => {
        const av = get(a); const bv = get(b);
        if (av === null && bv === null) {
            return fallback ? fallback(a, b) : 0;
        }
        if (av === null) return 1;
        if (bv === null) return -1;
        return bv - av;
    };
    // 收益比: 候选对象里字段名是 valueRatio(getCubShop 产出) 或 ratio(analytics 产出),
    // 两个都要认 —— 只认 ratio 的话购买侧永远读到 undefined, 兜底等同于失效。
    const ratioOf = (x) => {
        const v = (x && x.valueRatio !== undefined) ? x.valueRatio : (x && x.ratio);
        return (v === undefined || v === null) ? null : Number(v);
    };
    const byRatio = (a, b) => (ratioOf(b) ?? 0) - (ratioOf(a) ?? 0) || (a.price ?? 0) - (b.price ?? 0);
    const byProfit = byRatio;                                // 收益比(整只回收 ÷ 成本)
    // 其余策略: 指标全缺时退回收益比, 保证"预览"和"实际购买"选同一只
    const byLevel = bigger(x => x.level ?? null, byRatio);
    const byExp = bigger(x => x.expPerHour ?? null, byRatio);
    const byFertExp = bigger(x => x.fertExpPerHour ?? null, byRatio);
    const byNetProfit = bigger(x => x.netProfitPerHour ?? null, byRatio);
    const byFertProfit = bigger(x => x.fertProfitPerHour ?? null, byRatio);
    const pickSorter = (key) => {
        switch (key) {
            case 'max_level': return byLevel;
            case 'max_exp': return byExp;
            case 'max_fert_exp': return byFertExp;
            case 'max_profit': return byNetProfit;
            case 'max_fert_profit': return byFertProfit;
            default: return byProfit;
        }
    };

    const list = [...cubs];

    // 排外: 与农场 plantSeedExclude 同语义 —— 不买、也不参与排序
    if (exclude && exclude.length) {
        const ex = new Set(exclude.map(Number).filter(n => n > 0));
        const kept = list.filter(c => !ex.has(Number(c.animalId)));
        kept.sort(pickSorter(strategy === 'bag_priority' ? fallback : strategy));
        return kept;
    }

    // 主策略是 bag_priority: 商店候选没有"背包顺序"可言,
    // 直接按第二策略挑(背包里确实有幼崽时, 根本不会走到买这一步)。
    if (strategy === 'bag_priority') {
        list.sort(pickSorter(fallback));
        return list;
    }
    list.sort(pickSorter(strategy));
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

    // ⭐ 2026-11-20 用户要求: **只有「背包优先」策略才自动把背包幼崽入栏**。
    //   其他策略(最大净利润/时等)下, 用户不选背包 → 不碰背包,
    //   由 autoBuyCubs 按商店策略买新幼崽。
    //   否则: 栏位有空, 背包里有 1 只, 却因为"应先入栏"卡住不买, 也不放(策略不是背包优先),
    //   陷入"入栏被拒 → 暂停买"的死循环刷屏。
    const strategyNow = (() => {
        try {
            const store = require('../models/store');
            return typeof store.getRanchCubStrategy === 'function'
                ? store.getRanchCubStrategy(process.env.FARM_ACCOUNT_ID || '')
                : 'max_profit';
        } catch { return 'max_profit'; }
    })();
    if (strategyNow !== 'bag_priority') {
        return result;
    }

    // 1. 找出背包里的幼崽(itemType=105)与它们的数量
    let bag;
    try {
        bag = await require('./warehouse').getRanchBagItems();
    } catch {
        return result;
    }
    const collected = [];
    let getItemById = null;
    try { getItemById = require('../config/gameConfig').getItemById; } catch { /* 没配置就跳过类型判断 */ }
    for (const it of bag) {
        const info = getItemById ? getItemById(toNum(it.id)) : null;
        if (info && Number(info.type) === 105 && toNum(it.count) > 0) {
            collected.push({ id: toNum(it.id), count: toNum(it.count), name: info.name || `#${it.id}` });
        }
    }
    if (!collected.length) return result;

    // ⭐ 对齐农场 plantFromBagSeeds: 排外的幼崽不入栏, 其余按用户设的优先级顺序放。
    //   之前这里用道具在背包里的顺序(cubs[i % cubs.length]), 用户的优先级顺序形同虚设。
    const excludeSet = getRanchCubExcludeSet();
    const cubs = sortBagCubsForPlacing(collected);
    if (!cubs.length) {
        // 背包里全是排外的: 与农场"背包种子均已排外"同处理, 一句话说明, 不刷屏
        const total = collected.reduce((n, c) => n + c.count, 0);
        if (shouldLogOnce('ranch_place_all_excluded', `excluded#${total}`)) {
            log('牧场', `背包里的 ${total} 只幼崽全部已排外, 跳过入栏`, {
                module: 'ranch', event: '幼崽入栏', result: 'skip', excluded: excludeSet.size,
            });
        }
        return result;
    }

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
        // 明确说明"没空位", 但**不要每轮都刷**(农场也是状态变化时才提示)。
        const cubTotal = cubs.reduce((n, c) => n + c.count, 0);
        if (shouldLogOnce('ranch_place_full', `${animals.length}/${capacity}#${cubTotal}`)) {
            log('牧场', `栏位已满(${animals.length}/${capacity}), 背包里 ${cubTotal} 只幼崽等待入栏(等收获腾位后自动放)`, {
                module: 'ranch', event: '幼崽入栏', result: 'skip', used: animals.length, capacity,
            });
        }
        return result;
    }

    const maxPerRound = Math.max(1, toNum(opts.maxPerRound) || 8);

    // 3. 按栏舍类型(窝/棚)分开入栏。
    // ⚠ 抓包定案: 请求里**没有 slot**, 服务端自己挑空位; placeAnimal 按 cub id
    //   自动选窝(60xxx)/棚(70xxx) —— 所以空位也必须**按窝/棚分开算**。
    // ⚠ 2026-11-25 线上死锁(84 只卡背包 36h): 旧代码只算总空位数 + 首个失败就 break,
    //   收获在棚腾出 1 空位时, 优先级第一的窝幼崽发进满的窝 → 1045205 → break,
    //   棚幼崽永远轮不到 → 空位一直空着 → "入栏被拒 → 暂停买幼崽"死循环刷屏。
    const countKindFree = (v) => {
        let coop = 0;
        let pen = 0;
        for (const g of (v && v.coops) || []) coop += Math.max(0, (toNum(g && g.capacity) || 0) - (toNum(g && g.animalCount) || 0));
        for (const g of (v && v.pens) || []) pen += Math.max(0, (toNum(g && g.capacity) || 0) - (toNum(g && g.animalCount) || 0));
        return { coop, pen };
    };
    const kindFree = countKindFree(view);
    let freeLeft = kindFree.coop + kindFree.pen;
    const cubLeft0 = cubs.reduce((n, c) => n + c.count, 0);
    // 按优先级逐种放: 每种放到"该栏舍空位用完 / 该种用完 / 本轮上限"为止
    for (const cub of cubs) {
        if (freeLeft <= 0 || result.placed >= maxPerRound) break;
        if (!cub || cub.count <= 0) continue;
        const isPen = toNum(cub.id) >= 70000 && toNum(cub.id) < 80000;
        while (cub.count > 0 && result.placed < maxPerRound && (isPen ? kindFree.pen : kindFree.coop) > 0) {
            try {
                await placeAnimal(cub.id);
                result.placed += 1;
                result.details.push(`${cub.name}`);
                cub.count -= 1;
                freeLeft -= 1;
                if (isPen) kindFree.pen -= 1; else kindFree.coop -= 1;
                await sleep(300);
            } catch (e) {
                const code = parseRanchErrorCode(e);
                // 1045205 = 服务端拒绝(栏满/动物状态不允许): 该栏舍类型本轮别再试,
                // **换下一种幼崽继续**(另一种栏舍可能有空位); 等收获腾位后下一轮自然成功。
                // ⚠ 2026-11-20 线上刷屏: 这条日志没走节流, 每轮巡查都打, 10 分钟刷几十条。
                //   同状态 30 分钟内只提示一次(状态变化时立刻提示)。
                if (code === 1045205) {
                    if (isPen) kindFree.pen = 0; else kindFree.coop = 0;
                    const cubLeft = cubs.reduce((n, c) => n + c.count, 0);
                    if (shouldLogOnce('ranch_place_reject', `${animals.length}/${capacity}#${cubLeft}#${isPen ? 'pen' : 'coop'}`)) {
                        log('牧场', `入栏被拒(${cub.name}→${isPen ? '棚' : '窝'}, 栏位满或动物状态不允许): 背包还有 ${cubLeft} 只未入栏`, {
                            module: 'ranch', event: '幼崽入栏', result: 'skip', code,
                        });
                    }
                } else if (!isExpectedRanchError(e)) {
                    logWarn('牧场', `幼崽入栏失败 ${cub.name}: ${e.message}`, {
                        module: 'ranch', event: '幼崽入栏', result: 'error', itemId: cub.id,
                    });
                }
                break; // 该种幼崽这轮到此为止, 换下一种
            }
        }
    }
    if (freeLeft > 0 && cubLeft0 > 0 && result.placed === 0) {
        // 有空位却一只没放出去: 空位栏舍类型与背包幼崽类型对不上(或全被服务端拒) —— 提示一次
        if (shouldLogOnce('ranch_place_kind_mismatch', `${kindFree.coop}/${kindFree.pen}#${cubLeft0}`)) {
            log('牧场', `栏位有空(窝${kindFree.coop}/棚${kindFree.pen})但没有匹配的背包幼崽可放, 背包 ${cubLeft0} 只继续等待`, {
                module: 'ranch', event: '幼崽入栏', result: 'skip',
            });
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

/**
 * 放蚊子(使坏好友牧场) —— RanchService.PutHazard
 *
 * ⭐ 2026-11-20 抓包(20261120-001457)定案, 推翻旧实现:
 *   请求 = {1: 栏舍实例(10001/10003), 2: 好友gid, 3: 11003, 4: 1}
 *   旧实现拼成 {1:{1:gid,2:slot}} —— 服务端会当成"给自己的 10001 放蚊子", 必然失败。
 *   响应 {1:ok, 2:今日剩余次数, 3/4: 物品}。
 *   ⚠ 每日上限: op 11003 = 100 次(GetRanchOpTimes)。
 *
 * @param {number} friendGid 好友 gid
 * @param {object} [opts] hostGid 栏舍实例(默认 10001 窝); count 次数(默认 1)
 * @returns {Promise<{ok:boolean, remaining:number|null}>}
 */
async function putHazard(friendGid, opts = {}) {
    const gid = toNum(friendGid);
    if (!gid) throw new Error('缺少好友 gid');
    const instId = toNum(opts.hostGid) || RANCH_SELF_HOST_GID;
    const count = Math.max(1, toNum(opts.count) || 1);
    const body = types.PutHazardRequest.encode(types.PutHazardRequest.create({
        ranch_inst_id: toLong(instId),
        friend_gid: toLong(gid),
        op_id: toLong(RANCH_OP_ID_HAZARD),
        count: toLong(count),
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.RanchService', 'PutHazard', body);
    const reply = types.PutHazardReply.decode(replyBody);
    return {
        ok: toNum(reply.ok) === 1,
        remaining: reply.remaining === undefined ? null : toNum(reply.remaining),
    };
}

/**
 * 照顾(摸一摸)好友的动物 —— RanchService.StrokeAnimal
 *
 * ⭐ 2026-11-20 抓包定案:
 *   请求 = {1: 好友gid, 2:{1: 栏舍实例, 2: **animal_inst_id**}}
 *   注意与 PutHazard 相反: 这里外层 #1 是好友 gid, #2 才是栏舍/动物。
 *
 * ⚠ target#2 是 **animal_inst_id, 不是 slot_index**(2026-11-20 线上验证):
 *   抓包四帧全部对得上实例 ID, 与实际槽位无关:
 *     08914e105e → 94  = 该好友 窝 slot3 的 inst 94
 *     08914e1062 → 98  = 该好友 窝 slot6 的 inst 98
 *     08914e108802 → 264 = 窝 slot6 的 inst 264
 *     08914e10bf01 → 191 = 窝 slot6 的 inst 191
 *   传槽位号会一律返回 1045207「动物不存在」(线上实测刷了一整屏),
 *   与之前 FeedAnimal 踩的是同一个坑(commit 62f2fe9)。
 *
 * @param {number} friendGid 好友 gid
 * @param {object} [opts] hostGid 栏舍实例; animalInstId 动物实例 ID(必填)
 * @returns {Promise<{ok:boolean, ranches:Array}>}
 */
async function strokeAnimal(friendGid, opts = {}) {
    const gid = toNum(friendGid);
    if (!gid) throw new Error('缺少好友 gid');
    const instId = toNum(opts.animalInstId);
    if (!instId) throw new Error('需要指定动物实例 ID(animal_inst_id)');
    const hostGid = toNum(opts.hostGid) || RANCH_SELF_HOST_GID;
    const body = types.StrokeAnimalRequest.encode(types.StrokeAnimalRequest.create({
        friend_gid: toLong(gid),
        target: { host_gid: toLong(hostGid), slot: toLong(instId) },
    })).finish();
    const { body: replyBody } = await network.sendMsgAsync('gamepb.animalpb.RanchService', 'StrokeAnimal', body);
    const reply = types.StrokeAnimalReply.decode(replyBody);
    return { ok: true, ranches: reply.ranches || [] };
}

/** 用罐头桶加速(FeedAnimal) —— 与"喂食"同一接口, 语义是投喂罐头桶
 *  ⭐ #2 是喂食方式(2=普通罐头桶7003 / 1=有机罐头桶7004), 不是数量 */
async function useFeedBucket(slot, kind = 'organic', hostGid = 0) {
    // target#2 是 animal_inst_id(不是 feed_type); 先按槽位查出该动物的实例 ID
    const instId = await resolveAnimalInstIdBySlot(slot, hostGid);
    return feedAnimal(kind, hostGid, instId);
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

// 动物 id → 名字: 以官方 MCAnimalConfig 为权威。
// ⚠ 2026-11-22 修正: 旧手写表整体错位(60005"乌龟"实际是火鸡, 60004"猫"实际是兔子,
//   60002"兔子"实际是鸭...), 导致面板动物名字+图片对不上(线上 1 号账号 5 只火鸡全显示"乌龟")。
const ANIMAL_NAMES = {};
try {
    for (const a of require('../gameConfig/MCAnimalConfig.json')) {
        if (a && a.id) ANIMAL_NAMES[Number(a.id)] = String(a.name || `动物${a.id}`);
    }
} catch { /* 配置缺失时退回旧静态表(不应该发生, MCAnimalConfig 随仓库发布) */ }
if (!Object.keys(ANIMAL_NAMES).length) {
    Object.assign(ANIMAL_NAMES, {
        60001: '鸡', 60002: '鸭', 60003: '鹅', 60004: '兔子', 60005: '火鸡',
        60006: '天竺鼠', 60007: '乌龟', 60008: '松鼠', 60009: '刺猬', 60010: '鼹鼠',
        60011: '考拉', 60012: '狐狸', 60013: '豪猪', 60014: '龙猫', 60015: '孔雀', 60016: '貂',
        70001: '羊', 70002: '牛', 70003: '驴', 70004: '迷你猪', 70005: '马',
        70006: '水牛', 70007: '骆驼', 70008: '牦牛', 70009: '鸵鸟', 70010: '梅花鹿',
        70011: '浣熊', 70012: '羊驼',
    });
}
// 整只 ID → 名字。命名规则: 幼崽 60xxx → 整只 206xxxx(窝) / 207xxxx(棚), 偏移 1000000。
// (蛋/崽 106xxxx/107xxxx 不在这里 —— 官方 ItemInfo 已有准确名字(鸡蛋/羊毛/牛奶...),
//  getAnimalName 查不到时会走 ItemInfo 兜底)
for (const [id, name] of Object.entries(ANIMAL_NAMES)) {
    const n = Number(id);
    if (n < 60000 || n > 79999) continue;
    const isPen = n >= 70001;                       // 棚动物
    const base = n - (isPen ? 70000 : 60000);
    const grownId = (isPen ? 2070000 : 2060000) + base;     // 整只
    ANIMAL_NAMES[grownId] = `整${  name}`;
}
ANIMAL_NAMES[1102] = '牧场经验';

/**
 * 动物图标 URL: animalId(60xxx 幼崽) / 产物整只(206xxxx) 都能查到
 * (seed_images_named 里的动物图标 2026-11-22 实抽入库)。
 * 取不到返回 '', 前端回退到 emoji。
 */
function getAnimalImage(animalId) {
    const { getItemImageById } = require('../config/gameConfig');
    return getItemImageById(animalId) || '';
}

const getItemImageByIdOf = getAnimalImage;   // 道具图标同一条查找链(名字不同语义而已)

function getAnimalName(animalId) {
    const id = toNum(animalId);
    if (ANIMAL_NAMES[id]) return ANIMAL_NAMES[id];
    // 蛋/崽/产物(106xxxx/107xxxx)等: 官方 ItemInfo 名字兜底(鸡蛋/羊毛/牛奶...)
    try {
        const info = require('../config/gameConfig').getItemById(id);
        if (info && info.name) return String(info.name);
    } catch { /* 无配置就用编号 */ }
    return `动物#${id}`;
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
    // ⭐ 每次拿到详情就喂一次"周期学习": 服务端同一帧里给了
    //   infant/grow/mature_ready_at_ms 三个绝对时刻, 差值就是各阶段时长。
    //   ranch-analytics 用这些样本算"经验/时、净利润/时"(与农场四个指标同构)。
    try {
        const seen = [];
        for (const r of ranches) for (const a of (r.animals || [])) seen.push(a);
        require('./ranch-analytics').recordAnimalCycleSamples(seen);
        // 同时记住每只动物的"收获经验"(#21) 与"收获所得"(#22)
        const an = require('./ranch-analytics');
        for (const a of seen) {
            rememberHarvestExp(a.animal_id, a.expected_harvest_exp);
            const sells = a.expected_harvest_sells;
            if (sells && sells[0]) an.rememberSellValue(a.animal_id, sells[0].item_id, sells[0].amount);
        }
    } catch { /* 分析是旁路, 不影响视图 */ }
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
                // 服务端给的真实动物实例 ID(不是槽位); 喂食/催产等按它定位
                animalInstId: toNum(a.animal_inst_id),
                animalId,
                name: getAnimalName(animalId),
                image: getAnimalImage(animalId),
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
                // 当前阶段的总时长(秒) —— 面板画进度条要分母。
                // 来源: 官方 MCAnimalConfig 的 infant_sec / grow_sec / mature_sec;
                // 生产期用 product_round_sec。取不到给 null(前端不画进度条, 不编造)。
                stageTotalSec: (() => {
                    try {
                        const cfg = require('../config/gameConfig').getAnimalConfig(animalId);
                        if (!cfg) return null;
                        const pick = stage === 1 ? cfg.infant_sec
                            : stage === 2 ? cfg.grow_sec
                                : stage === 3 ? (cfg.product_round_sec || cfg.mature_sec)
                                    : (stage === 4 || stage === 5) ? cfg.mature_sec
                                        : 0;
                        const v = Number(pick) || 0;
                        return v > 0 ? v : null;
                    } catch { return null; }
                })(),
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
    6001004: 'coop', 6001005: 'coop', 6001006: 'coop',
    6001007: 'coop', 6001008: 'coop', 6001009: 'coop',
    6002001: 'pen',  6002002: 'pen',  6002003: 'pen',
    6002004: 'pen',  6002005: 'pen',  6002006: 'pen',
    7001001: 'feed', 7001002: 'feed', 7001003: 'feed',
    7001004: 'feed', 7001005: 'feed', 7001006: 'feed',
    7001007: 'feed', 7001008: 'feed', 7001009: 'feed',
    11001001: 'decor',
};
function buildingKind(buildingId) {
    return BUILDING_KINDS[Number(buildingId)] || '';
}

/**
 * 建筑档位(小程序显示的"窝 Lv4/棚 Lv3")—— 与服务端 AllCells.buildings.level **无关**
 * (实测 acc1: AllCells 窝 level=6/棚=7, 小程序显示 窝Lv4/棚Lv3)。
 * 档位 = buildingId 查 MCFacilityConfig 升级链(该表在客户端是 'FSpk' 加密 TextAsset, 解不出明文),
 * 但升级链的档位规则已由线上锚点定案: **末位 = 档位**(窝/棚/牧草机同规则):
 *   窝: 6001001→Lv1 … 6001005→Lv5 (acc3 6001002=窝Lv2 ✓, acc1 6001004=窝Lv4 ✓, 抓包别家 6001005=窝Lv5 ✓)
 *   棚: 6002001→Lv1 … 6002003→Lv3 (2026-11-23 二次修正: 用户实看 棚6002003=Lv3 ✓;
 *       首版"棚跳级 6002002→3"是时间线错误 —— 用户看表时棚已完成 13:42 的第二次升级)
 *   牧草机: 7001001→Lv1 7001002→Lv2 7001003→Lv3 (官方文档实锤, 末位=档位; 7001004→Lv4 同规则外推)
 *   留言板: 11001001 → 无档位概念, 固定 Lv1
 * 表外 buildingId 退回 null(前端回退显示服务端内部 level 加 * 号)。
 */
const BUILDING_TIER = {
    coop: { 6001001: 1, 6001002: 2, 6001003: 3, 6001004: 4, 6001005: 5, 6001006: 6, 6001007: 7, 6001008: 8, 6001009: 9 },
    pen: { 6002001: 1, 6002002: 2, 6002003: 3, 6002004: 4, 6002005: 5, 6002006: 6, 6002007: 7, 6002008: 8, 6002009: 9 },
    feed: { 7001001: 1, 7001002: 2, 7001003: 3, 7001004: 4, 7001005: 5, 7001006: 6, 7001007: 7, 7001008: 8, 7001009: 9 },
};
function buildingTier(buildingId) {
    const kind = buildingKind(buildingId);
    return BUILDING_TIER[kind] ? (BUILDING_TIER[kind][Number(buildingId)] ?? null) : null;
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
                const slotName = slot === 10001 ? '窝' : (slot === 10002 ? '牧草机' : (slot === 10000 ? '留言板' : `#${slot}`));
                logWarn('牧场', `建筑${slotName} 查询失败: ${e.message}`, {
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

            // ⭐ 2026-11-20 抓包定案: #2=上限, #3=已用, #4=剩余
            view.opLimits = (opTimesReply && opTimesReply.limits || []).map(l => ({
                opId: toNum(l.op_id),
                limit: toNum(l.limit),
                used: toNum(l.used),
                remaining: l.remaining === undefined ? null : toNum(l.remaining),
            }));
            view.opTimes = {
                hazard: view.opLimits.find(x => x.opId === RANCH_OP_ID_HAZARD) || null,
                stroke: view.opLimits.find(x => x.opId === RANCH_OP_ID_STROKE) || null,
            };
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
                        f.tier = buildingTier(b.buildingId);   // 小程序显示档位(区别于 upgradeLevel 服务端内部值)
                    } else {
                        f.upgrading = false;
                    }
                }
                // ⭐ 真实建筑清单(棚不在固定槽位里, 只能从 AllCells 拿):
                //   ItemInfo: 3601001=牧场窝(target 6001001) / 3602001=牧场棚(6002001) / 3702001=喂食机(7001001)
                // tier = 小程序显示档位(buildingTier); level = 服务端内部值(与显示无关, 见 buildingTier 注释)
                view.buildings = all.buildings.map(b => ({
                    instId: b.instId,
                    buildingId: b.buildingId,
                    level: b.level,
                    tier: buildingTier(b.buildingId),
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
            // 罐头桶余量(60s 小缓存): 总览头部显示"普通/有机桶", 桶空是喂食失败最常见原因
            try { view.canBuckets = await readCanBucketSecs(); } catch { view.canBuckets = { normalSec: null, organicSec: null }; }
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
 * 按「罐头策略」自动喂罐头 —— 与农场施肥策略(automation.fertilizer)完全同构:
 *   配置 automation.ranch_can: 'none' / 'normal' / 'organic' / 'both' / 'smart'
 *   配置 automation.ranch_can_smart_seconds: 快成熟判定秒数(默认 300 = 5 分钟)
 * 策略语义(化肥 → 罐头):
 *   normal  = 仅普通罐头: 给没用过(limited_can_used=0)的动物逐只各喂一次
 *   organic = 仅有机罐头: 全场每轮各喂一次(有机不限次数)
 *   both    = 普通 + 有机(全场每轮)
 *   smart   = 普通 + 快成熟有机(成熟期剩余 ≤ smart_seconds 的动物逐只喂有机)
 *   none    = 不自动喂
 * 普通罐头 ↔ 普通化肥, 有机罐头 ↔ 有机化肥; 快成熟判定 ↔ getFastMatureLands。
 * 逐只喂的原因: 普通罐头每只动物限一次, 全场一枪打过去已喂过的动物会混进失败;
 * 且带 target#2=animal_inst_id 才能精确记账。
 * @returns {{fed: number, details: string[], strategy: string}}
 */
async function autoFeedCansByStrategy(view, opts = {}) {
    const out = { fed: 0, details: [], strategy: 'none' };
    let automation = {};
    try {
        automation = require('../models/store').getAutomation(process.env.FARM_ACCOUNT_ID || '') || {};
    } catch { /* 读不到按 none */ }
    const strategy = String(opts.feedStrategy || automation.ranch_can || 'none').trim();
    out.strategy = strategy;
    if (!strategy || strategy === 'none') return out;
    const animals = (view && Array.isArray(view.animals)) ? view.animals : [];
    if (!animals.length) return out;
    const smartSeconds = Math.max(30, toNum(opts.smartSeconds) || toNum(automation.ranch_can_smart_seconds) || 300);

    const gidFor = a => toNum(a.ranchInstId) || 0;
    const instFor = a => toNum(a.animalInstId) || 0;

    // 桶空 → 灌一个对应桶再重试一次; 还失败就算这只喂不了(罐头耗尽=正常态)
    const feedOneWithRefill = async (a, kind) => {
        try {
            await feedAnimal(kind, gidFor(a), instFor(a));
        } catch (e) {
            if (parseRanchErrorCode(e) !== RANCH_ERR.CANS_EMPTY) throw e;
            const filled = await fillCanBuckets(kind, { maxItems: 1 }).catch(() => ({ used: 0 }));
            if (!(filled.used > 0)) throw e;
            await feedAnimal(kind, gidFor(a), instFor(a));
        }
        await sleep(300);
    };

    const feedList = async (targets, kind, label) => {
        let n = 0;
        for (const a of targets) {
            try {
                await feedOneWithRefill(a, kind);
                n += 1;
            } catch (e) {
                const code = parseRanchErrorCode(e);
                // 预期内拒绝(1045202 限流/已喂过/1045207 动物不在)不刷屏; 其余记一条
                if (code !== RANCH_ERR.FEED_REJECTED && !isExpectedRanchError(e)) {
                    logWarn('牧场', `喂${label}失败(槽${toNum(a.slot)}): code=${code || '?'} ${String(e.message || '').slice(0, 60)}`, {
                        module: 'ranch', event: '喂罐头', result: 'error', kind, slot: toNum(a.slot),
                    });
                }
            }
        }
        if (n > 0) {
            out.details.push(`${label}x${n}`);
            out.fed += n;
            recordOperation('ranchFeed', n);
        }
        return n;
    };

    // 普通罐头: 只喂没用过的(每只动物限一次, limited_can_used 服务端权威位)
    if (strategy === 'normal' || strategy === 'both' || strategy === 'smart') {
        const targets = animals.filter(a => a.canFeed && !a.limitedCanUsed && instFor(a) > 0);
        await feedList(targets, 'normal', '普通罐头');
    }
    // 有机罐头: organic/both = 全场每轮各一次; smart = 只喂快成熟的(对齐农场快成熟施肥)
    if (strategy === 'organic' || strategy === 'both' || strategy === 'smart') {
        let targets;
        if (strategy === 'smart') {
            // 快成熟判定(对齐 getFastMatureLands 的 timeToMature ∈ [0, threshold]):
            // 成熟期(stage=4)剩余秒数 ∈ (0, threshold]; 已熟(stage=5)/生产期不喂(浪费)
            targets = animals.filter(a => a.canFeed && instFor(a) > 0
                && toNum(a.stage) === 4
                && a.matureInSec !== null && a.matureInSec > 0 && a.matureInSec <= smartSeconds);
        } else {
            targets = animals.filter(a => a.canFeed && instFor(a) > 0);
        }
        await feedList(targets, 'organic', '有机罐头');
    }
    return out;
}

/**
 * 自动购买罐头检查 —— 与农场化肥自动购买(checkAndBuyFertilizerBoth)完全同构:
 *   配置 automation.ranch_can_buy_normal / ranch_can_buy_organic (开关, 默认关)
 *   配置 automation.ranch_can_buy_{normal|organic}_count          (买几次, 默认 10)
 *   配置 automation.ranch_can_buy_{normal|organic}_threshold_hours (桶余量阈值, 默认 10h)
 * 判定 = 罐头桶(7003/7004)余量低于阈值小时数; 购买 = 牧场商城(slot6/7)按奖励
 * itemId 识别商品, 买完顺手灌进桶。options 可覆盖配置(设置页保存后立即检测用)。
 * @returns {{boughtNormal: number, boughtOrganic: number, normalHours: number|null, organicHours: number|null}}
 */
async function checkAndBuyCansIfLow(opts = {}) {
    let automation = {};
    try {
        automation = require('../models/store').getAutomation(process.env.FARM_ACCOUNT_ID || '') || {};
    } catch { /* 读不到按关 */ }
    const pick = (key, _dft) => (opts[key] !== undefined && opts[key] !== null) ? opts[key] : automation[key];
    const buyNormal = opts.buyNormal !== undefined ? !!opts.buyNormal : !!automation.ranch_can_buy_normal;
    const buyOrganic = opts.buyOrganic !== undefined ? !!opts.buyOrganic : !!automation.ranch_can_buy_organic;
    if (!buyNormal && !buyOrganic) return { boughtNormal: 0, boughtOrganic: 0 };
    const { checkAndBuyCansBoth } = require('./mall');
    return checkAndBuyCansBoth({
        buyNormal,
        buyOrganic,
        normalCount: Math.max(0, toNum(pick('ranch_can_buy_normal_count', 10)) || 0),
        normalThresholdHours: Math.max(0, toNum(pick('ranch_can_buy_normal_threshold_hours', 10)) || 0),
        organicCount: Math.max(0, toNum(pick('ranch_can_buy_organic_count', 10)) || 0),
        organicThresholdHours: Math.max(0, toNum(pick('ranch_can_buy_organic_threshold_hours', 10)) || 0),
    });
}

// 周期子操作的失败熔断表(2026-11-22 全系统防刷屏):
// 每个子操作连挂 3 次 → 暂停 30 分钟(熔断期内不发请求不打日志, 到点半开试探)。
// 单只动物/单只目标的细粒度 skip 由各操作自己的表(_strokeSkip 等)处理。
const RANCH_CARE_BREAKERS = {
    feedMachine: createFailureBreaker(),
    harvest: createFailureBreaker(),
    produce: createFailureBreaker(),
    feedManual: createFailureBreaker(),
    feedStrategy: createFailureBreaker(),
    sell: createFailureBreaker(),
    placeCubs: createFailureBreaker(),
    buyCubs: createFailureBreaker(),
    cleanOwn: createFailureBreaker(),
    stealFriends: createFailureBreaker(),
    strokeFriends: createFailureBreaker(),
    hazardFriends: createFailureBreaker(),
    upgradeBuildings: createFailureBreaker(),
    unlockRegions: createFailureBreaker(),
    unlockShed: createFailureBreaker(),
    rotationShop: createFailureBreaker(),
    ranchTasks: createFailureBreaker(),
    canBuy: createFailureBreaker(),
};

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
    // ⭐ 2026-11-22 性能: gap 只在"这一步真的发了请求"后才需要(节奏防突发)。
    //   步骤被开关/熔断/计划跳过时没发任何 RPC, 不会再有"下一步撞上来"的风险, 直接不睡。
    //   16 处无条件 gap 在全跳过轮 = 12.8s 纯睡眠/轮(20~25s 的周期里占一半以上)。
    const gapIf = (didWork) => (didWork ? sleep(STEP_GAP_MS) : Promise.resolve());

    // ⭐ 2026-11-22 性能: 到点路径(runRanchDueTick)已经拉过牧场总览并算出动作计划,
    //   巡检路径直接复用它的判定 —— 计划为空就不再盲打 collect×6/催产/收获
    //   (约 9 RPC/轮 × 每小时上百轮, 是全系统最大 RPC 消耗方)。
    //   view 由调用方传入(runRanchDueTick → checkRanchGroup); 手动/旧调用不传时
    //   duePlan=null, 保持旧行为(盲打), 兼容手动「一键巡牧场」。
    const duePlan = Array.isArray(opts.view && opts.view.animals)
        ? planRanchDueActions(opts.view)
        : null;   // null = 未传 view, 退化旧行为
    const planHas = (action) => Array.isArray(duePlan) && duePlan.includes(action);

    // 分组执行: 自动巡查按组各自调度(对照农场的 农场/帮助/偷菜 三套独立间隔),
    // 不再"一轮把 15 个步骤全跑一遍"。手动「一键巡牧场」不传 groups = 全组。
    const wantGroups = Array.isArray(opts.groups) && opts.groups.length
        ? new Set(opts.groups.map(String))
        : null;
    const want = (group) => !wantGroups || wantGroups.has(group);

    // 0. 自动使用牧场背包道具(与农场 automation.auto_use_items 同一个开关)
    //    罐头(80021~80034)灌进桶也在这里发生 —— 桶有时长才能喂。
    let ranAutoUse = false;
    if (want('feed') && opts.autoUseItems !== false && isAutomationOn('auto_use_items')) {
        ranAutoUse = true;
        try {
            const r = await autoUseRanchBagItems();
            if (r.used > 0) result.details.push(`用道具${r.used}`);
        } catch (e) {
            if (!isExpectedRanchError(e)) {
                logWarn('牧场', `自动使用道具失败: ${e.message}`, { module: 'ranch', event: '自动使用道具', result: 'error' });
            }
        }
    }

    await gapIf(ranAutoUse);

    // 0. 牧草机补草(任务"给牧草机添加牧草"也靠它驱动)
    //    不挂 duePlan 闸门: 牧草机余量只有查了才知道, 动物 grassBlocked 是滞后的信号
    let ranFeedMachine = false;
    if (want('feed') && opts.feedMachine !== false && isAutomationOn('ranch_feedmachine') && !RANCH_CARE_BREAKERS.feedMachine.isOpen()) {
        ranFeedMachine = true;
        try {
            const fm = await autoFeedMachine(opts);
            result.feedMachineAdded = fm.fed;
            // bought 也算"做了事": bought 走 auto_add 直进牧草机, fed 可能是 0
            if (fm.fed + (fm.bought || 0) > 0) result.details.push(`牧草机+${fm.fed + (fm.bought || 0)}`);
        } catch (e) {
            // 1045115 建筑不存在 = 牧场还没摆放牧草机, 每轮都报一遍只会刷屏
            if (!isExpectedRanchError(e)) {
                const st = RANCH_CARE_BREAKERS.feedMachine.failure();
                if (st === 'open') {
                    logWarn('牧场', `牧草机检查连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '牧草机加草', result: 'error' });
                } else if (!st) {
                    logWarn('牧场', `牧草机检查失败: ${e.message}`, { module: 'ranch', event: '牧草机加草', result: 'error' });
                }
            }
        }
    }
    await gapIf(ranFeedMachine);

    // 1. 收获(蛋/崽/整只; 任务"完成1次收获""收获鸡蛋N个""收获整鸡N次"靠它驱动)
    //    ⭐ 官方操作顺序: 收副产物(CollectProduce, 架上的蛋) → 催产 → 收获(HarvestRanch)
    //    只发 HarvestRanch 收不到架上的蛋(鹅 feed=3/#6≥1 就是蛋在架上)
    const wantHarvest = want('core') && isAutomationOn('ranch_harvest') && !RANCH_CARE_BREAKERS.harvest.isOpen()
        && (!Array.isArray(duePlan) || planHas('collect') || planHas('harvest'));
    if (wantHarvest) try {
        let collectRan = false;
        for (const s of [1, 2, 3, 4, 5, 6]) {
            try {
                await collectProduce(s);
                collectRan = true;
                await sleep(200);
            } catch { /* 槽空/未就绪, 静默 */ }
        }
        await triggerProduce(0).catch(() => null);
        await gapIf(collectRan);
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
            const st = RANCH_CARE_BREAKERS.harvest.failure();
            if (st === 'open') {
                logWarn('牧场', `收获连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '收获牧场', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `收获失败: ${e.message}`, { module: 'ranch', event: '收获牧场', result: 'error' });
            }
        }
        // expected 错误(没有可收的等正常状态)不计入熔断
        else RANCH_CARE_BREAKERS.harvest.success();
    }
    await gapIf(wantHarvest);

    // 2. 催产(空请求 = 全部槽位; 任务"生产N次"靠它驱动)
    let ranProduce = false;
    if (want('core') && isAutomationOn('ranch_produce') && !RANCH_CARE_BREAKERS.produce.isOpen()
        && (!Array.isArray(duePlan) || planHas('trigger'))) {
        ranProduce = true;
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
        if (parseRanchErrorCode(e) === RANCH_ERR.FEED_REJECTED) {
            result.rateLimited = true;
            log('牧场', '催产被服务端拒绝(code=1045202), 本轮巡牧场提前结束', {
                module: 'ranch', event: '催产', result: 'rejected',
            });
            return result;
        }
        if (!isExpectedRanchError(e)) {
            const st = RANCH_CARE_BREAKERS.produce.failure();
            if (st === 'open') {
                logWarn('牧场', `催产连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '催产', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `催产失败: ${e.message}`, { module: 'ranch', event: '催产', result: 'error' });
            }
        }
        else RANCH_CARE_BREAKERS.produce.success();
    }
    }
    await gapIf(ranProduce);

    // 3. 喂罐头 —— 两条路径:
    //   a) 手动"全场投喂"(显式传 feedCount): 一次全场 FeedAnimal, 保留旧行为
    //   b) 罐头策略(automation.ranch_can, 与农场施肥策略同构): core 组每轮巡查执行
    // ⚠ 20261117 抓包: 真实客户端全程没调 FeedAnimal —— 动物吃牧草机里的草是自动的,
    //   这个接口是"投喂罐头加速"用的(消耗罐头 80021+)。
    let ranFeedBlock = false;
    if (want('feed') && opts.feedCount && toNum(opts.feedCount) > 0 && !RANCH_CARE_BREAKERS.feedManual.isOpen()) {
        ranFeedBlock = true;
        try {
            // 自动巡牧场不做单只投喂(没必要), 只支持"全场投喂"
            // ⭐ #2 是喂食方式: 4=普通罐头→2 / 5,6=有机→1
            // ⭐ 2026-11-22 修: 全场 = 窝+棚逐栏舍各喂一次(旧的只喂窝, 棚没喂到)
            const feedKind = Number(opts.feedType) === FEED_TYPE.NORMAL_CAN ? 'normal' : 'organic';
            const fr = await feedAllFacilities(feedKind);
            result.fed += fr.fed;
            if (fr.errors.length) {
                log('牧场', `全场投喂部分栏舍未喂: ${fr.errors.join('；')}`, {
                    module: 'ranch', event: '喂食', result: 'partial', gids: fr.gids,
                });
            }
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
                const st = RANCH_CARE_BREAKERS.feedManual.failure();
            if (st === 'open') {
                logWarn('牧场', `喂食连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '喂食', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `喂食失败: ${e.message}`, { module: 'ranch', event: '喂食', result: 'error' });
            }
            }
        }
    }
    else if (want('core') && isAutomationOn('ranch_auto') && !RANCH_CARE_BREAKERS.feedStrategy.isOpen()) {
        ranFeedBlock = true;
        // 罐头策略: none 不喂 / normal 仅普通(每只一次) / organic 仅有机(每轮每只一次)
        // / both 普通+有机 / smart 普通+快成熟有机(≤ ranch_can_smart_seconds, 默认 300s)
        try {
            let feedView = null;
            try { feedView = await getRanchOverview(); } catch { feedView = null; }
            const fr = await autoFeedCansByStrategy(feedView, opts);
            result.fed = fr.fed;
            if (fr.fed > 0) {
                result.details.push(`喂罐头${fr.details.join('+')}`);
                log('牧场', `罐头策略(${fr.strategy}): ${fr.details.join('，')}`, {
                    module: 'ranch', event: '喂罐头', result: 'ok', count: fr.fed, strategy: fr.strategy,
                });
            }
        } catch (e) {
            // 1045202 = 服务端限流, 中止本轮(继续打只会更糟)
            if (parseRanchErrorCode(e) === RANCH_ERR.FEED_REJECTED) {
                result.rateLimited = true;
                log('牧场', '喂罐头被服务端拒绝(code=1045202), 本轮巡牧场提前结束', {
                    module: 'ranch', event: '喂罐头', result: 'rejected',
                });
                return result;
            }
            if (!isExpectedRanchError(e)) {
                const st = RANCH_CARE_BREAKERS.feedStrategy.failure();
                if (st === 'open') {
                    logWarn('牧场', `罐头策略喂食连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '喂罐头', result: 'error' });
                } else if (!st) {
                    logWarn('牧场', `罐头策略喂食失败: ${e.message}`, { module: 'ranch', event: '喂罐头', result: 'error' });
                }
            }
        }
    }

    await gapIf(ranFeedBlock);

    // 3b. 罐头自动购买已改为独立检测定时器(startCanBuyCheckTimer, 与农场化肥定时器同构),
    //     不再挂在巡查轮 —— 以前 core 组每 20~25 秒读一次背包算桶余量, 太频繁。

    // 4. 出售产物(任务"出售鸡蛋"靠它驱动; type=107 的蛋/崽)
    let ranSell = false;
    if (want('daily') && opts.sell !== false && isAutomationOn('ranch_sell') && !RANCH_CARE_BREAKERS.sell.isOpen()) {
        ranSell = true;
        try {
            const r = await autoSellRanchProducts(opts);
            result.sold = r.sold;
            result.earned = r.earned;
            if (r.sold > 0) result.details.push(`卖出${r.sold}→金券${r.earned}`);
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.sell.failure();
            if (st === 'open') {
                logWarn('牧场', `出售产物连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '出售产物', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `出售产物失败: ${e.message}`, { module: 'ranch', event: '出售产物', result: 'error' });
            }
        }
    }

    await gapIf(ranSell);

    // 5. 幼崽入栏(必须在买幼崽之前!)
    // ⚠ 线上事故(2026-11-18): BuyGoods 的 auto_add **不会**把幼崽放进栏舍,
    //   幼崽只是进了背包(itemType=105)。不补这一步, 槽位永远算作"空",
    //   于是每轮巡检都再买 4 只 → 实测背包里堆了 1242 只鸡。
    //   抓包证实: 客户端买完后会调 AnimalService.PlaceAnimal 入栏。
    let ranPlaceCubs = false;
    if (want('core') && opts.placeCubs !== false && !RANCH_CARE_BREAKERS.placeCubs.isOpen()) {
        ranPlaceCubs = true;
        try {
            const placed = await autoPlaceCubs(opts);
            result.cubsPlaced = placed.placed;
            if (placed.placed > 0) result.details.push(`入栏${placed.placed}只`);
        } catch (e) {
            if (!isExpectedRanchError(e)) {
                const st = RANCH_CARE_BREAKERS.placeCubs.failure();
                if (st === 'open') {
                    logWarn('牧场', `幼崽入栏连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '幼崽入栏', result: 'error' });
                } else if (!st) {
                    logWarn('牧场', `幼崽入栏失败: ${e.message}`, { module: 'ranch', event: '幼崽入栏', result: 'error' });
                }
            }
        }
    }

    await gapIf(ranPlaceCubs);

    // 6. 买幼崽(任务"领养鸡幼崽N个"靠它驱动; 按收益比优先)
    let ranBuyCubs = false;
    if (want('core') && opts.buyCubs !== false && isAutomationOn('ranch_buy_cubs') && !RANCH_CARE_BREAKERS.buyCubs.isOpen()) {
        ranBuyCubs = true;
        try {
            let careView = null;
            try { careView = await getRanchOverview(); } catch { careView = null; }
            const r = await autoBuyCubs({ ...opts, view: careView });
            result.boughtCubs = r.bought;
            if (r.bought > 0) result.details.push(`买${r.details.join('/')}`);
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.buyCubs.failure();
            if (st === 'open') {
                logWarn('牧场', `买幼崽连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '买幼崽', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `买幼崽失败: ${e.message}`, { module: 'ranch', event: '买幼崽', result: 'error' });
            }
        }
    }

    await gapIf(ranBuyCubs);

    // 5.5a 清理自己的牧场(20261117 抓包: CleanAllRanch 清自己, 产便便 → 游商货币)
    let ranCleanOwn = false;
    if (want('daily') && opts.cleanOwn !== false && isAutomationOn('ranch_clean') && !RANCH_CARE_BREAKERS.cleanOwn.isOpen()) {
        ranCleanOwn = true;
        try {
            const r = await autoCleanOwnRanch();
            result.cleanedFriends += r.cleaned;   // 沿用统计字段
            if (r.cleaned > 0) result.details.push('清理牧场');
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.cleanOwn.failure();
            if (st === 'open') {
                logWarn('牧场', `清理牧场连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '清理牧场', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `清理牧场失败: ${e.message}`, { module: 'ranch', event: '清理牧场', result: 'error' });
            }
        }
    }

    await gapIf(ranCleanOwn);

    // 5.5b 偷好友牧场产物(20261117 抓包: StealProduce{gid}, feed_state==4 才偷)
    let ranSteal = false;
    if (want('steal') && opts.stealFriends !== false && isAutomationOn('ranch_steal') && !RANCH_CARE_BREAKERS.stealFriends.isOpen()) {
        ranSteal = true;
        try {
            const r = await autoStealFriendProduce(opts);
            result.stolenFriends = r.cleaned;
            if (r.cleaned > 0) result.details.push(`偷${r.cleaned}家`);
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.stealFriends.failure();
            if (st === 'open') {
                logWarn('牧场', `偷好友产物连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '偷好友产物', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `偷好友产物失败: ${e.message}`, { module: 'ranch', event: '偷好友产物', result: 'error' });
            }
        }
    }

    await gapIf(ranSteal);

    // 5.5c 照顾好友动物(StrokeAnimal) —— 牧歌初启"累计照料好友动物 N 次"靠它
    //   抓包(20261120-001457)定案: {1:好友gid, 2:{1:栏舍实例,2:槽位}}; 每日上限 op 11009 = 10 次
    let ranStroke = false;
    if (want('steal') && opts.strokeFriends !== false && isAutomationOn('ranch_stroke') && !RANCH_CARE_BREAKERS.strokeFriends.isOpen()) {
        ranStroke = true;
        try {
            const r = await autoStrokeFriendAnimals(opts);
            result.strokedFriends = r.count;
            if (r.count > 0) result.details.push(`照顾${r.count}只`);
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.strokeFriends.failure();
            if (st === 'open') {
                logWarn('牧场', `照顾好友动物连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '照顾好友动物', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `照顾好友动物失败: ${e.message}`, { module: 'ranch', event: '照顾好友动物', result: 'error' });
            }
        }
    }

    await gapIf(ranStroke);

    // 5.5d 对好友使坏(PutHazard) —— 牧歌初启"累计使坏好友 N 次"靠它
    //   抓包定案: {1:栏舍实例, 2:好友gid, 3:11003, 4:1}; 每日上限 op 11003 = 100
    let ranHazard = false;
    if (want('steal') && opts.hazardFriends !== false && isAutomationOn('ranch_hazard') && !RANCH_CARE_BREAKERS.hazardFriends.isOpen()) {
        ranHazard = true;
        try {
            const r = await autoPutHazardOnFriends(opts);
            result.hazardedFriends = r.count;
            if (r.count > 0) result.details.push(`使坏${r.count}`);
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.hazardFriends.failure();
            if (st === 'open') {
                logWarn('牧场', `使坏好友连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '使坏好友', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `使坏好友失败: ${e.message}`, { module: 'ranch', event: '使坏好友', result: 'error' });
            }
        }
    }

    await gapIf(ranHazard);

    // 5.6 建筑升级 / 地块解锁(2026-11-17 官方文档)
    //   归属 daily 组: 与农场的"每日任务"同层 —— 建筑/地块是长周期操作,
    //   不该跟着 core 巡查每 20 秒打一遍。
    let facility;
    try {
        facility = require('./ranch-facility');
    } catch { facility = null; }

    // 5.6a 自动解锁棚(2026-11-22: ActivateFacility(10003) 抓包定案) —
    //   没解锁先解锁, 解锁后 AllCells.buildings 里就有棚, 下面 autoUpgradeBuildings 跟窝一样自动升级/竣工。
    let ranShed = false;
    if (want('daily') && facility && opts.unlockRegions !== false && isAutomationOn('ranch_unlock') && !RANCH_CARE_BREAKERS.unlockShed.isOpen()) {
        ranShed = true;
        try {
            const r = await facility.autoActivateShed();
            if (r.activated) result.details.push('棚已解锁');
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.unlockShed.failure();
            if (st === 'open') {
                logWarn('牧场', `棚解锁连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '棚解锁', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `棚解锁失败: ${e.message}`, { module: 'ranch', event: '棚解锁', result: 'error' });
            }
        }
    }
    if (ranShed) await gapIf(true);

    let ranUpgrade = false;
    if (want('daily') && facility && opts.upgradeBuildings !== false && isAutomationOn('ranch_upgrade') && !RANCH_CARE_BREAKERS.upgradeBuildings.isOpen()) {
        ranUpgrade = true;
        try {
            const r = await facility.autoUpgradeBuildings(opts);
            result.buildingsCompleted = r.completed;
            result.buildingsUpgraded = r.upgraded;
            if (r.completed > 0 || r.upgraded > 0) {
                result.details.push(`建筑竣工${r.completed}/升级${r.upgraded}`);
            }
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.upgradeBuildings.failure();
            if (st === 'open') {
                logWarn('牧场', `建筑升级连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '建筑升级', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `建筑升级失败: ${e.message}`, { module: 'ranch', event: '建筑升级', result: 'error' });
            }
        }
    }

    await gapIf(ranUpgrade);

    let ranUnlock = false;
    if (want('daily') && facility && opts.unlockRegions !== false && isAutomationOn('ranch_unlock') && !RANCH_CARE_BREAKERS.unlockRegions.isOpen()) {
        ranUnlock = true;
        try {
            const r = await facility.autoUnlockRegions(opts);
            result.regionsCompleted = r.completed;
            result.regionsUnlocked = r.unlocked;
            if (r.completed > 0 || r.unlocked > 0) {
                result.details.push(`地块竣工${r.completed}/发起${r.unlocked}`);
            }
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.unlockRegions.failure();
            if (st === 'open') {
                logWarn('牧场', `地块解锁连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '地块解锁', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `地块解锁失败: ${e.message}`, { module: 'ranch', event: '地块解锁', result: 'error' });
            }
        }
    }

    await gapIf(ranUnlock);

    // 6. 游商兑换(便便换有机化肥, 纯赚)
    let ranTail = false;
    if (want('daily') && opts.rotationShop !== false && isAutomationOn('ranch_rotation') && !RANCH_CARE_BREAKERS.rotationShop.isOpen()) {
        ranTail = true;
        try {
            const r = await autoBuyRotationShop(opts);
            result.rotationBought = r.bought;
            if (r.bought > 0) result.details.push(`游商x${r.bought}`);
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.rotationShop.failure();
            if (st === 'open') {
                logWarn('牧场', `游商兑换连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '游商购买', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `游商兑换失败: ${e.message}`, { module: 'ranch', event: '游商购买', result: 'error' });
            }
        }
    }

    // 7. 牧场任务领取
    // ⚠ 修正: 牧场任务与农场任务完全独立, 必须用 TaskInfo{scene_id:2} 拉列表
    //   (见 docs/mc-ranch/牧场任务系统功能文档.md); 之前调 checkAndClaimTasks()
    //   拉的是农场任务列表, 牧场任务从来没领过。
    if (want('daily') && isAutomationOn('ranch_task') && !RANCH_CARE_BREAKERS.ranchTasks.isOpen()) {   // 统一由开关决定(原来 checkRanch 传 claimTasks:false 导致永不执行)
        ranTail = true;
        try {
            const { checkAndClaimRanchTasks } = require('./task');
            const r = await checkAndClaimRanchTasks();
            result.ranchTasksClaimed = r.claimed;
            if (r.claimed > 0) result.details.push(`任务${r.claimed}`);
        } catch (e) {
            const st = RANCH_CARE_BREAKERS.ranchTasks.failure();
            if (st === 'open') {
                logWarn('牧场', `牧场任务领取连续失败, 暂停30分钟后重试: ${e.message}`, { module: 'ranch', event: '牧场任务', result: 'error' });
            } else if (!st) {
                logWarn('牧场', `牧场任务领取失败: ${e.message}`, { module: 'ranch', event: '牧场任务', result: 'error' });
            }
        }
    }

    await gapIf(ranTail);

    // 手册(图鉴)领奖: 之前只在手动 API 里有, 巡检从不调用 → "手册的领奖没加"
    // ⚠ 图鉴分两类(2026-11-20 抓包定案):
    //   普通页签 = 植物图鉴(#2=1), 牧场「巨大」页签 = 牧场动物图鉴(#2=101)
    //   claimIllustratedRewards 内部会两类都查一遍再领, 这里不用额外区分。
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

// 重复状态提示节流(见 utils/log-throttle.js): 同一静态条件的 skip 日志
// 只在状态变化或间隔到点时放行, 不再每轮巡查刷屏。
// 日志节流: 供测试验证"同一状态不重复刷屏"
const { shouldLogOnce, resetLogOnceState } = require('../utils/log-throttle');

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

// 兜底轮询间隔 5~8 分钟
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
            // ⭐ 没干成时退回整组巡检, 并把到点路径刚拉的总览传下去做闸门(性能优化)
            if (!r.ran) await checkRanchGroup('core', { view: r.view });
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


/**
 * 把 runRanchCare 一轮的产出统一记进"今日统计"(对照农场 recordOperation)。
 * 之前只记了 收/产/喂 3 项, 出售/买崽/入栏/清理/偷/照顾/使坏/游商/任务/
 * 手册/建筑/地块/牧草机全都没有统计, 首页今日统计里永远显示不出来。
 */
function recordRanchCareStats(result) {
    if (!result) return;
    if (result.sold > 0) recordOperation('ranchSell', result.sold);
    if (result.boughtCubs > 0) recordOperation('ranchBuyCubs', result.boughtCubs);
    if (result.cubsPlaced > 0) recordOperation('ranchPlace', result.cubsPlaced);
    if (result.cleanedFriends > 0) recordOperation('ranchClean', result.cleanedFriends);
    if (result.stolenFriends > 0) recordOperation('ranchSteal', result.stolenFriends);
    if (result.strokedFriends > 0) recordOperation('ranchStroke', result.strokedFriends);
    if (result.hazardedFriends > 0) recordOperation('ranchHazard', result.hazardedFriends);
    if (result.rotationBought > 0) recordOperation('ranchRotation', result.rotationBought);
    if (result.ranchTasksClaimed > 0) recordOperation('ranchTask', result.ranchTasksClaimed);
    if (result.illustratedClaimed > 0) recordOperation('ranchIllustrated', result.illustratedClaimed);
    if (result.buildingsCompleted > 0 || result.buildingsUpgraded > 0) {
        recordOperation('ranchBuilding', result.buildingsCompleted + result.buildingsUpgraded);
    }
    if (result.regionsCompleted > 0 || result.regionsUnlocked > 0) {
        recordOperation('ranchRegion', result.regionsCompleted + result.regionsUnlocked);
    }
    if (result.feedMachineAdded > 0) recordOperation('ranchGrass', result.feedMachineAdded);
}

/**
 * 执行某个分组的巡查(防重入 + 开关闸门 + 汇总日志 + 统计)。
 * @param {'core'|'daily'|'steal'} groupKey
 * @returns {Promise<boolean>} 本轮有没有实际干活
 */
async function checkRanchGroup(groupKey, opts = {}) {
    const g = RANCH_GROUPS[groupKey] || RANCH_GROUPS.core;
    const key = g.key;
    if (isCheckingRanchGroup[key]) return false;
    if (!isAutomationOn('ranch_auto')) return false;
    isCheckingRanchGroup[key] = true;
    isCheckingRanch = true;
    try {
        const result = await runRanchCare({ claimTasks: false, groups: [key], view: opts.view });
        if (result && result.skipped === 'scene_locked') return false;

        // 统计(对照农场 recordOperation)
        if (result.harvested > 0) recordOperation('ranchHarvest', result.harvested);
        if (result.produced > 0) recordOperation('ranchProduce', result.produced);
        if (result.fed > 0) recordOperation('ranchFeed', result.fed);
        recordRanchCareStats(result);

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
    if (animals.some(a => a.grassBlocked) && Date.now() >= _feedSkipUntil) actions.push('feed');
    return actions;
}

/**
 * 执行"到点动作"——只跑 planRanchDueActions 算出来的那几步,
 * 不碰入栏/买幼崽/游商/任务这些与倒计时无关的东西。
 * @returns {Promise<{actions:string[], harvested:number, produced:number, details:string[]}>}
 */
async function runRanchDueActions(view, opts = {}) {
    const out = { actions: [], harvested: 0, produced: 0, feedMachineAdded: 0, details: [] };
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
                // ⭐ feed 到点动作由 grassBlocked=true 触发 → force=true(2026-11-22 残草死锁修复):
                //   机器剩 1~19 根也必须补满, 否则 stored>0 跳过 + 冷却 → 动物永远饿着
                const fm = await autoFeedMachine({ ...opts, force: true });
                if (fm.fed + (fm.bought || 0) > 0) {
                    out.feedMachineAdded = fm.fed + (fm.bought || 0);
                    out.details.push(`牧草机+${fm.fed + (fm.bought || 0)}`);
                }
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
    // 内部调度细节不进日志: 每次建筑推送都打一行"收到推送, N 分钟后巡牧场"纯刷屏
    ranchScheduler.setTimeoutTask('ranch_push_check', RANCH_PUSH_THROTTLE_MS, async () => {
        if (!isCheckingRanch) await checkRanch();
    });
}

// ============ 罐头自动购买检测定时器(与农场化肥 fertilizerBuyCheckTimer 完全同构) ============
// 2026-11-21 对齐: 罐头购买原来挂在巡查轮(20~25 秒读一次桶, 太频繁)且不可配间隔;
// 化肥是独立 setInterval(默认 60 分钟, UI 可配)。现在两边同构: 独立定时器 + 可配间隔。
let canBuyCheckTimer = null;

async function checkCanBuyOnce() {
    if (RANCH_CARE_BREAKERS.canBuy.isOpen()) return;   // 连续失败熔断中: 静默跳过, 不发请求
    if (!isAutomationOn('ranch_can_buy_organic') && !isAutomationOn('ranch_can_buy_normal')) return;
    try {
        const br = await checkAndBuyCansIfLow();
        // ⚠ 字段名是 normalBought/organicBought(checkAndBuyCansBoth 的返回), 不是 boughtNormal
        if (br.normalBought > 0 || br.organicBought > 0) {
            const parts = [];
            if (br.normalBought > 0) parts.push(`普通罐头x${br.normalBought}`);
            if (br.organicBought > 0) parts.push(`有机罐头x${br.organicBought}`);
            log('牧场', `罐头桶余量低于阈值, 已自动购买 ${parts.join(' + ')}`, {
                module: 'ranch', event: '买罐头', result: 'ok',
                boughtNormal: br.normalBought, boughtOrganic: br.organicBought,
            });
        }
    } catch (e) {
        // 独立定时器的周期检测: 连挂 3 次 → 暂停30分钟
        const st = RANCH_CARE_BREAKERS.canBuy.failure();
        if (st !== 'extend') {
            const tip = st === 'open' ? '连续失败, 暂停30分钟后重试: ' : '';
            logWarn('牧场', `罐头自动购买检测${tip}失败: ${e.message}`, { module: 'ranch', event: '买罐头', result: 'error' });
        }
    }
}

// 记录当前定时器实际生效的间隔: restart 在每次配置快照下发时都会被调,
// 靠它判断"配置是否真的变了", 没变就静默跳过, 不刷"已启动"日志
let canBuyCheckIntervalMinutes = 0;

function startCanBuyCheckTimer() {
    if (!isAutomationOn('ranch_can_buy_organic') && !isAutomationOn('ranch_can_buy_normal')) return;
    let intervalMinutes = 10;
    try {
        const automation = require('../models/store').getAutomation(process.env.FARM_ACCOUNT_ID || '') || {};
        intervalMinutes = Math.max(1, Math.min(1440, toNum(automation.ranch_can_buy_check_interval_minutes) || 10));
    } catch { /* 读不到用默认 */ }
    const intervalMs = intervalMinutes * 60 * 1000;
    canBuyCheckTimer = setInterval(() => { checkCanBuyOnce(); }, intervalMs);
    canBuyCheckIntervalMinutes = intervalMinutes;
    log('牧场', `罐头自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
        module: 'ranch', event: '买罐头计时器', result: 'start', intervalMinutes,
    });
}

function stopCanBuyCheckTimer() {
    if (canBuyCheckTimer) {
        clearInterval(canBuyCheckTimer);
        canBuyCheckTimer = null;
        canBuyCheckIntervalMinutes = 0;
    }
}

/**
 * 保存设置后重启罐头购买定时器(与化肥 restartFertilizerBuyCheckTimer 同构):
 * 开关 关→开 / 改间隔后立即按新配置重挂, 不用等重启进程。
 *
 * 2026-11-24 加静默跳过: restart 在每次配置快照下发时都调, 旧实现无条件
 * stop+start, 设置没动也反复刷"已启动"日志。开关与间隔都没变时直接返回。
 */
function restartCanBuyCheckTimer() {
    const wantOn = isAutomationOn('ranch_can_buy_organic') || isAutomationOn('ranch_can_buy_normal');
    if (wantOn && canBuyCheckTimer
        && canBuyCheckIntervalMinutes === getCanBuyCheckIntervalMinutes()) {
        return;
    }
    stopCanBuyCheckTimer();
    startCanBuyCheckTimer();
}

function getCanBuyCheckIntervalMinutes() {
    try {
        const automation = require('../models/store').getAutomation(process.env.FARM_ACCOUNT_ID || '') || {};
        return Math.max(1, Math.min(1440, toNum(automation.ranch_can_buy_check_interval_minutes) || 10));
    } catch {
        return 10;
    }
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
    // 启动罐头自动购买检测定时器(与农场化肥定时器同构)
    startCanBuyCheckTimer();
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
    // 停止罐头自动购买检测定时器
    stopCanBuyCheckTimer();
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
    // 牧草断了也要尽快补(空跑冷却内不提前 —— grassBlocked 滞后, 存量>0 时反复提前没意义)
    if ((view.animals || []).some(a => a.grassBlocked) && Date.now() >= _feedSkipUntil) {
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
        if (!plan.length) {
            // ⭐ 把 view 带回给调用方: 整组巡检(checkRanchGroup→runRanchCare)复用它做闸门,
            //   计划为空时不再盲打 collect/催产/收获
            return { ran: false, actions: [], harvested: 0, produced: 0, details: [], view };
        }

        // 3. 只执行这几步
        const out = await runRanchDueActions(view, { plan });
        if (out.harvested > 0) recordOperation('ranchHarvest', out.harvested);
        if (out.produced > 0) recordOperation('ranchProduce', out.produced);
        if (out.feedMachineAdded > 0) recordOperation('ranchGrass', out.feedMachineAdded);
        // ⭐ 只在真干出实事时打日志: grassBlocked 是滞后信号, 常在牧草机还有草时触发
        //   feed 动作 → 查了存量>0 不补 → 此时 [到点] feed 没有任何信息量, 每 15s 刷一条
        //   (2026-11-22 用户定案: 空跑不打)。补了草/收了东西才打。
        const hasWork = out.harvested > 0 || out.produced > 0 || out.feedMachineAdded > 0 || out.details.length > 0;
        if (out.actions.length && hasWork) {
            const parts = [];
            if (out.harvested > 0) parts.push(`收:${out.harvested}`);
            if (out.produced > 0) parts.push(`产:${out.produced}`);
            if (out.feedMachineAdded > 0) parts.push(`草:${out.feedMachineAdded}`);
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
    const shop = parseRotationShopReply(replyBody);
    // 商品名字(ItemInfo 配置): 面板与日志显示名字, 不再显示 #80011 编号
    const nameOf = (() => { try { return require('../config/gameConfig').getItemById; } catch { return null; } })();
    for (const g of shop.goods) {
        const it = nameOf ? nameOf(g.itemId) : null;
        g.name = (it && it.name) || '';
        g.image = getAnimalImage(g.itemId);   // 道具图标同一查找链(化肥/便便等都有)
    }
    return shop;
}

/** 游商商品显示名(带兜底): 有机化肥(1小时) / 物品#80011 */
function rotationGoodsLabel(g) {
    return g.name || `物品#${g.itemId}`;
}

/**
 * 松果币/便便商品的折扣是否生效。
 * 抓包(20261120-232455): #7=折后价, #8=折扣开始秒, #9=折扣结束秒(0=无窗口);
 * 窗口外按原价。折扣优先买是用户明确要求。
 */
function isDiscountActive(g) {
    const from = Number(g.discountFrom) || 0;
    const to = Number(g.discountTo) || 0;
    if (!g.discountPrice || !(to > 0)) return false;
    const now = Date.now();
    if (from > 0 && now < from) return false;
    if (to > 0 && now > to) return false;
    return Number(g.discountPrice) < Number(g.price);
}

/** 商品实付价: 折扣生效用折后价, 否则原价 */
function effectiveRotationPrice(g) {
    return isDiscountActive(g) ? Number(g.discountPrice) : Number(g.price);
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
        let tag = 0; let shift = 0;
        while (true) {
            if (i >= buf.length) return out;
            const b = buf[i++];
            tag += (b & 0x7F) * 2 ** shift;
            shift += 7;
            if (!(b & 0x80)) break;
        }
        const field = tag >> 3; const wire = tag & 7;
        if (wire === 0) {
            let v = 0n; shift = 0n;
            while (true) {
                if (i >= buf.length) return out;
                const b = buf[i++];
                v += BigInt(b & 0x7F) * (2n ** shift);
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
                len += (b & 0x7F) * 2 ** shift;
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
    } catch {
        // 没有待清理内容 = 正常状态, 静默
        return { cleaned: 0, details: [] };
    }
}

/**
 * 好友牧场的 op 次数上限(使坏 11003 / 照顾 11009)。
 * 抓包: 进好友牧场后客户端先发 GetRanchOpTimes, 用它判断还能不能继续操作。
 * @returns {Promise<{hazard:number, stroke:number}>} 今日剩余次数(取不到返回 -1 = 未知)
 */
async function getFriendOpRemaining() {
    try {
        const reply = await getRanchOpTimes();
        const limits = (reply && reply.limits) || [];
        const pick = (opId, defaultLimit) => {
            const row = limits.find(l => toNum(l.op_id) === opId);
            if (!row) return defaultLimit;
            // 服务端给了 #4(剩余)就用; 否则用 上限 - 已用
            if (row.remaining !== undefined) return toNum(row.remaining);
            return Math.max(0, toNum(row.limit) - toNum(row.used));
        };
        return { hazard: pick(RANCH_OP_ID_HAZARD, 100), stroke: pick(RANCH_OP_ID_STROKE, 10) };
    } catch {
        return { hazard: -1, stroke: -1 };
    }
}

/** 进/出好友牧场的公共包装(EnterHomestead{1:gid,2:2} → ... → LeaveHomestead{1:gid}) */
async function withFriendHomestead(gid, fn) {
    const w = protobuf.Writer.create();
    w.uint32((1 << 3) | 0).int64(toLong(gid));
    w.uint32((2 << 3) | 0).int64(toLong(2));
    await network.sendMsgAsync('gamepb.visitpb.VisitService', 'EnterHomestead', w.finish());
    await sleep(300);
    try {
        return await fn();
    } finally {
        await sleep(300);
        const lw = protobuf.Writer.create();
        lw.uint32((1 << 3) | 0).int64(toLong(gid));
        await network.sendMsgAsync('gamepb.visitpb.VisitService', 'LeaveHomestead', lw.finish()).catch(() => {});
    }
}

/**
 * 从好友牧场详情里挑出可操作的动物。
 * ⚠ 必须带上 animal_inst_id(#3): StrokeAnimal 的 target#2 用的是它, 不是槽位号。
 */
function listFriendAnimals(ranches) {
    const out = [];
    for (const r of (ranches || [])) {
        const instId = toNum(r.ranch_inst_id);
        for (const a of (r.animals || [])) {
            const animalInstId = toNum(a.animal_inst_id);
            const slot = toNum(a.slot_index);
            if (!instId || !animalInstId) continue;
            out.push({ instId, animalInstId, slot, animalId: toNum(a.animal_id) });
        }
    }
    return out;
}

/**
 * 自动照顾好友的动物(StrokeAnimal) —— 牧歌初启"累计照料好友动物 5 次"靠它。
 *
 * 抓包(20261120-001457)实证的客户端节奏:
 *   EnterHomestead → GetRanchOpTimes(拿剩余) → GetRanchDetail → 逐只 StrokeAnimal → LeaveHomestead
 * 每日上限 op 11009 = 10 次, 所以一轮最多摸 10 只; 用满就停, 不再空跑。
 *
 * @returns {Promise<{count:number, details:string[], remaining:number}>}
 */
const _strokeToday = new Map();  // dateKey -> 次数(本地累计, 防重启后又跑满一轮)
/**
 * 已经照料过 / 不可照料的动物(按日期+好友+实例)。
 * 线上 2026-11-20 实测两个状态码, 都意味着**这一轮不必再试这只**:
 *   1045246 你已经照料过这只动物啦  (每只每天一次)
 *   1045244 已经巨大化的动物不能再照料啦
 * 记下来后本次进程内直接跳过, 避免每轮把同样的动物重试一遍刷屏。
 */
const _strokeSkip = new Map();   // `${dateKey}:${gid}:${animalInstId}` -> true
// 未知错误码的连续失败计数(单只动物粒度): 连挂 2 次 → 今日跳过
const _strokeFailCount = new Map();   // skipKey -> 连续失败次数
// ⭐ 好友级跳过(2026-11-22 性能): 这家"今天已无可照料"(全部动物已照料/巨大化)→ 跳到当天结束;
//   空牧场 → 跳 60 分钟(可能中途买崽)。没有它, 每轮对每个好友都 Enter+GetRanchDetail 白跑。
const _strokeFriendSkipUntil = new Map();   // gid -> 跳过截止时刻(ms)
async function autoStrokeFriendAnimals(opts = {}) {
    const result = { count: 0, details: [], remaining: -1 };
    const maxTotal = Math.max(1, toNum(opts.maxStrokePerRound) || 10);
    const todayKey = new Date().toDateString();
    const already = toNum(_strokeToday.get(todayKey)) || 0;
    const skipKey = (gid, inst) => `${todayKey}:${toNum(gid)}:${toNum(inst)}`;
    const dayEndMs = new Date().setHours(24, 0, 0, 0);

    const limits = await getFriendOpRemaining();
    result.remaining = limits.stroke;
    if (limits.stroke === 0) return result;       // 今天的 10 次已经用满
    let budget = limits.stroke > 0
        ? Math.min(maxTotal, limits.stroke)
        : Math.max(0, maxTotal - already);          // 拿不到剩余时按本地计数兜底
    if (budget <= 0) return result;

    const { getFriendsList } = require('./friend');
    const friends = await getFriendsList().catch(() => []);
    if (!Array.isArray(friends) || friends.length === 0) return result;

    const targets0 = friends.slice(0, 20);
    let visited = 0;
    for (let idx = 0; idx < targets0.length; idx++) {
        const f = targets0[idx];
        if (budget <= 0) break;
        const gid = toNum(f && f.gid);
        if (!gid) continue;
        if (Date.now() < (toNum(_strokeFriendSkipUntil.get(gid)) || 0)) continue;
        // ⭐ 好友之间的节奏间隔只在"真要进这家"时生效; 跳过零延迟, 最后一家后不再空睡
        if (visited > 0) await sleep(400);
        visited += 1;
        let visitTargets = null;
        try {
            await withFriendHomestead(gid, async () => {
                const detail = await getRanchDetail(gid);
                visitTargets = listFriendAnimals(detail.ranches);
                const targets = visitTargets;
                let attempted = 0;
                for (const t of targets) {
                    if (budget <= 0) break;
                    // 今天已经照料过 / 巨大化不可照料 → 本次进程内直接跳过, 不再发请求
                    if (_strokeSkip.has(skipKey(gid, t.animalInstId))) continue;
                    // ⭐ 节奏间隔只在真实尝试之间生效; 跳过零延迟
                    if (attempted > 0) await sleep(600);
                    attempted += 1;
                    try {
                        await strokeAnimal(gid, { hostGid: t.instId, animalInstId: t.animalInstId });
                        budget -= 1;
                        result.count += 1;
                        _strokeToday.set(todayKey, already + result.count);
                        _strokeSkip.set(skipKey(gid, t.animalInstId), true);
                        if (result.details.length < 6) result.details.push(f.name || String(gid));
                    } catch (e) {
                        // ⚠ "已照料过 / 巨大化" 是**正常状态**, 不是故障:
                        //   记下来跳过, 且**不消耗预算**(没真正照料成功)
                        const code = parseRanchErrorCode(e);
                        const sk = skipKey(gid, t.animalInstId);
                        if (code === RANCH_ERR.STROKE_ALREADY || code === RANCH_ERR.STROKE_MUTANT) {
                            _strokeSkip.set(sk, true);
                        } else if (!isExpectedRanchError(e)) {
                            // code 拼进正文: 日志 meta 的 code 字段会被脱敏遮掉,
                            // 正文里的 "code=10452xx" 不受影响(短错误 40 字会截掉它, 必须补)
                            logWarn('牧场', `照顾动物失败 ${f.name || gid}动物#${t.animalInstId}: ${shortErr(e)}${code ? ` (code=${code})` : ' (无code)'}`, {
                                module: 'ranch', event: '照顾好友动物', result: 'error', code,
                            });
                            budget -= 1;   // 真失败才消耗预算, 防止无限重试
                            const fails = (toNum(_strokeFailCount.get(sk)) || 0) + 1;
                            _strokeFailCount.set(sk, fails);
                            if (fails >= 2) {
                                _strokeSkip.set(sk, true);
                                _strokeFailCount.delete(sk);
                                logWarn('牧场', `动物#${t.animalInstId} 连续${fails}次照顾失败(code=${code}), 今日跳过`, {
                                    module: 'ranch', event: '照顾好友动物', result: 'skip', code,
                                });
                            }
                        } else {
                            _strokeSkip.set(sk, true);
                        }
                    }
                }
            });
            // 这家今天已无可照料(空牧场/全部动物都跳过) → 好友级跳过, 不再每轮 Enter 白跑
            if (visitTargets && visitTargets.length === 0) {
                _strokeFriendSkipUntil.set(gid, Date.now() + 60 * 60 * 1000);
            } else if (visitTargets && visitTargets.length
                && visitTargets.every(t => _strokeSkip.has(skipKey(gid, t.animalInstId)))) {
                _strokeFriendSkipUntil.set(gid, dayEndMs);
            }
        } catch { /* 这家进不去就换下家 */ }
    }
    if (result.count > 0) {
        log('牧场', `照顾好友动物 x${result.count}`, {
            module: 'ranch', event: '照顾好友动物', result: 'ok', count: result.count,
        });
    }
    return result;
}

/**
 * 自动对好友使坏(放蚊子 PutHazard) —— 牧歌初启"累计使坏好友 3 次"靠它。
 *
 * 每日上限 op 11003 = 100 次; 一轮默认只做很少几次(够任务用即可), 避免无谓骚扰。
 * 请求结构: {1: 栏舍实例, 2: 好友gid, 3: 11003, 4: 1}
 *
 * @returns {Promise<{count:number, details:string[], remaining:number}>}
 */
// ⭐ 好友级冷却(2026-11-22 性能): 全部栏舍都放满/空牧场 → 跳 60 分钟,
//   不再每轮 Enter+GetRanchDetail 白跑(蚊子会被好友清理, 所以是小时级不是当天)。
const _hazardFriendSkipUntil = new Map();   // gid -> 跳过截止时刻(ms)
async function autoPutHazardOnFriends(opts = {}) {
    const result = { count: 0, details: [], remaining: -1 };
    const maxTotal = Math.max(1, toNum(opts.maxHazardPerRound) || 3);
    const limits = await getFriendOpRemaining();
    result.remaining = limits.hazard;
    if (limits.hazard === 0) return result;
    const budget = limits.hazard > 0 ? Math.min(maxTotal, limits.hazard) : maxTotal;
    if (budget <= 0) return result;

    const { getFriendsList } = require('./friend');
    const friends = await getFriendsList().catch(() => []);
    if (!Array.isArray(friends) || friends.length === 0) return result;

    let left = budget;
    // ⚠ 2026-11-20 线上: code=1045230「这里的蚊子已经够多啦, 换一处试试吧」
    //   同一栏舍连放会被拒。所以每换一个栏舍(窝 10001 / 棚 10003)就换一处试,
    //   一处放不进去只放弃这一处, 不影响其它好友。
    let lastCode = 0;
    const targets1 = friends.slice(0, 20);
    let visited = 0;
    for (let idx = 0; idx < targets1.length; idx++) {
        const f = targets1[idx];
        if (left <= 0) break;
        const gid = toNum(f && f.gid);
        if (!gid) continue;
        if (Date.now() < (toNum(_hazardFriendSkipUntil.get(gid)) || 0)) continue;
        if (visited > 0) await sleep(400);   // 节奏间隔只在真进这家时生效; 最后一家后不再空睡
        visited += 1;
        let placedInVisit = 0;
        let triedRanches = 0;
        let fullRanches = 0;
        try {
            await withFriendHomestead(gid, async () => {
                const detail = await getRanchDetail(gid);
                const animals = listFriendAnimals(detail.ranches);
                if (animals.length === 0) return;
                // 按栏舍分组: 先窝后棚(与客户端抓包一致), 每处最多放 1~2 次就换处
                const instIds = [...new Set(animals.map(a => a.instId))];
                let placementGap = false;   // 本次进店是否已放过(决定下一次放之前要不要等节奏)
                for (const instId of instIds) {
                    if (left <= 0) break;
                    triedRanches += 1;
                    let placedHere = 0;
                    let thisRanchFull = false;
                    const perRanch = 2;   // 同一栏舍放 2 次就换, 避免 1045230
                    while (left > 0 && placedHere < perRanch) {
                        if (placementGap) await sleep(500);   // 只在连续放置之间等待
                        placementGap = true;
                        try {
                            const r = await putHazard(gid, { hostGid: instId, count: 1 });
                            left -= 1;
                            placedHere += 1;
                            placedInVisit += 1;
                            result.count += 1;
                            if (result.details.length < 6) result.details.push(f.name || String(gid));
                            if (r.remaining === 0) { left = 0; break; }
                        } catch (e) {
                            const code = parseRanchErrorCode(e);
                            lastCode = code;
                            // 1045230 = 这处放满了, 换下一处/下一位好友(不是故障)
                            if (code === RANCH_ERR.HAZARD_ENOUGH) thisRanchFull = true;
                            else if (!isExpectedRanchError(e)) {
                                logWarn('牧场', `使坏失败 ${f.name || gid}: ${shortErr(e)}`, {
                                    module: 'ranch', event: '使坏好友', result: 'error', code,
                                });
                            }
                            break;
                        }
                    }
                    if (placedHere === 0 && thisRanchFull) fullRanches += 1;
                }
            });
            // 空牧场 / 所有栏舍都满 → 60 分钟后再看
            const detailEmpty = placedInVisit === 0 && triedRanches === 0;
            if (detailEmpty || (placedInVisit === 0 && triedRanches > 0 && fullRanches === triedRanches)) {
                _hazardFriendSkipUntil.set(gid, Date.now() + 60 * 60 * 1000);
            }
        } catch { /* 进不去就换下家 */ }
    }
    if (result.count === 0 && lastCode === RANCH_ERR.HAZARD_ENOUGH) {
        log('牧场', '使坏: 好友牧场蚊子已满, 换一轮再试', {
            module: 'ranch', event: '使坏好友', result: 'skip', code: lastCode,
        });
    }
    if (result.count > 0) {
        log('牧场', `使坏好友 x${result.count}`, {
            module: 'ranch', event: '使坏好友', result: 'ok', count: result.count,
        });
    }
    return result;
}

/**
 * 自动偷好友牧场产物(AnimalService.StealProduce, 20261117 抓包)。
 * 流程: EnterHomestead{gid,2} → GetRanchDetail{gid,2:{}} → feed_state==4 才发 StealProduce{gid}。
 * 节流: 每个好友按冷却反复检查(内存记录; 偷过的产物有冷却, 服务端也有每日上限)。
 * @returns {{cleaned: number, details: string[]}} cleaned = 偷到的好友数; details = "好友名: 物品×数量"
 */
const _stealToday = new Map();   // gid -> 下次可偷的时刻(ms)
// 2026-11-22 用户定案: 偷取只显示成功(带偷到明细), 空手/失败一律静默。
// 「别拿啦，给我留点吧！」(1045221) 是正常业务态 → 归入空货短冷却, 不算失败。
async function autoStealFriendProduce(opts = {}) {
    const result = { cleaned: 0, details: [], checked: 0, skipped: 0, empty: 0, errors: 0 };
    const maxPerRound = Math.max(1, toNum(opts.maxStealPerRound) || 10);

    // ⭐ 2026-11-21 修复「自动偷从来没跑」:
    //   旧实现每个好友**每天只偷一次**(_stealToday 按 gid 记日期),
    //   当天早上一轮就把所有好友标记完 → 之后一整天一条日志都没有。
    //   实际上好友的产物架会持续产出(ShelfInfo.remain_num 会回升),
    //   应该按**冷却时间**反复检查, 而不是一天一次。
    //   现在: 成功偷到的记 cooldown(默认 30 分钟), 没得偷的记短 cooldown(10 分钟),
    //   避免每轮都去撞同一个没货的好友。
    const now = Date.now();
    const cooldownOk = Math.max(1, toNum(opts.stealCooldownMin) || 30) * 60 * 1000;
    const cooldownEmpty = Math.max(1, toNum(opts.stealEmptyCooldownMin) || 10) * 60 * 1000;

    const { getFriendsList } = require('./friend');
    const friends = await getFriendsList().catch(() => []);
    if (!Array.isArray(friends) || friends.length === 0) return result;

    const targets = friends.slice(0, 40);
    for (let idx = 0; idx < targets.length; idx++) {
        const f = targets[idx];
        if (result.cleaned >= maxPerRound) break;
        const gid = toNum(f && f.gid);
        if (!gid) continue;
        const nextAt = _stealToday.get(gid) || 0;
        if (now < nextAt) { result.skipped += 1; continue; }
        // ⭐ 节奏间隔只在"真要进这家"时生效; 冷却跳过零延迟, 最后一家之后不再空睡
        if (idx > 0) await sleep(800);
        result.checked += 1;
        try {
            const r = await stealFriendProduce(gid);
            if (r.ok) {
                result.cleaned += 1;
                // 成功要带"偷到了啥": gains 由偷前/偷后产物架差值算出
                const gainStr = (r.gains || []).map(g => `${g.name}×${g.count}`).join('、') || '(明细未知)';
                result.details.push(`${f.name || gid}: ${gainStr}`);
                _stealToday.set(gid, Date.now() + cooldownOk);
            } else {
                // nothing_to_steal: 稍后再看(产物架会回涨)
                result.empty += 1;
                _stealToday.set(gid, Date.now() + cooldownEmpty);
            }
        } catch (e) {
            // 业务态(别拿啦 1045221/场景态等) = 没得偷, 短冷却后再看;
            // 真失败只内部计数 + 退避, 不打日志(巡检只显示成功)
            if (isExpectedRanchError(e)) {
                result.empty += 1;
            } else {
                result.errors += 1;
            }
            _stealToday.set(gid, Date.now() + cooldownEmpty);
        }
    }
    if (result.cleaned > 0) {
        log('牧场', `偷好友产物 x${result.cleaned}: ${result.details.slice(0, 6).join('，')}`, {
            module: 'ranch', event: '偷好友产物', result: 'ok', count: result.cleaned,
        });
    }
    return result;
}

async function autoBuyRotationShop(_opts = {}) {
    const result = { bought: 0, details: [], reason: '' };
    const shop = await getRotationShop();
    if (!shop.open) {
        result.reason = '集市未营业';
        log('游商', '兑换集市未营业, 跳过', { module: 'ranch', event: '游商', result: 'skip' });
        return result;
    }
    // 计价货币: 便便(7002, 主) + 松果币(1008, 2026-11-20 用户要求加)
    // ⭐ 松果币商品**优先买折扣的**(抓包: #7=折后价, #8/#9=折扣时间窗;
    //    折扣窗口外的按原价, 仍可买但排后面)
    const poopGoods = shop.goods.filter(g => g.currencyId === 7002 && g.price > 0);
    const pineGoods = shop.goods.filter(g => g.currencyId === 1008 && g.price > 0)
        .map(g => ({
            ...g,
            // 实付价 = 折后价(在折扣窗口内)或原价
            effectivePrice: effectiveRotationPrice(g),
            discounted: isDiscountActive(g),
        }))
        .sort((a, b) => {
            // 折扣中的排前面; 同为折扣按单价低优先
            if (a.discounted !== b.discounted) return a.discounted ? -1 : 1;
            return a.effectivePrice - b.effectivePrice;
        });
    const targets = [...poopGoods, ...pineGoods];
    if (targets.length === 0) {
        result.reason = '游商没有可兑换的商品';
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

    // 余额: 便便(7002)在牧场背包; 松果币(1008)在农场背包(与金券同处)
    const { getRanchBagDetail } = require('./warehouse');
    const ranchBag = await getRanchBagDetail();
    const poopItem = ranchBag.items.find(it => Number(it.id) === 7002);
    let poopCount = poopItem ? Number(poopItem.count) : 0;

    let pineCount = 0;
    try {
        const wh = require('./warehouse');
        const farmItems = wh.getBagItems(await wh.getBag()) || [];
        const pine = farmItems.find(it => toNum(it.id) === 1008);
        pineCount = pine ? Math.max(0, toNum(pine.count)) : 0;
    } catch { pineCount = 0; }

    if (poopCount <= 0 && pineCount <= 0) {
        result.reason = '没有便便/松果币可兑换';
        log('游商', '没有便便/松果币可兑换', { module: 'ranch', event: '游商', result: 'skip' });
        return result;
    }

    for (const g of eligible) {
        const isPine = Number(g.currencyId) === 1008;
        // 松果币商品按折扣实付价; 便便商品按原价
        const unitPrice = isPine ? effectiveRotationPrice(g) : Number(g.price);
        const balance = isPine ? pineCount : poopCount;
        if (balance < unitPrice) continue;
        // 限购次数
        const maxByLimit = Number(g.limit) > 0 ? Number(g.limit) : 99;
        const affordable = Math.floor(balance / unitPrice);
        const count = Math.min(maxByLimit, affordable);
        if (count <= 0) continue;
        try {
            // ⚠ 20261117 抓包修正: 游商购买的真实接口是 RotationBuyGoods,
            //   请求 {1:uid, 2:数量, 3:刷新时间戳, 4:1} —— 不是 MallService.Purchase
            const r = await purchaseRotationGoods(g.uid, count, shop.refreshAt);
            if (r && (r.ok !== false)) {
                const spent = unitPrice * count;
                if (isPine) pineCount -= spent;
                else poopCount -= spent;
                result.bought += count;
                const priceNote = isPine
                    ? `松果币${spent}${g.discounted ? '(折扣价)' : ''}`
                    : `便便${spent}`;
                result.details.push(`${rotationGoodsLabel(g)}x${count}(${priceNote})`);
            }
        } catch (e) {
            // 1004012 等"当前买不了"(等级/限购/已过期)属正常业务状态, 不是故障:
            // 记 info 而不是 warn, 否则每轮刷一条 error 日志。
            // 同一商品同一状态 6 小时只提示一次(等级不足/限购是静态条件, 每轮都刷)。
            if (isRotationNotPurchasable(e)) {
                if (shouldLogOnce('ranch_vendor_skip', String(g.itemId), 6 * 60 * 60 * 1000)) {
                    log('游商', `${rotationGoodsLabel(g)} 当前不可购买(${rotationErrorHint(e)})，跳过`, {
                        module: 'ranch', event: '游商购买', result: 'skip', itemId: g.itemId,
                    });
                }
            } else {
                logWarn('游商', `购买失败 ${rotationGoodsLabel(g)}: ${e.message}`, {
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

// grassBlocked 空跑冷却: 查到存量>0 后这段时间不再因 grassBlocked 排 feed 动作
const FEED_SKIP_COOLDOWN_MS = 10 * 60 * 1000;
let _feedSkipUntil = 0;

/**
 * 牧草机补草(2026-11-22 用户定案: 检测到没草 → 一次性补满, 不再留 20 阈值)。
 *
 * 流程: 余量为 0(或 ≤threshold) → 算缺口 → 背包有多少补多少 → 还缺就买满 → AddFeed 补满。
 *
 * 2026-11-24 用户定案补草优先级: **农场种植的牧草优先** —
 *   1. 农场背包(getBag/ItemService.Bag)的 7001: 农场种牧草种子收的草在这里
 *      (线上实测: 牧场 GetBag scene=2 没有 7001, 农场 bag 才有)
 *   2. 牧场背包(getRanchBagDetail/scene=2)的 7001(若有)
 *   3. 买成品(shop6 goods10001, 60金券, auto_add 直进机, 受 ranch_buy_grass 控制)
 * ⚠ 旧实现只读牧场背包 — 农场种的牧草永远读不到, 只会一路买成品烧金券。
 *
 * ⚠ force 语义(2026-11-22 线上 bug 修复): 到点 feed 动作是由 animals.grassBlocked=true
 *   触发的 —— 此时哪怕机器里还剩 1~19 根残草, 动物也已经吃不到(blocked)了,
 *   旧逻辑 `stored > threshold → 跳过 + 10min 冷却` 造成**残草死锁**:
 *   每次 feed 到点都因 stored>0 空跑, 永远不补, 动物饿到天荒地老。
 *   所以 grassBlocked 触发的 feed 必须传 force=true, 无视残草直接补满。
 *
 * @returns {{fed:number, stored:number, bought:number, spent:number}}
 */
async function autoFeedMachine(opts = {}) {
    const threshold = Math.max(0, toNum(opts.threshold) || 0);   // 默认 0 = 耗尽才补
    const force = opts.force === true;                            // grassBlocked 触发: 动物已断粮, 残草也补满
    const machine = await getFeedMachine();
    if (!force && machine.stored > threshold) {
        // 草还没耗尽, 巡查轮直接跳过。
        // ⚠ 不再在这里设 _feedSkipUntil(2026-11-22 残草死锁修复): 这个冷却会挡住
        //   planRanchDueActions 的到点 feed 动作 —— grassBlocked=true + 残草>0 时
        //   巡查轮每轮跳过并续 10min 冷却, 到点动作永远被闸住, 动物饿死。
        return { fed: 0, stored: machine.stored, bought: 0, spent: 0 };
    }
    // 补满缺口: 容量未知时按 100 兜底(老账号实测容量 100)
    const capacity = machine.capacity > 0 ? machine.capacity : 100;
    const gap = Math.max(0, capacity - machine.stored);
    if (gap <= 0) return { fed: 0, stored: machine.stored, bought: 0, spent: 0 };

    // 背包里的散装牧草(先用掉, 不白花钱):
    // 2026-11-24 改为农场背包优先 → 牧场背包(见函数头注释)
    const { getRanchBagDetail, getBag, getBagItems } = require('./warehouse');
    let useFromBag = 0;
    let have = 0;
    let farmGrass = 0;
    try {
        // 1) 农场背包(农场种牧草收的草在这里)
        const farmBag = getBagItems(await getBag());
        const farmGrassItem = (farmBag || []).find(it => Number(it.id) === GRASS_ITEM_ID);
        farmGrass = farmGrassItem ? Number(farmGrassItem.count) : 0;
        useFromBag = Math.min(farmGrass, gap);
    } catch { /* 农场背包查不到就退回牧场背包 */ }
    let ranchGrass = 0;
    if (useFromBag < gap) {
        try {
            // 2) 牧场背包(scene=2)的 7001(通常为 0, 兜底)
            const bag = await getRanchBagDetail();
            const grass = bag.items.find(it => Number(it.id) === GRASS_ITEM_ID);
            ranchGrass = grass ? Number(grass.count) : 0;
            const take = Math.min(ranchGrass, gap - useFromBag);
            useFromBag += take;
        } catch { /* 背包查不到就全按买 */ }
    }
    have = farmGrass + ranchGrass;

    // 还缺的数量 → 买(买的时候限购/单价由 buyGrass 自己查)
    let bought = 0;
    let spent = 0;
    let buyFail = '';
    const stillGap = gap - useFromBag;
    if (stillGap > 0 && opts.buyGrass !== false && isAutomationOn('ranch_buy_grass')) {
        // 未显式指定 buyGrassCount → 直接买满缺口
        const wantCount = toNum(opts.buyGrassCount) > 0 ? Math.floor(toNum(opts.buyGrassCount)) : stillGap;
        const r = await buyGrass(Math.min(wantCount, stillGap)).catch(e => ({ ok: false, bought: 0, spent: 0, error: e && e.message }));
        if (r && r.ok) {
            bought = r.bought;
            spent = r.spent;
            // 买完 auto_add=1 已直接进牧草机 → 存量已含 bought, 不用再 AddFeed 这部分
        } else {
            buyFail = (r && r.error) || '未知原因';
        }
    }

    // 背包的散草 + auto_add 没吃进去的部分 → 一次 AddFeed 补上
    // auto_add 只把买的直接进机, 背包原有的散草仍要 AddFeed
    let fed = 0;
    let stored = machine.stored + bought;
    const addCount = useFromBag;
    if (addCount > 0) {
        const r = await addFeedToMachine(addCount).catch(() => null);
        if (r) { fed += addCount; stored = r.stored; }
    }
    if (fed + bought > 0) {
        const parts = [];
        if (bought > 0) parts.push(`买 ${bought}(花 ${spent})`);
        if (fed > 0) parts.push(`背包补 ${fed}${farmGrass > 0 ? `(农场种${Math.min(farmGrass, fed)})` : ''}`);
        log('牧场', `${force ? `动物断粮(残草 ${machine.stored})` : '牧草没了'} → 一次性补满: ${parts.join(' + ')}, 牧草机现在 ${stored}/${capacity}`, {
            module: 'ranch', event: '牧草机加草', result: 'ok',
            bought, spent, fed, stored, force, farmGrass, ranchGrass,
        });
    } else if (!bought && !fed) {
        // 一根都没补上: 有缺口但背包无草且购买失败/未开
        // ⭐ 冷却设在这里(2026-11-22 残草死锁修复): 只有"真没补上"才冷却 10 分钟,
        //   防止 grassBlocked 每 15s 触发的 feed 到点动作空跑刷屏;
        //   补满成功不设 —— 服务端 grass_blocked 清除有滞后, 短时间内可能再来一次。
        logWarn('牧场', `牧草机空了但没补上: 背包 ${have} 根${buyFail ? `, 购买失败: ${buyFail}` : '(自动购买未开启)'}`, {
            module: 'ranch', event: '牧草机加草', result: 'skip',
        });
        _feedSkipUntil = Date.now() + FEED_SKIP_COOLDOWN_MS;
    }
    return { fed, stored, bought, spent };
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
                    // 道具图标(牧草/罐头等, seed_images_named 按物品 id 命中)
                    image: getItemById ? (getItemImageByIdOf(itemId)) : '',
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

/** 幼崽商店的等级门槛: conds 里 type=1 的 param(农场侧 getAvailableSeeds 同款规则) */
function cubRequiredLevel(g) {
    let level = 0;
    for (const cond of (g && g.conds) || []) {
        if (toNum(cond.type) === 1) level = Math.max(level, toNum(cond.param));
    }
    return level;
}

/**
 * 玩家当前农场等级(幼崽商店的解锁条件就是它 —— MCGoods 里写的是"最低大农场等级:N")。
 * 取不到返回 0(表示"不知道", 此时不本地拦截, 交给服务端的 unlocked 判定)。
 */
function getPlayerLevel() {
    try {
        const { getUserState } = require('../utils/network');
        return Number((getUserState() || {}).level) || 0;
    } catch {
        return 0;
    }
}

/** 幼崽商店列表(带收益比) */
async function getCubShop() {
    const goods = await getShopGoodsList(CUB_SHOP_ID);
    // 统一用 ranch-analytics 的推导(从 ItemInfo 的成品动物价算),
    // 不再依赖下面这张手工维护的 GROWN_VALUE 表 —— 两者曾经对不上。
    let grownValueOf = null;
    try {
        grownValueOf = require('./ranch-analytics').getGrownValue;
    } catch { /* 拿不到就回退到静态表 */ }

    // ⚠ 2026-11-19: 解锁判定必须和农场一致 —— 用**玩家等级 vs 商品等级门槛**,
    //   不能只信服务端的 unlocked 位(实测低等级号也能看到 unlocked=true 的高等级幼崽)。
    const playerLevel = getPlayerLevel();

    return goods.map(g => {
        const animalId = toNum(g.item_id);
        const price = Math.max(1, toNum(g.price));
        const grown = grownValueOf ? grownValueOf(animalId) : (GROWN_VALUE[animalId] || 0);
        const requiredLevel = cubRequiredLevel(g);
        const serverUnlocked = !!g.unlocked;
        const levelLocked = playerLevel > 0 && requiredLevel > playerLevel;
        const { getItemImageById } = require('../config/gameConfig');
        return {
            goodsId: toNum(g.id),
            animalId,
            // 窝/棚归属(2026-11-22): 60xxx=窝(小动物) 70xxx=棚(大动物), 商店卡片徽章+筛选用
            housing: animalId >= 70000 ? '棚' : '窝',
            name: getAnimalName(animalId),
            // 幼崽图标(2026-11-22: 所有牧场展示动物的页面都带图)
            image: getItemImageById(animalId) || '',
            price: toNum(g.price),
            limit: toNum(g.limit_count),
            bought: toNum(g.bought_num),
            // 剩余可买: 0 = 已售罄; null = 不限购(前端按 99 封顶)
            remaining: toNum(g.limit_count) > 0
                ? Math.max(0, toNum(g.limit_count) - toNum(g.bought_num))
                : null,
            // 玩家等级不够 → 视为未解锁(与农场 getAvailableSeeds 的 locked 同语义)
            unlocked: serverUnlocked && !levelLocked,
            requiredLevel,
            levelLocked,
            playerLevel: playerLevel || null,
            currencyId: toNum(g.price_id) || 1007,
            // 整只回收价 + 收益比 + 单只净赚(前端排序/展示都用)
            grownValue: grown,
            valueRatio: grown > 0 ? grown / price : 0,
            profit: grown > 0 ? grown - toNum(g.price) : null,
            // ⭐ 与农场四项指标同构, 供幼崽策略直接按同一套口径排序
            ...buildCubPerHourMetrics(animalId, grown, price),
        };
    }).sort((a, b) => b.valueRatio - a.valueRatio);
}

/**
 * 幼崽的"每小时"四项指标 —— 与农场 analytics 的口径一一对应。
 *
 * ⚠ 口径已经收敛到 ranch-analytics.getAnimalMetrics 唯一一处实现:
 *   周期来自官方 MCAnimalConfig(28 种全覆盖), 收获经验来自服务端 AnimalInfo#21,
 *   抓包样本只在官方表缺该动物时兜底。
 *   之前这里自己用 expPerHourCache + 只有 worker 才有的 cycleTable 重算,
 *   于是 admin 进程(分析页)重启后四项全是 null。现在两个进程同一套数据。
 *
 * 公式:
 *   经验/时        = 收获经验 / 周期 * 3600
 *   普通肥经验/时  = 收获经验 / (周期 - 3600) * 3600
 *   净利润/时      = (整只回收 - 幼崽成本) / 周期 * 3600
 *   普通肥净利润/时= 同上, 分母换成 (周期 - 3600)
 */
function buildCubPerHourMetrics(animalId, grownValue, cost) {
    try {
        const m = require('./ranch-analytics').getAnimalMetrics(animalId, { cost, grownValue });
        return {
            cycleSec: m.cycleSec,
            cycleSource: m.cycleSource,
            cycleParts: m.cycleParts,
            productRoundSec: m.productRoundSec,
            maxProduceCount: m.maxProduceCount,
            harvestExp: m.harvestExp,
            expPerHour: m.expPerHour,
            fertExpPerHour: m.fertExpPerHour,
            netProfitPerHour: m.netProfitPerHour,
            fertProfitPerHour: m.fertProfitPerHour,
            level: m.level,
        };
    } catch {
        return {
            cycleSec: null, cycleSource: 'none', cycleParts: null,
            productRoundSec: null, maxProduceCount: null, harvestExp: 0,
            expPerHour: null, fertExpPerHour: null,
            netProfitPerHour: null, fertProfitPerHour: null, level: null,
        };
    }
}

/** 运行时记住的"每只动物的收获经验"(由 GetRanchDetail 样本喂进来) */
const expPerHourCache = new Map();

/** 记录某动物的 expected_harvest_exp(#21) —— 策略排序与排行都要用 */
function rememberHarvestExp(animalId, exp) {
    const id = toNum(animalId);
    const v = toNum(exp);
    if (id > 0 && v > 0) {
        expPerHourCache.set(id, { expectedHarvestExp: v });
        // 同步给分析模块(它会落盘, 重启后 admin 进程也能读到)
        try { require('./ranch-analytics').rememberHarvestExp(id, v); } catch { /* 旁路 */ }
    }
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
 * @param {number} [opts.maxSpend] 可选的金券上限(默认不限; 用户明确要求移除默认 5000 上限)
 * @param {number} [opts.slots] 空槽位数(默认从牧场详情算)
 * @returns {Promise<{bought:number, spent:number, details:string[]}>} 本次购买结果
 */
async function autoBuyCubs(opts = {}) {
    const result = { bought: 0, spent: 0, details: [] };
    // ⭐ 先算空槽(一次总览, 10s 缓存内基本是命中), 栏满就不必再查幼崽商店 ——
    //   栏满时商店查询每轮白打(2026-11-22 性能: ~160 次/小时的白跑 RPC)
    let slots = toNum(opts.slots) || 0;
    // ⭐ 2026-11-23 修"棚的动物不会自动购买": 空槽必须**按栏舍分开算** ——
    //   窝(60xxx 小动物)与棚(70xxx 大动物)不通用, 只算总数会拿窝的空槽去买棚动物
    //   (或反过来), 服务端拒收后棚一直空着。棚动物 ratio 与窝动物相同(2.0),
    //   排序后窝动物稳定在前 → 棚永远轮不到。
    let coopSlots = toNum(opts.coopSlots) || 0;
    let penSlots = toNum(opts.penSlots) || 0;
    if (slots <= 0 && coopSlots <= 0 && penSlots <= 0) {
        try {
            // ⚠ 必须用带兜底的 view(AllCells 补容量), 不能用裸 getRanchDetail:
            //   从没进过牧场的号 RanchInfo 是空的(coop/pen 全 0) → slots=0 → 永远不买幼崽。
            const view = opts.view || await getRanchOverview();
            const animals = view.animals || [];
            const countIn = ht => animals.filter(a => toNum(a.husbandryType) === ht).length;
            coopSlots = Math.max(0, toNum(view.coopCount) - countIn(1));
            penSlots = Math.max(0, toNum(view.penCount) - countIn(2));
            slots = coopSlots + penSlots;
        } catch { slots = 0; }
    } else if (slots > 0 && coopSlots <= 0 && penSlots <= 0) {
        // 兼容旧调用方(显式 slots, 不分栏舍): 全部按窝算(老行为)
        coopSlots = slots;
        penSlots = 0;
    }
    if (slots <= 0) {
        // 与"栏位已满"同因, 不重复刷屏(农场同样只提示一次)
        if (shouldLogOnce('ranch_buy_no_slot', `slots#${slots}`, 6 * 60 * 60 * 1000)) {
            log('牧场', '没有空槽位, 跳过买幼崽', { module: 'ranch', event: '买幼崽', result: 'skip' });
        }
        return result;
    }

    const shop = await getCubShop();
    let usable = shop.filter(g => g.unlocked && g.price > 0 && g.valueRatio > 0);
    if (usable.length === 0) {
        log('牧场', '幼崽商店没有可买的(未解锁或价格为 0)', { module: 'ranch', event: '买幼崽', result: 'skip' });
        return result;
    }

    // 按用户配置的策略挑幼崽(对照农场 plantingStrategy, 但牧场完全独立)
    // ⭐ 排外(ranchCubExclude) 与农场 plantSeedExclude 同语义: 不买、也不排序
    usable = applyCubStrategy(usable, { exclude: [...getRanchCubExcludeSet()] });
    if (usable.length === 0) {
        log('牧场', '按当前幼崽策略没有可选目标', { module: 'ranch', event: '买幼崽', result: 'skip' });
        return result;
    }

    // ⭐ 2026-11-20 用户要求: 移除单轮预算上限(默认 5000 金券)。
    //   空槽有几个就买几只(仍受单轮 4 只与限购约束); 只有显式传 maxSpend 时才限制。
    const maxSpend = toNum(opts.maxSpend) > 0 ? toNum(opts.maxSpend) : Infinity;
    // ⚠ 单轮购买上限: 线上事故(2026-11-18)里机器人每轮都买 4 只,
    //   因为 buyGoods 的 auto_add 没把幼崽放进栏舍, 幼崽堆在背包里(实测 1242 只鸡),
    //   下一轮 slots 仍然是 4 → 又买 4 只 → 无限购买。
    //   加硬上限: 每轮最多买 slots 只, 且不超过 MAX_CUBS_PER_ROUND。
    const MAX_CUBS_PER_ROUND = 4;
    const buyBudget = Math.min(slots, MAX_CUBS_PER_ROUND);
    // 分栏舍后: 每种栏舍的上限 = min(该栏舍空槽, MAX_CUBS_PER_ROUND)(总买量 ≤ 两种合计)

    // 背包里已有的幼崽: 与农场 plantFromBagSeeds 同语义 ——
    //   **背包里还有可用(未排外)幼崽, 就先别买**, 把它们放完再说;
    //   排外的幼崽不算 "可用", 等于用户明确表示不养这种。
    // ⚠ 2026-11-19 改正: 原来只统计"数量", 不看排外, 也不看用户设的 pet 优先级。
    let bagUsableCubs = 0;
    let bagTotalCubs = 0;
    try {
        const warehouse = require('./warehouse');
        const bag = await warehouse.getRanchBagItems();
        const excludeSet = getRanchCubExcludeSet();
        const getItemById = (() => {
            try { return require('../config/gameConfig').getItemById; } catch { return null; }
        })();
        for (const it of bag) {
            const id = toNum(it.id);
            const info = getItemById ? getItemById(id) : null;
            if (!(info && Number(info.type) === 105)) continue;
            bagTotalCubs += toNum(it.count);
            if (!excludeSet.has(id)) bagUsableCubs += toNum(it.count);
        }
    } catch { /* 读不到背包就不做这个保护, 交给上限兜底 */ }

    const strategyNow = (() => {
        try {
            const store = require('../models/store');
            return typeof store.getRanchCubStrategy === 'function'
                ? store.getRanchCubStrategy(process.env.FARM_ACCOUNT_ID || '')
                : 'max_profit';
        } catch { return 'max_profit'; }
    })();

    // ⭐ 2026-11-20 用户要求: **只有背包优先时才用背包**。
    //   其他策略(最大净利润/时等)下, 背包里堆着的幼崽不影响购买 ——
    //   按商店策略买新的, 背包里的留着用户自己处理(不自动入栏、不拦购买)。
    if (bagUsableCubs > 0 && strategyNow === 'bag_priority') {
        // ⚠ 2026-11-25 线上刷屏: 背包 84 只卡着时这条每 20~25s 打一条, 一小时上百条。
        //   同状态(数量变化才算变)30 分钟提示一次。
        if (shouldLogOnce('ranch_buy_bag_first', `${bagUsableCubs}`)) {
            log('牧场', `背包优先模式: 背包里已有 ${bagUsableCubs} 只可用幼崽未入栏, 暂停买幼崽(应先入栏)`,
                {
                    module: 'ranch', event: '买幼崽', result: 'skip',
                    bagCubs: bagUsableCubs, bagExcluded: bagTotalCubs - bagUsableCubs, strategy: strategyNow,
                });
        }
        return result;
    }
    // 剩下的全是排外的 → 不买(与农场"背包种子均已排外"同一处理)
    if (bagTotalCubs > 0 && bagUsableCubs === 0) {
        if (shouldLogOnce('ranch_buy_all_excluded', `excluded#${bagTotalCubs}`)) {
            log('牧场', `背包里的 ${bagTotalCubs} 只幼崽全部已排外, 不自动购买也不入栏`,
                { module: 'ranch', event: '买幼崽', result: 'skip', bagCubs: bagTotalCubs });
        }
        return result;
    }

    // ⭐ 2026-11-20 用户要求: **只买收益最高的那一种**, 空槽全填同一种。
    //   之前是"按策略排名依次各买几只直到填满空槽", 于是 max_profit 下会买
    //   鹅x1 + 兔子x2 + 鸡x1 —— 用户要的是"选崽策略只有一个答案"。
    //   现在: 取排序后的第一名; 只有它买不到(限购已满/钱不够)时才轮到第二名。
    // ⭐ 2026-11-23 修棚不买: **按栏舍各挑各的** —— 窝空槽买窝动物(60xxx),
    //   棚空槽买棚动物(70xxx)。棚动物 ratio 与窝动物并列 2.0, 混在一个列表里
    //   排序永远窝在前, 棚就永远空着(线上实锤 acc1 棚 0/3 一直没买)。
    //   两种都要买时(窝棚都有空槽): 各自买各自的第一名, 一次购物车两单。
    let spend = 0;
    const boughtPerKind = { coop: 0, pen: 0 };
    for (const kindSlot of [
        { key: 'coop', free: Math.min(coopSlots, buyBudget), lo: 60000, hi: 70000 },
        { key: 'pen', free: Math.min(penSlots, buyBudget), lo: 70000, hi: 80000 },
    ]) {
        if (kindSlot.free <= 0) continue;
        const kindUsable = usable.filter(g => g.animalId >= kindSlot.lo && g.animalId < kindSlot.hi);
        for (const g of kindUsable) {
            if (boughtPerKind[kindSlot.key] >= kindSlot.free || spend >= maxSpend) break;
            // 限购余量
            const remain = g.limit > 0 ? Math.max(0, g.limit - g.bought) : 99;
            if (remain <= 0) continue;
            // 只买这一种, 一次买满该栏舍剩余空槽(只受限购与单轮上限约束)
            const count = Math.min(kindSlot.free - boughtPerKind[kindSlot.key], remain);
            if (count <= 0) continue;
            try {
                const reply = await purchaseShopGoods(g.goodsId, count, g.price);
                const costItems = (reply && reply.cost_items) || [];
                const spentThis = costItems.reduce((s, it) => s + toNum(it.count), 0);
                spend += spentThis || g.price * count;
                result.bought += count;
                boughtPerKind[kindSlot.key] += count;
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
            // 只买第一名这一种: 买完就停, 不再换下一种(除非它买不到, 由上面的 continue/break 兜)
            break;
        }
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
// 牧场可出售产物包含两类(实测 ItemInfo):
//   107 = 蛋/崽等副产物(1060001 鸡蛋 …)
//   106 = 成品动物(2060001 整鸡 / 2060002 鸭 / 2065002 巨大鸭 …)
// 之前只卖 107, 于是整鸡/鸭/鹅/巨大鸭在背包里越堆越多(用户实测 x1197)。
const PRODUCE_ITEM_TYPES = [107, 106];

async function autoSellRanchProducts(_opts = {}) {
    const result = { sold: 0, earned: 0, details: [] };
    const { getRanchBagDetail, sellItems } = require('./warehouse');
    const bag = await getRanchBagDetail();
    const products = bag.items.filter(it =>
        PRODUCE_ITEM_TYPES.includes(Number(it.itemType)) && Number(it.count) > 0);
    if (products.length === 0) return result;

    // ⚠ 必须按**原始格子**(originalItems)出售, 不能用合并后的 items:
    //   items 是按 bagGroupKey 合并的(同一物品多个格子 → count 累加),
    //   但 uid 只保留了第一个格子的。拿"合并数量 + 单个格子 uid"去卖,
    //   服务端按该格子实际库存校验 → code=1000019「巨大鸭不足」(线上实测)。
    const productIds = new Set(products.map(it => toNum(it.id)));
    const cells = (bag.originalItems || []).filter(c =>
        productIds.has(toNum(c.id)) && toNum(c.count) > 0);
    // 兜底: 没有 originalItems 时退回合并项(单个格子的情况下行为一致)
    const sellables = cells.length
        ? cells.map(c => ({ id: toNum(c.id), count: toNum(c.count), uid: toNum(c.uid) }))
        : products.map(it => ({ id: toNum(it.id), count: toNum(it.count), uid: toNum(it.uid) }));

    const payload = [];
    const mergedDetails = new Map();
    for (const it of sellables) {
        payload.push(it);
        result.sold += it.count;
        mergedDetails.set(it.id, (mergedDetails.get(it.id) || 0) + it.count);
    }
    for (const [id, n] of mergedDetails) {
        result.details.push(`${getAnimalName(id) || id}x${n}`);
    }
    try {
        const reply = await sellItems(payload, { skipFarmFilter: true, scene: 'ranch' });
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

/**
 * 全场收获三连(官方操作顺序, 文档 6.2 RPC 一览 + 入栏抓包 t+17~t+36):
 *   收取副产物(CollectProduce 按槽 1..6 收架上的蛋) → 催产(TriggerProduce 给冷却到点的动物开新轮)
 *   → 收获(HarvestRanch)。
 * ⭐ 只发 HarvestRanch 时架上有蛋(feed=3/#6≥1)会一直回 1045211 —— batch harvest
 *   之前只发这一个, 面板"全部收获"在有蛋时必失败。这里抽成公共函数, 手动 op
 *   和 batch sub=harvest 都走同一条路径。
 * @returns {{items: string[], harvested: number}} items 是"名字x数量"明细
 */
async function collectThenHarvest() {
    let collectedText = '';
    for (const s of [1, 2, 3, 4, 5, 6]) {
        try {
            const cr = await collectProduce(s);
            const got = ((cr.items || cr.get_items || []).map(it => `${toNum(it.id)}x${toNum(it.count)}`)).join(',');
            if (got) collectedText += `${collectedText ? '，' : ''  }槽${s}:${got}`;
            await sleep(200);
        } catch (e) {
            const code = parseRanchErrorCode(e);
            if (!isExpectedRanchError(e) && code !== 1045211) {
                logWarn('牧场', `收副产物槽${s}失败: ${e.message}`, { module: 'ranch', event: '收副产物', result: 'error', slot: s });
            }
        }
    }
    // 催产(给冷却到点的动物开新一轮; 失败不阻断)
    try {
        await triggerProduce(0).catch(() => null);
        await sleep(400);
    } catch { /* 催产失败继续尝试收获 */ }
    const r = await harvestRanch(1);
    const items = [];
    let harvested = 0;
    for (const gain of (r.gains || [])) {
        for (const item of (gain.items || [])) {
            const id = toNum(item.item_id);
            if (id === 1102) continue;
            items.push(`${getAnimalName(id) || id}x${toNum(item.count)}`);
            harvested += toNum(item.count);
        }
    }
    if (collectedText) items.unshift(`副产物[${collectedText}]`);
    return { items, harvested };
}

async function operateRanch(opts = {}) {
    // 兼容错误的调用形态(opts 被传成字符串), 并在未知 op 时把收到的参数打进错误里,
    // 便于定位"半更新"部署下 admin/worker 版本不一致的问题
    if (typeof opts === 'string') opts = { op: opts };
    const op = String((opts && opts.op) || '').trim();
    if (op && !['harvest', 'produce', 'feed', 'feedmachine', 'buycub', 'rotation', 'rotationbuy', 'clean', 'steal', 'place', 'collect', 'harvestanimal', 'donate', 'hazard', 'stroke', 'autostroke', 'autohazard', 'upgrade', 'unlock', 'batch'].includes(op)) {
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
            const { items, harvested } = await collectThenHarvest();
            if (harvested > 0) recordOperation('ranchHarvest', harvested);
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
                if (produced > 0) recordOperation('ranchProduce', produced);
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
            let feedAnimalInstId = 0;
            if (slot > 0) {
                try {
                    const v = await getRanchOverview();
                    const a = (v.animals || []).find(x => toNum(x.slot) === slot);
                    if (a) {
                        feedHostGid = toNum(a.ranchInstId) || 0;
                        feedAnimalInstId = toNum(a.animalInstId) || 0;
                    }
                } catch { /* 拿不到就回落默认实例 */ }
            }
            // 桶空时先自动灌罐头(80021+ → 容器 7003/7004), 再重试一次。
            // 之前缺这一步: 背包有 72 个罐头, 喂食却一直回 1045234「罐头桶已用完」。
            //
            // ⭐ 2026-11-20 线上问题「普通罐头还有很多, 却提示没有了」:
            //   FeedAnimal 请求里**没有罐头类型字段**(只有 host_gid/animal_inst_id/count),
            //   服务端按"哪个桶里有剩余时长"扣 —— 抓包回包 #5.#11 = {1:7003, 2:3596} 证实。
            //   所以 feedType 想生效, 必须**喂之前就把对应桶灌好**:
            //     · 普通罐头(4) → 必须有 7003 的余量
            //     · 有机罐头(5/6) → 必须有 7004 的余量
            //   旧逻辑只在"服务端报桶空"之后才灌, 而且灌的是 feedType 对应的桶 ——
            //   于是当另一个桶还有余量时, 服务端一直扣那个桶, 目标桶永远轮不到,
            //   表现为"背包里普通罐头一堆, 却说没有普通罐头了"。
            //   现在: 先按 feedType **预灌**目标桶(该桶没余量时才灌), 再喂。
            const wantKind = Number(feedType) === FEED_TYPE.NORMAL_CAN ? 'normal' : 'organic';
            const targetBucketId = wantKind === 'normal' ? 7003 : 7004;
            if (opts.autoFillCans !== false) {
                const pre = await fillCanBuckets(wantKind, { maxItems: 1, onlyIfBucketEmpty: true })
                    .catch(() => ({ used: 0 }));
                if (pre.used > 0) {
                    log('牧场', `喂食前把 1 个${wantKind === 'normal' ? '普通' : '有机'}罐头灌进桶(${targetBucketId})`, {
                        module: 'ranch', event: '灌罐头', result: 'ok', kind: wantKind,
                    });
                }
            }
            const doFeed = async () => (slot > 0
                ? feedAnimal(wantKind, feedHostGid, feedAnimalInstId)
                // 无槽位 = 全场(窝+棚逐栏舍各一次; 旧的落回窝 10001, 棚没喂到)
                : feedAllFacilities(wantKind).then(r => ({ _fed: r.fed })));
            try {
                await doFeed();
                recordOperation('ranchFeed', count);
                return { ok: true, action: '喂食', detail: `${feedLabel} x${count}` };
            } catch (e) {
                const code = parseRanchErrorCode(e);
                if (code === RANCH_ERR.CANS_EMPTY && opts.autoFillCans !== false) {
                    const kind = wantKind;
                    const filled = await fillCanBuckets(kind, { maxItems: 2 });
                    if (filled.used > 0) {
                        try {
                            await doFeed();
                            recordOperation('ranchFeed', count);
                            return {
                                ok: true, action: '喂食',
                                detail: `${feedLabel} x${count}(自动灌入 ${filled.used} 个罐头)`,
                            };
                        } catch (e2) {
                            return { ok: false, action: '喂食', error: feedFailureHint(feedType, e2) };
                        }
                    }
                    // ⚠ 2026-11-20: 这里必须带上**服务端原文** —— 我们的文案会掩盖真实原因。
                    //   线上实测: 农场背包里 7003 明明有 707513(≈196.5h), 服务端却回 1045234,
                    //   只显示"桶已空"会让人以为是数据问题。
                    const rawMsg = String(e.message || '').replace(/^[^:]*:\s*/, '').trim();
                    logWarn('牧场', `喂食失败(桶空分支) feedType=${feedType} code=${code} 背包无${wantKind}罐头; 服务端原文: ${rawMsg || '(空)'}`, {
                        module: 'ranch', event: '喂食', result: 'rejected',
                        feedType, code, kind: wantKind, raw: rawMsg,
                    });
                    return {
                        ok: false, action: '喂食',
                        error: `罐头桶已空，且背包里没有${wantKind === 'normal' ? '普通' : '有机'}罐头可灌。`
                            + `(服务端 code=${code}${rawMsg ? `：${rawMsg}` : ''})`,
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
            const wantGrass = toNum(opts.count) || 100;
            const r = await addFeedToMachine(wantGrass);
            recordOperation('ranchGrass', 1);   // 手动补草按次数记(与自动补草 ranchGrass 一致)
            return { ok: true, action: '牧草机加草', detail: `存量 ${r.stored}` };
        }
        case 'buycub': {
            // 用户指定了 goodsId + count(面板加购) → 精确买; 否则走"按收益比自动挑"
            if (toNum(opts.goodsId) > 0) {
                const r = await buyCubByGoods(opts.goodsId, opts.count, { price: opts.price });
                if (!r.ok) {
                    return { ok: false, action: '买幼崽', error: r.error, name: r.name };
                }
                if (r.bought > 0) recordOperation('ranchBuyCubs', r.bought);
                // ⭐ 买完立即入栏: BuyGoods 的 auto_add 只进背包(幼崽 itemType=105),
                //   不入栏 —— 之前要等下一轮自动巡检才进栏, 面板买了"看不到变化"。
                let placedNote = '';
                if (r.bought > 0 && opts.placeAfterBuy !== false) {
                    try {
                        const placed = await autoPlaceCubs({});
                        if (placed.placed > 0) placedNote = `，已入栏 ${placed.placed} 只`;
                    } catch { /* 入栏失败不阻断购买结果 */ }
                }
                return {
                    ok: true,
                    action: '买幼崽',
                    detail: `${r.name}x${r.bought} / 花 ${r.spent} 金券${placedNote}`,
                    bought: r.bought,
                    spent: r.spent,
                };
            }
            // 买幼崽(利益最大: 按 整只回收/幼崽成本 收益比排序)
            // 默认不限预算(用户要求移除); 只有显式传了才透传
            const r = await autoBuyCubs(toNum(opts.maxSpend) > 0 ? { maxSpend: toNum(opts.maxSpend) } : {});
            if (r.bought > 0) recordOperation('ranchBuyCubs', r.bought);
            // 同上: 自动买完也立即入栏(autoBuyCubs 内部不入栏, 入栏在巡检第 5 步)
            let autoPlacedNote = '';
            if (r.bought > 0 && opts.placeAfterBuy !== false) {
                try {
                    const placed = await autoPlaceCubs({});
                    if (placed.placed > 0) autoPlacedNote = `，已入栏 ${placed.placed} 只`;
                } catch { /* 入栏失败不阻断购买结果 */ }
            }
            return {
                ok: true,
                action: '买幼崽',
                detail: r.bought > 0 ? `${r.details.join('，')} / 花 ${r.spent} 金券${autoPlacedNote}` : '没有空槽或可买幼崽',
            };
        }
        case 'rotationbuy': {
            // 手动买游商某一格(面板用): opts.uid 商品 uid, count 数量
            if (!opts.uid) throw new Error('需要指定商品 uid');
            const shop = await getRotationShop();
            const r = await purchaseRotationGoods(
                toNum(opts.uid),
                Math.max(1, toNum(opts.count) || 1),
                toNum(shop.refreshAt) || 0,
            );
            if (r.ok) recordOperation('ranchRotation', Math.max(1, toNum(opts.count) || 1));
            return {
                ok: r.ok,
                action: '游商兑换',
                detail: r.items.length
                    ? r.items.map(i => `#${i.id}x${i.count}`).join('，')
                    : `已兑换 x${Math.max(1, toNum(opts.count) || 1)}`,
            };
        }
        case 'rotation': {
            const r = await autoBuyRotationShop(opts);
            if (r.bought > 0) recordOperation('ranchRotation', r.bought);
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
            if (r.cleaned > 0) recordOperation('ranchClean', r.cleaned);
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
            if (placedN > 0) recordOperation('ranchPlace', placedN);
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
        }
        case 'donate': {
            if (!slot) throw new Error('需要指定槽位');
            const r = await donateAnimal(slot);
            const gains = (r.gains || []).map(i => `#${toNum(i.id)}x${toNum(i.count)}`).join('，');
            return { ok: true, action: '出售动物', detail: gains || `槽${slot}` };
        }
        case 'hazard': {
            // 放蚊子(使坏) —— opts.gid 指定好友
            // 抓包定案: 请求是 {1:栏舍实例, 2:好友gid, 3:11003, 4:1}, 每日上限 100
            if (!opts.gid) throw new Error('需要指定好友 gid');
            const r = await putHazard(toNum(opts.gid), {
                hostGid: toNum(opts.instId) || RANCH_SELF_HOST_GID,
                count: toNum(opts.count) || 1,
            });
            if (r.ok) recordOperation('ranchHazard', toNum(opts.count) || 1);
            return {
                ok: r.ok,
                action: '放蚊子',
                detail: r.ok
                    ? `gid=${toNum(opts.gid)}${r.remaining === null ? '' : `，今日剩余 ${r.remaining} 次`}`
                    : `gid=${toNum(opts.gid)} 使坏失败`,
            };
        }
        case 'stroke': {
            // 照顾(摸一摸)好友动物 —— opts.gid 好友, animalInstId 动物实例 ID(必填)
            // 抓包定案: 请求 {1:好友gid, 2:{1:栏舍实例, 2:animal_inst_id}}; 每日上限 10
            // ⚠ target#2 是 animal_inst_id, 不是槽位号 —— 传槽位会回 1045207「动物不存在」
            if (!opts.gid) throw new Error('需要指定好友 gid');
            const animalInstId = toNum(opts.animalInstId) || toNum(opts.instId);
            if (!animalInstId) throw new Error('需要指定动物实例 ID(animalInstId)');
            await strokeAnimal(toNum(opts.gid), {
                hostGid: toNum(opts.hostGid) || RANCH_SELF_HOST_GID,
                animalInstId,
            });
            recordOperation('ranchStroke', 1);
            return { ok: true, action: '照顾动物', detail: `gid=${toNum(opts.gid)} 动物#${animalInstId}` };
        }
        case 'autostroke': {
            const r = await autoStrokeFriendAnimals(opts);
            if (r.count > 0) recordOperation('ranchStroke', r.count);
            return {
                ok: true,
                action: '自动照顾好友动物',
                detail: r.count > 0
                    ? `照顾 ${r.count} 只: ${r.details.join('，')}`
                    : (r.remaining === 0 ? '今日 10 次已用满' : '没有可照顾的好友动物'),
            };
        }
        case 'autohazard': {
            const r = await autoPutHazardOnFriends(opts);
            if (r.count > 0) recordOperation('ranchHazard', r.count);
            return {
                ok: true,
                action: '自动使坏好友',
                detail: r.count > 0
                    ? `使坏 ${r.count} 次: ${r.details.join('，')}`
                    : (r.remaining === 0 ? '今日次数已用满' : '没有可操作的好友'),
            };
        }
        case 'batch': {
            // 批量操作(对照农场"整田操作"): harvest/produce/clean/feed
            const sub = String(opts.batch || '').trim();
            if (sub === 'harvest') {
                // ⭐ 2026-11-21: 改成与手动「收获」同一套三连(收副产物→催产→收获)。
                //   之前只发 HarvestRanch —— 架上有蛋(鸡/鹅)时服务端回 1045211,
                //   面板「全部收获」按钮在有蛋的牧场永远失败。
                const { items, harvested } = await collectThenHarvest();
                if (harvested > 0) recordOperation('ranchHarvest', harvested);
                return { ok: true, action: '全场收获', detail: items.join('，') || '没有可收的' };
            }
            if (sub === 'produce') {
                const r = await triggerProduce(0);
                let n = 0;
                for (const p2 of (r.receipts || [])) n += toNum(p2.count);
                if (n > 0) recordOperation('ranchProduce', n);
                return { ok: true, action: '全场催产', detail: `${n} 个产物` };
            }
            if (sub === 'clean') {
                const r = await autoCleanOwnRanch();
                if (r.cleaned > 0) recordOperation('ranchClean', r.cleaned);
                return { ok: true, action: '全场清理', detail: r.cleaned > 0 ? '清理完成' : '没有待清理的' };
            }
            if (sub === 'feed') {
                // feedType: 4=普通罐头(每只一次) / 5,6=有机罐头(不限次数)。
                // 批量默认用有机罐头(5): 普通罐头对多数动物已用过, 全喂必然大面积失败。
                const ft = toNum(opts.feedType) || FEED_TYPE.ORGANIC_A;
                try {
                    // ⭐ #2 是喂食方式: 4=普通→2 / 5,6=有机→1(逐栏舍全场: 窝+棚各一次)
                    //   2026-11-22 修"喂棚的有机罐头喂到窝去了": 旧的单发 lastRanchInstIds[0]=窝
                    const ftKind = ft === FEED_TYPE.NORMAL_CAN ? 'normal' : 'organic';
                    // 预灌目标桶(与单只喂食一致): 桶没余量才灌, 省一次必失败的请求
                    if (opts.autoFillCans !== false) {
                        const pre = await fillCanBuckets(ftKind, { maxItems: 1, onlyIfBucketEmpty: true })
                            .catch(() => ({ used: 0 }));
                        if (pre.used > 0) {
                            log('牧场', `全场喂食前把 1 个${ftKind === 'normal' ? '普通' : '有机'}罐头灌进桶`, {
                                module: 'ranch', event: '灌罐头', result: 'ok', kind: ftKind,
                            });
                        }
                    }
                    const fr = await feedAllFacilities(ftKind);
                    recordOperation('ranchFeed', fr.fed || 1);
                    return {
                        ok: true, action: '全场喂罐头',
                        detail: `${FEED_TYPE_LABEL[ft] || '罐头'}：${fr.fed} 个栏舍(窝+棚)${fr.errors.length ? `，${fr.errors.length} 个未喂` : ''}`,
                    };
                } catch (e) {
                    const code = parseRanchErrorCode(e);
                    // 桶空 → 先灌罐头再重试(与单只路径一致; 同样逐栏舍窝+棚)
                    if (code === RANCH_ERR.CANS_EMPTY && opts.autoFillCans !== false) {
                        const kind = ft === FEED_TYPE.NORMAL_CAN ? 'normal' : 'organic';
                        const filled = await fillCanBuckets(kind, { maxItems: 2 });
                        if (filled.used > 0) {
                            try {
                                const fr2 = await feedAllFacilities(kind);
                                recordOperation('ranchFeed', fr2.fed || 1);
                                return { ok: true, action: '全场喂罐头', detail: `自动灌入 ${filled.used} 个罐头后喂食成功(${fr2.fed} 个栏舍)` };
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
                if (r.completed > 0 || r.upgraded > 0) recordOperation('ranchBuilding', r.completed + r.upgraded);
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
            if (r.completed > 0 || r.unlocked > 0) recordOperation('ranchRegion', r.completed + r.unlocked);
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
                if (r.ok) recordOperation('ranchSteal', 1);
                return {
                    ok: r.ok,
                    action: '偷产物',
                    detail: r.ok ? '偷取成功' : '该好友没有可偷的产物',
                };
            }
            const r = await autoStealFriendProduce(opts);
            if (r.cleaned > 0) recordOperation('ranchSteal', r.cleaned);
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
    autoFeedCansByStrategy,
    checkAndBuyCansIfLow,
    operateRanch,
    checkRanch,
    startRanchCheckLoop,
    stopRanchCheckLoop,
    restartCanBuyCheckTimer,
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
    enterRanchSceneForApi,
    useCanOnAnimal,
    useCanFillBucket,
    fillCanBuckets,
    // 日志节流: 供测试验证"同一状态不重复刷屏"
    shouldLogOnce,
    resetLogOnceState,
    planRanchDueActions,
    runRanchDueActions,
    pullRanchGroupForward,
    scheduleRanchFromCountdowns,
    ranchIntervalRangeSec,
    toRanchView,
    getAnimalName,
    getAnimalImage,
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
    strokeAnimal,
    autoStrokeFriendAnimals,
    autoPutHazardOnFriends,
    getFriendOpRemaining,
    useFeedBucket,
    cleanOwnRanch,
    stealFriendProduce,
    autoStealFriendProduce,
    purchaseRotationGoods,
    autoUseRanchBagItems,
    autoFillCansToWatermark,
    getRanchShop,
    buyGrass,
    readCanBucketSecs,
    invalidateCanBucketCache,
    collectThenHarvest,
    useItemWithUid,
    getRanchWeightScore,
    __privateRanchFns: {
        calcRanchLevel, parseRotationShopReply, parseFeedMachineReply, walkWire, isEmptyRanchView,
        // 幼崽: 供测试验证"背包已有幼崽就不再买 + 单轮上限"
        autoBuyCubs, autoPlaceCubs, applyCubStrategy,
        // 幼崽背包: 排外 + 入栏顺序(对齐农场 plantSeedExclude / bagSeedPriority)
        sortBagCubsForPlacing, getRanchCubExcludeSet,
        // 游商: 供测试验证"等级不够就不发购买请求 + 不刷 error 日志"
        autoBuyRotationShop, isRotationNotPurchasable, rotationErrorHint,
        // 喂食: 供测试验证两种罐头的 feed_type 与失败提示
        feedAnimal, feedFailureHint, FEED_TYPE, resolveRanchHostGid, RANCH_SELF_HOST_GID,
        // 缓存: 供测试验证"写操作后 overview 必须失效"(收获后入栏读到满栏的事故)
        invalidateRanchOverviewCache,
        // 栏舍实例: 供测试验证"棚动物要用 10003 而不是写死的 10001"
        rememberRanchInstIds, feedAllFacilities,
        planRanchDueActions, runRanchDueActions,
        // 好友牧场: 照顾 target#2 必须用 animal_inst_id(线上 1045207)
        listFriendAnimals, strokeAnimal, putHazard,
        // 建筑档位: 供测试验证"窝/棚显示档位与小程序一致"(AllCells.level 不是显示档位)
        buildingTier, BUILDING_TIER,
    },
};