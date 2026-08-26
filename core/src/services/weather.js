/**
 * 雨落成诗 (天气活动) — group_id=2026070300
 *
 * 子活动:
 *   2026070301 type=3  商店 (天气采集瓶 goods_id=200, 每日限购1, 200金豆豆)
 *   2026070302 type=17 气象研究入口 (仅入口, body 为空串)
 *   2026070303 type=8  任务进度 (使用采集瓶累计次数, 满10次得雷雨召唤瓶)
 *   2026070304 type=20 气象研究 (8档 1000-1008, 消耗雷电徽章 1027 升级, 各档解锁奖励)
 *   2026070305 type=6  每日任务列表 (使用采集瓶/雷雨瓶/收获闪电变异作物)
 *
 * 已确认协议:
 *   cmd=1 SHOP_BUY:              购买采集瓶  → Operate(2026070301, 1, shop_buy{200,1})
 *   cmd=9 USE_BOTTLE_ON_FRIEND:  对好友用采集瓶 → Operate(2026070303, 9, field107{friend_uid})
 *   cmd=40 UPGRADE_RESEARCH:     气象研究升级 → Operate(2026070304, 40, field140{tier_id})
 *   雷雨召唤瓶自用: ItemService.Use({ item:{id=5002,count=1,uid=<背包实例uid>}, target:{uid=自己uid} })
 *   任务奖励: 服务端自动发放, 无需客户端 claim
 */

const protobuf = require('protobufjs');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, randomDelay } = require('../utils/utils');
const { isAutomationOn } = require('../models/store');
const { getBag, getBagItems } = require('./warehouse');
const { getFriendsList } = require('./friend');
const { getItemImageById } = require('../config/gameConfig');

const WEATHER_SERVICE = 'gamepb.weatherpb.WeatherService';
const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';

// 活动与子活动ID
const WEATHER_GROUP_ID = 2026070300;
const ACTIVITY_ID_SHOP = 2026070301;
const ACTIVITY_ID_RESEARCH_ENTER = 2026070302;
const ACTIVITY_ID_TASK_PROGRESS = 2026070303;
const ACTIVITY_ID_RESEARCH = 2026070304;
const ACTIVITY_ID_DAILY_TASKS = 2026070305;

// 商品与道具
const WEATHER_SHOP_GOODS_ID = 200;      // 天气采集瓶(商店项)
const ITEM_ID_COLLECT_BOTTLE = 5001;    // 天气采集瓶
const ITEM_ID_THUNDER_BOTTLE = 5002;    // 雷雨召唤瓶
const ITEM_ID_THUNDER_BADGE = 1027;     // 雷电徽章
const ITEM_ID_GOLD_BEAN = 1005;         // 金豆豆(购买货币)

// Operate cmd
const CMD_SHOP_BUY = 1;
const CMD_USE_BOTTLE_ON_FRIEND = 9;
const CMD_UPGRADE_RESEARCH = 40;
// Operate 请求扩展 payload 字段号
const FIELD_USE_BOTTLE_ON_FRIEND = 107;
const FIELD_UPGRADE_RESEARCH = 140;

// 天气类型 (抓包看到 type=1 时为普通天气; 雷雨值待补)
// 用户描述: "已经是雷雨天气时无法使用雷雨召唤瓶"
const WEATHER_TYPE_NORMAL = 1;

// ============ 底层 RPC ============

async function getWeatherStatusRaw() {
    const body = types.GetWeatherStatusRequest.encode(types.GetWeatherStatusRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync(WEATHER_SERVICE, 'GetWeatherStatus', body);
    return types.GetWeatherStatusReply.decode(replyBody);
}

async function getWeatherGroupRaw() {
    // GetGroupRequest { group_id = 1 }; 复用 activitypb 里的定义手写等价编码
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 0).int64(toLong(WEATHER_GROUP_ID));
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'GetGroup', w.finish());
    return types.WeatherGroupReply.decode(replyBody);
}

