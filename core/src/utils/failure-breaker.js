/**
 * 周期任务的连续失败熔断器。
 *
 * 背景(2026-11-22 "照顾动物失败"刷屏教训): 未知错误码/持续故障会让每轮
 * 巡查都撞同一个失败点, 每轮打一条 warn —— 没有任何东西拦住它。
 * 顶层退避(ranchFailStreak)只管整轮异常, 管不到子操作。
 *
 * 行为(threshold=3, cooldownMs=30min 为默认):
 *   - 失败次数 < threshold: failure() 返回 false, 调用方照常打失败日志
 *   - 第 threshold 次失败: 返回 'open'(调用方打一条"暂停"提示), 熔断开始
 *   - 熔断期间 isOpen()=true: 调用方直接跳过该操作, 不发请求不打日志
 *   - cooldown 过后自动半开: isOpen()=false 放行一轮试探;
 *     试探再失败 → failure() 返回 'extend' 静默续期(不刷日志);
 *     试探成功(下一个运行轮次的 isOpen() 到来且中间没有 failure)→ 自动完全复位
 *   - CLOSED 状态下, 上一个运行轮次没报 failure(即成功了)→ 失败计数清零
 *   - success() 手动完全复位(guardPeriodic 在 happy path 已挂)
 *
 * 约定: 每轮任务在尝试前恰好调用一次 isOpen()(所有接入点均为
 * `if (... && !X.isOpen()) try {...}` 或入口守卫写法)。复位逻辑靠
 * "isOpen() 返回 false = 本轮真正运行" 这一节奏推断成功, 不要求
 * happy path 挂 success() —— 对任何轮询间隔(20秒/60分钟)都成立。
 *
 * 用法(runRanchCare 子操作同款):
 *   if (!breakers.harvest.isOpen()) {
 *     try { await doHarvest(); }
 *     catch (e) {
 *       const st = breakers.harvest.failure();
 *       if (st === 'open') logWarn(.., `收获连续失败, 暂停30分钟: ${e.message}`);
 *       else if (!st)      logWarn(.., `收获失败: ${e.message}`);
 *       // 'extend' → 静默(半开试探失败续期)
 *     }
 *   }
 */

/**
 * @param {{threshold?: number, cooldownMs?: number}} [opts]
 * @returns {{
 *   isOpen(): boolean,
 *   failure(): false | 'open' | 'extend',
 *   success(): void,
 *   stats(): {fails: number, openUntil: number}
 * }} 熔断器实例, 行为见文件头注释
 */
function createFailureBreaker(opts = {}) {
    const threshold = Math.max(2, Math.floor(Number(opts.threshold) || 3));
    const cooldownMs = Math.max(10 * 1000, Math.floor(Number(opts.cooldownMs) || 30 * 60 * 1000));
    let fails = 0;
    let openUntil = 0;
    let openAnnounced = false;
    let pendingFail = false; // 上一个真正运行的轮次是否报过 failure()

    return {
        isOpen() {
            if (openUntil > Date.now()) return true; // 熔断中: 本轮跳过(不动 pendingFail)
            // 本轮要真正运行了:
            if (openAnnounced && !pendingFail) {
                // 熔断冷却已过, 且上一个运行轮次(试探轮)没有报 failure → 试探成功, 完全复位
                fails = 0;
                openAnnounced = false;
            } else if (!openAnnounced && fails > 0 && !pendingFail) {
                // 上一个运行轮次成功 → 连续失败链断掉, 重新计数
                fails = 0;
            }
            pendingFail = false;
            return false;
        },
        failure() {
            pendingFail = true;
            const now = Date.now();
            if (openAnnounced && now >= openUntil) {
                // 半开试探失败: 静默续期, 不刷日志
                openUntil = now + cooldownMs;
                return 'extend';
            }
            fails += 1;
            if (fails < threshold) return false;
            openUntil = now + cooldownMs;
            openAnnounced = true;
            return 'open';
        },
        success() {
            fails = 0;
            openUntil = 0;
            openAnnounced = false;
            pendingFail = false;
        },
        stats() {
            return { fails, openUntil };
        },
    };
}

/**
 * 给周期任务包一层"失败即熔断"的守卫, 免得每个 catch 手写。
 *
 * @param {ReturnType<typeof createFailureBreaker>} breaker
 * @param {string} label 日志里的动作名
 * @param {() => Promise<any>} fn 真正的操作
 * @param {(level: 'warn' | 'info', msg: string, meta?: object) => void} log 日志函数(通常 logWarn)
 * @param {object} [meta] 日志 meta
 * @returns {Promise<any>} fn 的返回值; 熔断中直接跳过返回 null
 */
async function guardPeriodic(breaker, label, fn, log, meta = {}) {
    if (breaker.isOpen()) return null;
    try {
        const r = await fn();
        breaker.success();
        return r;
    } catch (e) {
        const st = breaker.failure();
        const msg = String((e && e.message) || e);
        if (st === 'open') {
            log('warn', `${label}连续失败, 暂停30分钟后重试: ${msg}`, meta);
        } else if (!st) {
            log('warn', `${label}失败: ${msg}`, meta);
        }
        return null;
    }
}

module.exports = { createFailureBreaker, guardPeriodic };
