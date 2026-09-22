const process = require('node:process');
/**
 * 子进程 Worker - 负责运行单个账号的挂机逻辑
 */
const { parentPort, workerData } = require('node:worker_threads');
const { CONFIG } = require('../config/config');
// 线程模式下从 workerData 读取启动模式
if (parentPort && workerData && workerData.startupMode === 'code_refresh') {
    process.env.FARM_STARTUP_MODE = 'code_refresh';
}
const { getLevelExpProgress } = require('../config/gameConfig');
const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot, getBuyBookConfig } = require('../models/store');
const { checkAndClaimEmails } = require('../services/email');
const { getEmailDailyState } = require('../services/email');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, getLandsDetail, getAvailableSeeds, buySeed, runFarmOperation, runFertilizerByConfig } = require('../services/farm');
const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, runBadOnceOnStartup, isHelpExpLimitReached, getFriendsList, getFriendLandsDetail, doFriendOperation } = require('../services/friend');
const { getInteractRecords } = require('../services/interact');
const { processInviteCodes } = require('../services/invite');
const { autoBuyOrganicFertilizer, autoBuyFertilizer, checkAndBuyFertilizerBoth, buyFreeGifts, getFreeGiftDailyState, checkAndBuyChallengeBooks } = require('../services/mall');
const { getMallCatalog, purchaseCatalogGoods } = require('../services/mall');
const treasureRob = require('../services/treasure-rob');
const { getActivityOverview, drawLottery, drawActivity, claimBattlePassRewards, claimActivityTasks, claimDailySignin, exchangeShopGoods, performQingniangBrew, sellQingniangBrew, shareSellQingniangBrew, getStarActivityOverview, exchangeStarShopGoods, lightUpStarRegister, checkAndLightUpStar } = require('../services/activity');
const { performDailyMonthCardGift, getMonthCardDailyState } = require('../services/monthcard');
const { performDailyVipGift, getVipDailyState } = require('../services/qqvip');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { performDailyShare, getShareDailyState } = require('../services/share');
const { setInitialValues, resetSessionGains, recordOperation, initStatsWithPersistence, saveStats } = require('../services/stats');
const { initStatusBar, setStatusPlatform, statusData } = require('../services/status');
const { setRecordGoldExpHook } = require('../services/status');
const { cleanupTaskSystem, checkAndClaimTasks, getTaskClaimDailyState, getTaskDailyStateLikeApp, getGrowthTaskStateLikeApp } = require('../services/task');
const { getActiveMysteryShop, buyMysteryGoods, checkAndBuyMysteryShop } = require('../services/mystery-shop');
const { getSolarTerms, claimSolarTerms, checkAndClaimSolarTerms } = require('../services/solarterms');
const { sellAllFruits, getBag, getBagItems, openFertilizerGiftPacksSilently } = require('../services/warehouse');
if (parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}
const { activateDog, deployDog, withdrawDog, feedDog, getDogStatus, getPetBagInfo, getDogFoodList, getPetList, getGuardLogs, getGuardReward, claimGuardReward, getCapitalMode, setCapitalMode } = require('../services/pet');
const { connect, reconnect, cleanup, getWs, getUserState, networkEvents, isConnected, disableAutoReconnect, getWsErrorState } = require('../utils/network');
const { loadProto } = require('../utils/proto');
const { setLogHook, log, logWarn, toNum } = require('../utils/utils');

function sendToMaster(payload) {
    if (process.send) {
        process.send(payload);
        return;
    }
    if (parentPort) {
        parentPort.postMessage(payload);
    }
}

function onMasterMessage(handler) {
    if (process.send) {
        process.on('message', handler);
    }
    if (parentPort) {
        parentPort.on('message', handler);
    }
}

