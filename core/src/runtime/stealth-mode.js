/**
 * 防封号(低调)模式调度器 —— 运行在**主进程**侧
 *
 * 目的: 不要让对方服务器看到账号 7x24 在线。做法是"在线一小段时间 → 离线一大段时间"循环,
 *       同时保证作物成熟时能及时上线收取。
 *
 * 关键点:
 * - worker 是独立进程, 由 worker-manager 启停; 本模块只负责"什么时候停 / 什么时候启"
 * - 下线前先问 worker 要一次作物成熟时间(getFarmRipeness), 用它可以:
 *     · 很快就要熟(小于一个离线窗口) → 这次不折腾, 留在线上把这一波收完
 *     · 还要很久才熟 → 离线, 但离线时长不超过"成熟时间 + 缓冲", 到点自动上线
 * - qcby 取码调度器会"自动启动"账号, 必须通过 isOfflineByStealth() 让它尊重本模块的离线状态
 */

const { getStealthConfig } = require('../models/store');
const { log: rawLog, toNum } = require('../utils/utils');

function createStealthMode(options = {}) {
    const {
        scheduler,
        startWorker,
        stopWorker,
        callWorkerApi,
        findAccountByAnyRef,
        addAccountLog,
        log = (msg) => rawLog('防封号', msg, { module: 'system', event: '防封号' }),
    } = options;

    function accountOf(accountId) {
        try {
            return (typeof findAccountByAnyRef === 'function' ? findAccountByAnyRef(accountId) : null) || {};
        } catch (e) { return {}; }
    }

    /** 同时写全局日志流(带账号归属)与账号日志流 */
    function notify(accountId, action, msg, meta = {}) {
        const acc = accountOf(accountId);
        try {
            log(msg, { accountId: String(accountId), accountName: acc.name || '', module: 'system', event: '防封号', ...meta });
        } catch (e) { /* 忽略 */ }
        accountLog(accountId, action, msg, meta);
    }

    /** 账号维度日志(会显示在该账号的运行日志里) */
    function accountLog(accountId, action, msg, meta = {}) {
        if (typeof addAccountLog !== 'function') return;
        try {
            const acc = (typeof findAccountByAnyRef === 'function' ? findAccountByAnyRef(accountId) : null) || {};
            addAccountLog(action, msg, String(accountId), acc.name || '', meta);
        } catch (e) { /* 忽略 */ }
    }

    const states = new Map(); // accountId -> state
    let running = false;

    function stateOf(accountId) {
        const id = String(accountId || '');
        if (!states.has(id)) {
            states.set(id, {
                accountId: id,
                phase: 'unknown',        // online | offline
                nextSwitchAt: 0,         // 下次切换(上线/下线)时间戳(ms)
                lastReason: '',
                onlineSince: 0,
                offlineSince: 0,
                cycles: 0,
                ripeness: null,          // 上次读取到的成熟信息
            });
        }
        return states.get(id);
    }

    function randomBetween(min, max) {
        const lo = Math.min(min, max);
        const hi = Math.max(min, max);
        return lo + Math.random() * (hi - lo);
    }

    function clearTimers(accountId) {
        if (!scheduler) return;
        if (typeof scheduler.clear === 'function') {
            scheduler.clear(`stealth_off_${accountId}`);
            scheduler.clear(`stealth_on_${accountId}`);
        }
    }

    /** 该账号当前是否"因为防封号模式而处于离线" */
    function isOfflineByStealth(accountId) {
        const st = states.get(String(accountId || ''));
        return !!(st && st.phase === 'offline');
    }

    function statusList() {
        const out = [];
        for (const st of states.values()) {
            const cfg = getStealthConfig(st.accountId);
            out.push({
                accountId: st.accountId,
                enabled: cfg.enabled,
                phase: st.phase,
                nextSwitchAt: st.nextSwitchAt,
                nextSwitchInSec: st.nextSwitchAt ? Math.max(0, Math.round((st.nextSwitchAt - Date.now()) / 1000)) : 0,
                lastReason: st.lastReason,
                onlineSince: st.onlineSince,
                offlineSince: st.offlineSince,
                cycles: st.cycles,
                ripeness: st.ripeness,
                config: cfg,
            });
        }
        return out;
    }

    /** 安排"下线"的时间点(在线窗口内随机) */
    function scheduleOffline(accountId) {
        const cfg = getStealthConfig(accountId);
        const st = stateOf(accountId);
        if (!cfg.enabled) {
            st.phase = st.phase === 'unknown' ? 'online' : st.phase;
            st.nextSwitchAt = 0;
            return;
        }
        const sec = randomBetween(cfg.onlineMinMinutes, cfg.onlineMaxMinutes) * 60;
        st.phase = 'online';
        if (!st.onlineSince) st.onlineSince = Date.now();
        st.nextSwitchAt = Date.now() + sec * 1000;
        st.lastReason = `在线中(本轮 ${Math.round(sec / 60)} 分钟)`;
        if (!scheduler || typeof scheduler.setTimeoutTask !== 'function') return;
        scheduler.setTimeoutTask(`stealth_off_${accountId}`, sec * 1000, () => { void goOffline(accountId); });
        log(`账号 ${accountId} 防封号: 将在 ${Math.round(sec / 60)} 分钟后下线`);
        notify(accountId, 'stealth_plan', `防封号: 本次计划在线 ${Math.round(sec / 60)} 分钟, 之后自动下线`, { reason: 'plan', onlineSeconds: Math.round(sec) });
    }

    /** 下线: 先算成熟时间, 决定离线时长 */
    async function goOffline(accountId) {
        const cfg = getStealthConfig(accountId);
        const st = stateOf(accountId);
        if (!cfg.enabled) { st.nextSwitchAt = 0; return; }

        // 先问 worker 作物情况(此刻还在线)
        let ripe = null;
        try {
            if (typeof callWorkerApi === 'function') {
                ripe = await callWorkerApi(accountId, 'getFarmRipeness', []);
                st.ripeness = ripe && ripe.ok !== false
                    ? {
                        ripeCount: toNum(ripe.ripeCount),
                        nextReadyAt: toNum(ripe.nextReadyAt),
                        checkedAt: Date.now(),
                    }
                    : null;
            }
        } catch (e) {
            st.ripeness = null;
            log(`账号 ${accountId} 读取作物成熟时间失败: ${e.message}`);
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const nextReadyAt = st.ripeness ? toNum(st.ripeness.nextReadyAt) : 0;
        const timeToRipeSec = nextReadyAt > nowSec ? nextReadyAt - nowSec : 0;

        // 成熟就在眼前(不足一个最短离线窗口) → 不值得下线, 留在线上把这波收完再走
        if (nextReadyAt > 0 && timeToRipeSec > 0 && timeToRipeSec < cfg.offlineMinMinutes * 60) {
            const waitSec = timeToRipeSec + 30;   // 成熟后再多留 30 秒把活儿干完
            st.phase = 'online';
            st.nextSwitchAt = Date.now() + waitSec * 1000;
            st.lastReason = `${Math.max(1, Math.round(timeToRipeSec / 60))} 分钟后有作物成熟, 保持在线`;
            if (scheduler && typeof scheduler.setTimeoutTask === 'function') {
                scheduler.setTimeoutTask(`stealth_off_${accountId}`, waitSec * 1000, () => { void goOffline(accountId); });
            }
            log(`账号 ${accountId} 防封号: 作物将在 ${Math.round(timeToRipeSec / 60)} 分钟后成熟, 本次不下线`);
            notify(accountId, 'stealth_hold', `防封号: ${Math.max(1, Math.round(timeToRipeSec / 60))} 分钟后有作物成熟, 保持在线收取`, { reason: 'ripe_soon' });
            return;
        }

        // 计算离线时长: 随机窗口; 若成熟的更早, 则提前上线(留 10 秒缓冲)
        let offlineSec = randomBetween(cfg.offlineMinMinutes, cfg.offlineMaxMinutes) * 60;
        let reason = `离线中(随机 ${Math.round(offlineSec / 60)} 分钟)`;
        if (cfg.wakeForRipe && nextReadyAt > nowSec) {
            const wakeSec = Math.max(30, timeToRipeSec + 10);
            if (wakeSec < offlineSec) {
                offlineSec = wakeSec;
                reason = `${Math.round(timeToRipeSec / 60)} 分钟后作物成熟, 提前上线收取`;
            }
        } else if (cfg.wakeForRipe && st.ripeness && toNum(st.ripeness.ripeCount) > 0) {
            // 还有熟着的作物没收完 → 不收完不下线
            st.lastReason = `仍有 ${toNum(st.ripeness.ripeCount)} 块地已成熟, 保持在线收取`;
            st.nextSwitchAt = Date.now() + 60 * 1000;
            if (scheduler && typeof scheduler.setTimeoutTask === 'function') {
                scheduler.setTimeoutTask(`stealth_off_${accountId}`, 60 * 1000, () => { void goOffline(accountId); });
            }
            log(`账号 ${accountId} 防封号: 仍有 ${toNum(st.ripeness.ripeCount)} 块地已成熟, 暂不下线`);
            notify(accountId, 'stealth_hold', `防封号: 仍有 ${toNum(st.ripeness.ripeCount)} 块地已成熟, 保持在线收取`, { reason: 'has_ripe' });
            return;
        }

        // 执行下线(带原因, 会写入该账号的运行日志)
        const wakeAt = new Date(Date.now() + offlineSec * 1000);
        const wakeText = `预计 ${wakeAt.toLocaleTimeString('zh-CN', { hour12: false })} 上线`;
        const stopReason = `防封号模式: 主动下线 —— ${reason}，${wakeText}`;
        try {
            if (typeof stopWorker === 'function') stopWorker(accountId, { reason: stopReason, byStealth: true });
        } catch (e) {
            log(`账号 ${accountId} 下线失败: ${e.message}`);
            notify(accountId, 'stealth_error', `防封号: 下线失败 - ${e.message}`, { reason: 'stop_failed' });
        }
        st.phase = 'offline';
        st.offlineSince = Date.now();
        st.nextSwitchAt = Date.now() + offlineSec * 1000;
        st.lastReason = reason;
        st.cycles += 1;
        log(`账号 ${accountId} 防封号: 已下线, ${Math.round(offlineSec / 60)} 分钟后上线 (${reason})`);

        if (scheduler && typeof scheduler.setTimeoutTask === 'function') {
            scheduler.setTimeoutTask(`stealth_on_${accountId}`, offlineSec * 1000, () => { void goOnline(accountId); });
        }
    }

    /** 上线: 启动 worker(自动做收取/种植等), 并安排下一次下线 */
    function goOnline(accountId) {
        const cfg = getStealthConfig(accountId);
        const st = stateOf(accountId);
        clearTimers(accountId);
        if (!cfg.enabled) { st.phase = 'unknown'; st.nextSwitchAt = 0; return; }
        try {
            const account = typeof findAccountByAnyRef === 'function' ? findAccountByAnyRef(accountId) : null;
            if (!account) {
                st.phase = 'offline';
                st.lastReason = '账号不存在, 等待中';
                st.nextSwitchAt = Date.now() + 5 * 60 * 1000;
                if (scheduler && typeof scheduler.setTimeoutTask === 'function') {
                    scheduler.setTimeoutTask(`stealth_on_${accountId}`, 5 * 60 * 1000, () => { void goOnline(accountId); });
                }
                return;
            }
            if (typeof startWorker === 'function') startWorker(account);
            st.phase = 'online';
            st.onlineSince = Date.now();
            st.offlineSince = 0;
            log(`账号 ${accountId} 防封号: 已上线收取`);
            notify(accountId, 'stealth_online', '防封号: 已到点上线, 开始收取作物', { reason: 'wake_up' });
        } catch (e) {
            log(`账号 ${accountId} 上线失败: ${e.message}`);
        }
        scheduleOffline(accountId);
    }

    /** worker 启动后调用, 重新开始计时(用户手动启动 / 取码启动 / 自我唤醒 都会走到) */
    function onAccountStarted(accountId) {
        const cfg = getStealthConfig(accountId);
        if (!cfg.enabled) return;
        clearTimers(accountId);
        scheduleOffline(accountId);
    }

    /** 账号被停止/删除时清理 */
    function onAccountStopped(accountId, options2 = {}) {
        clearTimers(accountId);
        const st = stateOf(accountId);
        if (options2.byStealth) return;             // 我们自己停的: 保留离线状态, 等唤醒
        st.phase = 'unknown';
        st.nextSwitchAt = 0;
        st.lastReason = '';
    }

    /** 开关或参数变化时, 对所有已运行账号重排 */
    function refreshAll() {
        for (const st of states.values()) {
            const cfg = getStealthConfig(st.accountId);
            if (!cfg.enabled) {
                clearTimers(st.accountId);
                st.phase = 'unknown';
                st.nextSwitchAt = 0;
                st.lastReason = '';
                continue;
            }
            if (st.phase === 'online') scheduleOffline(st.accountId);
        }
    }

    function start() {
        running = true;
    }

    return {
        start,
        isRunning: () => running,
        isOfflineByStealth,
        statusList,
        stateOf,
        onAccountStarted,
        onAccountStopped,
        goOnline,
        goOffline,
        refreshAll,
    };
}

module.exports = { createStealthMode };