// 手动构造 Operate 请求(避开 activitypb.OperateRequest field107=LotteryDrawReq 冲突)
function encodeOperateRequestRaw(activityId, cmd, payloadFieldNumber, payloadBytes) {
    const w = new protobuf.Writer();
    w.uint32((1 << 3) | 0).int64(toLong(activityId));
    w.uint32((2 << 3) | 0).int64(toLong(cmd));
    if (payloadFieldNumber && payloadBytes && payloadBytes.length) {
        w.uint32((payloadFieldNumber << 3) | 2).bytes(payloadBytes);
    }
    return w.finish();
}

async function operateWeatherActivityRaw(activityId, cmd, payloadFieldNumber, payloadBytes) {
    const body = encodeOperateRequestRaw(activityId, cmd, payloadFieldNumber, payloadBytes);
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'Operate', body);
    return replyBody; // 返回原始字节, 由调用方按需解析
}

// ============ 规范化 ============

function normalizeItem(item, extra = {}) {
    const id = toNum(item && item.id);
    return {
        id,
        count: toNum(item && item.count),
        image: id ? getItemImageById(id) : '',
        ...extra,
    };
}

function normalizeGroup(groupReply) {
    const g = groupReply && groupReply.group;
    if (!g) return null;
    const children = Array.isArray(g.children) ? g.children : [];
    const byId = new Map(children.map(c => [toNum(c.head && c.head.id), c]));

    const shopEntry = byId.get(ACTIVITY_ID_SHOP);
    const shop = shopEntry && shopEntry.shop
        ? {
            activityId: ACTIVITY_ID_SHOP,
            goods: (shopEntry.shop.goods || []).map(g0 => ({
                id: toNum(g0.id),
                name: String(g0.name || ''),
                item: normalizeItem(g0.item),
                cost: normalizeItem(g0.cost),
                purchaseLimit: toNum(g0.purchase_limit),
                purchasedCount: toNum(g0.purchased_count),
                remaining: Math.max(0, toNum(g0.purchase_limit) - toNum(g0.purchased_count)),
            })),
        }
        : null;

    const taskEntry = byId.get(ACTIVITY_ID_TASK_PROGRESS);
    const taskProgress = taskEntry && taskEntry.task_progress
        ? {
            activityId: ACTIVITY_ID_TASK_PROGRESS,
            current: toNum(taskEntry.task_progress.current),
            target: toNum(taskEntry.task_progress.target),
            itemId: toNum(taskEntry.task_progress.item_id),
            stage: toNum(taskEntry.task_progress.stage),
            stageReward: taskEntry.task_progress.reward
                ? normalizeItem(taskEntry.task_progress.reward.item, { rewardId: toNum(taskEntry.task_progress.reward.reward_id) })
                : null,
        }
        : null;

    const dailyEntry = byId.get(ACTIVITY_ID_DAILY_TASKS);
    const dailyTasks = dailyEntry && dailyEntry.daily_tasks
        ? {
            activityId: ACTIVITY_ID_DAILY_TASKS,
            tasks: (dailyEntry.daily_tasks.tasks || []).map(t => ({
                id: toNum(t.id),
                targetItemId: toNum(t.target_item_id),
                targetCount: Math.max(1, toNum(t.target_count) || 1),
                name: String(t.name || ''),
                reward: normalizeItem(t.reward),
            })),
        }
        : null;

    const researchEntry = byId.get(ACTIVITY_ID_RESEARCH);
    const research = researchEntry && researchEntry.research && researchEntry.research.inner
        ? {
            activityId: ACTIVITY_ID_RESEARCH,
            currentTier: toNum(researchEntry.research.inner.current_tier),
            tiers: (researchEntry.research.inner.tiers || []).map(t => {
                // 抓包观察: field3=1 未达到, =2 可升级, =4 已升级完成
                const state = toNum(t.field3);
                return {
                    tierId: toNum(t.tier_id),
                    state,
                    upgradable: state === 2,
                    upgraded: state === 4,
                    cost: normalizeItem(t.cost),
                    reward: normalizeItem(t.reward),
                };
            }),
        }
        : null;

    return {
        groupId: toNum(g.head && g.head.id),
        name: String(g.head && g.head.name || ''),
        startTime: toNum(g.head && g.head.start_time),
        endTime: toNum(g.head && g.head.end_time),
        shop,
        taskProgress,
        dailyTasks,
        research,
    };
}

