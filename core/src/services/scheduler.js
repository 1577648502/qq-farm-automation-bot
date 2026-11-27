const { createModuleLogger } = require('./logger');

const schedulerLogger = createModuleLogger('scheduler');
const schedulerRegistry = new Map(); // namespace -> { createdAt, timers: Map<taskName, TaskMeta> }

function toDelayMs(value, fallbackMs = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return Math.max(0, fallbackMs | 0);
    return Math.max(0, Math.floor(n));
}

function ensureNamespaceStore(namespace) {
    const key = String(namespace || 'default');
    const existed = schedulerRegistry.get(key);
    if (existed) return existed;
    const created = {
        namespace: key,
        createdAt: Date.now(),
        timers: new Map(),
    };
    schedulerRegistry.set(key, created);
    return created;
}

function normalizeTaskSnapshot(taskName, meta) {
    const item = meta || {};
    return {
        name: String(taskName || ''),
        kind: item.kind || 'timeout',
        delayMs: Math.max(0, Number(item.delayMs) || 0),
        createdAt: Number(item.createdAt) || 0,
        nextRunAt: Number(item.nextRunAt) || 0,
        lastRunAt: Number(item.lastRunAt) || 0,
        runCount: Number(item.runCount) || 0,
        running: !!item.running,
        preventOverlap: item.preventOverlap !== false,
    };
}

function getSchedulerRegistrySnapshot(namespace = '') {
    const ns = String(namespace || '').trim();
    const list = [];
    for (const [name, store] of schedulerRegistry.entries()) {
        if (ns && name !== ns) continue;
        const tasks = [];
        for (const [taskName, meta] of store.timers.entries()) {
            tasks.push(normalizeTaskSnapshot(taskName, meta));
        }
        tasks.sort((a, b) => a.name.localeCompare(b.name));
        list.push({
            namespace: name,
            createdAt: Number(store.createdAt) || 0,
            taskCount: tasks.length,
            tasks,
        });
    }
    list.sort((a, b) => a.namespace.localeCompare(b.namespace));
    return {
        generatedAt: Date.now(),
        schedulerCount: list.length,
        schedulers: list,
    };
}

function createScheduler(namespace = 'default') {
    const name = String(namespace || 'default');
    const store = ensureNamespaceStore(name);
    const timers = store.timers;

    function clear(taskName) {
        const key = String(taskName || '');
        const entry = timers.get(key);
        if (!entry) return false;
        timers.delete(key);
        if (entry.kind === 'interval') {
            clearInterval(entry.handle);
        } else {
            clearTimeout(entry.handle);
        }
        return true;
    }

    function clearAll() {
        const keys = Array.from(timers.keys());
        for (const key of keys) clear(key);
    }

    function setTimeoutTask(taskName, delayMs, taskFn) {
        const key = String(taskName || '');
        if (!key) throw new Error('taskName 不能为空');
        if (typeof taskFn !== 'function') throw new Error(`timeout 任务 ${key} 缺少回调函数`);
        clear(key);
        const delay = toDelayMs(delayMs, 0);
        const entry = {
            kind: 'timeout',
            delayMs: delay,
            createdAt: Date.now(),
            nextRunAt: Date.now() + delay,
            lastRunAt: 0,
            runCount: 0,
            running: false,
            preventOverlap: true,
            handle: null,
        };
        const handle = setTimeout(async () => {
            const current = timers.get(key);
            if (!current || current.handle !== handle) return;
            current.running = true;
            current.lastRunAt = Date.now();
            current.runCount += 1;
            try {
                await taskFn();
            } catch (e) {
                schedulerLogger.warn(`[${name}] timeout 任务执行失败: ${key}`, {
                    module: 'scheduler',
                    scope: name,
                    task: key,
                    error: e && e.message ? e.message : String(e),
                });
            } finally {
                // 只删除自己，避免删掉 taskFn 执行期间注册的新 entry
                const after = timers.get(key);
                if (after && after.handle === handle) {
                    timers.delete(key);
                }
            }
        }, delay);
        entry.handle = handle;
        timers.set(key, entry);
        return handle;
    }

    function setIntervalTask(taskName, intervalMs, taskFn, options = {}) {
        const key = String(taskName || '');
        if (!key) throw new Error('taskName 不能为空');
        if (typeof taskFn !== 'function') throw new Error(`interval 任务 ${key} 缺少回调函数`);
        clear(key);

        const delay = Math.max(1, toDelayMs(intervalMs, 1000));
        const preventOverlap = options.preventOverlap !== false;
        const runImmediately = !!options.runImmediately;
        const entry = {
            kind: 'interval',
            delayMs: delay,
            createdAt: Date.now(),
            nextRunAt: Date.now() + delay,
            lastRunAt: 0,
            runCount: 0,
            running: false,
            preventOverlap,
            handle: null,
            taskFn,   // rescheduleTask 重建 runner 时要用
        };

        if (runImmediately) {
            timers.set(key, entry);
            startIntervalLoop(key, entry, delay);
            Promise.resolve().then(entry.taskFn).catch(() => null);
        } else {
            startIntervalLoop(key, entry, delay);
            timers.set(key, entry);
        }
        return entry.handle;
    }

    /** 动态改 interval 周期(下次触发起生效): 用于按状态调整扫描节奏(如神秘商店空窗放宽) */
    function rescheduleTask(taskName, intervalMs) {
        const key = String(taskName || '');
        const entry = timers.get(key);
        if (!entry || entry.kind !== 'interval') return false;
        const delay = Math.max(1, toDelayMs(intervalMs, entry.delayMs));
        if (delay === entry.delayMs) return true;   // 周期没变, 不重启计时器
        entry.delayMs = delay;
        clearInterval(entry.handle);
        return startIntervalLoop(key, entry, delay);
    }

    function startIntervalLoop(key, entry, delay) {
        const runner = async () => {
            const current = timers.get(key);
            if (!current || current.handle !== entry.handle) return;
            if (entry.preventOverlap && current.running) return;
            current.running = true;
            current.lastRunAt = Date.now();
            current.runCount += 1;
            try {
                await entry.taskFn();
            } catch (e) {
                schedulerLogger.warn(`[${name}] interval 任务执行失败: ${key}`, {
                    module: 'scheduler',
                    scope: name,
                    task: key,
                    error: e && e.message ? e.message : String(e),
                });
            } finally {
                const updated = timers.get(key);
                if (updated && updated.handle === entry.handle) {
                    updated.running = false;
                    updated.nextRunAt = Date.now() + delay;
                }
            }
        };
        const handle = setInterval(runner, delay);
        entry.handle = handle;
        return true;
    }

    function has(taskName) {
        return timers.has(String(taskName || ''));
    }

    function getTaskNames() {
        return Array.from(timers.keys());
    }

    function getSnapshot() {
        const one = getSchedulerRegistrySnapshot(name);
        return one.schedulers[0] || { namespace: name, createdAt: Date.now(), taskCount: 0, tasks: [] };
    }

    return {
        setTimeoutTask,
        setIntervalTask,
        rescheduleTask,
        clear,
        clearAll,
        has,
        getTaskNames,
        getSnapshot,
    };
}

module.exports = {
    createScheduler,
    getSchedulerRegistrySnapshot,
};
