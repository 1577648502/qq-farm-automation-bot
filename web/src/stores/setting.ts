import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { normalizeMilkTeaHireDuration } from '@/config/milkTea'

export interface AutomationConfig {
  farm?: boolean
  farm_push?: boolean
  land_upgrade?: boolean
  friend?: boolean
  task?: boolean
  sell?: boolean
  fertilizer?: string
  fertilizer_multi_season?: boolean
  fertilizer_land_types?: string[]
  fertilizer_smart_seconds?: number
  friend_steal?: boolean
  friend_help?: boolean
  friend_bad?: boolean
}

export interface IntervalsConfig {
  farm?: number
  friend?: number
  farmMin?: number
  farmMax?: number
  friendMin?: number
  friendMax?: number
  helpMin?: number
  helpMax?: number
  stealMin?: number
  stealMax?: number
}

export interface FriendQuietHoursConfig {
  enabled?: boolean
  start?: string
  end?: string
}

export interface OfflineConfig {
  channel: string
  reloginUrlMode: string
  endpoint: string
  token: string
  title: string
  msg: string
  offlineDeleteSec: number
}

export interface UIConfig {
  theme?: string
}

export interface SettingsState {
  plantingStrategy: string
  preferredSeedId: number
  bagSeedPriority: number[]
  bagSeedFallbackStrategy: string
  plantSeedExclude: number[]
  intervals: IntervalsConfig
  friendQuietHours: FriendQuietHoursConfig
  automation: AutomationConfig
  ui: UIConfig
  offlineReminder: OfflineConfig
  stealDelaySeconds: number
  plantOrderRandom: boolean
  plantDelaySeconds: number
  fertilizerBuyOrganicCount: number
  fertilizerBuyOrganicThresholdHours: number
  fertilizerBuyNormalCount: number
  fertilizerBuyNormalThresholdHours: number
  fertilizerBuyCheckIntervalMinutes: number
  // 防封号(低调)模式
  stealthEnabled: boolean
  stealthOnlineMinMinutes: number
  stealthOnlineMaxMinutes: number
  stealthOfflineMinMinutes: number
  stealthOfflineMaxMinutes: number
  stealthWakeForRipe: boolean
  // 夺宝(抢宝)
  robTreasureIntervalMinutes: number
  robMaxPerRun: number
  robDailyLimit: number
  buyBookEnabled: boolean
  buyBookCount: number
  autumnWishEnabled: boolean
  fireworkEnabled: boolean
  fireworkMode: 'self' | 'friend'
  fireworkCount: number
  happyShareEnabled: boolean
  milkTeaEnabled: boolean
  milkTeaCashier: boolean
  milkTeaCraft: boolean
  milkTeaSpeaker: boolean
  milkTeaStoreName: string
  milkTeaHireDuration: number
  milkTeaAutoInteract: boolean
  milkTeaAutoWage: boolean
  milkTeaAutoBuySeed: boolean
  milkTeaAutoUpgrade: boolean
  milkTeaInteractType: number
  sellGoldenFruit: boolean
  adGiftEnabled: boolean
}

