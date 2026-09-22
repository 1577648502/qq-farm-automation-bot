<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api'
import AccountModal from '@/components/AccountModal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { getPlatformClass, getPlatformLabel, useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'
import { useUserStore } from '@/stores/user'
import { getAccountQQUin, getQQAvatarUrl } from '@/utils/qq'

const router = useRouter()
const accountStore = useAccountStore()
const userStore = useUserStore()
const settingStore = useSettingStore()
const farmStore = useFarmStore()

const activeTab = ref<'account' | 'strategy' | 'automation' | 'user'>(
  (localStorage.getItem('settings-active-tab') as 'account' | 'strategy' | 'automation' | 'user') || 'account'
)

watch(activeTab, (newTab) => {
  localStorage.setItem('settings-active-tab', newTab)
})

const tabs = [
  { key: 'account', label: '账号管理', icon: 'i-carbon-user-settings' },
  { key: 'strategy', label: '策略设置', icon: 'i-fas-cogs' },
  { key: 'automation', label: '自动控制', icon: 'i-carbon-toggle-on' },
  { key: 'user', label: '用户管理', icon: 'i-carbon-user' },
] as const

const modalVisible = ref(false)
const modalConfig = ref({
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  isAlert: true,
})

function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = {
    title: type === 'danger' ? '错误' : '提示',
    message,
    type,
    isAlert: true,
  }
  modalVisible.value = true
}

// ==================== 账号管理 ====================
const { accounts, loading: accountsLoading, currentAccountId } = storeToRefs(accountStore)

const showModal = ref(false)
const showDeleteConfirm = ref(false)
const deleteLoading = ref(false)
const editingAccount = ref<any>(null)
const accountToDelete = ref<any>(null)
const showClearStoppedConfirm = ref(false)
const clearStoppedLoading = ref(false)
const kickoutRefreshSavingId = ref('')

const isAccountOpsDisabled = computed(() => !userStore.isAdmin && userStore.isExpired)
const quotaLimit = computed(() => {
  const limit = userStore.accountLimit
  if (limit === undefined || limit === null)
    return 3
  return limit
})
const isOverQuota = computed(() => {
  if (userStore.isAdmin)
    return false
  const limit = quotaLimit.value
  if (limit === -1)
    return false
  return accounts.value.length >= limit
})
const isAddAccountDisabled = computed(() => isAccountOpsDisabled.value || isOverQuota.value)
const addAccountDisabledReason = computed(() => {
  if (isAccountOpsDisabled.value)
    return '账号已到期，无法添加账号'
  if (isOverQuota.value)
    return '已超过配额，无法添加账号'
  return ''
})

const stoppedAccounts = computed(() => accounts.value.filter((acc: any) => !acc.running))
const stoppedAccountsCount = computed(() => stoppedAccounts.value.length)

/** 按当前账号加载所有设置(挂载时 + 切换账号时都会调用) */
async function loadForCurrentAccount() {
  if (!currentAccountId.value)
    return
  await settingStore.fetchSettings(currentAccountId.value)
  syncLocalStrategySettings()
  syncLocalAutomationSettings()
  syncLocalOfflineSettings()
  await farmStore.fetchSeeds(currentAccountId.value)
  await fetchStealthStatus()
}

onMounted(async () => {
  await accountStore.fetchAccounts()
  if (!currentAccountId.value && accounts.value.length > 0 && accounts.value[0]) {
    accountStore.selectAccount(String(accounts.value[0].id))
  }
  // 先取活动开关状态, 再同步本地设置(否则后台已关闭的活动开关无法被自动关掉)
  await fetchActivityStatus()
  await loadForCurrentAccount()
})

// 切换账号时重新加载该账号的设置(否则页面还显示上一个账号的配置)
watch(currentAccountId, (now, prev) => {
  if (String(now ?? '') !== String(prev ?? ''))
    void loadForCurrentAccount()
})

useIntervalFn(() => {
  fetchStealthStatus()
  accountStore.fetchAccounts()
}, 3000)

function openSettings(account: any) {
  accountStore.selectAccount(account.id)
  router.push('/settings')
}

function openAddModal() {
  editingAccount.value = null
  showModal.value = true
}

function openEditModal(account: any) {
  editingAccount.value = { ...account }
  showModal.value = true
}

async function handleDelete(account: any) {
  accountToDelete.value = account
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (accountToDelete.value) {
    try {
      deleteLoading.value = true
      await accountStore.deleteAccount(accountToDelete.value.id)
      accountToDelete.value = null
      showDeleteConfirm.value = false
    }
    finally {
      deleteLoading.value = false
    }
  }
}

async function toggleAccount(account: any) {
  if (account.running) {
    await accountStore.stopAccount(account.id)
  }
  else {
    await accountStore.startAccount(account.id)
  }
}

async function toggleKickoutCodeRefresh(account: any, enabled: boolean) {
  if (!account?.id)
    return
  kickoutRefreshSavingId.value = String(account.id)
  const oldValue = !!account.keepRunningOnKickout
  account.keepRunningOnKickout = enabled
  try {
    await accountStore.setKickoutCodeRefresh(String(account.id), enabled)
  }
  catch (e) {
    account.keepRunningOnKickout = oldValue
    showAlert('保存失败，请稍后重试', 'danger')
  }
  finally {
    kickoutRefreshSavingId.value = ''
  }
}

function handleSaved() {
  accountStore.fetchAccounts()
}

function selectAccount(account: any) {
  if (!account || !account.id)
    return
  accountStore.selectAccount(String(account.id))
}

function openClearStoppedConfirm() {
  if (stoppedAccountsCount.value === 0) {
    showAlert('没有已停止的账号需要清理', 'primary')
    return
  }
  showClearStoppedConfirm.value = true
}

async function confirmClearStopped() {
  clearStoppedLoading.value = true
  try {
    const stoppedIds = stoppedAccounts.value.map((acc: any) => acc.id)
    let deletedCount = 0
    for (const id of stoppedIds) {
      try {
        await accountStore.deleteAccount(id)
        deletedCount++
      }
      catch (e) {
        console.error(`删除账号 ${id} 失败:`, e)
      }
    }
    showClearStoppedConfirm.value = false
    showAlert(`成功清理 ${deletedCount} 个已停止的账号`, 'primary')
    await accountStore.fetchAccounts()
  }
  finally {
    clearStoppedLoading.value = false
  }
}

// ==================== 策略设置 ====================
const { settings, loading: settingsLoading } = storeToRefs(settingStore)
const { seeds } = storeToRefs(farmStore)

const strategySaving = ref(false)

const currentAccountName = computed(() => {
  const acc = accounts.value.find((a: any) => a.id === currentAccountId.value)
  return acc ? (acc.name || acc.nick || acc.id) : null
})

const localStrategySettings = ref({
  plantingStrategy: 'max_exp',
  preferredSeedId: 0,
  bagSeedPriority: [] as number[],
  bagSeedFallbackStrategy: 'level',
  plantSeedExclude: [] as number[],
  stealDelaySeconds: 0,
  plantOrderRandom: false,
  plantDelaySeconds: 0,
  intervals: { farmMin: 2, farmMax: 5, helpMin: 10, helpMax: 15, stealMin: 10, stealMax: 15 },
  friendQuietHours: { enabled: false, start: '23:00', end: '07:00' },
})

const plantingStrategyOptions = [
  { label: '优先种植种子', value: 'preferred' },
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
  { label: '背包种子优先', value: 'bag_priority' },
]

const BAG_FALLBACK_STRATEGY_OPTIONS = [
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
  { label: '优先种植种子', value: 'preferred' },
]

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
}

const bagSeeds = ref<BagSeedItem[]>([])
const bagSeedsLoading = ref(false)
const bagSeedsError = ref<string | null>(null)
const draggingBagSeedId = ref<number | null>(null)
const excludedSeedIds = computed(() => new Set((localStrategySettings.value.plantSeedExclude || []).map(seedId => Number(seedId))))

const sortedBagSeeds = computed(() => {
  const priority = localStrategySettings.value.bagSeedPriority || []
  const indexMap = new Map<number, number>()
  priority.forEach((seedId, index) => indexMap.set(seedId, index))

  return [...bagSeeds.value].sort((a, b) => {
    const aIndex = indexMap.has(a.seedId) ? indexMap.get(a.seedId)! : Number.MAX_SAFE_INTEGER
    const bIndex = indexMap.has(b.seedId) ? indexMap.get(b.seedId)! : Number.MAX_SAFE_INTEGER
    if (aIndex !== bIndex)
      return aIndex - bIndex
    // 未手动排序时默认 2x2 等大作物优先，避免 1x1 先占满土地。
    if (a.plantSize !== b.plantSize)
      return b.plantSize - a.plantSize
    if (a.requiredLevel !== b.requiredLevel)
      return b.requiredLevel - a.requiredLevel
    return a.seedId - b.seedId
  })
})

async function fetchBagSeeds() {
  if (!currentAccountId.value)
    return
  bagSeedsLoading.value = true
  bagSeedsError.value = null
  try {
    const res = await api.get('/api/bag/seeds', {
      headers: { 'x-account-id': currentAccountId.value },
    })
    if (res.data.ok) {
      bagSeeds.value = res.data.data || []
    }
  }
  catch (e: any) {
    bagSeedsError.value = e.message || '加载失败'
  }
  finally {
    bagSeedsLoading.value = false
  }
}

function resetBagSeedPriority() {
  localStrategySettings.value.bagSeedPriority = []
}

function getVisibleBagSeedOrder() {
  return sortedBagSeeds.value.map(seed => seed.seedId)
}

