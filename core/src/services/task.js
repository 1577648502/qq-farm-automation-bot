/**
 * 任务系统 - 自动领取任务奖励
 */

const { isAutomationOn } = require('../models/store');
const { sendMsgAsync, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { getItemById } = require('../config/gameConfig');

let checking = false;
let taskClaimDoneDateKey = '';
let taskClaimLastAt = 0;
const taskScheduler = createScheduler('task');

function getDateKey() {
    const { getServerTimeSec } = require('../utils/utils');
    const nowSec = getServerTimeSec();
    const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
    const bjOffset = 8 * 3600 * 1000;
    const bjDate = new Date(nowMs + bjOffset);
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ============ 任务 API ============

/**
 * 拉任务列表。
 * @param {{sceneId?: number}} opts  sceneId=2 拉牧场任务(GLOBAL_SCENE_ID_BIG_FARM), 省略=农场
 */
async function getTaskInfo(opts = {}) {
    const sceneId = toNum(opts && opts.sceneId) || 0;
    const body = types.TaskInfoRequest.encode(types.TaskInfoRequest.create({
        scene_id: toLong(sceneId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'TaskInfo', body);
    return types.TaskInfoReply.decode(replyBody);
}

async function claimTaskReward(taskId, doShared = false) {
    const body = types.ClaimTaskRewardRequest.encode(types.ClaimTaskRewardRequest.create({
        id: toLong(taskId),
        do_shared: doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimTaskReward', body);
    return types.ClaimTaskRewardReply.decode(replyBody);
}

async function claimDailyReward(type, pointIds) {
    if (!types.ClaimDailyRewardRequest || !types.ClaimDailyRewardReply) {
        return { items: [] };
    }
    const body = types.ClaimDailyRewardRequest.encode(types.ClaimDailyRewardRequest.create({
        type: Number(type) || 0,
        point_ids: (pointIds || []).map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimDailyReward', body);
    return types.ClaimDailyRewardReply.decode(replyBody);
}

/**
 * 按类别领图鉴奖励。
 * ⭐ 2026-11-20 抓包定案: 请求 #1 是图鉴类别(1=植物, 101=牧场动物「巨大」页签),
 *   不是 only_claimable —— 旧实现发 true 只领到植物类。
 * @param {number} listType 1=植物图鉴(默认); 101=牧场动物图鉴
 */
async function claimAllIllustratedRewards(listType = 1) {
    if (!types.ClaimAllRewardsV2Request || !types.ClaimAllRewardsV2Reply) {
        return { items: [], bonus_items: [] };
    }
    const body = types.ClaimAllRewardsV2Request.encode(types.ClaimAllRewardsV2Request.create({
        list_type: Number(listType) || 1,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.illustratedpb.IllustratedService', 'ClaimAllRewardsV2', body);
    return types.ClaimAllRewardsV2Reply.decode(replyBody);
}

async function getTicketBalanceFromBag() {
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const rep = await getBag();
        const items = getBagItems(rep);
        for (const it of (items || [])) {
            if (toNum(it && it.id) === 1002) return Math.max(0, toNum(it && it.count));
        }
        return 0;
    } catch {
        return 0;
    }
}

// ============ 任务分析 ============

function formatTask(t, category = 'main') {
    return {
        id: toNum(t.id),
        desc: t.desc || `任务#${toNum(t.id)}`,
        category,
        progress: toNum(t.progress),
        totalProgress: toNum(t.total_progress),
        isClaimed: t.is_claimed,
        isUnlocked: t.is_unlocked,
        shareMultiple: toNum(t.share_multiple),
        rewards: (t.rewards || []).map(r => ({ id: toNum(r.id), count: toNum(r.count) })),
        canClaim: t.is_unlocked && !t.is_claimed && toNum(t.progress) >= toNum(t.total_progress) && toNum(t.total_progress) > 0
    };
}

/**
 * 分析任务列表，找出可领取的任务
 */
function analyzeTaskList(tasks, category = 'main') {
    const claimable = [];
    for (const task of tasks) {
        const t = formatTask(task, category);
        if (t.canClaim) {
            claimable.push(t);
        }
    }
    return claimable;
}

/**
 * 计算奖励摘要
 */
function getRewardSummary(items) {
    const summary = [];
    for (const item of items) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        // 货币用固定叫法, 其余从游戏配置查名字(原来只会显示"物品#80031x30")
        let name = '';
        if (id === 1 || id === 1001) name = '金币';
        else if (id === 2 || id === 1101) name = '经验';
        else if (id === 1002) name = '点券';
        else if (id === 1007) name = '金券';
        else if (id === 1008) name = '松果';
        if (!name) {
            try {
                const info = getItemById(id);
                if (info && info.name) name = String(info.name);
            } catch { /* 配置没加载就退回 id */ }
        }
        summary.push(name ? `${name}x${count}` : `物品#${id}x${count}`);
    }
    return summary.join('/');
}

function buildDailyTasksForDebug(taskInfo) {
    const ti = taskInfo && typeof taskInfo === 'object' ? taskInfo : {};
    const dailyList = Array.isArray(ti.daily_tasks) ? ti.daily_tasks : [];
    if (dailyList.length > 0) return dailyList;
    const merged = [
        ...(Array.isArray(ti.tasks) ? ti.tasks : []),
        ...(Array.isArray(ti.growth_tasks) ? ti.growth_tasks : []),
    ];
    return merged.filter((t) => toNum(t && t.task_type) === 2);
}

async function checkAndClaimActives(actives) {
    const list = Array.isArray(actives) ? actives : [];
    let scanned = 0;
    let claimed = 0;
    let errors = 0;
    for (const active of list) {
        const activeType = toNum(active.type);
        const rewards = active.rewards || [];
        const claimable = rewards.filter(r => toNum(r.status) === 2);
        if (!claimable.length) continue;
        scanned += claimable.length;
        const pointIds = claimable.map(r => toNum(r.point_id)).filter(n => n > 0);
        if (!pointIds.length) continue;
        const typeName = activeType === 1 ? '日活跃' : (activeType === 2 ? '周活跃' : `活跃${activeType}`);
        try {
            log('活跃', `${typeName} 发现 ${pointIds.length} 个可领取奖励`, {
                module: 'task', event: '扫描活跃奖励', result: 'ok', activeType, count: pointIds.length
            });
            const reply = await claimDailyReward(activeType, pointIds);
            const items = reply.items || [];
            if (items.length > 0) {
                log('活跃', `${typeName} 领取: ${getRewardSummary(items)}`, {
                    module: 'task', event: '领取活跃奖励', result: 'ok', activeType, count: items.length
                });
            }
            claimed += pointIds.length;
            await sleep(300);
        } catch (e) {
            errors += 1;
            log('活跃', `${typeName} 领取失败: ${e.message}`, {
                module: 'task', event: '领取活跃奖励', result: 'error', activeType
            });
        }
    }
    return { scanned, claimed, errors };
}

// ⭐ 2026-11-22 性能: 图鉴探测(2×getBag + 2×ClaimAllRewardsV2)原先跟着 farm tick
//   每 20~25 秒打一遍且几乎永远空手(≈800 探测 RPC/h)。领奖是进度事件驱动的,
//   60s 节流足够及时 —— 漏领一次下一分钟也能捡回来。
const ILLUSTRATED_PROBE_INTERVAL_MS = 60 * 1000;
let lastIllustratedProbeAt = 0;

async function checkAndClaimIllustratedRewards(force = false) {
    const nowMs = Date.now();
    if (!force && nowMs - lastIllustratedProbeAt < ILLUSTRATED_PROBE_INTERVAL_MS) return false;
    lastIllustratedProbeAt = nowMs;
    try {
        const beforeTicket = await getTicketBalanceFromBag();
        // ⭐ 两类图鉴都要领(抓包: 领奖请求 #1 = 类别, 1=植物 / 101=牧场动物「巨大」页签)
        // 先查有没有可领的再发领奖请求(无可领时省一半请求; 2026-11-22)
        const { getIllustratedList, claimAllRewards } = require('./illustrated');
        const allItems = [];
        const claimedByType = { 1: 0, 101: 0 };
        for (const listType of [1, 101]) {
            try {
                const list = await getIllustratedList({ listType });
                const arr = (list && list.items) || [];
                const hasClaimable = arr.some(it => it && it.planted && !it.has_reward
                    && Number(it.planted_count) > 0
                    && Number(it.harvest_count) >= Number(it.planted_count));
                if (!hasClaimable) continue;
                const reply = await claimAllRewards(listType);
                const got = [
                    ...(Array.isArray(reply && reply.items) ? reply.items : []),
                    ...(Array.isArray(reply && reply.bonus_items) ? reply.bonus_items : []),
                ];
                claimedByType[listType] = got.length;
                allItems.push(...got);
            } catch { /* 单类失败不影响另一类 */ }
        }
        const items = allItems;
        // ⭐ 成功判定不能只看点券(2026-11-22): 巨大(牧场动物)图鉴的奖励是收藏点(3003),
        //   不涨点券 —— 旧判定 gainTicket>=200 让牧场图鉴领奖**永远静默**(领了也不记日志/统计)。
        //   只要服务端返回了奖励条目就算成功。
        if (!items.length) return false;
        const afterTicket = await getTicketBalanceFromBag();
        const gainTicket = Math.max(0, afterTicket - beforeTicket);

        log('任务', `图鉴奖励领取成功 ${items.length} 项${gainTicket > 0 ? `, 点券+${gainTicket}` : ''}${claimedByType[101] > 0 ? `(含巨大图鉴 ${claimedByType[101]})` : ''}`, {
            module: 'task',
            event: '图鉴奖励',
            result: 'ok',
            scope: 'illustrated',
            count: items.length,
        });
        taskClaimDoneDateKey = getDateKey();
        taskClaimLastAt = Date.now();
        recordOperation('taskClaim', 1);
        // 巨大(牧场动物)图鉴单独计数, 便于观察「巨大」页签的领取情况
        if (claimedByType[101] > 0) recordOperation('ranchIllustrated', claimedByType[101]);
        return true;
    } catch {
        return false;
    }
}

// 牧场(大农场)场景 ID —— 见 docs/mc-ranch/牧场任务系统功能文档.md
const RANCH_SCENE_ID = 2;

// ============ 自动领取 ============

async function checkAndClaimTasks() {
    if (checking) return;
    if (!isAutomationOn('task')) return;
    checking = true;
    try {
        const reply = await getTaskInfo();
        if (!reply.task_info) { checking = false; return; }

        const taskInfo = reply.task_info;
        const dailyAll = buildDailyTasksForDebug(taskInfo);

        const dailyClaimable = analyzeTaskList(dailyAll, 'daily');
        const growthClaimable = analyzeTaskList(taskInfo.growth_tasks || [], 'growth');
        const mainClaimable = analyzeTaskList(taskInfo.tasks || [], 'main');
        const claimable = [...dailyClaimable, ...growthClaimable, ...mainClaimable];
        if (claimable.length > 0) {
            log('任务', `发现 ${claimable.length} 个可领取任务`, {
                module: 'task', event: '扫描任务', result: 'ok', count: claimable.length
            });
            if (dailyClaimable.length > 0) {
                log('任务', `每日任务可领取: ${dailyClaimable.map(t => t.desc).join('，')}`, {
                    module: 'task', event: '扫描任务', result: 'ok', count: dailyClaimable.length, scope: 'daily'
                });
            }
            let dailyClaimSuccess = 0;
            for (const task of claimable) {
                const ok = await doClaim(task);
                if (task.category === 'daily' && ok) dailyClaimSuccess += 1;
            }
            if (dailyClaimable.length > 0 && dailyClaimSuccess === 0) {
                log('任务', '每日任务本次未领取成功', {
                    module: 'task', event: '领取任务', result: 'none', scope: 'daily'
                });
            }
        }
        await checkAndClaimActives(taskInfo.actives || []);
        await checkAndClaimIllustratedRewards();
    } catch (e) {
        logWarn('任务', `检查任务失败: ${e.message}`, {
            module: 'task', event: '扫描任务', result: 'error'
        });
    } finally {
        checking = false;
    }
}

/**
 * 「牧场任务」自动领取(2026-11-17, 见 docs/mc-ranch/牧场任务系统功能文档.md)。
 *
 * 牧场任务与农场任务**完全独立**, 共用 TaskService 但列表按 scene_id=2 拉取;
 * 牧场任务只保留 task_type 4(成长)/5(日常)/6(支线), 农场的是 1/2/3。
 * 日常活跃宝箱牧场侧不领取(actives 被客户端过滤)。
 *
 * @returns {{claimable:number, claimed:number, tasks:string[]}}
 */
async function checkAndClaimRanchTasks() {
    const result = { claimable: 0, claimed: 0, tasks: [] };
    if (!isAutomationOn('task')) return result;
    try {
        const reply = await getTaskInfo({ sceneId: RANCH_SCENE_ID });
        const ti = (reply && reply.task_info) || null;
        if (!ti) return result;

        // 只保留牧场任务类型(4/5/6), 兼容分组列表与扁平列表
        const MC_TYPES = new Set([4, 5, 6]);
        const groups = [
            ...(Array.isArray(ti.growth_tasks) ? ti.growth_tasks : []),
            ...(Array.isArray(ti.daily_tasks) ? ti.daily_tasks : []),
            ...(Array.isArray(ti.side_tasks) ? ti.side_tasks : []),
            ...(Array.isArray(ti.tasks) ? ti.tasks : []),
        ];
        const mcTasks = groups.filter(t => MC_TYPES.has(toNum(t && t.task_type)));

        const claimable = analyzeTaskList(mcTasks, 'daily')
            .filter(t => t.progress >= t.totalProgress && !t.isClaimed);
        result.claimable = claimable.length;
        if (claimable.length === 0) return result;

        log('牧场', `发现 ${claimable.length} 个可领取牧场任务`, {
            module: 'ranch', event: '牧场任务', result: 'ok', count: claimable.length,
        });
        for (const task of claimable) {
            const ok = await doClaim(task);
            if (ok) {
                result.claimed += 1;
                result.tasks.push(task.desc);
            }
        }
        if (result.claimed > 0) {
            log('牧场', `领取牧场任务 x${result.claimed}: ${result.tasks.slice(0, 6).join('，')}`, {
                module: 'ranch', event: '牧场任务', result: 'ok', count: result.claimed,
            });
        }
    } catch (e) {
        logWarn('牧场', `牧场任务领取失败: ${e.message}`, {
            module: 'ranch', event: '牧场任务', result: 'error',
        });
    }
    return result;
}

/**
 * 牧场任务只读视图(面板用)。
 *
 * 与 checkAndClaimRanchTasks 的区别: 那个是自动领, 这个是"给人看" ——
 * 返回每条任务的进度/是否已领/奖励, 页面据此渲染列表并允许单条手动领取。
 *
 * @returns {Promise<{tasks:Array<object>, claimable:number, claimed:number}>}
 */
async function getRanchTaskView() {
    const reply = await getTaskInfo({ sceneId: RANCH_SCENE_ID });
    const ti = (reply && reply.task_info) || null;
    if (!ti) return { tasks: [], claimable: 0, claimed: 0 };

    const MC_TYPES = new Set([4, 5, 6]);
    const groups = [
        ...(Array.isArray(ti.growth_tasks) ? ti.growth_tasks : []),
        ...(Array.isArray(ti.daily_tasks) ? ti.daily_tasks : []),
        ...(Array.isArray(ti.side_tasks) ? ti.side_tasks : []),
        ...(Array.isArray(ti.tasks) ? ti.tasks : []),
    ];
    const mcTasks = groups.filter(t => MC_TYPES.has(toNum(t && t.task_type)));

    const TYPE_LABEL = { 4: '成长', 5: '日常', 6: '支线' };
    // ⚠ analyzeTaskList 只返回"可领"的; 面板要展示**全部**任务(含未完成/已领),
    //   所以这里直接遍历原始任务用 formatTask 归一, 再补上 task_type。
    const tasks = mcTasks.map((raw) => {
        const t = formatTask(raw, 'daily');
        const taskType = toNum(raw && raw.task_type);
        return {
            ...t,
            taskType,
            typeLabel: TYPE_LABEL[taskType] || '任务',
            rewardText: getRewardSummary(t.rewards || []),
        };
    });

    return {
        tasks,
        claimable: tasks.filter(t => t.canClaim).length,
        claimed: tasks.filter(t => t.isClaimed).length,
        total: tasks.length,
    };
}

async function doClaim(task) {
    try {
        const useShare = task.shareMultiple > 1;
        const multipleStr = useShare ? ` (${task.shareMultiple}倍)` : '';

        const claimReply = await claimTaskReward(task.id, useShare);
        const items = claimReply.items || [];
        const rewardStr = items.length > 0 ? getRewardSummary(items) : '无';

        const categoryName = task.category === 'daily' ? '每日任务' : (task.category === 'growth' ? '成长任务' : '任务');
        log('任务', `领取(${categoryName}): ${task.desc}${multipleStr} → ${rewardStr}`, {
            module: 'task', event: '领取任务', result: 'ok', taskId: task.id, shared: useShare
        });
        taskClaimDoneDateKey = getDateKey();
        taskClaimLastAt = Date.now();
        recordOperation('taskClaim', 1);
        await sleep(300);
        return true;
    } catch {
        // 领取失败静默处理
        return false;
    }
}

function onTaskInfoNotify(taskInfo) {
    if (!taskInfo) return;
    if (!isAutomationOn('task')) return;

    const claimable = [
        ...analyzeTaskList(taskInfo.daily_tasks || [], 'daily'),
        ...analyzeTaskList(taskInfo.growth_tasks || [], 'growth'),
        ...analyzeTaskList(taskInfo.tasks || [], 'main'),
    ];
    const actives = taskInfo.actives || [];
    const hasClaimable = claimable.length > 0;
    if (!hasClaimable && actives.length === 0) return;
    if (hasClaimable) log('任务', `有 ${claimable.length} 个任务可领取，准备自动领取...`, {
        module: 'task', event: '领取任务', result: 'plan', count: claimable.length
    });
    taskScheduler.setTimeoutTask('task_claim_debounce', 1000, async () => {
        if (hasClaimable) await claimTasksFromList(claimable);
        await checkAndClaimActives(actives);
        await checkAndClaimIllustratedRewards();
    });
}

async function claimTasksFromList(claimable) {
    if (!isAutomationOn('task')) return;
    for (const task of claimable) {
        await doClaim(task);
    }
}

// ============ 初始化 ============

function initTaskSystem() {
    cleanupTaskSystem();
    networkEvents.on('taskInfoNotify', onTaskInfoNotify);
    taskScheduler.setTimeoutTask('task_init_bootstrap', 4000, () => {
        checkAndClaimTasks();
    });
}

function cleanupTaskSystem() {
    networkEvents.off('taskInfoNotify', onTaskInfoNotify);
    taskScheduler.clearAll();
    checking = false;
}

module.exports = {
    getTaskInfo,
    checkAndClaimTasks,
    checkAndClaimRanchTasks,
    getRanchTaskView,
    initTaskSystem,
    cleanupTaskSystem,
    claimTaskReward,
    doClaim, // 供手动领取使用
    getTaskClaimDailyState: () => ({
        key: 'task_claim',
        doneToday: taskClaimDoneDateKey === getDateKey(),
        lastClaimAt: taskClaimLastAt,
    }),
    getTaskDailyStateLikeApp: async () => {
        try {
            const reply = await getTaskInfo();
            const ti = reply && reply.task_info ? reply.task_info : {};
            const dailyAll = buildDailyTasksForDebug(ti);
            const completedDaily = dailyAll.filter((t) => {
                const progress = toNum(t && t.progress);
                const totalProgress = toNum(t && t.total_progress);
                return totalProgress > 0 && progress >= totalProgress;
            });
            const completedCount = Math.min(3, completedDaily.length);
            const pendingDaily = dailyAll.filter((t) => {
                const isUnlocked = !!(t && t.is_unlocked);
                const isClaimed = !!(t && t.is_claimed);
                const totalProgress = toNum(t && t.total_progress);
                return isUnlocked && !isClaimed && totalProgress > 0;
            });
            const dailyClaimable = analyzeTaskList(dailyAll, 'daily');
            return {
                key: 'task_claim',
                // 每日任务总数按 3 计算，完成口径为 progress >= total_progress
                doneToday: completedCount >= 3,
                lastClaimAt: taskClaimLastAt,
                claimableCount: dailyClaimable.length,
                pendingCount: pendingDaily.length,
                completedCount,
                totalCount: 3,
            };
        } catch {
            return {
                key: 'task_claim',
                doneToday: false,
                lastClaimAt: taskClaimLastAt,
                claimableCount: 0,
                pendingCount: 0,
                completedCount: 0,
                totalCount: 3,
            };
        }
    },
    getGrowthTaskStateLikeApp: async () => {
        try {
            const reply = await getTaskInfo();
            const ti = reply && reply.task_info ? reply.task_info : {};
            let growthList = Array.isArray(ti.growth_tasks) ? ti.growth_tasks : [];
            if (growthList.length === 0) {
                // fallback: 从 tasks 中按 task_type=1（成长任务）筛选
                const allTasks = Array.isArray(ti.tasks) ? ti.tasks : [];
                growthList = allTasks.filter((t) => toNum(t && t.task_type) === 1);
            }
            const tasks = growthList.map((t) => {
                const progress = Math.max(0, toNum(t && t.progress));
                const totalProgress = Math.max(0, toNum(t && t.total_progress));
                const isClaimed = !!(t && t.is_claimed);
                const isUnlocked = !!(t && t.is_unlocked);
                const isCompleted = totalProgress > 0 && progress >= totalProgress;
                return {
                    id: toNum(t && t.id),
                    desc: (t && t.desc) || `成长任务#${toNum(t && t.id)}`,
                    progress,
                    totalProgress,
                    isClaimed,
                    isUnlocked,
                    isCompleted,
                };
            });
            const totalCount = tasks.length;
            const completedCount = tasks.filter((t) => t.isCompleted).length;
            return {
                key: 'growth_task',
                doneToday: totalCount > 0 && completedCount >= totalCount,
                completedCount,
                totalCount,
                tasks,
            };
        } catch {
            return {
                key: 'growth_task',
                doneToday: false,
                completedCount: 0,
                totalCount: 0,
                tasks: [],
            };
        }
    },
};
