import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

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
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>({
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
  buyBookEnabled: false,
  buyBookCount: 2,
  })
  const loading = ref(false)

  async function fetchSettings(accountId: string) {
    if (!accountId)
      return
    loading.value = true
    try {
      const { data } = await api.get('/api/settings', {
        headers: { 'x-account-id': accountId },
      })
      if (data && data.ok && data.data) {
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
  settings.value.buyBookEnabled = d.buyBookEnabled ?? false
  settings.value.buyBookCount = d.buyBookCount ?? 2
      }
    }
    finally {
      loading.value = false
    }
  }

  async function saveSettings(accountId: string, newSettings: any) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }
    loading.value = true
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
      }

      await api.post('/api/settings/save', settingsPayload, {
        headers: { 'x-account-id': accountId },
      })

      if (newSettings.automation) {
        await api.post('/api/automation', newSettings.automation, {
          headers: { 'x-account-id': accountId },
        })
      }

      await fetchSettings(accountId)
      return { ok: true }
    }
    finally {
      loading.value = false
    }
  }

  async function saveOfflineConfig(config: OfflineConfig) {
    loading.value = true
    try {
      const { data } = await api.post('/api/settings/offline-reminder', config)
      if (data && data.ok) {
        settings.value.offlineReminder = config
        return { ok: true }
      }
      return { ok: false, error: '保存失败' }
    }
    finally {
      loading.value = false
    }
  }

  return { settings, loading, fetchSettings, saveSettings, saveOfflineConfig }
})
