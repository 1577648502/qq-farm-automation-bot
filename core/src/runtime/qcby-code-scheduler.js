/**
 * qcby 取 code 调度器
 *
 * 按配置的账号映射，周期性（默认 5 分钟）通过 qcby-vxcode API 获取「经典农场」
 * 小程序 code，并调用 refreshAccountCode 应用到对应农场实例（未运行则启动，
 * 运行中则用新 code 重连/重启）。
 */
const { fetchFarmCode } = require('../services/qcby-code');

function createQcbyCodeScheduler(options = {}) {
    const config = options.config || {};
    const refreshAccountCode = typeof options.refreshAccountCode === 'function' ? options.refreshAccountCode : null;
    const rawLog = typeof options.log === 'function' ? options.log : null;
    const logInfo = (msg) => (rawLog ? rawLog('qcby取码', msg) : console.log('[qcby取码]', msg));

    const timers = new Map();
    const running = new Set();

    async function fetchAndApply(mapping) {
        const accountId = mapping.accountId;
        if (running.has(accountId)) return; // 防重入：上一轮未结束则跳过
        running.add(accountId);
        try {
            const result = await fetchFarmCode({
                baseUrl: config.baseUrl,
                protocol: mapping.protocol || config.protocol,
                wxid: mapping.wxid,
                ref: mapping.ref,
                appid: mapping.appid || config.appid,
                authHeader: config.authHeader,
                codePath: config.codePath,
            });

            if (!result.ok) {
                logInfo(`账号 ${accountId} 取 code 失败: ${result.reason}`);
                return;
            }

            const short = String(result.code).slice(0, 8);
            logInfo(`账号 ${accountId} 取到 code=${short}...，应用中`);

            if (!refreshAccountCode) {
                logInfo(`账号 ${accountId} 无法应用：refreshAccountCode 未注入`);
                return;
            }

            const applied = await refreshAccountCode(accountId, result.code);
            if (applied && applied.ok) {
                const action = applied.started ? '启动' : applied.restarted ? '重启' : '更新';
                logInfo(`账号 ${accountId} 已用新 code ${action}成功`);
            } else {
                logInfo(`账号 ${accountId} 应用 code 失败: ${(applied && applied.reason) || 'unknown'}`);
            }
        } catch (err) {
            logInfo(`账号 ${accountId} 处理异常: ${err && err.message ? err.message : String(err)}`);
        } finally {
            running.delete(accountId);
        }
    }

    function start() {
        if (!config.enabled) {
            logInfo('未启用（enabled=false），已跳过。配置文件: ' + (config.configFile || 'data/qcby-code.json'));
            return false;
        }
        if (!config.baseUrl || !config.appid) {
            logInfo('缺少 baseUrl 或 appid，已跳过');
            return false;
        }
        if (!Array.isArray(config.accounts) || !config.accounts.length) {
            logInfo('未配置账号映射(accounts)，已跳过');
            return false;
        }

        const seconds = Math.round(config.intervalMs / 1000);
        logInfo(`启动：${config.accounts.length} 个账号，每 ${seconds}s 取一次 code（协议 ${config.protocol}，服务 ${config.baseUrl}）`);

        for (const mapping of config.accounts) {
            if (config.runOnStart !== false) {
                fetchAndApply(mapping);
            }
            const timer = setInterval(() => fetchAndApply(mapping), config.intervalMs);
            if (typeof timer.unref === 'function') timer.unref();
            timers.set(mapping.accountId, timer);
        }
        return true;
    }

    function stop() {
        for (const timer of timers.values()) clearInterval(timer);
        timers.clear();
    }

    return { start, stop, fetchAndApply };
}

module.exports = { createQcbyCodeScheduler };