function exitWorker(code = 0) {
    if (parentPort) {
        try {
            parentPort.close();
        } catch {}
        return;
    }
    process.exit(code);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLocalDateTime24(date = new Date()) {
    const d = date instanceof Date ? date : new Date();
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

let loginMode = 'start';
let suppressRefreshLogs = process.env.FARM_STARTUP_MODE === 'code_refresh';

function shouldSuppressRefreshLog(tag, msg, isWarn, meta) {
    if (!suppressRefreshLogs) return false;
    if (isWarn) return false;
    if (meta && meta.result === 'error') return false;
    const text = `${tag || ''} ${msg || ''}`;
    // 刷新期间的日志只允许关键消息通过
    if (text.includes('正在获取新 Code') || text.includes('已获取到 code') || text.includes('已使用新 code') || text.includes('Code 刷新')) return false;
    return true;
}

// 捕获日志发送给主进程
setLogHook((tag, msg, isWarn, meta) => {
    if (shouldSuppressRefreshLog(tag, msg, isWarn, meta || {})) return;
    sendToMaster({
        type: 'log',
        data: {
            time: formatLocalDateTime24(new Date()),
            tag,
            msg,
            isWarn,
            meta: meta || {},
        }
    });
});

// 捕获金币经验变化
setRecordGoldExpHook((gold, exp) => {
    // 更新内部统计
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);

    // 发送给主进程
    sendToMaster({ type: 'stat_update', data: { gold, exp } });
});

let isRunning = false;
let loginReady = false;

/**
 * 定时任务统一闸门
 *
 * ⚠ 历史 bug: 各处只用 loginReady 判断, 而 loginReady 只在"暂停等 Code / 停账号"时被复位。
 *   WS 被服务端关掉(掉线、心跳超时重连拿到 400 等)时 loginReady 仍是 true, 于是所有定时任务
 *   继续拿一个**已关闭的 socket** 发请求, 每 20s 刷一条"连接未打开: TaskInfo/Bag/...",
 *   而状态栏用的是 ws.readyState → 界面显示"已离线"。两者判据不一致, 就成了
 *   "显示离线 + 一直报错"的僵尸状态。
 *   现在统一用 canRunTasks(): 既要登录过, 也要 socket 真的可用。
 */
function canRunTasks() {
    return !!(loginReady && isConnected());
}

/**
 * 当前"为什么不在线"的可读原因(推给面板, 免得用户只看到"已离线"却不知道原因)
 * null = 在线
 */
let connectionDownInfo = null;

function setConnectionDown(reason, detail = '') {
    connectionDownInfo = { reason, detail: detail || reason, since: Date.now() };
}

function clearConnectionDown() {
    connectionDownInfo = null;
}
let appliedConfigRevision = 0;
let unifiedSchedulerRunning = false;
let farmTaskRunning = false;
let nextFarmRunAt = 0;
let lastStatusHash = '';
let lastStatusSentAt = 0;
let onSellGain = null;
let onFarmHarvested = null;
let harvestSellRunning = false;
let onWsError = null;
let onDisconnected = null;
let wsErrorHandledAt = 0;
let lastDailyRunDate = '';
let keepRunningOnKickout = false;
const workerScheduler = createScheduler('worker');

function isDailyRoutineEnabled(_auto) {
    // 每日任务默认启用，不再检查开关
    return true;
}

function getLocalDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function runDailyRoutines(force = false) {
    if (!canRunTasks()) return;
    try {
        // 以下功能默认启用，不再检查开关
        await checkAndClaimEmails(force);
        await performDailyShare(force);
        await performDailyMonthCardGift(force);
        await buyFreeGifts(force);
        await performDailyVipGift(force);
        await checkAndBuyMysteryShop();
        await checkAndLightUpStar();
        await checkAndClaimSolarTerms();
        await require('../services/weather').checkAndRunWeatherTasks();
        await require('../services/weather').checkAndRunWeatherResearch();
        await require('../services/charity').checkAndRunCharityTasks();
        await require('../services/mengchong').checkAndRunMengchongTasks();
        // 每日购买中级挑战书(150 金豆豆/个, 数量可在设置里调)
        await runBuyChallengeBooks('daily_routine');
    } catch (e) {
        log('系统', `每日任务调度失败: ${e.message}`, { module: 'system', event: '每日任务', result: 'error' });
    }
}

let lastTreasureRobAt = 0;

function stopDailyRoutineTimer() {
    workerScheduler.clear('daily_routine_interval');
    workerScheduler.clear('mystery_shop_interval');
    workerScheduler.clear('treasure_rob_interval');
    workerScheduler.clear('escort_settle_interval');
    workerScheduler.clear('buy_book_interval');
}

/**
 * 每日购买中级挑战书 —— 独立检查(不依赖"每日任务"的触发时机)
 * 之前只挂在 runDailyRoutines 里, 而它只在"登录后 / 跨日"才跑,
 * 于是中途打开开关要等到第二天才生效。现在每 10 分钟自查一次:
 *   已按目标买满当天 → 直接返回(零网络请求), 有缺口才去商城买。
 */
async function runBuyChallengeBooks(reason = 'interval') {
    if (!canRunTasks()) return { skipped: true, reason: 'offline' };
    const cfg = getBuyBookConfig();
    if (!cfg.enabled || cfg.count <= 0) return { skipped: true, reason: 'disabled' };
    try {
        const r = await checkAndBuyChallengeBooks(false, cfg.count);
        if (r.boughtNow > 0) {
            log('商城', `每日购买中级挑战书: 本次 ${r.boughtNow} 本, 累计 ${r.bought}/${r.target} (150 金豆豆/个${r.gameDailyLimit ? `, 游戏每日限购 ${r.gameDailyLimit}` : ''})`, {
                module: 'mall', event: '购买挑战书', result: 'ok', trigger: reason,
            });
        } else if (r.ok === false) {
            log('商城', `每日购买中级挑战书未完成: ${r.skipped || '未知原因'}`, { module: 'mall', event: '购买挑战书', result: 'warn', trigger: reason });
        }
        return r;
    } catch (e) {
        log('商城', `每日购买中级挑战书失败: ${e.message}`, { module: 'mall', event: '购买挑战书', result: 'error', trigger: reason });
        return { ok: false, error: e.message };
    }
}

function startDailyRoutineTimer() {
    stopDailyRoutineTimer();
    lastDailyRunDate = getLocalDateKey();
    // 新账号登录后按当前设置强制执行一次领取
    runDailyRoutines(true).catch(() => null);
    workerScheduler.setIntervalTask('daily_routine_interval', 30 * 1000, () => {
        if (!canRunTasks()) return;
        const today = getLocalDateKey();
        if (today === lastDailyRunDate) return;
        lastDailyRunDate = today;
        runDailyRoutines(true).catch(() => null);
    });
    // 神秘商店 NPC 会在一天中随时刷新，定时检测自动购买（开关关闭时内部直接返回）
    workerScheduler.setIntervalTask('mystery_shop_interval', 10 * 60 * 1000, () => {
        if (!canRunTasks()) return;
        checkAndBuyMysteryShop().catch(() => null);
    }, { preventOverlap: true });
    // 夺宝: 60s 轮询一次, 内部按"配置的检查间隔"节流(这样改间隔不用重启 worker)
    workerScheduler.setIntervalTask('treasure_rob_interval', 60 * 1000, () => {
        if (!canRunTasks()) return;
        const intervalMs = treasureRob.getAutoRobIntervalMs();
        if (Date.now() - lastTreasureRobAt < intervalMs) return;
        lastTreasureRobAt = Date.now();
        treasureRob.checkAndRobTreasure().catch(() => null);
    }, { preventOverlap: true });
    // 护送结算领取: 护送结束(到期/被夺满/爆仓)后宝藏资金要主动领, 官方客户端打开活动页时自动领;
    // 这里每 5 分钟查一次, 有"已结束未领取"的才发领取请求(领取成功会写进抢夺记录)
    workerScheduler.setIntervalTask('escort_settle_interval', 5 * 60 * 1000, () => {
        if (!canRunTasks()) return;
        treasureRob.checkAndClaimEscortSettlement().catch(() => null);
    }, { preventOverlap: true });
    // 每日购买中级挑战书: 每 10 分钟自查(买满当天就不再发请求)
    workerScheduler.setIntervalTask('buy_book_interval', 10 * 60 * 1000, () => {
        runBuyChallengeBooks('interval').catch(() => null);
    }, { preventOverlap: true });
}

function normalizeIntervalRangeSec(minSec, maxSec, fallbackSec) {
    const fallback = Math.max(1, Number.parseInt(fallbackSec, 10) || 1);
    let min = Math.max(1, Number.parseInt(minSec, 10) || fallback);
    let max = Math.max(1, Number.parseInt(maxSec, 10) || fallback);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals) {
    const data = (intervals && typeof intervals === 'object') ? intervals : {};

    const farmLegacy = Math.max(1, Number.parseInt(data.farm, 10) || 2);
    const farmRange = normalizeIntervalRangeSec(data.farmMin, data.farmMax, farmLegacy);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    // 帮助和偷菜的独立间隔
    const helpRange = normalizeIntervalRangeSec(data.helpMin, data.helpMax, 10);
    CONFIG.helpCheckIntervalMin = helpRange.min * 1000;
    CONFIG.helpCheckIntervalMax = helpRange.max * 1000;

    const stealRange = normalizeIntervalRangeSec(data.stealMin, data.stealMax, 10);
    CONFIG.stealCheckIntervalMin = stealRange.min * 1000;
    CONFIG.stealCheckIntervalMax = stealRange.max * 1000;
}

function randomIntervalMs(minMs, maxMs) {
    const minSec = Math.max(1, Math.floor(Math.max(1000, Number(minMs) || 1000) / 1000));
    const maxSec = Math.max(minSec, Math.floor(Math.max(1000, Number(maxMs) || minSec * 1000) / 1000));
    if (maxSec === minSec) return minSec * 1000;
    const sec = minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
    return sec * 1000;
}

function resetUnifiedSchedule() {
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    const helpMs = randomIntervalMs(
        CONFIG.helpCheckIntervalMin || 10000,
        CONFIG.helpCheckIntervalMax || 10000
    );
    const stealMs = randomIntervalMs(
        CONFIG.stealCheckIntervalMin || 10000,
        CONFIG.stealCheckIntervalMax || 10000
    );
    const now = Date.now();
    nextFarmRunAt = now + farmMs;
    nextHelpRunAt = now + helpMs;
    nextStealRunAt = now + stealMs;
}

async function runFarmTick(auto) {
    if (farmTaskRunning) return;
    farmTaskRunning = true;
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    try {
        if (auto.farm) await checkFarm();
        if (auto.task) await checkAndClaimTasks();
        if (auto.email) await checkAndClaimEmails();
        if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
    } catch {
        // ignore
    } finally {
        nextFarmRunAt = Date.now() + farmMs;
        farmTaskRunning = false;
    }
}

// ============ 帮助巡查（独立调度） ============
let helpTaskRunning = false;
let nextHelpRunAt = 0;

async function runHelpTick(auto) {
    if (helpTaskRunning) {
        return;
    }
    if (!auto.friend_help) {
        return;
    }
    // 检查是否开启了经验满不帮忙，且经验已达上限
    const stopWhenExpLimit = !!auto.friend_help_exp_limit;
    if (stopWhenExpLimit && isHelpExpLimitReached()) {
        // 计算下次调度时间，但不执行巡查
        const helpMs = randomIntervalMs(
            CONFIG.helpCheckIntervalMin || 10000,
            CONFIG.helpCheckIntervalMax || 10000
        );
        nextHelpRunAt = Date.now() + helpMs;
        return;
    }
    helpTaskRunning = true;
    const helpMs = randomIntervalMs(
        CONFIG.helpCheckIntervalMin || 10000,
        CONFIG.helpCheckIntervalMax || 10000
    );
    //log('系统', `帮助巡查开始执行，下次间隔 ${helpMs}ms`, { module: 'system', event: '帮助巡查', result: 'start', intervalMs: helpMs });
    try {
        await checkFriends({ onlyHelp: true });
    } catch (e) {
        log('系统', `帮助巡查执行失败: ${e.message}`, { module: 'system', event: '帮助巡查', result: 'error' });
    } finally {
        nextHelpRunAt = Date.now() + helpMs;
        helpTaskRunning = false;
       // log('系统', `帮助巡查执行完成，下次执行时间: ${new Date(nextHelpRunAt).toISOString()}`, { module: 'system', event: '帮助巡查', result: 'done', nextRunAt: nextHelpRunAt });
    }
}

// ============ 偷菜巡查（独立调度） ============
let stealTaskRunning = false;
let nextStealRunAt = 0;

async function runStealTick(auto) {
    if (stealTaskRunning) {
        //log('系统', '偷菜巡查跳过：正在执行中', { module: 'system', event: '偷菜巡查', result: 'skipped', reason: 'running' });
        return;
    }
    if (!auto.friend_steal) {
       // log('系统', '偷菜巡查跳过：功能未开启', { module: 'system', event: '偷菜巡查', result: 'skipped', reason: 'disabled' });
        return;
    }
    stealTaskRunning = true;
    const stealMs = randomIntervalMs(
        CONFIG.stealCheckIntervalMin || 10000,
        CONFIG.stealCheckIntervalMax || 10000
    );
    try {
        await checkFriends({ onlySteal: true });
    } catch (e) {
        log('系统', `偷菜巡查执行失败: ${e.message}`, { module: 'system', event: '偷菜巡查', result: 'error' });
    } finally {
        nextStealRunAt = Date.now() + stealMs;
        stealTaskRunning = false;
    }
}

async function runUnifiedTick() {
    if (!unifiedSchedulerRunning || !canRunTasks()) return;
    const now = Date.now();
    const dueFarm = now >= nextFarmRunAt;
    const dueHelp = now >= nextHelpRunAt;
    const dueSteal = now >= nextStealRunAt;
    if (!dueFarm && !dueHelp && !dueSteal) return;

    const auto = getAutomation();
    // 串行执行而非并行，避免并发请求过多导致超时
    if (dueFarm) await runFarmTick(auto);
    if (dueHelp) await runHelpTick(auto);
    if (dueSteal) await runStealTick(auto);
}

function scheduleUnifiedNextTick() {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');
    if (!canRunTasks()) return;

    const now = Date.now();
    const nextAt = Math.min(
        Number(nextFarmRunAt) || (now + 1000),
        Number(nextHelpRunAt) || (now + 1000),
        Number(nextStealRunAt) || (now + 1000)
    );
    const delayMs = Math.max(1000, nextAt - now); // 最低 1 秒

    workerScheduler.setTimeoutTask('unified_next_tick', delayMs, async () => {
        try {
            await runUnifiedTick();
        } finally {
            scheduleUnifiedNextTick();
        }
    });
}

function startUnifiedScheduler() {
    if (unifiedSchedulerRunning) return;
    unifiedSchedulerRunning = true;
    resetUnifiedSchedule();
    scheduleUnifiedNextTick();
}

function stopUnifiedScheduler() {
    unifiedSchedulerRunning = false;
    farmTaskRunning = false;
    helpTaskRunning = false;
    stealTaskRunning = false;
    workerScheduler.clear('unified_next_tick');
}

/** 只在本进程第一次登录成功时跑一次的动作(邀请码/化肥礼包/放虫放草) */
let startupOnceDone = false;

function pauseForCodeRefresh() {
    loginReady = false;
    loginMode = 'refresh';
    suppressRefreshLogs = true;
    stopUnifiedScheduler();
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopDailyRoutineTimer();
    workerScheduler.clear('bad_startup_once');
    workerScheduler.clear('daily_routine_immediate');
    workerScheduler.clear('fertilizer_immediate_after_save');
}

function applyRuntimeConfig(snapshot, syncNow = false) {
    const prevAuto = getAutomation();
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, 'keepRunningOnKickout')) {
        keepRunningOnKickout = !!snapshot.keepRunningOnKickout;
    }
    applyConfigSnapshot(snapshot || {}, { persist: false, accountId });
    const rev = Number((snapshot || {}).__revision || 0);
    if (rev > 0) appliedConfigRevision = rev;

    // 优先使用本次下发的间隔，避免 worker 内部 store 漂移导致回退默认值
    const incomingIntervals = (snapshot && snapshot.intervals && typeof snapshot.intervals === 'object')
        ? snapshot.intervals
        : null;
    if (incomingIntervals) {
        applyIntervalsToRuntime(incomingIntervals);
    }

    if (loginReady) {
        refreshFarmCheckLoop(200);
        refreshFriendCheckLoop(200);
        resetUnifiedSchedule();
        scheduleUnifiedNextTick();

        // 保存设置后若“自动处理日常”开启，则立即执行一次
        const hasAutomationPayload = !!(snapshot && snapshot.automation && typeof snapshot.automation === 'object');
        if (hasAutomationPayload) {
            const nextAuto = getAutomation();
            const wasEnabled = isDailyRoutineEnabled(prevAuto);
            const nowEnabled = isDailyRoutineEnabled(nextAuto);
            if (!wasEnabled && nowEnabled) {
                // 保存设置时 /api/automation 可能触发多次 config_sync，这里做防抖且仅关->开触发
                workerScheduler.setTimeoutTask('daily_routine_immediate', 400, () => {
                    runDailyRoutines(true).catch(() => null);
                });
            }

            // 神秘商店自动购买 关->开 时立即检测一次
            if (!(prevAuto && prevAuto.mystery_shop) && (nextAuto && nextAuto.mystery_shop)) {
                workerScheduler.setTimeoutTask('mystery_shop_immediate', 500, () => {
                    if (!canRunTasks()) return;
                    checkAndBuyMysteryShop().catch(() => null);
                });
            }

            // 千星游记自动点亮 关->开 时立即执行一次
            if (!(prevAuto && prevAuto.star_light_up) && (nextAuto && nextAuto.star_light_up)) {
                workerScheduler.setTimeoutTask('star_light_up_immediate', 500, () => {
                    if (!canRunTasks()) return;
                    checkAndLightUpStar().catch(() => null);
                });
            }

            // 打开"每日购买中级挑战书"后立即试一次(不必等到明天)
            workerScheduler.setTimeoutTask('buy_book_immediate', 3000, () => {
                if (!canRunTasks()) return;
                const now = getBuyBookConfig();
                if (now.enabled && now.count > 0) runBuyChallengeBooks('config_changed').catch(() => null);
            });

            // 夺宝自动抢夺 关->开 时立即执行一次
            if (!(prevAuto && prevAuto.rob_treasure) && (nextAuto && nextAuto.rob_treasure)) {
                workerScheduler.setTimeoutTask('treasure_rob_immediate', 600, () => {
                    if (!canRunTasks()) return;
                    lastTreasureRobAt = Date.now();
                    treasureRob.runAutoRobTreasure().catch(() => null);
                });
            }

            // 节令小礼自动领取 关->开 时立即执行一次
            if (!(prevAuto && prevAuto.solar_terms) && (nextAuto && nextAuto.solar_terms)) {
                workerScheduler.setTimeoutTask('solar_terms_immediate', 500, () => {
                    if (!canRunTasks()) return;
                    checkAndClaimSolarTerms().catch(() => null);
                });
            }

            // 雨落成诗每日任务 关->开 时立即执行一次
            if (!(prevAuto && prevAuto.weather_task) && (nextAuto && nextAuto.weather_task)) {
                workerScheduler.setTimeoutTask('weather_task_immediate', 500, () => {
                    if (!canRunTasks()) return;
                    require('../services/weather').checkAndRunWeatherTasks().catch(() => null);
                });
            }

            // 雨落成诗气象研究 关->开 时立即执行一次
            if (!(prevAuto && prevAuto.weather_research) && (nextAuto && nextAuto.weather_research)) {
                workerScheduler.setTimeoutTask('weather_research_immediate', 500, () => {
                    if (!canRunTasks()) return;
                    require('../services/weather').checkAndRunWeatherResearch().catch(() => null);
                });
            }

            // 公益小红花每日任务 关->开 时立即执行一次
            if (!(prevAuto && prevAuto.charity_task) && (nextAuto && nextAuto.charity_task)) {
                workerScheduler.setTimeoutTask('charity_task_immediate', 500, () => {
                    if (!canRunTasks()) return;
                    require('../services/charity').checkAndRunCharityTasks().catch(() => null);
                });
            }

            // 萌宠游记每日任务 关->开 时立即执行一次
            if (!(prevAuto && prevAuto.mengchong_task) && (nextAuto && nextAuto.mengchong_task)) {
                workerScheduler.setTimeoutTask('mengchong_task_immediate', 500, () => {
                    if (!canRunTasks()) return;
                    require('../services/mengchong').checkAndRunMengchongTasks().catch(() => null);
                });
            }

            const prevFertilizerMode = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const nextFertilizerMode = String(nextAuto && nextAuto.fertilizer ? nextAuto.fertilizer : '').toLowerCase();
            const fertilizerChanged = prevFertilizerMode !== nextFertilizerMode;
            // if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic')) {
            if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic' || nextFertilizerMode === 'smart')) {
                // 保存设置时 /api/automation 可能连续触发多次 config_sync，这里做防抖为一次立即施肥
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 600, async () => {
                    if (!canRunTasks()) return;
                    try {
                        // await runFertilizerByConfig([]);
                        await runFertilizerByConfig([], { skipNormal: true });
                    } catch (e) {
                        log('施肥', `保存配置后立即施肥失败: ${e.message}`, {
                            module: 'farm',
                            event: '施肥',
                            result: 'error',
                        });
                    }
                });
            }
        }
    }

    if (syncNow) syncStatus();
}