function normalizeWeather(weatherReply) {
    const w = weatherReply && weatherReply.weather;
    if (!w) return null;
    const type = toNum(w.type);
    return {
        type,
        typeName: describeWeatherType(type),
        beginTime: toNum(w.begin_time),
        endTime: toNum(w.end_time),
        isThunder: isThunderWeather(type),
    };
}

// 已知 type=1 为普通(晴/多云); 雷雨天气 type 待补(有雷雨状态时应无法用雷雨召唤瓶)
// 保守策略: 只有确认 type=1 时视为"非雷雨", 其他一律按"雷雨/未知"处理
function describeWeatherType(type) {
    switch (Number(type)) {
        case 1: return '普通';
        default: return `未知(${type})`;
    }
}

function isThunderWeather(type) {
    return Number(type) !== WEATHER_TYPE_NORMAL;
}

// ============ 对外 API ============

/**
 * 获取雨落成诗完整概览: 天气 + 活动数据 + 相关背包数量
 */
async function getWeatherOverview() {
    // 串行请求, 避免瞬时并发挤占心跳/核心接口导致连接超时断开
    const weatherReply = await getWeatherStatusRaw().catch(e => { logWarn('活动', `获取天气状态失败: ${e.message}`); return null; });
    const groupReply = await getWeatherGroupRaw().catch(e => { logWarn('活动', `获取雨落成诗活动失败: ${e.message}`); return null; });
    const bagReply = await getBag().catch(() => null);

    const bagItems = bagReply ? getBagItems(bagReply) : [];
    const bagCounts = new Map();
    for (const it of bagItems) {
        const id = toNum(it && it.id);
        if (id > 0) bagCounts.set(id, (bagCounts.get(id) || 0) + toNum(it.count));
    }

    return {
        updatedAt: Date.now(),
        weather: normalizeWeather(weatherReply),
        activity: normalizeGroup(groupReply),
        bag: {
            collectBottle: bagCounts.get(ITEM_ID_COLLECT_BOTTLE) || 0,
            thunderBottle: bagCounts.get(ITEM_ID_THUNDER_BOTTLE) || 0,
            thunderBadge: bagCounts.get(ITEM_ID_THUNDER_BADGE) || 0,
            goldBean: bagCounts.get(ITEM_ID_GOLD_BEAN) || 0,
        },
    };
}

/**
 * 购买天气采集瓶 (使用 activitypb 通用 shop_buy 载荷)
 */
async function buyCollectBottle(count = 1) {
    const cnt = Math.max(1, Math.floor(Number(count) || 1));
    const reqBody = types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
        id: toLong(ACTIVITY_ID_SHOP),
        cmd: toLong(CMD_SHOP_BUY),
        shop_buy: { goods_id: toLong(WEATHER_SHOP_GOODS_ID), count: toLong(cnt) },
    })).finish();
    const { body: replyBody } = await sendMsgAsync(ACTIVITY_SERVICE, 'Operate', reqBody);
    const reply = types.ActivityOperateReply.decode(replyBody);
    const rsp = reply && reply.shop_buy ? reply.shop_buy : {};
    return {
        count: cnt,
        awards: (Array.isArray(rsp.awards) ? rsp.awards : []).map(a => normalizeItem(a)),
        costs: (Array.isArray(rsp.costs) ? rsp.costs : []).map(a => normalizeItem(a)),
    };
}