function materializeBagSeedPriority() {
  const visibleOrder = getVisibleBagSeedOrder()
  const visibleSet = new Set(visibleOrder)
  const savedOrder = (localStrategySettings.value.bagSeedPriority || []).filter(seedId => visibleSet.has(seedId))
  const missing = visibleOrder.filter(seedId => !savedOrder.includes(seedId))
  return [...savedOrder, ...missing]
}

function moveBagSeed(seedId: number, direction: -1 | 1) {
  const nextOrder = materializeBagSeedPriority()
  const index = nextOrder.indexOf(seedId)
  const targetIndex = index + direction
  if (index < 0 || targetIndex < 0 || targetIndex >= nextOrder.length)
    return

  const temp = nextOrder[index]!
  nextOrder[index] = nextOrder[targetIndex]!
  nextOrder[targetIndex] = temp
  localStrategySettings.value.bagSeedPriority = nextOrder
}

function startBagSeedDrag(seedId: number, event: DragEvent) {
  draggingBagSeedId.value = seedId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(seedId))
  }
}

function dragOverBagSeed(_seedId: number, event: DragEvent) {
  if (draggingBagSeedId.value === null)
    return
  event.preventDefault()
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = 'move'
}

function dropBagSeed(seedId: number, event: DragEvent) {
  event.preventDefault()
  const sourceSeedId = draggingBagSeedId.value ?? Number(event.dataTransfer?.getData('text/plain') || '')
  if (!sourceSeedId || sourceSeedId === seedId) {
    draggingBagSeedId.value = null
    return
  }

  const nextOrder = materializeBagSeedPriority()
  const sourceIndex = nextOrder.indexOf(sourceSeedId)
  const targetIndex = nextOrder.indexOf(seedId)

  if (sourceIndex < 0 || targetIndex < 0) {
    draggingBagSeedId.value = null
    return
  }

  const [source] = nextOrder.splice(sourceIndex, 1)
  const newTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
  nextOrder.splice(newTargetIndex, 0, source!)

  localStrategySettings.value.bagSeedPriority = nextOrder
  draggingBagSeedId.value = null
}

function isBagSeedExcluded(seedId: number) {
  return excludedSeedIds.value.has(Number(seedId))
}

async function toggleBagSeedExcluded(seed: BagSeedItem) {
  if (!seed || !seed.seedId)
    return
  const seedId = Number(seed.seedId)
  const next = [...(localStrategySettings.value.plantSeedExclude || [])]
  const index = next.indexOf(seedId)
  if (index >= 0) {
    next.splice(index, 1)
  }
  else {
    next.push(seedId)
  }
  localStrategySettings.value.plantSeedExclude = next
}

watchEffect(() => {
  if (localStrategySettings.value.plantingStrategy === 'bag_priority' && currentAccountId.value) {
    fetchBagSeeds()
  }
})