// 接收主进程指令
onMasterMessage(async (msg) => {
    try {
        if (msg.type === 'start') {
            await startBot(msg.config);
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            handleApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        }
    } catch (e) {
        sendToMaster({ type: 'error', error: e.message });
    }
});

async function startBot(config) {
    if (isRunning) return;
    isRunning = true;
    loginMode = process.env.FARM_STARTUP_MODE === 'code_refresh' ? 'refresh' : 'start';
    suppressRefreshLogs = loginMode === 'refresh';

    const { code, platform } = config;
    keepRunningOnKickout = !!(config && config.keepRunningOnKickout);

    CONFIG.platform = platform || 'qq';
    // 注意：间隔配置由 applyIntervalsToRuntime 统一处理，不要在这里覆盖

    await loadProto();

    log('系统', suppressRefreshLogs ? '正在获取新 Code...' : '正在连接服务器...');

    // 加载保存的配置
    applyRuntimeConfig(getConfigSnapshot(), false);

    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    if (onDisconnected) {
        networkEvents.off('disconnected', onDisconnected);
        onDisconnected = null;
    }
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (payload) => {
        if ((Number(payload?.code) || 0) !== 400) return;
        const now = Date.now();
        // 同一类 400 每分钟只处理/记一次: 自动重连会反复拿旧 Code 重试, 别把日志刷爆
        if (now - wsErrorHandledAt < 60000) return;
        wsErrorHandledAt = now;
        logWarn('系统', '连接被拒绝(HTTP 400)：Code 已失效，需要更新 Code；任务已暂停，将按退避策略重试');
        setConnectionDown('Code 已失效，请更新 Code', '服务端拒绝连接(HTTP 400)，Code 已失效；任务已暂停，更新 Code 后会自动恢复');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: payload?.message || '',
        });
        if (isRunning) {
            workerScheduler.setTimeoutTask('ws_error_cleanup', 1000, () => {
                if (isRunning) cleanup();
            });
        }
    };
    networkEvents.on('ws_error', onWsError);

    // 连接断开: 立刻关掉任务闸门, 避免拿死连接空转发请求刷屏(只打一条日志, 别每 20s 一条)
    onDisconnected = (payload) => {
        const wasOnline = loginReady;
        loginReady = false;                       // 立刻关闸门: 别再拿死连接发请求
        const errState = getWsErrorState();
        const codeInvalid = Number(errState && errState.code) === 400;
        setConnectionDown(
            codeInvalid ? 'Code 已失效，请更新 Code' : '连接已断开，正在自动重连',
            codeInvalid
                ? `服务端拒绝连接(HTTP 400)，Code 已失效；已暂停自动任务，更新 Code 后会自动恢复`
                : `连接已断开${payload && payload.code ? ` (code=${payload.code})` : ''}，已暂停自动任务，正在按退避策略自动重连`,
        );
        // 只在"本来在线"时提示一次; 启动就连不上的情况由 ws_error(400) 那条日志说明
        if (wasOnline) {
            logWarn('系统', `连接已断开${payload && payload.code ? ` (code=${payload.code})` : ''}，已暂停自动任务，正在按退避策略自动重连…`);
        }
        syncStatus();
    };
    networkEvents.on('disconnected', onDisconnected);

    networkEvents.on('kickout', onKickout);

    const onLoginSuccess = async () => {
        const isCodeRefresh = loginMode === 'refresh';
        loginReady = true;
        clearConnectionDown();
        if (onSellGain) {
            networkEvents.off('sell', onSellGain);
        }
        onSellGain = (deltaGold) => {
            const delta = Number(deltaGold || 0);
            if (!Number.isFinite(delta) || delta <= 0) return;
            recordOperation('sell', 1);
        };
        networkEvents.on('sell', onSellGain);

        if (onFarmHarvested) {
            networkEvents.off('farmHarvested', onFarmHarvested);
        }
        onFarmHarvested = async () => {
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await sellAllFruits();
            } catch (e) {
                log('仓库', `收获后自动出售失败: ${e.message}`, { module: 'warehouse', event: '收获后出售', result: 'error' });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        // 登录后主动拉一次背包，初始化点券(ID:1002)数量
        try {
            const bagReply = await getBag();
            const items = getBagItems(bagReply);
            let coupon = 0;
            for (const it of (items || [])) {
                if (toNum(it && it.id) === 1002) {
                    coupon = toNum(it.count);
                    break;
                }
            }
            const state = getUserState();
            state.coupon = Math.max(0, coupon);
        } catch {
            // ignore
        }
        // 登录成功后，以当前金币/经验/点券作为统计基线，并清空会话增量
        const latest = getUserState();
        const accountId = process.env.FARM_ACCOUNT_ID || '';
        initStatsWithPersistence(accountId, Number(latest.gold || 0), Number(latest.exp || 0), Number(latest.coupon || 0));
        resetSessionGains();

        if (!isCodeRefresh) {
            // 登录成功后启动各模块
            // ⚠ 邀请码/化肥礼包/放虫放草只应在"本进程第一次登录"时执行:
            //   掉线自动重连也会走这里, 否则每次重连都会再放一遍虫草、再开一批礼包。
            if (!startupOnceDone) {
                startupOnceDone = true;
                await processInviteCodes();
                if (getAutomation().fertilizer_gift) {
                    await openFertilizerGiftPacksSilently().catch(() => 0);
                }

                // 启动时执行一次放虫放草（只在账号启动时执行）
                workerScheduler.setTimeoutTask('bad_startup_once', 10000, async () => {
                    try {
                        await runBadOnceOnStartup();
                    } catch (e) {
                        log('好友', `启动时放虫放草执行失败: ${e.message}`, { module: 'friend', event: '启动放虫放草失败', error: e.message });
                    }
                });
            }

            startFarmCheckLoop({ externalScheduler: true });
            startFriendCheckLoop({ externalScheduler: true });
            startUnifiedScheduler();
            // 每日礼包/任务改为跨日调度，不在农场轮询内执行
            startDailyRoutineTimer();
        } else {
            // 刷新 Code 后，循环已被 pauseForCodeRefresh 完全停止，需要重新启动
            log('系统', `已获取到 code：${code.substring(0, 8)}...`);
            log('系统', '已使用新 code 连接成功');
            startFarmCheckLoop({ externalScheduler: true });
            startFriendCheckLoop({ externalScheduler: true });
            startUnifiedScheduler();
            startDailyRoutineTimer();
            // 刷新成功后恢复正常日志输出
            suppressRefreshLogs = false;
            loginMode = 'running';
        }

        // 立即发送一次状态
        syncStatus();
    };

    connect(code, onLoginSuccess);

    // 启动定时状态同步
    workerScheduler.setIntervalTask('status_sync', 3000, syncStatus, { preventOverlap: true });
}