/**
 * 对好友使用天气采集瓶
 * cmd=9, payload 在 field107 位置 (与 activitypb.LotteryDrawReq 字段号相同, 用手动编码避开冲突)
 */
async function useCollectBottleOnFriend(friendUid) {
    const uid = toNum(friendUid);
    if (!uid) throw new Error('缺少好友 UID');
    const payloadBytes = types.WeatherUseBottleOnFriendReq.encode(
        types.WeatherUseBottleOnFriendReq.create({ friend_uid: toLong(uid) })
    ).finish();
    const replyBody = await operateWeatherActivityRaw(ACTIVITY_ID_TASK_PROGRESS, CMD_USE_BOTTLE_ON_FRIEND, FIELD_USE_BOTTLE_ON_FRIEND, payloadBytes);
    // 响应为空(常见)或含 field108(任务奖励发放), 均视为成功
    return { friendUid: uid, replyLen: replyBody.length };
}

/**
 * 对自己使用雷雨召唤瓶
 * ItemService.Use 的变体载荷: { item:{id=5002,count=1,uid=<背包实例uid>}, target:{uid=自己uid} }
 * 服务端在已是雷雨天气时会返回错误, 调用方需捕获
 */
async function useThunderBottleSelf() {
    // 1) 查背包拿雷雨瓶实例 uid
    const bagReply = await getBag();
    const items = getBagItems(bagReply) || [];
    const bottle = items.find(it => toNum(it && it.id) === ITEM_ID_THUNDER_BOTTLE && toNum(it.count) > 0);
    if (!bottle) throw new Error('背包无雷雨召唤瓶');
    const itemUid = toNum(bottle.uid);
    if (!itemUid) throw new Error('雷雨召唤瓶缺少实例 uid');

    // 2) 拿自己 UID
    const state = getUserState();
    const selfUid = toNum(state && state.gid);
    if (!selfUid) throw new Error('无法获取自身 UID');

    // 3) 手动编码, 强制显式写 target.field3=0 以完全匹配抓包
    // (proto3 默认省略零值, 但服务端可能校验字段存在, 抓包中客户端始终显式写了)
    const w = protobuf.Writer.create();
    const itemW = w.uint32((1 << 3) | 2).fork();
    itemW.uint32((1 << 3) | 0).int64(toLong(ITEM_ID_THUNDER_BOTTLE));
    itemW.uint32((2 << 3) | 0).int64(toLong(1));
    itemW.uint32((6 << 3) | 0).int64(toLong(itemUid));
    itemW.ldelim();
    const targetW = w.uint32((2 << 3) | 2).fork();
    targetW.uint32((1 << 3) | 0).int64(toLong(selfUid));
    targetW.uint32((3 << 3) | 0).int64(toLong(0));
    targetW.ldelim();
    const reqBody = w.finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', reqBody);
    // UseReply 结构与其他 Use 一致 (items 列表), 可选解析
    let awards = [];
    try {
        const rep = types.UseReply.decode(replyBody);
        awards = (rep.items || []).map(a => normalizeItem(a));
    } catch (_) { /* 忽略解析失败 */ }
    return { itemUid, awards };
}

/**
 * 气象研究升级到指定档位
 * Operate(2026070304, cmd=40, field140{ tier_id })
 */
async function upgradeResearchTier(tierId) {
    const tid = toNum(tierId);
    if (!tid) throw new Error('缺少研究档位 ID');
    const payloadBytes = types.WeatherUpgradeResearchReq.encode(
        types.WeatherUpgradeResearchReq.create({ tier_id: toLong(tid) })
    ).finish();
    const replyBody = await operateWeatherActivityRaw(
        ACTIVITY_ID_RESEARCH, CMD_UPGRADE_RESEARCH, FIELD_UPGRADE_RESEARCH, payloadBytes,
    );
    return { tierId: tid, replyLen: replyBody.length };
}

// ============ 自动化 ============