const preferredSeedOptions = computed(() => {
  const options: { label: string; value: number; disabled?: boolean }[] = [{ label: '自动选择', value: 0, disabled: false }]
  if (seeds.value) {
    options.push(...seeds.value.map(seed => ({
      label: `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
      value: seed.seedId,
      disabled: seed.locked || seed.soldOut,
    })))
  }
  return options
})

const analyticsSortByMap: Record<string, string> = {
  max_exp: 'exp',
  max_fert_exp: 'fert',
  max_profit: 'profit',
  max_fert_profit: 'fert_profit',
}

const strategyPreviewLabel = ref<string | null>(null)

watchEffect(async () => {
  let strategy = localStrategySettings.value.plantingStrategy
  if (strategy === 'preferred') {
    strategyPreviewLabel.value = null
    return
  }
  if (strategy === 'bag_priority') {
    strategy = localStrategySettings.value.bagSeedFallbackStrategy || 'level'
    if (strategy === 'preferred') {
      const preferredId = localStrategySettings.value.preferredSeedId
      if (preferredId > 0 && seeds.value) {
        const seed = seeds.value.find(s => s.seedId === preferredId)
        if (seed) {
          strategyPreviewLabel.value = `${seed.requiredLevel}级 ${seed.name}`
        }
        else {
          strategyPreviewLabel.value = '未选择优先种子'
        }
      }
      else {
        strategyPreviewLabel.value = '未选择优先种子'
      }
      return
    }
  }
  if (!seeds.value || seeds.value.length === 0) {
    strategyPreviewLabel.value = null
    return
  }
  const available = seeds.value.filter(s => !s.locked && !s.soldOut)
  if (available.length === 0) {
    strategyPreviewLabel.value = '暂无可用种子'
    return
  }
  if (strategy === 'level') {
    const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel)[0]
    strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
    return
  }
  const sortBy = analyticsSortByMap[strategy]
  if (sortBy) {
    try {
      const res = await api.get(`/api/analytics?sort=${sortBy}`)
      const rankings: any[] = res.data.ok ? (res.data.data || []) : []
      const availableIds = new Set(available.map(s => s.seedId))
      const match = rankings.find(r => availableIds.has(Number(r.seedId)))
      if (match) {
        const seed = available.find(s => s.seedId === Number(match.seedId))
        strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : null
      }
      else {
        strategyPreviewLabel.value = '暂无匹配种子'
      }
    }
    catch {
      strategyPreviewLabel.value = null
    }
  }
})

function syncLocalStrategySettings() {
  if (settings.value) {
    localStrategySettings.value = JSON.parse(JSON.stringify({
      plantingStrategy: settings.value.plantingStrategy,
      preferredSeedId: settings.value.preferredSeedId,
      bagSeedPriority: settings.value.bagSeedPriority ?? [],
      bagSeedFallbackStrategy: settings.value.bagSeedFallbackStrategy ?? 'level',
      plantSeedExclude: settings.value.plantSeedExclude ?? [],
      stealDelaySeconds: settings.value.stealDelaySeconds ?? 0,
      plantOrderRandom: !!settings.value.plantOrderRandom,
      plantDelaySeconds: settings.value.plantDelaySeconds ?? 0,
      intervals: settings.value.intervals,
      friendQuietHours: settings.value.friendQuietHours,
    }))
  }
}

async function loadStrategyData() {
  if (currentAccountId.value) {
    await settingStore.fetchSettings(currentAccountId.value)
    syncLocalStrategySettings()
    await farmStore.fetchSeeds(currentAccountId.value)
  }
}

async function saveStrategySettings() {
  if (!currentAccountId.value)
    return
  strategySaving.value = true
  try {
    const fullSettings = {
      ...settings.value,
      ...localStrategySettings.value,
      automation: localAutomationSettings.value.automation,
    }
    const res = await settingStore.saveSettings(currentAccountId.value, fullSettings)
    if (res.ok) {
      showAlert('策略设置已保存', 'primary')
    }
    else {
      showAlert(`保存失败: ${res.error}`, 'danger')
    }
  }
  finally {
    strategySaving.value = false
  }
}

watch(currentAccountId, async () => {
  if (currentAccountId.value) {
    await loadStrategyData()
    syncLocalAutomationSettings()
    syncLocalOfflineSettings()
  }
})

// ==================== 自动控制 ====================
const automationSaving = ref(false)

const allFertilizerLandTypes = ['amethyst', 'gold', 'black', 'red', 'normal']

const fertilizerLandTypeOptions = [
  { label: '紫晶土地', value: 'amethyst' },
  { label: '金土地', value: 'gold' },
  { label: '黑土地', value: 'black' },
  { label: '红土地', value: 'red' },
  { label: '普通土地', value: 'normal' },
]

function normalizeFertilizerLandTypes(input: unknown) {
  const source = Array.isArray(input) ? input : allFertilizerLandTypes
  const normalized: string[] = []
  for (const item of source) {
    const value = String(item || '').trim().toLowerCase()
    if (!allFertilizerLandTypes.includes(value))
      continue
    if (normalized.includes(value))
      continue
    normalized.push(value)
  }
  return normalized
}

const localAutomationSettings = ref({
  automation: {
    farm: false,
    task: false,
    sell: false,
    friend: false,
    farm_push: false,
    land_upgrade: false,
    friend_steal: false,
    friend_help: false,
    friend_bad: false,
    friend_help_exp_limit: false,
    fertilizer_gift: false,
    fertilizer_buy_organic: false,
    fertilizer_buy_normal: false,
    mystery_shop: false,
    star_light_up: false,
    solar_terms: false,
    weather_task: false,
    weather_research: false,
    charity_task: false,
    mengchong_task: false,
    mengchong_hunt: false,
    rob_treasure: false,
    fertilizer: 'normal',
    skip_own_weed_bug: false,
    fertilizer_multi_season: false,
    fertilizer_land_types: [...allFertilizerLandTypes],
    fertilizer_smart_seconds: 300,
  },
  // 夺宝(抢宝)
  robTreasureIntervalMinutes: 10,
  robMaxPerRun: 1,
  robDailyLimit: 20,
  buyBookEnabled: true,
  buyBookCount: 2,
  // 防封号(低调)模式
  stealthEnabled: false,
  stealthOnlineMinMinutes: 3,
  stealthOnlineMaxMinutes: 8,
  stealthOfflineMinMinutes: 20,
  stealthOfflineMaxMinutes: 60,
  stealthWakeForRipe: true,
  fertilizerBuyOrganicCount: 10,
  fertilizerBuyOrganicThresholdHours: 10,
  fertilizerBuyNormalCount: 10,
  fertilizerBuyNormalThresholdHours: 10,
  fertilizerBuyCheckIntervalMinutes: 30,
})

const fertilizerOptions = [
  { label: '普通 + 有机', value: 'both' },
  { label: '普通 + 快成熟有机', value: 'smart' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '仅有机化肥', value: 'organic' },
  { label: '不施肥', value: 'none' },
]

// 活动菜单在后台被关闭时, 对应自动化开关必须一并关闭
const activityStatus = ref<Record<string, boolean>>({})
const ACTIVITY_GATED_AUTOMATION: Record<string, string> = {
  star_light_up: 'qianXingEnabled',
  weather_task: 'yuLuoChengShiEnabled',
  weather_research: 'yuLuoChengShiEnabled',
  charity_task: 'gongYiXiaoHongHuaEnabled',
  mengchong_task: 'mengChongEnabled',
  mengchong_hunt: 'mengChongEnabled',
}

function isAutomationGated(key: string): boolean {
  const flagKey = ACTIVITY_GATED_AUTOMATION[key]
  return !!flagKey && activityStatus.value[flagKey] === false
}

function autoLabel(key: string, base: string): string {
  return isAutomationGated(key) ? `${base}（活动已在后台关闭）` : base
}

/** 把被后台关闭的活动的自动化开关强制置为 false */
function applyActivityGate() {
  const auto = localAutomationSettings.value.automation as any
  if (!auto) return
  for (const key of Object.keys(ACTIVITY_GATED_AUTOMATION)) {
    if (isAutomationGated(key)) auto[key] = false
  }
}

// ===== 防封号(低调)模式: 状态与手动切换 =====
const stealthStatus = ref<any>(null)
const stealthLoading = ref(false)
const stealthStatusError = ref('')
const stealthSaveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const stealthSavedAt = ref('')
const stealthSaveError = ref('')
let stealthSaveTimer: any = null

async function fetchStealthStatus() {
  try {
    const res = await api.get('/api/stealth/status')
    if (res.data?.ok) {
      stealthStatus.value = res.data.data
      stealthStatusError.value = ''
    } else {
      stealthStatusError.value = `后台未返回防封号状态：${res.data?.error || '未知原因'}`
    }
  } catch (e: any) {
    const code = e?.response?.status
    stealthStatusError.value = code === 404
      ? '后台没有 /api/stealth 接口 —— 说明后台进程还是旧版本，请重启后台（core）后再试'
      : `无法读取防封号状态：${e?.response?.data?.error || e?.message || '请求失败'}`
  }
}

/** 当前防封号表单值(用于自动保存) */
function stealthPayload() {
  return {
    stealthEnabled: !!localAutomationSettings.value.stealthEnabled,
    stealthOnlineMinMinutes: Number(localAutomationSettings.value.stealthOnlineMinMinutes) || 3,
    stealthOnlineMaxMinutes: Number(localAutomationSettings.value.stealthOnlineMaxMinutes) || 8,
    stealthOfflineMinMinutes: Number(localAutomationSettings.value.stealthOfflineMinMinutes) || 20,
    stealthOfflineMaxMinutes: Number(localAutomationSettings.value.stealthOfflineMaxMinutes) || 60,
    stealthWakeForRipe: localAutomationSettings.value.stealthWakeForRipe !== false,
  }
}
/** 后台已保存的防封号值 */
function stealthSavedPayload() {
  const s: any = settings.value || {}
  return {
    stealthEnabled: !!s.stealthEnabled,
    stealthOnlineMinMinutes: s.stealthOnlineMinMinutes ?? 3,
    stealthOnlineMaxMinutes: s.stealthOnlineMaxMinutes ?? 8,
    stealthOfflineMinMinutes: s.stealthOfflineMinMinutes ?? 20,
    stealthOfflineMaxMinutes: s.stealthOfflineMaxMinutes ?? 60,
    stealthWakeForRipe: s.stealthWakeForRipe !== false,
  }
}
function stealthSame(a: any, b: any) {
  return a.stealthEnabled === b.stealthEnabled
    && a.stealthOnlineMinMinutes === b.stealthOnlineMinMinutes
    && a.stealthOnlineMaxMinutes === b.stealthOnlineMaxMinutes
    && a.stealthOfflineMinMinutes === b.stealthOfflineMinMinutes
    && a.stealthOfflineMaxMinutes === b.stealthOfflineMaxMinutes
    && a.stealthWakeForRipe === b.stealthWakeForRipe
}

/** 有未保存的改动 */
const stealthDirty = computed(() => !stealthSame(stealthPayload(), stealthSavedPayload()))

/** 只保存防封号相关设置(自动保存用, 不影响其它未保存的编辑) */
async function saveStealthSettings() {
  if (!currentAccountId.value)
    return
  stealthSaveState.value = 'saving'
  stealthSaveError.value = ''
  try {
    // 用「已保存的完整设置」打底, 只覆盖防封号字段 —— 避免部分保存把其它设置(背包种子顺序/排外等)冲掉
    const payload = { ...(settings.value || {}), ...stealthPayload() }
    const res = await settingStore.saveSettings(currentAccountId.value, payload)
    if (res?.ok) {
      // 同步到本地 settings, 让"未保存"提示消失
      Object.assign(settings.value as any, stealthPayload())
      stealthSaveState.value = 'saved'
      stealthSavedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      await fetchStealthStatus()
    } else {
      stealthSaveState.value = 'error'
      stealthSaveError.value = res?.error || '保存失败'
    }
  } catch (e: any) {
    stealthSaveState.value = 'error'
    stealthSaveError.value = e?.response?.data?.error || e?.message || '保存失败'
  }
}

// 防封号设置改动后自动保存(免去"改了但忘记点保存")
watch(
  () => { const p = stealthPayload(); return JSON.stringify(p) },
  () => {
    if (!currentAccountId.value || !stealthDirty.value)
      return
    if (stealthSaveTimer) clearTimeout(stealthSaveTimer)
    stealthSaveTimer = setTimeout(() => { void saveStealthSettings() }, 700)
  },
)

async function handleForceStealth(action: 'online' | 'offline') {
  if (!currentAccountId.value)
    return
  stealthLoading.value = true
  try {
    const res = await api.post('/api/stealth/force', { action }, { headers: { 'x-account-id': currentAccountId.value } })
    if (res.data?.ok) {
      const detail = res.data?.data?.message
      showAlert(detail || (action === 'offline' ? '已手动下线' : '已手动上线'), 'primary')
      await fetchStealthStatus()
    } else {
      showAlert(res.data?.error || '操作失败', 'danger')
    }
  } catch (e: any) {
    showAlert(e?.response?.data?.error || e?.message || '操作失败', 'danger')
  } finally {
    stealthLoading.value = false
  }
}

/** 当前账号的防封号状态 */
const myStealth = computed(() => {
  const list = stealthStatus.value?.accounts || []
  return list.find((x: any) => String(x.accountId) === String(currentAccountId.value || '')) || null
})

function fmtClock(ms: number) {
  if (!ms)
    return '-'
  const d = new Date(ms)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function fmtRemain(sec: number) {
  const v = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(v / 60)
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分`
}

async function fetchActivityStatus() {
  try {
    const res = await api.get('/api/activities/status')
    if (res.data) {
      activityStatus.value = {
        heFengEnabled: res.data.heFengEnabled !== false,
        qingNiangEnabled: res.data.qingNiangEnabled !== false,
        qianXingEnabled: res.data.qianXingEnabled !== false,
        yuLuoChengShiEnabled: res.data.yuLuoChengShiEnabled !== false,
        gongYiXiaoHongHuaEnabled: res.data.gongYiXiaoHongHuaEnabled !== false,
        mengChongEnabled: res.data.mengChongEnabled !== false,
      }
      applyActivityGate()
    }
  } catch (e) { /* 状态取不到时不拦截 */ }
}

function syncLocalAutomationSettings() {
  if (settings.value) {
    if (!settings.value.automation) {
      localAutomationSettings.value.automation = {
        farm: false,
        task: false,
        sell: false,
        friend: false,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop: false,
        star_light_up: false,
        solar_terms: false,
        weather_task: false,
        weather_research: false,
        charity_task: false,
        mengchong_task: false,
    mengchong_hunt: false,
    rob_treasure: false,
        fertilizer: 'none',
        skip_own_weed_bug: false,
        fertilizer_multi_season: false,
        fertilizer_land_types: [...allFertilizerLandTypes],
        fertilizer_smart_seconds: 300,
      }
    }
    else {
      const defaults = {
        farm: false,
        task: false,
        sell: false,
        friend: false,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        mystery_shop: false,
        star_light_up: false,
        solar_terms: false,
        weather_task: false,
        weather_research: false,
        charity_task: false,
        mengchong_task: false,
    mengchong_hunt: false,
    rob_treasure: false,
        fertilizer: 'none',
        skip_own_weed_bug: false,
        fertilizer_multi_season: false,
        fertilizer_land_types: [...allFertilizerLandTypes],
        fertilizer_smart_seconds: 300,
      }
      localAutomationSettings.value.automation = {
        ...defaults,
        ...settings.value.automation,
      }
    }
    localAutomationSettings.value.automation.fertilizer_land_types = normalizeFertilizerLandTypes(localAutomationSettings.value.automation.fertilizer_land_types)
    if (localAutomationSettings.value.automation.fertilizer_smart_seconds === undefined) {
      localAutomationSettings.value.automation.fertilizer_smart_seconds = 300
    }
    localAutomationSettings.value.stealthEnabled = !!settings.value.stealthEnabled
    localAutomationSettings.value.stealthOnlineMinMinutes = settings.value.stealthOnlineMinMinutes ?? 3
    localAutomationSettings.value.stealthOnlineMaxMinutes = settings.value.stealthOnlineMaxMinutes ?? 8
    localAutomationSettings.value.stealthOfflineMinMinutes = settings.value.stealthOfflineMinMinutes ?? 20
    localAutomationSettings.value.stealthOfflineMaxMinutes = settings.value.stealthOfflineMaxMinutes ?? 60
    localAutomationSettings.value.stealthWakeForRipe = settings.value.stealthWakeForRipe !== false
    localAutomationSettings.value.robTreasureIntervalMinutes = settings.value.robTreasureIntervalMinutes ?? 10
  localAutomationSettings.value.robMaxPerRun = settings.value.robMaxPerRun ?? 1
  localAutomationSettings.value.robDailyLimit = settings.value.robDailyLimit ?? 20
  localAutomationSettings.value.buyBookEnabled = settings.value.buyBookEnabled ?? true
  localAutomationSettings.value.buyBookCount = settings.value.buyBookCount ?? 2
    localAutomationSettings.value.fertilizerBuyOrganicCount = settings.value.fertilizerBuyOrganicCount ?? 10
    localAutomationSettings.value.fertilizerBuyOrganicThresholdHours = settings.value.fertilizerBuyOrganicThresholdHours ?? 10
    localAutomationSettings.value.fertilizerBuyNormalCount = settings.value.fertilizerBuyNormalCount ?? 10
    localAutomationSettings.value.fertilizerBuyNormalThresholdHours = settings.value.fertilizerBuyNormalThresholdHours ?? 10
    localAutomationSettings.value.fertilizerBuyCheckIntervalMinutes = settings.value.fertilizerBuyCheckIntervalMinutes ?? 30
    applyActivityGate()
  }
}

/** 立即执行一次自动夺宝 */
const buyBookRunning = ref(false)
const buyBookResult = ref('')

/** 立即购买一次中级挑战书(手动, 便于当场看到成功/失败原因) */
async function buyBooksNow() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId) {
    showAlert('请先选择账号', 'danger')
    return
  }
  buyBookRunning.value = true
  buyBookResult.value = ''
  try {
    const res = await api.post('/api/mall/buy-books', {
      force: true,
      count: localAutomationSettings.value.buyBookCount,
    }, { headers: { 'x-account-id': accountId } })
    const d = res.data?.data || {}
    if (!res.data?.ok) {
      buyBookResult.value = res.data?.error || '购买失败'
      return
    }
    const botPart = `机器人今日 ${d.todayBoughtByBot ?? d.bought ?? 0}/${d.target ?? '-'}`
    const gamePart = d.gameDailyLimit ? `，游戏侧已购 ${d.gameBought ?? 0}/${d.gameDailyLimit}` : ''
    if (d.boughtNow > 0) {
      buyBookResult.value = `本次购买 ${d.boughtNow} 本（${botPart}${gamePart}）`
    } else {
      buyBookResult.value = `未购买：${d.skipped || '未知原因'}（${botPart}${gamePart}）`
    }
  } catch (e: any) {
    buyBookResult.value = e?.response?.data?.error || e?.message || '购买失败（账号未运行？）'
  } finally {
    buyBookRunning.value = false
  }
}

const treasureRunning = ref(false)
async function runTreasureNow() {
  if (!currentAccountId.value)
    return
  treasureRunning.value = true
  try {
    const res = await api.post('/api/treasure/run-auto', {}, {
      headers: { 'x-account-id': currentAccountId.value },
      timeout: 180000,
    })
    if (res.data?.ok) {
      const d = res.data.data || {}
      if (d.skipped) {
        showAlert('自动夺宝开关未开启（请先勾选上面的"启用自动夺宝"）', 'danger')
      } else if (d.reason === 'no_book') {
        showAlert('没有可用的挑战书', 'danger')
      } else if (d.reason === 'no_target') {
        showAlert(`已查 ${d.friends} 位好友，暂无可夺宝藏`, 'primary')
      } else {
        showAlert(`自动夺宝完成：尝试 ${d.attempted} 次，成功 ${d.success}，未生效 ${d.noEffect}，失败 ${d.failed}`, 'primary')
      }
    } else {
      showAlert(res.data?.error || '执行失败', 'danger')
    }
  } catch (e: any) {
    showAlert(e?.response?.data?.error || e?.message || '执行失败', 'danger')
  } finally {
    treasureRunning.value = false
  }
}

async function saveAutomationSettings() {
  if (!currentAccountId.value)
    return
  automationSaving.value = true
  try {
    // 后台已关闭的活动, 其自动化开关一并置 false 后再保存
    applyActivityGate()
    const fullSettings = {
      ...settings.value,
      automation: localAutomationSettings.value.automation,
      stealthEnabled: localAutomationSettings.value.stealthEnabled,
      stealthOnlineMinMinutes: localAutomationSettings.value.stealthOnlineMinMinutes,
      stealthOnlineMaxMinutes: localAutomationSettings.value.stealthOnlineMaxMinutes,
      stealthOfflineMinMinutes: localAutomationSettings.value.stealthOfflineMinMinutes,
      stealthOfflineMaxMinutes: localAutomationSettings.value.stealthOfflineMaxMinutes,
      stealthWakeForRipe: localAutomationSettings.value.stealthWakeForRipe,
      robTreasureIntervalMinutes: localAutomationSettings.value.robTreasureIntervalMinutes,
      robMaxPerRun: localAutomationSettings.value.robMaxPerRun,
      robDailyLimit: localAutomationSettings.value.robDailyLimit,
      buyBookEnabled: localAutomationSettings.value.buyBookEnabled,
      buyBookCount: localAutomationSettings.value.buyBookCount,
      fertilizerBuyOrganicCount: localAutomationSettings.value.fertilizerBuyOrganicCount,
      fertilizerBuyOrganicThresholdHours: localAutomationSettings.value.fertilizerBuyOrganicThresholdHours,
      fertilizerBuyNormalCount: localAutomationSettings.value.fertilizerBuyNormalCount,
      fertilizerBuyNormalThresholdHours: localAutomationSettings.value.fertilizerBuyNormalThresholdHours,
      fertilizerBuyCheckIntervalMinutes: localAutomationSettings.value.fertilizerBuyCheckIntervalMinutes,
    }
    const res = await settingStore.saveSettings(currentAccountId.value, fullSettings)
    if (res.ok) {
      showAlert('自动控制设置已保存', 'primary')

      // 如果启用了自动购买化肥，立即检测并购买
      if (localAutomationSettings.value.automation.fertilizer_buy_organic || localAutomationSettings.value.automation.fertilizer_buy_normal) {
        try {
          const buyRes = await api.post('/api/fertilizer/check-and-buy', {
            buyOrganic: localAutomationSettings.value.automation.fertilizer_buy_organic,
            buyNormal: localAutomationSettings.value.automation.fertilizer_buy_normal,
            organicCount: localAutomationSettings.value.fertilizerBuyOrganicCount,
            organicThresholdHours: localAutomationSettings.value.fertilizerBuyOrganicThresholdHours,
            normalCount: localAutomationSettings.value.fertilizerBuyNormalCount,
            normalThresholdHours: localAutomationSettings.value.fertilizerBuyNormalThresholdHours,
          }, {
            headers: { 'x-account-id': currentAccountId.value },
          })
          if (buyRes.data?.ok) {
            const totalBought = (buyRes.data.organicBought || 0) + (buyRes.data.normalBought || 0)
            if (totalBought > 0) {
              showAlert(`已自动购买 ${totalBought} 个化肥`, 'primary')
            }
          }
        }
        catch (e) {
          console.error('检测购买化肥失败', e)
        }
      }
    }
    else {
      showAlert(`保存失败: ${res.error}`, 'danger')
    }
  }
  finally {
    automationSaving.value = false
  }
}

// ==================== 用户管理 ====================
const passwordSaving = ref(false)
const offlineSaving = ref(false)
const offlineTesting = ref(false)

const passwordForm = ref({
  old: '',
  new: '',
  confirm: '',
})

const localOffline = ref({
  channel: 'webhook',
  reloginUrlMode: 'none',
  endpoint: '',
  token: '',
  title: '',
  msg: '',
  offlineDeleteSec: 0,
})

const channelOptions = [
  { label: 'Webhook(自定义接口)', value: 'webhook' },
  { label: 'Qmsg 酱', value: 'qmsg' },
  { label: 'Server 酱', value: 'serverchan' },
  { label: 'Push Plus', value: 'pushplus' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip' },
  { label: '钉钉', value: 'dingtalk' },
  { label: '企业微信', value: 'wecom' },
  { label: 'Bark', value: 'bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp' },
  { label: 'OneBot', value: 'onebot' },
  { label: 'Atri', value: 'atri' },
  { label: 'PushDeer', value: 'pushdeer' },
  { label: 'iGot', value: 'igot' },
  { label: 'Telegram', value: 'telegram' },
  { label: '飞书', value: 'feishu' },
  { label: 'IFTTT', value: 'ifttt' },
  { label: '企业微信群机器人', value: 'wecombot' },
  { label: 'Discord', value: 'discord' },
  { label: 'WxPusher', value: 'wxpusher' },
]

const reloginUrlModeOptions = [
  { label: '不需要', value: 'none' },
  { label: 'QQ直链', value: 'qq_link' },
  { label: '二维码链接', value: 'qr_link' },
]

const CHANNEL_DOCS: Record<string, string> = {
  webhook: '',
  qmsg: 'https://qmsg.zendee.cn/',
  serverchan: 'https://sct.ftqq.com/',
  pushplus: 'https://www.pushplus.plus/',
  pushplushxtrip: 'https://pushplus.hxtrip.com/',
  dingtalk: 'https://open.dingtalk.com/document/group/custom-robot-access',
  wecom: 'https://guole.fun/posts/626/',
  wecombot: 'https://developer.work.weixin.qq.com/document/path/91770',
  bark: 'https://github.com/Finb/Bark',
  gocqhttp: 'https://docs.go-cqhttp.org/api/',
  onebot: 'https://docs.go-cqhttp.org/api/',
  atri: 'https://blog.tianli0.top/',
  pushdeer: 'https://www.pushdeer.com/',
  igot: 'https://push.hellyw.com/',
  telegram: 'https://core.telegram.org/bots',
  feishu: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973',
  ifttt: 'https://ifttt.com/maker_webhooks',
  discord: 'https://discord.com/developers/docs/resources/webhook#execute-webhook',
  wxpusher: 'https://wxpusher.zjiecode.com/docs/#/',
}

const currentChannelDocUrl = computed(() => {
  const key = String(localOffline.value.channel || '').trim().toLowerCase()
  return CHANNEL_DOCS[key] || ''
})

function openChannelDocs() {
  const url = currentChannelDocUrl.value
  if (!url)
    return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function syncLocalOfflineSettings() {
  if (settings.value?.offlineReminder) {
    localOffline.value = JSON.parse(JSON.stringify(settings.value.offlineReminder))
  }
}

watch(settings, () => {
  syncLocalOfflineSettings()
}, { deep: true })

async function handleChangePassword() {
  if (!passwordForm.value.old || !passwordForm.value.new) {
    showAlert('请填写完整', 'danger')
    return
  }
  if (passwordForm.value.new !== passwordForm.value.confirm) {
    showAlert('两次密码输入不一致', 'danger')
    return
  }
  if (passwordForm.value.new.length < 4) {
    showAlert('密码长度至少4位', 'danger')
    return
  }

  passwordSaving.value = true
  try {
    const res = await userStore.changePassword(passwordForm.value.old, passwordForm.value.new)

    if (res.ok) {
      showAlert('密码修改成功，请重新登录', 'primary')
      passwordForm.value = { old: '', new: '', confirm: '' }
      setTimeout(() => {
        userStore.logout()
        window.location.href = '/login'
      }, 1500)
    }
    else {
      showAlert(`修改失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    passwordSaving.value = false
  }
}

async function handleSaveOffline() {
  offlineSaving.value = true
  try {
    const res = await settingStore.saveOfflineConfig(localOffline.value)

    if (res.ok) {
      showAlert('下线提醒设置已保存', 'primary')
    }
    else {
      showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    offlineSaving.value = false
  }
}

async function handleTestOffline() {
  offlineTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', localOffline.value)
    if (data?.ok) {
      showAlert('测试消息发送成功', 'primary')
    }
    else {
      showAlert(`测试失败: ${data?.error || '未知错误'}`, 'danger')
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '请求失败'
    showAlert(`测试失败: ${msg}`, 'danger')
  }
  finally {
    offlineTesting.value = false
  }
}
</script>

<template>
  <div class="settings-page">
    <div class="mb-4">
      <h1 class="text-2xl text-gray-900 font-bold dark:text-gray-100">
        设置
      </h1>
    </div>

    <div class="border border-gray-200 rounded-lg bg-white shadow dark:border-gray-700 dark:bg-gray-800">
      <div class="border-b border-gray-200 dark:border-gray-700">
        <nav class="flex flex-nowrap gap-1 overflow-x-auto pb-1 snap-x snap-mandatory scrollbar-none sm:flex-wrap sm:overflow-visible sm:pb-0 p-2">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all"
            :class="activeTab === tab.key
              ? 'text-white shadow-sm'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'"
            :style="activeTab === tab.key ? { backgroundColor: 'var(--theme-primary)' } : {}"
            @click="activeTab = tab.key"
          >
            <div :class="tab.icon" />
            {{ tab.label }}
          </button>
        </nav>
      </div>

      <div class="p-4">
        <!-- 账号管理 -->
        <div v-if="activeTab === 'account'" class="space-y-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
              账号管理
            </h3>
            <div class="flex flex-wrap gap-2">
              <BaseButton
                v-if="userStore.isAdmin"
                variant="secondary"
                size="sm"
                :disabled="stoppedAccountsCount === 0"
                @click="openClearStoppedConfirm"
              >
                <div class="i-carbon-trash-can mr-2" />
                <span class="hidden sm:inline">一键清理</span>
                <span class="sm:hidden">清理</span>
                ({{ stoppedAccountsCount }})
              </BaseButton>
              <BaseButton
                variant="primary"
                size="sm"
                :disabled="isAddAccountDisabled"
                :title="addAccountDisabledReason"
                @click="openAddModal"
              >
                <div class="i-carbon-add mr-2" />
                添加账号
              </BaseButton>
            </div>
          </div>

          <div v-if="accountsLoading && accounts.length === 0" class="py-8 text-center text-gray-500">
            <div i-svg-spinners-90-ring-with-bg class="mb-2 inline-block text-2xl" />
            <div>加载中...</div>
          </div>

          <div v-else-if="accounts.length === 0" class="rounded-lg bg-white py-12 text-center shadow dark:bg-gray-800">
            <div i-carbon-user-avatar class="mb-4 inline-block text-4xl text-gray-400" />
            <p class="mb-4 text-gray-500">
              暂无账号
            </p>
            <BaseButton
              variant="text"
              size="sm"
              :disabled="isAddAccountDisabled"
              :title="addAccountDisabledReason"
              @click="openAddModal"
            >
              立即添加
            </BaseButton>
          </div>

          <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <div
              v-for="acc in accounts"
              :key="acc.id"
              class="cursor-pointer border rounded-lg bg-white p-3 shadow transition-all duration-200 dark:bg-gray-800 sm:p-4"
              :class="String(currentAccountId) === String(acc.id)
                ? 'ring-2'
                : 'border-transparent'"
              :style="String(currentAccountId) === String(acc.id)
                ? { borderColor: 'var(--theme-primary)', backgroundColor: 'rgba(var(--theme-primary-rgb, 59, 130, 246), 0.1)' }
                : {}"
              @click="selectAccount(acc)"
            >
              <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                  <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700 sm:h-12 sm:w-12">
                    <img v-if="getAccountQQUin(acc)" :src="getQQAvatarUrl(acc)" class="h-full w-full object-cover">
                    <div v-else class="i-carbon-user text-xl text-gray-400 sm:text-2xl" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <h4 class="truncate text-base font-bold sm:text-lg">
                      {{ acc.name || acc.nick || acc.id }}
                    </h4>
                    <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span
                        v-if="acc.platform"
                        class="rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight"
                        :class="getPlatformClass(acc.platform)"
                      >
                        {{ getPlatformLabel(acc.platform) }}
                      </span>
                      <span class="truncate text-xs text-gray-500 sm:text-sm">
                        {{ getAccountQQUin(acc) || '未绑定' }}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="flex items-center justify-end gap-2 sm:flex-col sm:items-end">
                  <span class="flex items-center gap-1 text-xs text-gray-500 sm:hidden">
                    <div class="h-2 w-2 rounded-full" :class="acc.running ? 'bg-green-500' : 'bg-gray-300'" />
                    {{ acc.running ? '运行中' : '已停止' }}
                  </span>
                  <BaseButton
                    variant="secondary"
                    size="sm"
                    class="border rounded-full shadow-sm transition-all duration-500 ease-in-out active:scale-95 sm:w-20"
                    :class="acc.running ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 focus:ring-red-500 active:border-red-300 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30 dark:focus:ring-red-500 dark:active:border-red-700' : 'border-green-200 bg-green-50 text-green-600 hover:bg-green-100 focus:ring-green-500 active:border-green-300 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/30 dark:focus:ring-green-500 dark:active:border-green-700'"
                    :disabled="!acc.running && isAccountOpsDisabled"
                    :title="!acc.running && isAccountOpsDisabled ? '账号已到期，无法启动账号' : ''"
                    @click="toggleAccount(acc)"
                  >
                    <div :class="acc.running ? 'i-carbon-stop-filled' : 'i-carbon-play-filled'" class="mr-1" />
                    {{ acc.running ? '停止' : '启动' }}
                  </BaseButton>
                </div>
              </div>

              <div class="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-900/40 dark:text-gray-300" @click.stop>
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="font-medium">
                      踢下线后等待 Code
                    </div>
                    <div class="mt-0.5 text-[11px] text-gray-400">
                      开启后不会自动停止，等桌面登录刷新 Code
                    </div>
                  </div>
                  <BaseSwitch
                    :model-value="!!acc.keepRunningOnKickout"
                    @update:model-value="value => toggleKickoutCodeRefresh(acc, !!value)"
                  />
                </div>
                <div v-if="kickoutRefreshSavingId === String(acc.id)" class="mt-1 text-[11px] text-blue-500">
                  保存中...
                </div>
              </div>

              <div class="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 dark:border-gray-700 sm:mt-4 sm:pt-4">
                <div class="hidden items-center gap-2 text-sm text-gray-500 sm:flex">
                  <span class="flex items-center gap-1">
                    <div class="h-2 w-2 rounded-full" :class="acc.running ? 'bg-green-500' : 'bg-gray-300'" />
                    {{ acc.running ? '运行中' : '已停止' }}
                  </span>
                </div>

                <div class="flex flex-1 justify-end gap-1 sm:flex-initial sm:gap-2">
                  <BaseButton
                    variant="ghost"
                    class="min-h-[36px] min-w-[36px] !p-2"
                    title="设置"
                    @click="openSettings(acc)"
                  >
                    <div i-carbon-settings />
                  </BaseButton>
                  <BaseButton
                    variant="ghost"
                    class="min-h-[36px] min-w-[36px] !p-2"
                    title="编辑"
                    @click="openEditModal(acc)"
                  >
                    <div i-carbon-edit />
                  </BaseButton>
                  <BaseButton
                    variant="ghost"
                    class="text-red-500 min-h-[36px] min-w-[36px] !p-2 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300"
                    title="删除"
                    @click="handleDelete(acc)"
                  >
                    <div i-carbon-trash-can />
                  </BaseButton>
                </div>
              </div>
            </div>
          </div>

          <AccountModal
            :show="showModal"
            :edit-data="editingAccount"
            @close="showModal = false"
            @saved="handleSaved"
          />

          <ConfirmModal
            :show="showDeleteConfirm"
            :loading="deleteLoading"
            title="删除账号"
            :message="accountToDelete ? `确定要删除账号 ${accountToDelete.name || accountToDelete.id} 吗?` : ''"
            confirm-text="删除"
            type="danger"
            @close="!deleteLoading && (showDeleteConfirm = false)"
            @cancel="!deleteLoading && (showDeleteConfirm = false)"
            @confirm="confirmDelete"
          />

          <ConfirmModal
            :show="showClearStoppedConfirm"
            :loading="clearStoppedLoading"
            title="一键清理已停止账号"
            :message="`确定要清理 ${stoppedAccountsCount} 个已停止的账号吗？此操作不可恢复！`"
            confirm-text="确认清理"
            type="danger"
            @close="!clearStoppedLoading && (showClearStoppedConfirm = false)"
            @cancel="!clearStoppedLoading && (showClearStoppedConfirm = false)"
            @confirm="confirmClearStopped"
          />
        </div>

        <!-- 策略设置 -->
        <div v-else-if="activeTab === 'strategy'" class="space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="flex items-center gap-2 text-lg text-gray-900 font-bold dark:text-gray-100">
              <div class="i-fas-cog text-lg" />
              策略设置
              <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
                ({{ currentAccountName }})
              </span>
            </h3>
          </div>

          <div v-if="settingsLoading" class="py-4 text-center text-gray-500">
            <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
            <p>加载中...</p>
          </div>

          <div v-else-if="!currentAccountId" class="py-8 text-center text-gray-500">
            <div class="i-carbon-settings-adjust mx-auto mb-2 text-3xl text-gray-400" />
            <p>请先选择账号</p>
          </div>

          <div v-else class="space-y-4">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-2">
              <BaseSelect
                v-model="localStrategySettings.plantingStrategy"
                label="种植策略"
                :options="plantingStrategyOptions"
              />
              <BaseSelect
                v-if="localStrategySettings.plantingStrategy === 'preferred'"
                v-model="localStrategySettings.preferredSeedId"
                label="优先种植种子"
                :options="preferredSeedOptions"
              />
              <BaseSelect
                v-else-if="localStrategySettings.plantingStrategy === 'bag_priority' && localStrategySettings.bagSeedFallbackStrategy === 'preferred'"
                v-model="localStrategySettings.preferredSeedId"
                label="优先种植种子"
                :options="preferredSeedOptions"
              />
              <div v-else class="flex flex-col gap-1.5">
                <label class="text-sm text-gray-700 font-medium dark:text-gray-300">
                  {{ localStrategySettings.plantingStrategy === 'bag_priority' ? '第二优先策略预览' : '策略选种预览' }}
                </label>
                <div
                  class="w-full flex items-center justify-between border border-gray-200 rounded-lg bg-gray-50 px-3 py-2 text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400"
                >
                  <span class="truncate">{{ strategyPreviewLabel ?? '加载中...' }}</span>
                  <div class="i-carbon-chevron-down shrink-0 text-lg text-gray-400" />
                </div>
              </div>
            </div>

            <div v-if="localStrategySettings.plantingStrategy === 'bag_priority'" class="space-y-3">
              <BaseSelect
                v-model="localStrategySettings.bagSeedFallbackStrategy"
                label="第二优先策略"
                :options="BAG_FALLBACK_STRATEGY_OPTIONS"
              />
              <div class="border border-amber-200 rounded-lg bg-amber-50/70 p-3 space-y-3 dark:border-amber-800/50 dark:bg-amber-900/20">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div class="text-sm text-amber-900 font-semibold dark:text-amber-200">
                      背包种子优先顺序
                    </div>
                    <p class="mt-1 text-xs text-amber-700/90 dark:text-amber-300/90">
                      默认优先 2x2 作物；调整后按下方顺序种植，标记排外的种子不会被自动种植。
                    </p>
                  </div>
                  <button
                    class="rounded bg-amber-100 px-2 py-1 text-xs text-amber-700 transition hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-900/70"
                    @click="resetBagSeedPriority"
                  >
                    重置顺序
                  </button>
                </div>
                <div v-if="bagSeedsLoading" class="py-4 text-center text-sm text-amber-700 dark:text-amber-300">
                  加载中...
                </div>
                <div v-else-if="bagSeedsError" class="py-4 text-center text-sm text-red-600 dark:text-red-400">
                  {{ bagSeedsError }}
                </div>
                <div v-else-if="bagSeeds.length === 0" class="py-4 text-center text-sm text-amber-700 dark:text-amber-300">
                  背包中暂无可用种子
                </div>
                <div v-else class="grid gap-2 lg:grid-cols-3 sm:grid-cols-2">
                  <div
                    v-for="(seed, index) in sortedBagSeeds"
                    :key="seed.seedId"
                    class="flex items-center gap-2 border border-amber-200 rounded-lg bg-white p-2 dark:border-amber-700/50 dark:bg-gray-800"
                    :class="isBagSeedExcluded(seed.seedId) ? 'opacity-70' : ''"
                    draggable="true"
                    @dragstart="startBagSeedDrag(seed.seedId, $event)"
                    @dragover.prevent="dragOverBagSeed(seed.seedId, $event)"
                    @drop="dropBagSeed(seed.seedId, $event)"
                  >
                    <div class="h-8 w-8 flex shrink-0 items-center justify-center rounded bg-amber-100 text-xs text-amber-700 font-bold dark:bg-amber-900/50 dark:text-amber-300">
                      {{ index + 1 }}
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex min-w-0 items-center gap-1.5">
                        <span class="truncate text-sm text-gray-800 font-medium dark:text-gray-200">
                          {{ seed.name }}
                        </span>
                        <span v-if="isBagSeedExcluded(seed.seedId)" class="shrink-0 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                          已排外
                        </span>
                      </div>
                      <div class="text-xs text-gray-500 dark:text-gray-400">
                        数量: {{ seed.count }} | 等级: {{ seed.requiredLevel }} | 占地: {{ seed.plantSize }}x{{ seed.plantSize }}
                      </div>
                    </div>
                    <button
                      class="h-8 shrink-0 flex items-center gap-1 rounded px-2 text-xs transition"
                      :class="isBagSeedExcluded(seed.seedId)
                        ? 'bg-rose-100 text-rose-700 hover:bg-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:hover:bg-rose-900/60'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
                      :title="isBagSeedExcluded(seed.seedId) ? '取消种植排外' : '加入种植排外'"
                      @click.stop="toggleBagSeedExcluded(seed)"
                    >
                      <div :class="isBagSeedExcluded(seed.seedId) ? 'i-carbon-checkmark text-sm' : 'i-carbon-subtract-alt text-sm'" />
                      <span>{{ isBagSeedExcluded(seed.seedId) ? '取消' : '排外' }}</span>
                    </button>
                    <div class="flex shrink-0 flex-col gap-1">
                      <button
                        class="rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
                        :disabled="index === 0"
                        @click="moveBagSeed(seed.seedId, -1)"
                      >
                        <div class="i-carbon-arrow-up text-sm" />
                      </button>
                      <button
                        class="rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
                        :disabled="index === sortedBagSeeds.length - 1"
                        @click="moveBagSeed(seed.seedId, 1)"
                      >
                        <div class="i-carbon-arrow-down text-sm" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
              <BaseInput
                v-model.number="localStrategySettings.intervals.farmMin"
                label="农场巡查最小 (秒)"
                type="number"
                min="1"
              />
              <BaseInput
                v-model.number="localStrategySettings.intervals.farmMax"
                label="农场巡查最大 (秒)"
                type="number"
                min="1"
              />
            </div>

            <div class="grid grid-cols-2 gap-3 md:grid-cols-2">
              <BaseInput
                v-model.number="localStrategySettings.intervals.helpMin"
                label="帮助巡查最小 (秒)"
                type="number"
                min="1"
              />
              <BaseInput
                v-model.number="localStrategySettings.intervals.helpMax"
                label="帮助巡查最大 (秒)"
                type="number"
                min="1"
              />
            </div>

            <div class="grid grid-cols-2 gap-3 md:grid-cols-2">
              <BaseInput
                v-model.number="localStrategySettings.intervals.stealMin"
                label="偷菜巡查最小 (秒)"
                type="number"
                min="1"
              />
              <BaseInput
                v-model.number="localStrategySettings.intervals.stealMax"
                label="偷菜巡查最大 (秒)"
                type="number"
                min="1"
              />
            </div>

            <div class="flex flex-wrap items-center gap-4 border-t pt-3 dark:border-gray-700">
              <BaseSwitch
                v-model="localStrategySettings.friendQuietHours.enabled"
                label="启用静默时段"
              />
              <div class="flex items-center gap-2">
                <input
                  v-model="localStrategySettings.friendQuietHours.start"
                  type="time"
                  class="w-20 border border-gray-200 rounded bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  :disabled="!localStrategySettings.friendQuietHours.enabled"
                >
                <span class="text-xs text-gray-500">-</span>
                <input
                  v-model="localStrategySettings.friendQuietHours.end"
                  type="time"
                  class="w-20 border border-gray-200 rounded bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  :disabled="!localStrategySettings.friendQuietHours.enabled"
                >
              </div>
            </div>

            <div class="border-t pt-3 space-y-3 dark:border-gray-700">
              <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
                种植与偷菜延迟设置
              </h4>
              <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                <BaseSwitch
                  v-model="localStrategySettings.plantOrderRandom"
                  label="种植顺序随机"
                />
                <BaseInput
                  v-model.number="localStrategySettings.plantDelaySeconds"
                  label="种植延迟 (秒)"
                  type="number"
                  min="0"
                />
                <BaseInput
                  v-model.number="localStrategySettings.stealDelaySeconds"
                  label="偷菜延迟 (秒)"
                  type="number"
                  min="0"
                />
              </div>
            </div>

            <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
              <BaseButton
                variant="primary"
                size="sm"
                :loading="strategySaving"
                @click="saveStrategySettings"
              >
                保存策略设置
              </BaseButton>
            </div>
          </div>
        </div>

        <!-- 自动控制 -->
        <div v-else-if="activeTab === 'automation'" class="space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
              自动控制
              <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
                ({{ currentAccountName }})
              </span>
            </h3>
          </div>

          <div v-if="settingsLoading" class="py-4 text-center text-gray-500">
            <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
            <p>加载中...</p>
          </div>

          <div v-else-if="!currentAccountId" class="py-8 text-center text-gray-500">
            <div class="i-carbon-settings-adjust mx-auto mb-2 text-3xl text-gray-400" />
            <p>请先选择账号</p>
          </div>

          <div v-else class="space-y-4">
            <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
              <BaseSwitch v-model="localAutomationSettings.automation.farm" label="自动种植收获" />
              <BaseSwitch v-model="localAutomationSettings.automation.task" label="自动做任务" />
              <BaseSwitch v-model="localAutomationSettings.automation.sell" label="自动卖果实" />
              <BaseSwitch v-model="localAutomationSettings.automation.friend" label="自动好友互动" />
              <BaseSwitch v-model="localAutomationSettings.automation.farm_push" label="推送触发巡田" />
              <BaseSwitch v-model="localAutomationSettings.automation.land_upgrade" label="自动升级土地" />
              <BaseSwitch v-model="localAutomationSettings.automation.fertilizer_gift" label="自动填充化肥" />
            <BaseSwitch v-model="localAutomationSettings.automation.fertilizer_buy_organic" label="自动购买有机化肥" />
            <BaseSwitch v-model="localAutomationSettings.automation.fertilizer_buy_normal" label="自动购买无机化肥" />
            <BaseSwitch v-model="localAutomationSettings.automation.mystery_shop" label="自动购买神秘商店" />
            <BaseSwitch v-model="localAutomationSettings.automation.star_light_up" :label="autoLabel('star_light_up', '千星游记自动点亮领取')" :disabled="isAutomationGated('star_light_up')" />

            <!-- 夺宝(抢宝) -->
            <div class="space-y-2 rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/10">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div class="text-sm text-amber-800 font-medium dark:text-amber-300">
                    夺宝（抢宝）
                  </div>
                  <div class="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                    自动遍历好友，找到正在运送的宝藏并抢夺；挑战书优先用高等级（高级 → 中级 → 初级）。
                  </div>
                  <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    手动夺宝请到「萌宠游记」页面 → 顶部「夺宝（抢宝）」子页面。
                  </div>
                </div>
                <BaseSwitch v-model="localAutomationSettings.automation.rob_treasure" label="启用自动夺宝" />
              </div>
              <div v-if="localAutomationSettings.automation.rob_treasure" class="flex flex-wrap items-end gap-3">
                <BaseInput
                  v-model.number="localAutomationSettings.robTreasureIntervalMinutes"
                  label="检查间隔 (分钟)"
                  type="number"
                  min="1"
                  max="1440"
                />
                <BaseInput
                  v-model.number="localAutomationSettings.robMaxPerRun"
                  label="每轮最多抢 (个)"
                  type="number"
                  min="1"
                  max="20"
                />
                <BaseInput
                  v-model.number="localAutomationSettings.robDailyLimit"
                  label="每日上限 (次, 0=不限)"
                  type="number"
                  min="0"
                  max="200"
                />
                <BaseButton variant="secondary" size="sm" :loading="treasureRunning" @click="runTreasureNow">
                  立即执行一次
                </BaseButton>
              </div>
              <div class="mt-2 space-y-2 border-t border-amber-200 pt-2 dark:border-amber-900/40">
                <div class="flex flex-wrap items-center gap-3">
                  <BaseSwitch v-model="localAutomationSettings.buyBookEnabled" label="每日购买中级挑战书" />
                  <BaseInput
                    v-model.number="localAutomationSettings.buyBookCount"
                    label="每日数量 (个)"
                    type="number"
                    min="0"
                    max="20"
                    class="w-32"
                  />
                </div>
                <div class="flex flex-wrap items-center gap-3">
                  <BaseButton variant="secondary" size="sm" :loading="buyBookRunning" @click="buyBooksNow">
                    立即购买一次
                  </BaseButton>
                  <span v-if="buyBookResult" class="text-xs text-gray-600 dark:text-gray-300">{{ buyBookResult }}</span>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400">
                  每天自动在商城买中级挑战书，150 金豆豆/个（商城 goodsId 1050，游戏每日限购 2 个）；
                  金豆豆不足时只买够的部分，进度跨重启累计。登录后 / 跨日 / 改设置后都会自动检查，
                  另外每 10 分钟自查一次（当天买满就不再发请求）。
                </div>
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400">
                修改后自动保存；自动夺宝在后台按上面的间隔巡检。每次抢夺消耗 1 张挑战书（无论胜负），
                每日最多 20 次；会按对方宝藏的可博弈资金挑挑战书面值，面值超了会被拒绝（白贴书）。
              </div>
            </div>
            <BaseSwitch v-model="localAutomationSettings.automation.solar_terms" label="节令小礼自动领取" />
            <BaseSwitch v-model="localAutomationSettings.automation.weather_task" :label="autoLabel('weather_task', '雨落成诗：每日买采集瓶+对好友使用+雷雨瓶自用')" :disabled="isAutomationGated('weather_task')" />
            <BaseSwitch v-model="localAutomationSettings.automation.weather_research" :label="autoLabel('weather_research', '雨落成诗：气象研究自动升级（消耗雷电徽章）')" :disabled="isAutomationGated('weather_research')" />
            <BaseSwitch v-model="localAutomationSettings.automation.charity_task" :label="autoLabel('charity_task', '公益小红花：每日领公益礼包+送爱心+分享')" :disabled="isAutomationGated('charity_task')" />
            <BaseSwitch v-model="localAutomationSettings.automation.mengchong_task" :label="autoLabel('mengchong_task', '萌宠游记：每日任务(种子礼包/手记/自动投喂)')" :disabled="isAutomationGated('mengchong_task')" />
            <BaseSwitch v-model="localAutomationSettings.automation.mengchong_hunt" :label="autoLabel('mengchong_hunt', '萌宠游记：自动寻宝(消耗元气糕700/次，已有护送时跳过)')" :disabled="isAutomationGated('mengchong_hunt')" />
            <BaseSwitch v-model="localAutomationSettings.automation.skip_own_weed_bug" label="不除自己草虫" />
          </div>

          <!-- 防封号(低调)模式 -->
          <div class="space-y-3 rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/10">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div class="text-sm text-amber-800 font-medium dark:text-amber-300">
                  防封号（低调模式）
                </div>
                <div class="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                  不长期在线：在线一小段时间 → 离线一大段时间循环；作物成熟时自动提前上线收取。
                </div>
                <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  与「自动取码」配合：取码只更新 Code，不会打断正在进行的在线会话；离线期间也不会被取码自动拉起。
                </div>
              </div>
              <BaseSwitch v-model="localAutomationSettings.stealthEnabled" label="启用" />
            </div>

            <div v-if="localAutomationSettings.stealthEnabled" class="space-y-2">
              <div class="flex flex-wrap items-end gap-3">
                <BaseInput
                  v-model.number="localAutomationSettings.stealthOnlineMinMinutes"
                  label="单次在线最短 (分钟)"
                  type="number"
                  min="1"
                  max="180"
                />
                <BaseInput
                  v-model.number="localAutomationSettings.stealthOnlineMaxMinutes"
                  label="单次在线最长 (分钟)"
                  type="number"
                  min="1"
                  max="180"
                />
              </div>
              <div class="flex flex-wrap items-end gap-3">
                <BaseInput
                  v-model.number="localAutomationSettings.stealthOfflineMinMinutes"
                  label="离线最短 (分钟)"
                  type="number"
                  min="1"
                  max="1440"
                />
                <BaseInput
                  v-model.number="localAutomationSettings.stealthOfflineMaxMinutes"
                  label="离线最长 (分钟)"
                  type="number"
                  min="1"
                  max="1440"
                />
              </div>
              <BaseSwitch v-model="localAutomationSettings.stealthWakeForRipe" label="作物成熟时优先上线收取（推荐）" />

              <!-- 实时状态 -->
              <div class="rounded bg-white p-2 text-xs dark:bg-gray-800">
                <div class="mb-1 flex items-center justify-between">
                  <span class="text-gray-500 dark:text-gray-400">当前账号状态</span>
                  <span v-if="stealthSaveState === 'saving'" class="text-blue-500">正在保存…</span>
                  <span v-else-if="stealthSaveState === 'error'" class="text-red-500">保存失败：{{ stealthSaveError }}</span>
                  <span v-else-if="stealthDirty" class="text-amber-600 dark:text-amber-400">有未保存的修改…</span>
                  <span v-else-if="stealthSaveState === 'saved'" class="text-gray-400">已自动保存 {{ stealthSavedAt }}</span>
                  <span v-else class="text-gray-400">修改后自动保存</span>
                </div>
                <div v-if="stealthStatusError" class="mb-2 rounded bg-red-50 px-2 py-1 text-red-600 dark:bg-red-900/30 dark:text-red-300">
                  {{ stealthStatusError }}
                </div>
                <div v-if="myStealth" class="space-y-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class="rounded px-1.5 py-0.5"
                      :class="myStealth.phase === 'online'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                        : myStealth.phase === 'offline'
                          ? 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'"
                    >
                      {{ !myStealth.enabled
                        ? '未启用'
                        : myStealth.phase === 'online'
                          ? '在线中'
                          : myStealth.phase === 'offline'
                            ? '离线中'
                            : '待调度' }}
                    </span>
                    <span v-if="myStealth.nextSwitchAt" class="text-gray-600 dark:text-gray-300">
                      {{ myStealth.phase === 'online' ? '预计' : '预计' }}
                      {{ fmtClock(myStealth.nextSwitchAt) }} {{ myStealth.phase === 'online' ? '下线' : '上线' }}
                      ({{ fmtRemain(myStealth.nextSwitchInSec) }}后)
                    </span>
                  </div>
                  <div v-if="myStealth.lastReason" class="text-gray-500 dark:text-gray-400">
                    {{ myStealth.lastReason }}
                  </div>
                  <div v-if="myStealth.ripeness && myStealth.ripeness.nextReadyAt" class="text-gray-400 dark:text-gray-500">
                    下一批成熟: {{ fmtClock(myStealth.ripeness.nextReadyAt * 1000) }}
                    <span v-if="myStealth.ripeness.ripeCount > 0">(当前有 {{ myStealth.ripeness.ripeCount }} 块地已成熟)</span>
                  </div>
                </div>
                <div v-else class="text-gray-400 dark:text-gray-500">
                  暂无状态记录（开启防封号后自动开始计时）
                </div>
                <div class="mt-2 flex gap-2 border-t border-gray-100 pt-2 dark:border-gray-700">
                  <BaseButton variant="secondary" size="sm" :loading="stealthLoading" @click="handleForceStealth('offline')">
                    立即下线
                  </BaseButton>
                  <BaseButton variant="secondary" size="sm" :loading="stealthLoading" @click="handleForceStealth('online')">
                    立即上线
                  </BaseButton>
                </div>
              </div>
            </div>
          </div>

          <div v-if="localAutomationSettings.automation.fertilizer_buy_organic || localAutomationSettings.automation.fertilizer_buy_normal" class="space-y-3 rounded bg-green-50 p-3 text-sm dark:bg-green-900/20">
            <div v-if="localAutomationSettings.automation.fertilizer_buy_organic" class="space-y-2">
              <div class="font-medium text-green-700 dark:text-green-400">有机化肥设置</div>
              <div class="flex flex-wrap gap-4">
                <BaseInput
                  v-model.number="localAutomationSettings.fertilizerBuyOrganicCount"
                  label="购买数量"
                  type="number"
                  min="1"
                  max="10000"
                />
                <BaseInput
                  v-model.number="localAutomationSettings.fertilizerBuyOrganicThresholdHours"
                  label="触发阈值 (小时)"
                  type="number"
                  min="1"
                  max="990"
                />
              </div>
            </div>
            <div v-if="localAutomationSettings.automation.fertilizer_buy_normal" class="space-y-2">
              <div class="font-medium text-green-700 dark:text-green-400">无机化肥设置</div>
              <div class="flex flex-wrap gap-4">
                <BaseInput
                  v-model.number="localAutomationSettings.fertilizerBuyNormalCount"
                  label="购买数量"
                  type="number"
                  min="1"
                  max="10000"
                />
                <BaseInput
                  v-model.number="localAutomationSettings.fertilizerBuyNormalThresholdHours"
                  label="触发阈值 (小时)"
                  type="number"
                  min="1"
                  max="990"
                />
              </div>
            </div>
            <div class="flex flex-wrap gap-4">
              <BaseInput
                v-model.number="localAutomationSettings.fertilizerBuyCheckIntervalMinutes"
                label="检测间隔 (分钟)"
                type="number"
                min="1"
                max="1440"
              />
            </div>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              系统会按照设定的检测间隔定时检测化肥容器剩余量，当低于触发阈值时自动购买。保存设置后会立即检测一次。同时开启两种化肥购买时，优先购买有机化肥。
            </p>
          </div>

          <div v-if="localAutomationSettings.automation.friend" class="flex flex-wrap gap-4 rounded bg-blue-50 p-3 text-sm dark:bg-blue-900/20">
              <BaseSwitch v-model="localAutomationSettings.automation.friend_steal" label="自动偷菜" />
              <BaseSwitch v-model="localAutomationSettings.automation.friend_help" label="自动帮忙" />
              <BaseSwitch v-model="localAutomationSettings.automation.friend_bad" label="自动捣乱" />
              <BaseSwitch v-model="localAutomationSettings.automation.friend_help_exp_limit" label="经验满不帮忙" />
            </div>

            <div class="space-y-3">
              <div class="border border-amber-200 rounded bg-amber-50/60 p-3 dark:border-amber-800/60 dark:bg-amber-900/10">
                <div class="mb-2 text-sm text-amber-800 font-medium dark:text-amber-300">
                  施肥范围
                </div>
                <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <label
                    v-for="option in fertilizerLandTypeOptions"
                    :key="option.value"
                    class="flex cursor-pointer items-center gap-1.5 rounded bg-white px-2 py-1 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                  >
                    <input
                      v-model="localAutomationSettings.automation.fertilizer_land_types"
                      :value="option.value"
                      type="checkbox"
                      class="h-3.5 w-3.5"
                    >
                    <span>{{ option.label }}</span>
                  </label>
                </div>
                <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  施肥前会优先按土地类型过滤，仅对命中范围的地块执行施肥策略。
                </p>
              </div>

              <BaseSelect
                v-model="localAutomationSettings.automation.fertilizer"
                label="施肥策略"
                :options="fertilizerOptions"
              />

              <div class="flex items-center gap-4">
                <BaseSwitch
                  v-model="localAutomationSettings.automation.fertilizer_multi_season"
                  label="多季补肥"
                />
              </div>

              <div v-if="localAutomationSettings.automation.fertilizer === 'smart'" class="flex flex-wrap gap-4 rounded bg-amber-50 p-3 text-sm dark:bg-amber-900/20">
                <BaseInput
                  v-model.number="localAutomationSettings.automation.fertilizer_smart_seconds"
                  label="快成熟判定秒数"
                  type="number"
                  min="30"
                  max="3600"
                  class="w-40"
                />
                <span class="flex items-end pb-2 text-xs text-gray-500 dark:text-gray-400">
                  距离成熟时间 ≤ 此秒数时施有机肥（默认300秒=5分钟）
                </span>
              </div>
            </div>

            <div class="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
              <BaseButton
                variant="primary"
                size="sm"
                :loading="automationSaving"
                @click="saveAutomationSettings"
              >
                保存自动控制
              </BaseButton>
            </div>
          </div>
        </div>

        <!-- 用户管理 -->
        <div v-else-if="activeTab === 'user'" class="space-y-4">
          <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
            用户管理
          </h3>

          <div class="space-y-4">
            <div class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
                <div class="i-carbon-password" />
                修改用户密码
              </h4>

              <div class="space-y-3">
                <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <BaseInput
                    v-model="passwordForm.old"
                    label="当前密码"
                    type="password"
                    placeholder="当前用户密码"
                  />
                  <BaseInput
                    v-model="passwordForm.new"
                    label="新密码"
                    type="password"
                    placeholder="至少 4 位"
                  />
                  <BaseInput
                    v-model="passwordForm.confirm"
                    label="确认新密码"
                    type="password"
                    placeholder="再次输入新密码"
                  />
                </div>

                <div class="flex items-center justify-end pt-1">
                  <BaseButton
                    variant="primary"
                    size="sm"
                    :loading="passwordSaving"
                    @click="handleChangePassword"
                  >
                    修改用户密码
                  </BaseButton>
                </div>
              </div>
            </div>

            <div class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
                <div class="i-carbon-notification" />
                下线提醒
              </h4>

              <div class="space-y-3">
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-2">
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between">
                      <span class="text-sm text-gray-700 font-medium dark:text-gray-300">推送渠道</span>
                      <BaseButton
                        variant="text"
                        size="sm"
                        :disabled="!currentChannelDocUrl"
                        @click="openChannelDocs"
                      >
                        官网
                      </BaseButton>
                    </div>
                    <BaseSelect
                      v-model="localOffline.channel"
                      :options="channelOptions"
                    />
                  </div>
                  <BaseSelect
                    v-model="localOffline.reloginUrlMode"
                    label="重登录链接"
                    :options="reloginUrlModeOptions"
                  />
                </div>

                <BaseInput
                  v-model="localOffline.endpoint"
                  label="接口地址"
                  type="text"
                  :disabled="localOffline.channel !== 'webhook'"
                />

                <BaseInput
                  v-model="localOffline.token"
                  label="Token"
                  type="text"
                  placeholder="接收端 token"
                />

                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-2">
                  <BaseInput
                    v-model="localOffline.title"
                    label="标题"
                    type="text"
                    placeholder="提醒标题"
                  />
                  <BaseInput
                    v-model.number="localOffline.offlineDeleteSec"
                    label="离线删除账号 (秒)"
                    type="number"
                    min="0"
                    placeholder="0 表示不删除"
                  />
                </div>

                <BaseInput
                  v-model="localOffline.msg"
                  label="内容"
                  type="text"
                  placeholder="提醒内容"
                />
              </div>

              <div class="mt-4 flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
                <BaseButton
                  variant="secondary"
                  size="sm"
                  :loading="offlineTesting"
                  :disabled="offlineSaving"
                  @click="handleTestOffline"
                >
                  测试通知
                </BaseButton>
                <BaseButton
                  variant="primary"
                  size="sm"
                  :loading="offlineSaving"
                  :disabled="offlineTesting"
                  @click="handleSaveOffline"
                >
                  保存下线提醒设置
                </BaseButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="modalVisible"
      :title="modalConfig.title"
      :message="modalConfig.message"
      :type="modalConfig.type"
      :is-alert="modalConfig.isAlert"
      confirm-text="知道了"
      @confirm="modalVisible = false"
      @cancel="modalVisible = false"
    />
  </div>
</template>