async function stopBot() {
    if (!isRunning) return exitWorker(0);
    saveStats();
    isRunning = false;
    loginReady = false;
    disableAutoReconnect();   // 先停自动重连, 再关 socket
    stopUnifiedScheduler();
    networkEvents.off('kickout', onKickout);
    if (onDisconnected) {
        networkEvents.off('disconnected', onDisconnected);
        onDisconnected = null;
    }
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopDailyRoutineTimer();
    cleanupTaskSystem();
    workerScheduler.clearAll();
    cleanup();
    const ws = getWs();
    if (ws) ws.close();
    exitWorker(0);
}

function waitForLoginReady(timeoutMs) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
        function check() {
            if (loginReady) return resolve(true);
            if (Date.now() - startedAt >= timeoutMs) return resolve(false);
            workerScheduler.setTimeoutTask('refresh_code_login_wait', 500, check);
        }
        check();
    });
}

async function refreshCode(newCode) {
    const code = String(newCode || '').trim();
    if (!code) {
        throw new Error('missing_code');
    }
    if (!isRunning) {
        throw new Error('账号未运行');
    }
    pauseForCodeRefresh();
    try {
        reconnect(code);
        const ok = await waitForLoginReady(30000);
        if (!ok) {
            throw new Error('code_refresh_login_timeout');
        }
        log('系统', `已使用新 code 连接成功：${code.substring(0, 8)}...`);
        return { ok: true };
    } finally {
        loginMode = 'running';
        suppressRefreshLogs = false;
    }
}