/**
 * 每日气象任务: 买1个采集瓶 + 遍历好友用瓶(直到用完或无好友可用)
 * (雷雨召唤瓶自用/收获闪电变异作物 因协议未确认, 本轮不自动)
 */
async function autoRunDailyWeatherTasks() {
    const summary = { bought: 0, usedOnFriends: 0, skipped: [], errors: [] };
    let overview;
    try {
        overview = await getWeatherOverview();
    } catch (e) {
        return { skipped: true, reason: 'overview_failed', error: e.message };
    }
    if (!overview.activity || !overview.activity.shop) {
        return { skipped: true, reason: 'activity_not_active' };
    }

    // 1) 每日买1瓶(若未买)
    const shopGoods = (overview.activity.shop.goods || []).find(g => g.id === WEATHER_SHOP_GOODS_ID);
    if (shopGoods && shopGoods.remaining > 0) {
        if (overview.bag.goldBean >= toNum(shopGoods.cost && shopGoods.cost.count)) {
            try {
                await buyCollectBottle(1);
                summary.bought = 1;
                log('活动', '雨落成诗: 购买天气采集瓶×1 成功', { module: 'activity', event: '雨落成诗', result: 'buy_ok' });
                await randomDelay(500, 1200);
            } catch (e) {
                summary.errors.push(`购买采集瓶失败: ${e.message}`);
                logWarn('活动', `雨落成诗购买瓶失败: ${e.message}`, { module: 'activity', event: '雨落成诗', result: 'buy_error' });
            }
        } else {
            summary.skipped.push('金豆豆不足, 跳过购买');
        }
    }

    // 2) 遍历好友用采集瓶 (本地推算瓶数: 初始库存 + 本次购买, 避免再发一次 overview 请求)
    let bottles = (overview.bag.collectBottle || 0) + (summary.bought || 0);
    if (bottles <= 0) {
        summary.skipped.push('无采集瓶, 跳过对好友使用');
        return summary;
    }

    let friends = [];
    try {
        friends = await getFriendsList(false);
    } catch (e) {
        summary.errors.push(`获取好友列表失败: ${e.message}`);
        return summary;
    }

    for (const f of friends) {
        if (bottles <= 0) break;
        const uid = toNum(f && f.gid);
        if (!uid) continue;
        try {
            await useCollectBottleOnFriend(uid);
            summary.usedOnFriends++;
            bottles--;
            log('活动', `雨落成诗: 对好友 ${f.name || uid} 使用采集瓶成功`, {
                module: 'activity', event: '雨落成诗', result: 'use_bottle_ok', friendUid: uid,
            });
            await randomDelay(1200, 2200);
        } catch (e) {
            // 该好友已被使用/不满足条件 → 继续下一个, 不消耗瓶数
            summary.errors.push(`对好友 ${uid} 使用失败: ${e.message}`);
        }
    }

    // 3) 尝试对自己使用雷雨召唤瓶 (若背包有; 服务端在雷雨天气时会拒绝, 我们捕获即可)
    summary.thunderUsed = 0;
    try {
        const afterUse = await getWeatherOverview();
        if ((afterUse.bag.thunderBottle || 0) > 0) {
            try {
                await useThunderBottleSelf();
                summary.thunderUsed = 1;
                log('活动', '雨落成诗: 对自己使用雷雨召唤瓶成功', {
                    module: 'activity', event: '雨落成诗', result: 'thunder_ok',
                });
            } catch (e) {
                // 已是雷雨天气 / 冷却中 → 视为跳过, 不报错
                summary.skipped.push(`雷雨瓶使用跳过: ${e.message}`);
            }
        }
    } catch (e) {
        summary.errors.push(`雷雨瓶检查失败: ${e.message}`);
    }

    return summary;
}

/**
 * 顶层自动化入口 (受 weather_task 开关控制)
 */
