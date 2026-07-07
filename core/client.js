const process = require('node:process');
/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */

const {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
} = require('./src/controllers/admin');
const { createRuntimeEngine } = require('./src/runtime/runtime-engine');
const { createModuleLogger } = require('./src/services/logger');
const { syncItemInfoFromQQCache } = require('./src/services/game-config-sync');
const mainLogger = createModuleLogger('main');

(async () => {
    if (process.env.QQ_FARM_CACHE_SYNC !== '0') {
        try {
            const syncResult = await syncItemInfoFromQQCache();
            if (!syncResult.skipped) {
                mainLogger.info('QQ前台缓存配置同步完成', syncResult);
            }
        } catch (err) {
            mainLogger.warn('QQ前台缓存配置同步失败，继续使用现有配置', {
                error: err && err.message ? err.message : String(err),
            });
        }
    }

// 打包后 worker 由当前可执行文件以 --worker 模式启动
const isWorkerProcess = process.env.FARM_WORKER === '1';
if (isWorkerProcess) {
    require('./src/core/worker');
} else {
    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId, status) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry, accountId) => {
            // 确保日志条目包含 accountId
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry) => {
            emitRealtimeAccountLog(entry);
        },
    });

    await runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts: false,
    });
}
})().catch((err) => {
    mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
});