function onKickout(payload) {
    const reason = payload && payload.reason ? payload.reason : '未知';
    if (keepRunningOnKickout) {
        pauseForCodeRefresh();
        log('系统', `检测到踢下线，已保留账号运行等待 Code 刷新。原因: ${reason}`);
        sendToMaster({ type: 'account_kicked', reason });
        return;
    }
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${reason}`);
    sendToMaster({ type: 'account_kicked', reason });
    workerScheduler.setTimeoutTask('kickout_stop', 200, () => {
        stopBot().catch(() => exitWorker(0));
    });
}

// 处理来自 Admin 面板的直接调用请求 (如: 购买种子、开关设置等)
async function handleApiCall(msg) {
    const { id, method, args } = msg;
    let result = null;
    let error = null;

    try {
        switch (method) {
            case 'getLands':
                result = await getLandsDetail();
                break;
            case 'getFriends':
                result = await getFriendsList(args[0] === true);
                break;
            case 'clearFriendsCache':
                require('../services/friend').clearFriendsListCache();
                result = { ok: true };
                break;
            case 'getInteractRecords':
                result = await getInteractRecords();
                break;
            case 'getFriendLands':
                result = await getFriendLandsDetail(args[0]);
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1]);
                break;
            case 'getSeeds': {
                const { getSeedImageBySeedId } = require('../config/gameConfig');
                const seeds = await getAvailableSeeds();
                result = (seeds || []).map(s => ({
                    ...s,
                    image: getSeedImageBySeedId(s.seedId),
                }));
                break;
            }
            case 'buySeed': {
                const [goodsId, num, price] = args;
                result = await buySeed(goodsId, num, price);
                break;
            }
            case 'getMysteryShop':
                result = await getActiveMysteryShop();
                break;
            case 'buyMystery':
                result = await buyMysteryGoods(args[0]);
                break;
            case 'getBag':
                result = await require('../services/warehouse').getBagDetail();
                break;
            case 'getWeatherOverview':
                result = await require('../services/weather').getWeatherOverview();
                break;
            case 'buyWeatherBottle':
                result = await require('../services/weather').buyCollectBottle(args[0] || 1);
                break;
            case 'useWeatherBottleOnFriend':
                result = await require('../services/weather').useCollectBottleOnFriend(args[0]);
                break;
            case 'runWeatherTasksNow':
                result = await require('../services/weather').autoRunDailyWeatherTasks();
                break;
            case 'useWeatherThunderBottle':
                result = await require('../services/weather').useThunderBottleSelf();
                break;
            case 'upgradeWeatherResearch':
                result = await require('../services/weather').upgradeResearchTier(args[0]);
                break;
            case 'runWeatherResearchNow':
                result = await require('../services/weather').checkAndRunWeatherResearch();
                break;
            case 'getCharityOverview':
                result = await require('../services/charity').getCharityOverview();
                break;
            case 'claimCharityGift':
                result = await require('../services/charity').claimCharityGift();
                break;
            case 'sendCharityLove':
                result = await require('../services/charity').sendCharityLove();
                break;
            case 'claimCharityTier':
                result = await require('../services/charity').claimCharityTier(args[0]);
                break;
            case 'shareCharity':
                result = await require('../services/charity').shareCharity();
                break;
            case 'runCharityTasksNow':
                result = await require('../services/charity').autoRunCharityTasks();
                break;
            case 'getMengchongOverview':
                result = await require('../services/mengchong').getMengchongOverview();
                break;
            case 'claimMengchongFreeGift':
                result = await require('../services/mengchong').claimFreeSeedGift();
                break;
            case 'feedMengchongPet':
                result = await require('../services/mengchong').feedPet();
                break;
            case 'getFarmRipeness':
                result = await require('../services/farm').getNextRipeness();
                break;
            case 'getMengchongShop':
                result = await require('../services/mengchong').getMengchongShop();
                break;
            case 'exchangeMengchongShopGoods':
                result = await require('../services/mengchong').exchangeMengchongShopGoods(args[0], args[1]);
                break;
            case 'autoFeedMengchongPet':
                result = await require('../services/mengchong').autoFeedPet(args[0] || {});
                break;
            case 'claimMengchongBearPet':
                result = await require('../services/mengchong').claimBearPet();
                break;
            case 'refreshMengchongWishBags':
                result = await require('../services/mengchong').refreshWishBags();
                break;
            case 'selectMengchongCharm':
                result = await require('../services/mengchong').selectCharmById(args[0]);
                break;
            case 'selectMengchongWishBag':
                result = await require('../services/mengchong').selectWishBag(args[0]);
                break;
            case 'getMengchongRules':
                result = await require('../services/mengchong').getMengchongRules();
                break;
            case 'mengchongTreasureHunt':
                result = await require('../services/mengchong').treasureHunt();
                break;
            case 'unlockMengchongHandnote':
                result = await require('../services/mengchong').unlockPetHandnote(args[0]);
                break;
            case 'claimMengchongHandnote':
                result = await require('../services/mengchong').claimPetHandnote(args[0]);
                break;
            case 'mengchongOperate':
                result = await require('../services/mengchong').petOperate(args[0] || {});
                break;
            case 'runMengchongTasksNow':
                result = await require('../services/mengchong').autoRunMengchongTasks();
                break;
            case 'getIllustrated': {
                const { getIllustratedOverview } = require('../services/illustrated');
                const { getPlantNameBySeedId, getSeedImageBySeedId, getPlantBySeedId, getPlantByFruitId } = require('../config/gameConfig');
                const overview = await getIllustratedOverview();
                overview.items = (overview.items || []).map((it) => {
                    const plant = getPlantBySeedId(it.seedId) || getPlantByFruitId(it.seedId);
                    return {
                        ...it,
                        name: getPlantNameBySeedId(it.seedId),
                        image: getSeedImageBySeedId(it.seedId),
                        requiredLevel: plant ? (Number(plant.land_level_need) || 0) : 0,
                    };
                }).sort((a, b) => (a.requiredLevel - b.requiredLevel) || (a.seedId - b.seedId));
                result = overview;
                break;
            }
            case 'claimIllustrated':
                result = await require('../services/illustrated').claimIllustratedRewards();
                break;
            case 'getBagSeeds':
                result = await require('../services/warehouse').getBagSeeds();
                break;
            case 'useItem': {
                const { useItem: _useItem } = require('../services/warehouse');
                const itemId = Number(args[0]) || 0;
                const count = Math.max(1, Number(args[1]) || 1);
                result = await _useItem(itemId, count, []);
                break;
            }
            case 'sellItems': {
                const { sellItems: _sell } = require('../services/warehouse');
                const sellList = Array.isArray(args[0]) ? args[0] : [];
                result = await _sell(sellList.map(it => ({ id: it.id, count: it.count, uid: it.uid || 0 })));
                break;
            }
            case 'setAutomation': {
                const payload = args && args[0] ? args[0] : {};
                applyRuntimeConfig({ automation: { [payload.key]: payload.value } }, true);
                result = getAutomation();
                break;
            }
            case 'doFarmOp':
                result = await runFarmOperation(args[0]); // opType
                break;
            case 'buyFertilizer': {
                const fertilizerType = args[0] || 'organic';
                const fertilizerCount = Number(args[1]) || 0;
                result = await autoBuyFertilizer(true, fertilizerType, fertilizerCount);
                break;
            }
            case 'checkAndBuyFertilizer': {
                const options = args[0] || {};
                result = await checkAndBuyFertilizerBoth(options);
                break;
            }
            case 'getAnalytics': {
                const { getPlantRankings } = require('../services/analytics');
                result = getPlantRankings(args[0]); // sortBy
                break;
            }
            case 'getDailyGiftOverview':
                result = await getDailyGiftOverview();
                break;
            case 'getSchedulers':
                result = getSchedulerRegistrySnapshot();
                break;
            case 'refreshCode':
                result = await refreshCode(args[0]);
                break;
            case 'beginCodeRefresh':
                pauseForCodeRefresh();
                result = { ok: true };
                break;

            case 'getMallCatalog': {
                // provider 传的是 { slotType }; 之前直接把对象当 slotType 用导致永远按 1 查
                const options = args[0] || {};
                const slot = Number(options && typeof options === 'object' ? options.slotType : options);
                result = await getMallCatalog(Number.isFinite(slot) && slot > 0 ? slot : 1);
                break;
            }
            case 'purchaseMallGoods': {
                const [goodsId, count, slotType, source, shopId] = args;
                result = await purchaseCatalogGoods(goodsId, count, slotType, source, shopId);
                break;
            }
            case 'getActivityOverview':
                result = await getActivityOverview(args[0] || {});
                break;
            case 'drawActivityLottery':
                result = await drawLottery(args[0] || {});
                break;
            case 'drawActivity':
                result = await drawActivity(args[0] || {});
                break;
            case 'performQingniangBrew':
                result = await performQingniangBrew(args[0] || {});
                break;
            case 'sellQingniangBrew':
                result = await sellQingniangBrew(args[0] || {});
                break;
            case 'shareSellQingniangBrew':
                result = await shareSellQingniangBrew(args[0] || {});
                break;
            case 'claimActivityBattlePass':
                result = await claimBattlePassRewards();
                break;
            case 'claimActivityTasks':
                result = await claimActivityTasks(args[0] || {});
                break;
            case 'claimActivityDailySignin':
                result = await claimDailySignin(args[0] || {});
                break;
            case 'exchangeActivityGoods':
                result = await exchangeShopGoods(args[0] || {});
                break;
            case 'getStarActivity':
                result = await getStarActivityOverview();
                break;
            case 'exchangeStarGoods':
                result = await exchangeStarShopGoods(args[0] || {});
                break;
            case 'lightUpStar':
                result = await lightUpStarRegister(args[0] || {});
                break;
            // ===== 夺宝(抢宝) =====
            case 'getTreasureBooks':
                result = { books: await treasureRob.getBookInventory() };
                break;
            case 'getTreasureTargets': {
                const opt = args[0] || {};
                if (opt.gid) {
                    result = { gid: Number(opt.gid), treasures: await treasureRob.queryFriendTreasures(opt.gid) };
                } else {
                    result = await treasureRob.collectTargets(opt);
                }
                break;
            }
            case 'getTreasureMyStatus':
                result = await treasureRob.getMyTreasureStatus();
                break;
            case 'buyChallengeBooks': {
                const opt = args[0] || {};
                const cfgNow = getBuyBookConfig();
                const count = Math.max(0, Math.min(20, toNum(opt.count) || cfgNow.count || 0));
                result = await checkAndBuyChallengeBooks(!!opt.force, count);
                // 把这几个数字打进日志: 排查"为什么没买"时一眼能看出是谁拦住的
                log('商城', `手动购买挑战书: ${result.boughtNow > 0 ? `成功 ${result.boughtNow} 本` : `未购买(${result.skipped || '未知'})`}` +
                    ` | 机器人计数 ${result.todayBoughtByBot}/${result.target}` +
                    ` | 游戏侧已购 ${result.gameBought === null || result.gameBought === undefined ? '?' : result.gameBought}/${result.gameDailyLimit || '不限'}` +
                    ` | 本次计划 ${result.need === undefined ? '?' : result.need} 本`, {
                    module: 'mall', event: '购买挑战书', result: result.boughtNow > 0 ? 'ok' : 'warn', manual: true,
                });
                break;
            }
            case 'claimTreasureSettlement':
                result = await treasureRob.claimEscortSettlement();
                break;
            case 'checkAndClaimEscortSettlement':
                result = await treasureRob.checkAndClaimEscortSettlement();
                break;
            case 'listTreasureRobRecords':
                result = treasureRob.listRobRecords(args[0] || {});
                break;
            case 'clearTreasureRobRecords':
                result = treasureRob.clearRobRecords();
                break;
            case 'robTreasure': {
                const opt = args[0] || {};
                result = await treasureRob.robOnce({
                    gid: opt.gid,
                    treasureId: opt.treasureId,
                    bookItemId: opt.bookItemId,
                    friendName: opt.friendName || '',
                    source: opt.source || 'manual',
                    verify: opt.verify !== false,
                });
                break;
            }
            case 'runTreasureRobNow':
                result = await treasureRob.runAutoRobTreasure(args[0] || {});
                break;
            case 'getSolarTerms':
                result = await getSolarTerms();
                break;
            case 'claimSolarTerms':
                result = await claimSolarTerms(args[0]);
                break;
             case 'activateDog': {
                 const [activateTypeId] = args;
                 result = await activateDog(activateTypeId);
                 break;
             }
             case 'feedDog': {
                 const [feedItemId, feedCount] = args;
                 result = await feedDog(feedItemId, feedCount);
                 break;
             }
             case 'getDogStatus':
                 result = await getDogStatus(args[0] || 0);
                 break;
             case 'getDogFoodList':
                 result = await getDogFoodList();
                 break;
             case 'getPetList':
                 result = await getPetList();
                 break;
             case 'deployDog': {
                 const [deployTypeId] = args;
                 result = await deployDog(deployTypeId);
                 break;
             }
             case 'withdrawDog':
                 result = await withdrawDog();
                 break;
             case 'getPetBagInfo':
                 result = await getPetBagInfo(args[0] || null);
                 break;
             case 'getGuardLogs': {
                 const [guardPage, guardPageSize] = args;
                 result = await getGuardLogs(guardPage, guardPageSize);
                 break;
             }
             case 'getGuardReward':
                 result = await getGuardReward();
                 break;
             case 'claimGuardReward':
                 result = await claimGuardReward();
                 break;
             case 'getCapitalMode':
                 result = await getCapitalMode();
                 break;
             case 'setCapitalMode': {
                 const [capitalConfig] = args;
                 result = await setCapitalMode(capitalConfig);
                 break;
             }
            default:
                error = 'Unknown method';
        }
    } catch (e) {
        error = e.message;
    }

    sendToMaster({ type: 'api_response', id, result, error });
}

async function getDailyGiftOverview() {
    const auto = getAutomation() || {};
    const task = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp()
        : (getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 });
    const growthTask = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp()
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };
    const email = getEmailDailyState ? getEmailDailyState() : { doneToday: false, lastCheckAt: 0 };
    const free = getFreeGiftDailyState ? getFreeGiftDailyState() : { doneToday: false, lastClaimAt: 0 };
    const share = getShareDailyState ? getShareDailyState() : { doneToday: false, lastClaimAt: 0 };
    const vip = getVipDailyState ? getVipDailyState() : { doneToday: false, lastClaimAt: 0 };
    const month = getMonthCardDailyState ? getMonthCardDailyState() : { doneToday: false, lastClaimAt: 0 };

    return {
        date: new Date().toISOString().slice(0, 10),
        growth: {
            key: 'growth_task',
            label: '成长任务',
            doneToday: !!growthTask.doneToday,
            completedCount: Number(growthTask.completedCount || 0),
            totalCount: Number(growthTask.totalCount || 0),
            tasks: Array.isArray(growthTask.tasks) ? growthTask.tasks : [],
        },
        gifts: [
            {
                key: 'task_claim',
                label: '每日任务',
                enabled: !!auto.task,
                doneToday: !!task.doneToday,
                lastAt: Number(task.lastClaimAt || 0),
                completedCount: Number(task.completedCount || 0),
                totalCount: Number(task.totalCount || 3),
            },
            // 以下功能默认启用，enabled 固定为 true
            { key: 'email_rewards', label: '邮箱奖励', enabled: true, doneToday: !!email.doneToday, lastAt: Number(email.lastCheckAt || 0) },
            { key: 'mall_free_gifts', label: '商城免费礼包', enabled: true, doneToday: !!free.doneToday, lastAt: Number(free.lastClaimAt || 0) },
            { key: 'daily_share', label: '分享礼包', enabled: true, doneToday: !!share.doneToday, lastAt: Number(share.lastClaimAt || 0) },
            {
                key: 'vip_daily_gift',
                label: '会员礼包',
                enabled: true,
                doneToday: !!vip.doneToday,
                lastAt: Number(vip.lastClaimAt || vip.lastCheckAt || 0),
                hasGift: Object.prototype.hasOwnProperty.call(vip, 'hasGift') ? !!vip.hasGift : undefined,
                canClaim: Object.prototype.hasOwnProperty.call(vip, 'canClaim') ? !!vip.canClaim : undefined,
                result: vip.result || '',
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: true,
                doneToday: !!month.doneToday,
                lastAt: Number(month.lastClaimAt || month.lastCheckAt || 0),
                hasCard: Object.prototype.hasOwnProperty.call(month, 'hasCard') ? !!month.hasCard : undefined,
                hasClaimable: Object.prototype.hasOwnProperty.call(month, 'hasClaimable') ? !!month.hasClaimable : undefined,
                result: month.result || '',
            },
        ],
    };
}

function syncStatus() {
    if (!process.send && !parentPort) return;

    const userState = getUserState();
    const ws = getWs();
    const connected = !!(loginReady && ws && ws.readyState === 1);
    if (connected && connectionDownInfo) connectionDownInfo = null;

    let expProgress = null;
    const level = (userState.level ?? statusData.level ?? 0);
    const exp = (userState.exp ?? statusData.exp ?? 0);

    if (level > 0 && exp >= 0) {
        expProgress = getLevelExpProgress(level, exp);
    }

    const limits = require('../services/friend').getOperationLimits();
    const fullStats = require('../services/stats').getStats(statusData, userState, connected, limits);
    const nowMs = Date.now();
    const farmRemainSec = Math.max(0, Math.ceil((Number(nextFarmRunAt || 0) - nowMs) / 1000));
    const helpRemainSec = Math.max(0, Math.ceil((Number(nextHelpRunAt || 0) - nowMs) / 1000));
    const stealRemainSec = Math.max(0, Math.ceil((Number(nextStealRunAt || 0) - nowMs) / 1000));
    fullStats.nextChecks = {
        farmRemainSec,
        helpRemainSec,
        stealRemainSec,
        friendRemainSec: Math.max(helpRemainSec, stealRemainSec),
    };

    if (fullStats.connection) {
        fullStats.connection = {
            ...fullStats.connection,
            connected,
            reason: connected ? '' : (connectionDownInfo ? connectionDownInfo.reason : ''),
            detail: connected ? '' : (connectionDownInfo ? connectionDownInfo.detail : ''),
            since: connected ? 0 : (connectionDownInfo ? connectionDownInfo.since : 0),
        };
    }
    fullStats.automation = getAutomation();
    fullStats.preferredSeed = getPreferredSeed();
    fullStats.levelProgress = expProgress;
    fullStats.configRevision = appliedConfigRevision;
    const hash = JSON.stringify(fullStats);
    const now = Date.now();
    if (hash !== lastStatusHash || now - lastStatusSentAt > 8000) {
        lastStatusHash = hash;
        lastStatusSentAt = now;
        sendToMaster({ type: 'status_sync', data: fullStats });
    }
}