function createDefaultSettings(): SettingsState {
  return {
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    bagSeedPriority: [],
    bagSeedFallbackStrategy: 'level',
    plantSeedExclude: [],
    intervals: {},
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00' },
    automation: {},
    ui: {},
    offlineReminder: {
      channel: 'webhook',
      reloginUrlMode: 'none',
      endpoint: '',
      token: '',
      title: '账号下线提醒',
      msg: '账号下线',
      offlineDeleteSec: 0,
    },
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    fertilizerBuyOrganicCount: 10,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 10,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 30,
    stealthEnabled: false,
    stealthOnlineMinMinutes: 3,
    stealthOnlineMaxMinutes: 8,
    stealthOfflineMinMinutes: 20,
    stealthOfflineMaxMinutes: 60,
    stealthWakeForRipe: true,
    robTreasureIntervalMinutes: 10,
    robMaxPerRun: 1,
    robDailyLimit: 20,
    buyBookEnabled: true,
    buyBookCount: 2,
    autumnWishEnabled: true,
    fireworkEnabled: false,
    fireworkMode: 'self',
    fireworkCount: 1,
    happyShareEnabled: true,
    milkTeaEnabled: true,
    milkTeaCashier: true,
    milkTeaCraft: true,
    milkTeaSpeaker: false,
    milkTeaStoreName: '奶茶小铺',
    milkTeaHireDuration: 1,
    milkTeaAutoInteract: false,
    milkTeaAutoWage: true,
    milkTeaAutoBuySeed: false,
    milkTeaAutoUpgrade: true,
    milkTeaInteractType: 2,
    sellGoldenFruit: false,
    adGiftEnabled: true,
  }
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>(createDefaultSettings())
  const loading = ref(false)
  const settingsLoadError = ref('')
  const settingsAccountId = ref('')
  let latestFetchRequest = 0
  let latestSaveRequest = 0
  let settingsContextEpoch = 0
  let saveQueue: Promise<void> = Promise.resolve()

  interface SettingsSaveContext {
    accountId: string
    loadEpoch: number
  }

  function resetSettingsState() {
    settings.value = createDefaultSettings()
    settingsAccountId.value = ''
  }

  function cloneSettingsValue<T>(value: T): T {
    if (value === undefined || value === null)
      return value
    return JSON.parse(JSON.stringify(value))
  }

  function requestErrorMessage(error: any, fallback: string) {
    return error?.response?.data?.error
      || error?.response?.data?.message
      || error?.message
      || fallback
  }

  function invalidatePendingSaves() {
    latestSaveRequest += 1
    settingsContextEpoch += 1
  }

  function contextMatches(context: SettingsSaveContext) {
    return !!context.accountId
      && context.loadEpoch === settingsContextEpoch
      && settingsAccountId.value === context.accountId
      && !settingsLoadError.value
      && !loading.value
  }

  function saveRequestMatches(context: SettingsSaveContext, requestId: number) {
    return requestId === latestSaveRequest && contextMatches(context)
  }

  function saveRequestOwnsContext(context: SettingsSaveContext, requestId: number) {
    return requestId === latestSaveRequest && context.loadEpoch === settingsContextEpoch
  }

  function enqueueSaveOperation<T>(
    context: SettingsSaveContext,
    staleResult: T,
    operation: () => Promise<T>,
  ) {
    const task = saveQueue.then(() => contextMatches(context) ? operation() : staleResult)
    saveQueue = task.then(() => undefined, () => undefined)
    return task
  }

  /** 切换账号时立即清掉上一个账号的值，并让仍在途的旧请求失效。 */
  function prepareSettingsLoad(accountId: string) {
    const normalizedAccountId = String(accountId || '')
    if (normalizedAccountId && settingsAccountId.value === normalizedAccountId && !settingsLoadError.value)
      return
    latestFetchRequest += 1
    invalidatePendingSaves()
    resetSettingsState()
    settingsLoadError.value = ''
    loading.value = !!normalizedAccountId
  }

  async function fetchSettings(accountId: string, options: { invalidateSaves?: boolean } = {}) {
    const normalizedAccountId = String(accountId || '')
    if (options.invalidateSaves !== false)
      invalidatePendingSaves()
    if (!normalizedAccountId) {
      latestFetchRequest += 1
      resetSettingsState()
      settingsLoadError.value = '未选择账号'
      loading.value = false
      return { ok: false, error: settingsLoadError.value }
    }

    const requestId = ++latestFetchRequest
    if (settingsAccountId.value !== normalizedAccountId)
      resetSettingsState()
    settingsLoadError.value = ''
    loading.value = true
    try {
      const { data } = await api.get('/api/settings', {
        headers: { 'x-account-id': normalizedAccountId },
      })
      if (!data || data.ok !== true || !data.data)
        throw new Error(data?.error || '设置接口未返回有效数据')
      if (requestId !== latestFetchRequest)
        return { ok: false, error: '', stale: true }

      const d = data.data
      settings.value.plantingStrategy = d.strategy || 'max_exp'
      settings.value.preferredSeedId = d.preferredSeed || 0
      settings.value.intervals = d.intervals || {}
      settings.value.friendQuietHours = d.friendQuietHours || { enabled: false, start: '23:00', end: '07:00' }
      settings.value.automation = d.automation || {}
      settings.value.ui = d.ui || {}
      settings.value.offlineReminder = d.offlineReminder || {
        channel: 'webhook',
        reloginUrlMode: 'none',
        endpoint: '',
        token: '',
        title: '账号下线提醒',
        msg: '账号下线',
        offlineDeleteSec: 0,
      }
      settings.value.stealDelaySeconds = d.stealDelaySeconds ?? 0
      settings.value.plantOrderRandom = d.plantOrderRandom ?? false
      settings.value.plantDelaySeconds = d.plantDelaySeconds ?? 0
      settings.value.fertilizerBuyOrganicCount = d.fertilizerBuyOrganicCount ?? 10
      settings.value.fertilizerBuyOrganicThresholdHours = d.fertilizerBuyOrganicThresholdHours ?? 10
      settings.value.fertilizerBuyNormalCount = d.fertilizerBuyNormalCount ?? 10
      settings.value.fertilizerBuyNormalThresholdHours = d.fertilizerBuyNormalThresholdHours ?? 10
      settings.value.fertilizerBuyCheckIntervalMinutes = d.fertilizerBuyCheckIntervalMinutes ?? 30
      settings.value.stealthEnabled = !!d.stealthEnabled
      settings.value.stealthOnlineMinMinutes = d.stealthOnlineMinMinutes ?? 3
      settings.value.stealthOnlineMaxMinutes = d.stealthOnlineMaxMinutes ?? 8
      settings.value.stealthOfflineMinMinutes = d.stealthOfflineMinMinutes ?? 20
      settings.value.stealthOfflineMaxMinutes = d.stealthOfflineMaxMinutes ?? 60
      settings.value.stealthWakeForRipe = d.stealthWakeForRipe !== false
      settings.value.bagSeedPriority = d.bagSeedPriority ?? []
      settings.value.bagSeedFallbackStrategy = d.bagSeedFallbackStrategy ?? 'level'
      settings.value.plantSeedExclude = d.plantSeedExclude ?? []
      settings.value.robTreasureIntervalMinutes = d.robTreasureIntervalMinutes ?? 10
      settings.value.robMaxPerRun = d.robMaxPerRun ?? 1
      settings.value.robDailyLimit = d.robDailyLimit ?? 20
      settings.value.buyBookEnabled = d.buyBookEnabled ?? true
      settings.value.buyBookCount = d.buyBookCount ?? 2
      settings.value.autumnWishEnabled = d.autumnWishEnabled ?? true
      settings.value.fireworkEnabled = d.fireworkEnabled ?? false
      settings.value.fireworkMode = d.fireworkMode === 'friend' ? 'friend' : 'self'
      settings.value.fireworkCount = d.fireworkCount ?? 1
      settings.value.happyShareEnabled = d.happyShareEnabled ?? true
      settings.value.milkTeaEnabled = d.milkTeaEnabled ?? true
      settings.value.milkTeaCashier = d.milkTeaCashier ?? true
      settings.value.milkTeaCraft = d.milkTeaCraft ?? true
      settings.value.milkTeaSpeaker = d.milkTeaSpeaker ?? false
      settings.value.milkTeaStoreName = d.milkTeaStoreName ?? '奶茶小铺'
      settings.value.milkTeaHireDuration = normalizeMilkTeaHireDuration(d.milkTeaHireDuration)
      settings.value.milkTeaAutoInteract = d.milkTeaAutoInteract ?? false
      settings.value.milkTeaAutoWage = d.milkTeaAutoWage !== false
      settings.value.milkTeaAutoBuySeed = !!d.milkTeaAutoBuySeed
      settings.value.milkTeaAutoUpgrade = d.milkTeaAutoUpgrade !== false
      settings.value.milkTeaInteractType = Number(d.milkTeaInteractType) || 2
      settings.value.sellGoldenFruit = d.sellGoldenFruit ?? false
      settings.value.adGiftEnabled = d.adGiftEnabled ?? true
      settingsAccountId.value = normalizedAccountId
      return { ok: true }
    }
    catch (error: any) {
      if (requestId !== latestFetchRequest)
        return { ok: false, error: '', stale: true }
      settings.value = createDefaultSettings()
      settingsAccountId.value = ''
      settingsLoadError.value = requestErrorMessage(error, '设置加载失败')
      return { ok: false, error: settingsLoadError.value }
    }
    finally {
      if (requestId === latestFetchRequest)
        loading.value = false
    }
  }

  async function performSaveSettings(context: SettingsSaveContext, newSettings: any) {
    const normalizedAccountId = context.accountId
    if (!normalizedAccountId)
      return { ok: false, error: '未选择账号', refreshed: false }
    if (settingsLoadError.value)
      return { ok: false, error: `设置尚未成功加载，禁止保存：${settingsLoadError.value}`, refreshed: false }
    if (!contextMatches(context))
      return { ok: false, error: '', refreshed: false, stale: true }
    if (settingsAccountId.value !== normalizedAccountId)
      return { ok: false, error: '账号设置尚未加载完成，禁止保存', refreshed: false }

    const requestId = ++latestSaveRequest
    let settingsSaved = false
    let automationSaved = !newSettings.automation
    const isCurrentSave = () => saveRequestMatches(context, requestId)
    try {
      // 注意: 未传的字段一律保持 undefined 透传(JSON 序列化时自动省略, 后端跳过不动现有值)。
      // 千万不要在这里填默认值 —— 部分字段的保存(如防封号自动保存)只传增量字段,
      // 填默认值会把用户已配置的 背包种子顺序/排外列表/偷取延迟 等冲掉(踩过的坑)。
      const settingsPayload = {
        plantingStrategy: newSettings.plantingStrategy,
        preferredSeedId: newSettings.preferredSeedId,
        bagSeedPriority: newSettings.bagSeedPriority,
        bagSeedFallbackStrategy: newSettings.bagSeedFallbackStrategy,
        plantSeedExclude: newSettings.plantSeedExclude,
        intervals: newSettings.intervals,
        friendQuietHours: newSettings.friendQuietHours,
        stealDelaySeconds: newSettings.stealDelaySeconds,
        plantOrderRandom: newSettings.plantOrderRandom,
        plantDelaySeconds: newSettings.plantDelaySeconds,
        fertilizerBuyOrganicCount: newSettings.fertilizerBuyOrganicCount,
        fertilizerBuyOrganicThresholdHours: newSettings.fertilizerBuyOrganicThresholdHours,
        fertilizerBuyNormalCount: newSettings.fertilizerBuyNormalCount,
        fertilizerBuyNormalThresholdHours: newSettings.fertilizerBuyNormalThresholdHours,
        fertilizerBuyCheckIntervalMinutes: newSettings.fertilizerBuyCheckIntervalMinutes,
        stealthEnabled: newSettings.stealthEnabled,
        stealthOnlineMinMinutes: newSettings.stealthOnlineMinMinutes,
        stealthOnlineMaxMinutes: newSettings.stealthOnlineMaxMinutes,
        stealthOfflineMinMinutes: newSettings.stealthOfflineMinMinutes,
        stealthOfflineMaxMinutes: newSettings.stealthOfflineMaxMinutes,
        stealthWakeForRipe: newSettings.stealthWakeForRipe,
        robTreasureIntervalMinutes: newSettings.robTreasureIntervalMinutes,
        robMaxPerRun: newSettings.robMaxPerRun,
        robDailyLimit: newSettings.robDailyLimit,
        buyBookEnabled: newSettings.buyBookEnabled,
        buyBookCount: newSettings.buyBookCount,
        autumnWishEnabled: newSettings.autumnWishEnabled,
        fireworkEnabled: newSettings.fireworkEnabled,
        fireworkMode: newSettings.fireworkMode,
        fireworkCount: newSettings.fireworkCount,
        happyShareEnabled: newSettings.happyShareEnabled,
        milkTeaEnabled: newSettings.milkTeaEnabled,
        milkTeaCashier: newSettings.milkTeaCashier,
        milkTeaCraft: newSettings.milkTeaCraft,
        milkTeaSpeaker: newSettings.milkTeaSpeaker,
        milkTeaStoreName: newSettings.milkTeaStoreName,
        milkTeaHireDuration: newSettings.milkTeaHireDuration,
        milkTeaAutoInteract: newSettings.milkTeaAutoInteract,
        milkTeaAutoWage: newSettings.milkTeaAutoWage,
        milkTeaAutoBuySeed: newSettings.milkTeaAutoBuySeed,
        milkTeaAutoUpgrade: newSettings.milkTeaAutoUpgrade,
        milkTeaInteractType: newSettings.milkTeaInteractType,
        sellGoldenFruit: newSettings.sellGoldenFruit,
        adGiftEnabled: newSettings.adGiftEnabled,
      }

      if (!isCurrentSave())
        return { ok: false, stale: true, error: '', refreshed: false }
      const settingsResponse = await api.post('/api/settings/save', settingsPayload, {
        headers: { 'x-account-id': normalizedAccountId },
      })
      if (!isCurrentSave())
        return { ok: false, stale: true, error: '', refreshed: false }
      if (settingsResponse.data?.ok === false)
        throw new Error(settingsResponse.data?.error || '基础设置保存失败')
      settingsSaved = true

      if (newSettings.automation) {
        if (!isCurrentSave())
          return { ok: false, stale: true, error: '', refreshed: false }
        const automationResponse = await api.post('/api/automation', newSettings.automation, {
          headers: { 'x-account-id': normalizedAccountId },
        })
        if (!isCurrentSave())
          return { ok: false, stale: true, error: '', refreshed: false }
        if (automationResponse.data?.ok === false)
          throw new Error(automationResponse.data?.error || '自动控制设置保存失败')
        automationSaved = true
      }

      if (!isCurrentSave())
        return { ok: false, stale: true, error: '', refreshed: false }
      const refreshResult = await fetchSettings(normalizedAccountId, { invalidateSaves: false })
      if (refreshResult.stale || !saveRequestOwnsContext(context, requestId))
        return { ok: false, stale: true, error: '', refreshed: false }
      if (!refreshResult.ok) {
        return {
          ok: false,
          error: `设置已保存，但重新读取服务端状态失败：${refreshResult.error || '未知原因'}`,
          saved: true,
          partial: false,
          refreshed: false,
        }
      }
      return { ok: true, refreshed: true }
    }
    catch (error: any) {
      if (!isCurrentSave())
        return { ok: false, stale: true, error: '', refreshed: false }
      const partial = settingsSaved || (!!newSettings.automation && automationSaved)
      const refreshResult = await fetchSettings(normalizedAccountId, { invalidateSaves: false })
      if (refreshResult.stale || !saveRequestOwnsContext(context, requestId))
        return { ok: false, stale: true, error: '', refreshed: false }
      let message = requestErrorMessage(error, '设置保存失败')
      if (partial) {
        if (settingsSaved && !automationSaved)
          message = `基础设置已保存，但自动控制设置保存失败：${message}`
        else
          message = `设置可能只保存了一部分：${message}`
      }
      message += refreshResult.ok
        ? '；已重新读取服务端当前状态'
        : `；服务端状态回读也失败：${refreshResult.error || '未知原因'}`
      return {
        ok: false,
        error: message,
        saved: settingsSaved,
        partial,
        settingsSaved,
        automationSaved,
        refreshed: refreshResult.ok,
      }
    }
  }

  function saveSettings(accountId: string, newSettings: any) {
    const context: SettingsSaveContext = {
      accountId: String(accountId || ''),
      loadEpoch: settingsContextEpoch,
    }
    const snapshot = cloneSettingsValue(newSettings)
    return enqueueSaveOperation(
      context,
      { ok: false, error: '', refreshed: false, stale: true },
      () => performSaveSettings(context, snapshot),
    )
  }

  async function saveOfflineConfig(config: OfflineConfig, accountId = settingsAccountId.value) {
    const normalizedAccountId = String(accountId || '')
    if (!normalizedAccountId)
      return { ok: false, error: '未选择账号' }

    const context: SettingsSaveContext = {
      accountId: normalizedAccountId,
      loadEpoch: settingsContextEpoch,
    }
    const snapshot = cloneSettingsValue(config)
    return enqueueSaveOperation(
      context,
      { ok: false, error: '', stale: true },
      async () => {
        if (settingsLoadError.value)
          return { ok: false, error: `设置尚未成功加载，禁止保存：${settingsLoadError.value}` }
        if (!contextMatches(context))
          return { ok: false, error: '', stale: true }
        const requestId = ++latestSaveRequest
        const isCurrentSave = () => saveRequestMatches(context, requestId)

        try {
          if (!isCurrentSave())
            return { ok: false, error: '', stale: true }
          const { data } = await api.post('/api/settings/offline-reminder', snapshot, {
            headers: { 'x-account-id': normalizedAccountId },
          })
          if (!isCurrentSave())
            return { ok: false, error: '', stale: true }
          if (data && data.ok) {
            settings.value.offlineReminder = { ...snapshot }
            return { ok: true }
          }
          return { ok: false, error: data?.error || '保存失败' }
        }
        catch (error: any) {
          if (!isCurrentSave())
            return { ok: false, error: '', stale: true }
          return { ok: false, error: requestErrorMessage(error, '保存失败') }
        }
      },
    )
  }

  return {
    settings,
    loading,
    settingsLoadError,
    settingsAccountId,
    prepareSettingsLoad,
    fetchSettings,
    saveSettings,
    saveOfflineConfig,
  }
})