async function checkAndRunWeatherTasks() {
    if (!isAutomationOn('weather_task')) return { skipped: true };
    try {
        const result = await autoRunDailyWeatherTasks();
        log('活动', `雨落成诗每日自动化: 购买 ${result.bought || 0}, 对好友使用 ${result.usedOnFriends || 0}, 雷雨瓶使用 ${result.thunderUsed || 0}`, {
            module: 'activity', event: '雨落成诗', result: 'auto_done',
        });
        return result;
    } catch (e) {
        logWarn('活动', `雨落成诗每日自动化失败: ${e.message}`, { module: 'activity', event: '雨落成诗', result: 'auto_error' });
        return { error: e.message };
    }
}

/**
 * 气象研究自动升级入口 (受 weather_research 开关控制)
 * 抓包观察: 档位 field3=1 未达到, =2 可升级, =4 已完成
 * 策略: 循环找 upgradable=true 且徽章足够的档位, 升级到无法继续为止
 */
async function checkAndRunWeatherResearch() {
    if (!isAutomationOn('weather_research')) return { skipped: true };
    const summary = { upgraded: [], skipped: [], errors: [] };
    try {
        // 只查询一次 overview, 之后本地推演逐档升级 (研究档位链式固定顺序 1000→1008)
        // 避免每轮重复 getWeatherOverview 产生大量并发请求挤占连接
        const overview = await getWeatherOverview();
        const research = overview.activity && overview.activity.research;
        if (!research) { summary.skipped.push('研究活动未开启'); return summary; }

        // 从当前可升级档开始, 按数组顺序依次升级; 每升一档本地扣减徽章
        const tiers = (research.tiers || []).slice().sort((a, b) => toNum(a.tierId) - toNum(b.tierId));
        let badge = overview.bag.thunderBadge || 0;
        let startIndex = tiers.findIndex(t => t.upgradable);
        if (startIndex < 0) { summary.skipped.push(`无可升级档位(徽章=${badge})`); return summary; }

        for (let i = startIndex; i < tiers.length; i++) {
            const tier = tiers[i];
            if (tier.upgraded) continue;
            const cost = toNum(tier.cost && tier.cost.count);
            if (badge < cost) {
                summary.skipped.push(`徽章不足(剩 ${badge}, 需 ${cost}), 停止于档位 ${tier.tierId}`);
                break;
            }
            try {
                await upgradeResearchTier(tier.tierId);
                badge -= cost;
                summary.upgraded.push(tier.tierId);
                log('活动', `雨落成诗气象研究: 升级档位 ${tier.tierId} 成功 (消耗徽章 ${cost}, 剩 ${badge})`, {
                    module: 'activity', event: '雨落成诗研究', result: 'upgrade_ok', tierId: tier.tierId,
                });
                await randomDelay(800, 1500);
            } catch (e) {
                summary.errors.push(`升级档位 ${tier.tierId} 失败: ${e.message}`);
                logWarn('活动', `雨落成诗气象研究: 升级档位 ${tier.tierId} 失败: ${e.message}`, { module: 'activity', event: '雨落成诗研究', result: 'upgrade_error' });
                break; // 遇错停止
            }
        }
        return summary;
    } catch (e) {
        logWarn('活动', `雨落成诗气象研究失败: ${e.message}`, { module: 'activity', event: '雨落成诗研究', result: 'error' });
        return { error: e.message, ...summary };
    }
}

module.exports = {
    // 常量
    WEATHER_GROUP_ID,
    ITEM_ID_COLLECT_BOTTLE,
    ITEM_ID_THUNDER_BOTTLE,
    ITEM_ID_THUNDER_BADGE,
    // 查询
    getWeatherStatusRaw,
    getWeatherGroupRaw,
    getWeatherOverview,
    // 写操作 (全部协议已确认)
    buyCollectBottle,
    useCollectBottleOnFriend,
    useThunderBottleSelf,
    upgradeResearchTier,
    // 自动化
    autoRunDailyWeatherTasks,
    checkAndRunWeatherTasks,
    checkAndRunWeatherResearch,
};
