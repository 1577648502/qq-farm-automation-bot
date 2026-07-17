const { fork } = require('node:child_process')
const path = require('node:path')
const process = require('node:process');
const { Worker } = require('node:worker_threads')
const store = require('../models/store')
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config')
const { sendPushooMessage } = require('../services/push')
const { MiniProgramLoginSession } = require('../services/qrlogin')
const { createDataProvider } = require('./data-provider')
const { createReloginReminderService } = require('./relogin-reminder')
const { createRuntimeState } = require('./runtime-state')
const { createWorkerManager } = require('./worker-manager')
const { loadQcbyCodeConfig } = require('../services/qcby-code-config')
const { createQcbyCodeScheduler } = require('./qcby-code-scheduler')

const OPERATION_KEYS = ['harvest', 'water', 'weed', 'bug', 'fertilize', 'plant', 'steal', 'helpWater', 'helpWeed', 'helpBug', 'taskClaim', 'sell', 'upgrade']

function createRuntimeEngine(options = {}) {
  const processRef = options.processRef || process
  const mainEntryPath = options.mainEntryPath || path.join(__dirname, '../../client.js')
  const workerScriptPath = options.workerScriptPath || path.join(__dirname, '../core/worker.js')
  const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase()
  const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null
  const onLog = typeof options.onLog === 'function' ? options.onLog : null
  const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null
  const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null

  const workerControls = { startWorker: null, restartWorker: null, refreshWorkerCode: null }
  let qcbyScheduler = null
  const runtimeState = createRuntimeState({
    store,
    operationKeys: OPERATION_KEYS,
  })
  const {
    workers,
    globalLogs: GLOBAL_LOGS,
    accountLogs: ACCOUNT_LOGS,
    runtimeEvents,
    nextConfigRevision,
    buildConfigSnapshotForAccount,
    log,
    addAccountLog,
    normalizeStatusForPanel,
    buildDefaultStatus,
    filterLogs,
  } = runtimeState

  const reloginReminder = createReloginReminderService({
    store,
    miniProgramLoginSession: MiniProgramLoginSession,
    sendPushooMessage,
    log,
    addAccountLog,
    getAccounts: store.getAccounts,
    addOrUpdateAccount: store.addOrUpdateAccount,
    resolveWorkerControls: () => workerControls,
  })

  const {
    getOfflineAutoDeleteMs,
    triggerOfflineReminder,
  } = reloginReminder

  const { startWorker, stopWorker, restartWorker, callWorkerApi, refreshWorkerCode } = createWorkerManager({
    fork,
    WorkerThread: Worker,
    runtimeMode,
    processRef,
    mainEntryPath,
    workerScriptPath,
    workers,
    globalLogs: GLOBAL_LOGS,
    log,
    addAccountLog,
    normalizeStatusForPanel,
    buildConfigSnapshotForAccount,
    getOfflineAutoDeleteMs,
    triggerOfflineReminder,
    addOrUpdateAccount: store.addOrUpdateAccount,
    deleteAccount: store.deleteAccount,
    getAccounts: store.getAccounts,
    onStatusSync: (accountId, status, accountName) => {
      runtimeEvents.emit('status', { accountId, status, accountName })
      if (onStatusSync) onStatusSync(accountId, status, accountName)
    },
    onWorkerLog: (entry, accountId, accountName) => {
      runtimeEvents.emit('worker_log', { entry, accountId, accountName })
      if (onLog) onLog(entry, accountId, accountName)
    },
  })
  workerControls.startWorker = startWorker
  workerControls.restartWorker = restartWorker
  workerControls.refreshWorkerCode = refreshWorkerCode

  const dataProvider = createDataProvider({
    workers,
    globalLogs: GLOBAL_LOGS,
    accountLogs: ACCOUNT_LOGS,
    store,
    getAccounts: store.getAccounts,
    callWorkerApi,
    refreshWorkerCode,
    buildDefaultStatus,
    normalizeStatusForPanel,
    filterLogs,
    addAccountLog,
    nextConfigRevision,
    broadcastConfigToWorkers,
    startWorker,
    stopWorker,
    restartWorker,
    refreshWorkerCode,
  })

  runtimeEvents.on('log', (entry) => {
    if (onLog) onLog(entry, entry && entry.accountId ? entry.accountId : '', entry && entry.accountName ? entry.accountName : '')
  })
  runtimeEvents.on('account_log', (entry) => {
    if (onAccountLog) onAccountLog(entry)
  })

  function broadcastConfigToWorkers(targetAccountId = '') {
    const targetId = String(targetAccountId || '').trim()
    for (const [accId, worker] of Object.entries(workers)) {
      if (targetId && String(accId) !== targetId) continue
      const snapshot = buildConfigSnapshotForAccount(accId)
      try {
        worker.process.send({ type: 'config_sync', config: snapshot })
      }
      catch {
        // ignore IPC failures for exited workers
      }
    }
  }

  function startAllAccounts() {
    const accounts = (store.getAccounts().accounts || [])
    if (accounts.length > 0) {
      log('系统', `发现 ${accounts.length} 个账号，正在启动...`)
      accounts.forEach(acc => startWorker(acc))
    }
    else {
      log('系统', '未发现账号，请访问管理面板添加账号')
    }
  }

  async function start(options = {}) {
    const shouldStartAdminServer = options.startAdminServer !== false
    const shouldAutoStartAccounts = options.autoStartAccounts !== false

    // 启动时加载已保存的系统配置
    const savedSystemConfig = store.getSystemConfig()
    if (savedSystemConfig) {
      updateRuntimeConfig(savedSystemConfig)
      log('系统', `已加载系统配置: serverUrl=${savedSystemConfig.serverUrl}, clientVersion=${savedSystemConfig.clientVersion}, platform=${savedSystemConfig.platform}`)
    }

    if (shouldStartAdminServer && startAdminServer) {
      startAdminServer(dataProvider)
    }

    // 启动 qcby 自动取 code 调度器（通过 qcby-vxcode API 周期性获取农场 code）
    try {
      const qcbyConfig = loadQcbyCodeConfig()
      if (qcbyConfig.fileCreated) {
        log('系统', `已生成 qcby 取码配置示例: ${qcbyConfig.configFile}（填好后将 enabled 改为 true 并重启）`)
      }
      qcbyScheduler = createQcbyCodeScheduler({
        config: qcbyConfig,
        refreshAccountCode: dataProvider.refreshAccountCode,
        log,
      })
      qcbyScheduler.start()
    } catch (err) {
      log('系统', 'qcby 取码调度器启动失败: ' + (err && err.message ? err.message : String(err)))
    }

    if (shouldAutoStartAccounts) {
      startAllAccounts()
    }
  }

  function stopAllAccounts() {
    if (qcbyScheduler) qcbyScheduler.stop()
    for (const accountId of Object.keys(workers)) {
      stopWorker(accountId)
    }
  }

  return {
    store,
    runtimeEvents,
    workers,
    dataProvider,
    start,
    startAllAccounts,
    stopAllAccounts,
    broadcastConfigToWorkers,
    startWorker,
    stopWorker,
    restartWorker,
    callWorkerApi,
    refreshWorkerCode,
    log,
    addAccountLog,
  }
}

module.exports = {
  createRuntimeEngine,
}
