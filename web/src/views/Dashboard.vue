<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { formatCompactNumber, formatSignedCompactNumber } from '@/utils/number-format'

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const bagStore = useBagStore()
const toastStore = useToastStore()
const {
  status,
  logs: statusLogs,
  realtimeConnected,
} = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { dashboardItems } = storeToRefs(bagStore)
const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const lastBagFetchAt = ref(0)
const clearingLogs = ref(false)

const allLogs = computed(() => {
  return (statusLogs.value || [])
    .map((log: any, index: number) => ({
      ...log,
      _uiKey: `${log.id || 'log'}-${log.ts || 0}-${index}`,
    }))
    .sort((a: any, b: any) => getLogTimestamp(a) - getLogTimestamp(b))
})

const filter = reactive({
  module: '',
  event: '',
  keyword: '',
  level: '',
})

const hasActiveLogFilter = computed(() =>
  !!(filter.module || filter.event || filter.keyword || filter.level),
)

const modules = [
  { label: '所有模块', value: '' },
  { label: '农场', value: 'farm' },
  { label: '好友', value: 'friend' },
  { label: '仓库', value: 'warehouse' },
  { label: '任务', value: 'task' },
  { label: '活动', value: 'activity' },
  { label: '商城', value: 'mall' },
  { label: '神秘商店', value: 'mystery_shop' },
  { label: '网络', value: 'network' },
  { label: '调度', value: 'scheduler' },
  { label: '系统', value: 'system' },
]

const events = [
  { label: '所有事件', value: '' },
  { label: '奶茶热销中', value: '奶茶热销中' },
  { label: '秋祈良愿', value: '秋祈良愿' },
  { label: '萌宠游记', value: '萌宠游记' },
  { label: '雨落成诗', value: '雨落成诗' },
  { label: '千星点亮', value: '千星点亮' },
  { label: '夺宝', value: '夺宝' },
  { label: '公益小红花', value: '公益小红花' },
  { label: '快乐不独享', value: '快乐不独享' },
  { label: '农场循环', value: '农场循环' },
  { label: '收获作物', value: '收获作物' },
  { label: '种植种子', value: '种植种子' },
  { label: '施肥', value: '施肥' },
  { label: '铲除植物', value: '铲除植物' },
  { label: '选择种子', value: '选择种子' },
  { label: '购买种子', value: '购买种子' },
  { label: '购买化肥', value: '购买化肥' },
  { label: '开启化肥礼包', value: '开启化肥礼包' },
  { label: '扫描任务', value: '扫描任务' },
  { label: '领取任务', value: '领取任务' },
  { label: '扫描活跃奖励', value: '扫描活跃奖励' },
  { label: '领取活跃奖励', value: '领取活跃奖励' },
  { label: '图鉴奖励', value: '图鉴奖励' },
  { label: '偷菜巡查', value: '偷菜巡查' },
  { label: '好友巡查循环', value: '好友巡查循环' },
  { label: '帮助巡查', value: '帮助巡查' },
  { label: '升级土地', value: '升级土地' },
  { label: '解锁土地', value: '解锁土地' },
  { label: '登录成功', value: 'login_success' },
  { label: '登录失败', value: 'login_failed' },
]

const eventLabelMap: Record<string, string> = Object.fromEntries(
  events.filter(e => e.value).map(e => [e.value, e.label]),
)

function getEventLabel(event: string) {
  return eventLabelMap[event] || event
}

const logLevels = [
  { label: '所有等级', value: '' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
  { label: '错误', value: 'error' },
  { label: '跳过', value: 'skip' },
]

const displayName = computed(() => {
  const account = accountStore.currentAccount

  // Try to use nickname from status (game server)
  const gameName = status.value?.status?.name
  if (gameName) {
    // 如果有备注，显示为“昵称（备注）”
    if (account?.name) {
      return `${gameName} (${account.name})`
    }
    return gameName
  }

  // Check login status
  if (!status.value?.connection?.connected) {
    if (account) {
      // 如果有备注和昵称，显示为“昵称（备注）”
      if (account.name && account.nick) {
        return `${account.nick} (${account.name})`
      }
      return account.name || account.nick || '未登录'
    }
    return '未登录'
  }

  // Fallback to account name (usually ID) or '未命名'
  if (account) {
    // 如果有备注和昵称，显示为“昵称（备注）”
    if (account.name && account.nick) {
      return `${account.nick} (${account.name})`
    }
    return account.name || account.nick || '未命名'
  }
  return '未命名'
})

// Exp Rate & Time to Level
const expRate = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptime = status.value?.uptime || 0
  if (!uptime)
    return '0/时'
  const hours = uptime / 3600
  const rate = hours > 0 ? (gain / hours) : 0
  return `${Math.floor(rate)}/时`
})

const timeToLevel = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptime = status.value?.uptime || 0
  const current = status.value?.levelProgress?.current || 0
  const needed = status.value?.levelProgress?.needed || 0

  if (!needed || !uptime || gain <= 0)
    return ''

  const hours = uptime / 3600
  const ratePerHour = hours > 0 ? (gain / hours) : 0
  if (ratePerHour <= 0)
    return ''

  const expNeeded = needed - current
  const minsToLevel = expNeeded / (ratePerHour / 60)

  if (minsToLevel < 60)
    return `约 ${Math.ceil(minsToLevel)} 分钟后升级`
  return `约 ${(minsToLevel / 60).toFixed(1)} 小时后升级`
})

// Fertilizer & Collection
const fertilizerNormal = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 1011))
const fertilizerOrganic = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 1012))
const collectionNormal = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 3001))
const collectionRare = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 3002))

function formatBucketTime(item: any) {
  if (!item)
    return '0.0h'
  if (item.hoursText)
    return item.hoursText.replace('小时', 'h')
  const count = Number(item.count || 0)
  return `${(count / 3600).toFixed(1)}h`
}

// Next Check Countdown
const nextFarmCheck = ref('--:--:--')
const nextHelpCheck = ref('--:--:--')
const nextStealCheck = ref('--:--:--')
const localUptime = ref(0)
let localNextFarmRemainSec = 0
let localNextHelpRemainSec = 0
let localNextStealRemainSec = 0

function updateCountdowns() {
  // Update uptime
  if (!status.value?.connection?.connected) {
    nextFarmCheck.value = '账号未登录'
    nextHelpCheck.value = '账号未登录'
    nextStealCheck.value = '账号未登录'
  }
  else {
    localUptime.value++
    if (localNextFarmRemainSec > 0) {
      localNextFarmRemainSec--
      nextFarmCheck.value = formatDuration(localNextFarmRemainSec)
    }
    else {
      nextFarmCheck.value = '巡查中...'
    }

    if (localNextHelpRemainSec > 0) {
      localNextHelpRemainSec--
      nextHelpCheck.value = formatDuration(localNextHelpRemainSec)
    }
    else {
      nextHelpCheck.value = '巡查中...'
    }

    if (localNextStealRemainSec > 0) {
      localNextStealRemainSec--
      nextStealCheck.value = formatDuration(localNextStealRemainSec)
    }
    else {
      nextStealCheck.value = '巡查中...'
    }
  }
}

watch(status, (newVal) => {
  if (newVal?.nextChecks) {
    // Only update local counters if they are significantly different or 0
    // Actually, we should sync from server periodically.
    // Here we just take server value when it comes.
    localNextFarmRemainSec = newVal.nextChecks.farmRemainSec || 0
    localNextHelpRemainSec = newVal.nextChecks.helpRemainSec || 0
    localNextStealRemainSec = newVal.nextChecks.stealRemainSec || 0
    updateCountdowns() // Update immediately
  }
  if (newVal?.uptime !== undefined) {
    localUptime.value = newVal.uptime
  }
}, { deep: true })

function formatDuration(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  const pad = (n: number) => n.toString().padStart(2, '0')

  if (d > 0)
    return `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function formatNumber(value: unknown) {
  return Math.max(0, Number(value) || 0).toLocaleString('zh-CN')
}

function formatCurrencyNumber(value: unknown) {
  return formatCompactNumber(value)
}

function formatSignedCurrencyNumber(value: unknown) {
  return formatSignedCompactNumber(value)
}

function getLogTimestamp(log: any) {
  const ts = Number(log?.ts)
  if (Number.isFinite(ts) && ts > 0)
    return ts
  const parsed = Date.parse(String(log?.time || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function getLogLevel(log: any) {
  const tag = String(log?.tag || '')
  const result = String(log?.meta?.result || '').toLowerCase()
  if (tag === '错误' || result === 'error')
    return 'error'
  if (result === 'skip')
    return 'skip'
  if (tag === '警告' || result === 'warn' || log?.isWarn)
    return 'warn'
  return 'info'
}

function getLogTag(log: any) {
  const tag = String(log?.tag || '系统')
  return tag === '错误' || tag === '警告' ? '系统' : tag
}

const LOG_LEVEL_LABELS: Record<string, string> = {
  info: '普通',
  warn: '警告',
  error: '错误',
  skip: '跳过',
}

function getLogLevelLabel(level: string) {
  return LOG_LEVEL_LABELS[level] || level
}

function getLogTagClass(tag: string) {
  if (tag === '活动')
    return 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
  if (tag === '商城' || tag === '神秘商店')
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
  if (tag === '网络' || tag === '调度')
    return 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'
  if (tag === '系统')
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
}

function getLogLevelClass(level: string) {
  if (level === 'warn')
    return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
  if (level === 'error')
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (level === 'skip')
    return 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  return ''
}

function getLogMsgClass(level: string) {
  if (level === 'error')
    return 'text-red-600 dark:text-red-400'
  if (level === 'warn')
    return 'text-orange-700 dark:text-orange-300'
  return 'text-gray-700 dark:text-gray-300'
}

function formatLogTime(timeStr: string) {
  // 2024/5/20 12:34:56 -> 12:34:56
  if (!timeStr)
    return ''
  const parts = timeStr.split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}

const OP_META: Record<string, { label: string, icon: string, color: string }> = {
  harvest: { label: '收获', icon: 'i-carbon-crop-growth', color: 'text-green-500' },
  water: { label: '浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-400' },
  weed: { label: '除草', icon: 'i-carbon-cut-out', color: 'text-yellow-500' },
  bug: { label: '除虫', icon: 'i-carbon-warning-alt', color: 'text-red-400' },
  fertilize: { label: '施肥', icon: 'i-carbon-chemistry', color: 'text-emerald-500' },
  plant: { label: '种植', icon: 'i-carbon-tree', color: 'text-lime-500' },
  steal: { label: '偷菜', icon: 'i-carbon-run', color: 'text-orange-500' },
  helpWater: { label: '帮浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-300' },
  helpWeed: { label: '帮除草', icon: 'i-carbon-cut-out', color: 'text-yellow-400' },
  helpBug: { label: '帮除虫', icon: 'i-carbon-warning-alt', color: 'text-red-300' },
  taskClaim: { label: '任务', icon: 'i-carbon-task-complete', color: 'text-indigo-500' },
  sell: { label: '出售', icon: 'i-carbon-shopping-cart', color: 'text-pink-500' },
}

const filteredOperations = computed(() => {
  const ops = status.value?.operations || {}
  const result: Record<string, number> = {}
  for (const key of Object.keys(ops)) {
    if (key !== 'upgrade' && key !== 'levelUp') {
      result[key] = ops[key]
    }
  }
  return result
})

function getOpName(key: string | number) {
  return OP_META[String(key)]?.label || String(key)
}

function getOpIcon(key: string | number) {
  return OP_META[String(key)]?.icon || 'i-carbon-circle-dash'
}

function getOpColor(key: string | number) {
  return OP_META[String(key)]?.color || 'text-gray-400'
}

function getExpPercent(p: any) {
  if (!p || !p.needed)
    return 0
  return Math.min(100, Math.max(0, (p.current / p.needed) * 100))
}

async function refreshBag(force = false) {
  if (!currentAccountId.value)
    return
  if (!currentAccount.value?.running)
    return
  if (!status.value?.connection?.connected)
    return

  const now = Date.now()
  if (!force && now - lastBagFetchAt.value < 2500)
    return
  lastBagFetchAt.value = now
  await bagStore.fetchBag(currentAccountId.value)
}

async function refresh(forceReloadLogs = false) {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    // 首次加载、断线兜底时走 HTTP；连接正常时优先走 WS 实时推送
    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }

    if (forceReloadLogs || hasActiveLogFilter.value || !realtimeConnected.value) {
      await statusStore.fetchLogs(currentAccountId.value, {
        module: filter.module || undefined,
        event: filter.event || undefined,
        keyword: filter.keyword || undefined,
        level: filter.level || undefined,
      })
    }

    // 仅在账号已运行且连接就绪后拉背包，避免启动阶段触发500
    await refreshBag()
  }
}

function onLogFilterChange() {
  refresh(true)
}

function onLogSearchTrigger() {
  refresh(true)
}

watch(currentAccountId, async () => {
  await refresh()
  scrollToBottom()
})

watch(() => status.value?.connection?.connected, (connected) => {
  if (connected)
    refreshBag(true)
})

watch(() => JSON.stringify(status.value?.operations || {}), (next, prev) => {
  if (!realtimeConnected.value || next === prev)
    return
  refreshBag()
})

watch(hasActiveLogFilter, (enabled) => {
  statusStore.setRealtimeLogsEnabled(!enabled)
  refresh()
})

function onLogScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el)
    return
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  autoScroll.value = isNearBottom
}

async function clearLogs() {
  if (!currentAccountId.value)
    return
  clearingLogs.value = true
  try {
    const { data } = await api.delete('/api/logs')
    if (data?.ok) {
      toastStore.success('日志已清空')
      await refresh(true)
    }
    else {
      toastStore.error(`清空失败: ${data?.error || '未知错误'}`)
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '请求失败'
    toastStore.error(`清空失败: ${msg}`)
  }
  finally {
    clearingLogs.value = false
  }
}

// Auto scroll logs
watch(allLogs, () => {
  nextTick(() => {
    if (logContainer.value && autoScroll.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
}, { deep: true })

function scrollToBottom() {
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
}

onMounted(async () => {
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  await refresh()
  scrollToBottom()
})

// Auto refresh fallback every 10s (WS 断开或筛选条件启用时会回退 HTTP)
useIntervalFn(refresh, 10000)
// Countdown timer (every 1s)
useIntervalFn(updateCountdowns, 1000)
</script>

<template>
  <div class="flex flex-col gap-6 pt-6">
    <!-- Status Cards -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3 sm:grid-cols-2">
      <!-- Account & Exp -->
      <div class="flex flex-col rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-2 flex items-start justify-between">
          <div class="flex items-center gap-1.5 text-sm text-gray-500">
            <div class="i-fas-user-circle" />
            账号
          </div>
          <div class="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            Lv.{{ status?.status?.level || 0 }}
          </div>
        </div>
        <div class="mb-1 truncate text-xl font-bold" :title="displayName">
          {{ displayName }}
        </div>

        <!-- Level Progress -->
        <div class="mt-auto">
          <div class="mb-1 flex justify-between text-xs text-gray-500">
            <div class="flex items-center gap-1">
              <div class="i-fas-bolt text-blue-400" />
              <span>EXP</span>
            </div>
            <span>{{ formatNumber(status?.levelProgress?.current) }} / {{ status?.levelProgress?.needed ? formatNumber(status.levelProgress.needed) : '?' }}</span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              class="h-full rounded-full bg-blue-500 transition-all duration-500"
              :style="{ width: `${getExpPercent(status?.levelProgress)}%` }"
            />
          </div>
          <div class="mt-2 flex justify-between text-xs text-gray-400">
            <span>效率: {{ expRate }}</span>
            <span>{{ timeToLevel }}</span>
          </div>
        </div>
      </div>

      <!-- Assets & Status -->
      <div class="flex flex-col justify-between rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="flex justify-between">
          <div>
            <div class="flex items-center gap-1.5 text-xs text-gray-500">
              <div class="i-fas-coins text-yellow-500" />
              金币
            </div>
            <div class="text-2xl text-yellow-600 font-bold dark:text-yellow-500">
              {{ formatCurrencyNumber(status?.status?.gold) }}
            </div>
            <div
              v-if="(status?.sessionGoldGained || 0) !== 0"
              class="text-[10px]"
              :class="(status?.sessionGoldGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ formatSignedCurrencyNumber(status?.sessionGoldGained) }}
            </div>
          </div>
          <div class="text-right">
            <div class="flex items-center justify-end gap-1.5 text-xs text-gray-500">
              <div class="i-fas-ticket-alt text-emerald-400" />
              点券
            </div>
            <div class="text-2xl text-emerald-500 font-bold dark:text-emerald-400">
              {{ formatCurrencyNumber(status?.status?.coupon) }}
            </div>
            <div
              v-if="(status?.sessionCouponGained || 0) !== 0"
              class="text-[10px]"
              :class="(status?.sessionCouponGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ formatSignedCurrencyNumber(status?.sessionCouponGained) }}
            </div>
          </div>
          <div class="text-right">
            <div class="flex items-center justify-end gap-1.5 text-xs text-gray-500">
              <div class="i-carbon-diamond-outline text-blue-400" />
              钻石
            </div>
            <div class="text-2xl text-blue-500 font-bold dark:text-blue-400">
              {{ formatCurrencyNumber(status?.status?.diamond) }}
            </div>
          </div>
          <div class="text-right">
            <div class="flex items-center justify-end gap-1.5 text-xs text-gray-500">
              <div class="i-carbon-circle text-amber-500" />
              金豆豆
            </div>
            <div class="text-2xl text-amber-500 font-bold dark:text-amber-400">
              {{ formatCurrencyNumber(status?.status?.goldBean) }}
            </div>
          </div>
        </div>
        <div class="mt-4 border-t border-gray-100 pt-3 dark:border-gray-700">
          <div class="flex items-center justify-between">
            <div class="flex min-w-0 items-center gap-2">
              <div class="h-2.5 w-2.5 shrink-0 rounded-full" :class="status?.connection?.connected ? 'bg-green-500' : 'bg-red-500'" />
              <span class="shrink-0 text-xs font-bold">{{ status?.connection?.connected ? '在线' : '离线' }}</span>
              <!-- 离线原因: 以前只显示"已离线", 用户不知道是掉线还是 Code 失效 -->
              <span
                v-if="!status?.connection?.connected && status?.connection?.reason"
                class="truncate text-xs text-red-400"
                :title="status?.connection?.detail || status?.connection?.reason"
              >
                {{ status?.connection?.reason }}
              </span>
            </div>
            <div class="flex items-center gap-1.5 text-xs text-gray-400">
              <div class="i-fas-clock text-purple-400" />
              {{ formatDuration(localUptime) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Items (Fertilizer & Collection) -->
      <div class="flex flex-col justify-between rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-2 flex items-center gap-1.5 text-sm text-gray-500">
          <div class="i-fas-flask text-emerald-400" />
          化肥容器
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-flask text-emerald-400" />
              普通
            </div>
            <div class="font-bold">
              {{ formatBucketTime(fertilizerNormal) }}
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-vial text-emerald-400" />
              有机
            </div>
            <div class="font-bold">
              {{ formatBucketTime(fertilizerOrganic) }}
            </div>
          </div>
        </div>
        <div class="my-2 border-t border-gray-100 dark:border-gray-700" />
        <div class="mb-1 flex items-center gap-1.5 text-sm text-gray-500">
          <div class="i-fas-star text-emerald-400" />
          收藏点
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-bookmark text-emerald-400" />
              普通
            </div>
            <div class="font-bold">
              {{ collectionNormal?.count || 0 }}
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-gem text-emerald-400" />
              典藏
            </div>
            <div class="font-bold">
              {{ collectionRare?.count || 0 }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Content Flex -->
    <div class="flex flex-1 flex-col items-stretch gap-6 md:flex-row">
      <!-- Logs (Left Column) -->
      <div class="flex flex-1 flex-col gap-6 md:w-3/4">
        <!-- Logs -->
        <div class="flex flex-1 flex-col rounded-lg bg-white p-6 shadow md:overflow-hidden dark:bg-gray-800">
          <div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <h3 class="flex items-center gap-2 text-lg font-medium">
              <div class="i-carbon-document" />
              <span>运行日志</span>
            </h3>

            <div class="flex flex-wrap items-center gap-2 text-sm">
              <BaseSelect
                v-model="filter.module"
                :options="modules"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseSelect
                v-model="filter.event"
                :options="events"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseSelect
                v-model="filter.level"
                :options="logLevels"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseInput
                v-model="filter.keyword"
                placeholder="关键词..."
                class="w-32"
                clearable
                @keyup.enter="onLogSearchTrigger"
                @clear="onLogSearchTrigger"
              />

              <BaseButton
                variant="primary"
                size="sm"
                @click="onLogSearchTrigger"
              >
                <div class="i-carbon-search" />
              </BaseButton>

              <BaseButton
                variant="secondary"
                size="sm"
                :loading="clearingLogs"
                @click="clearLogs"
              >
                <div class="i-carbon-trash-can" />
              </BaseButton>
            </div>
          </div>

          <div ref="logContainer" class="max-h-[50vh] min-h-0 flex-1 overflow-y-auto rounded bg-gray-50 p-4 text-sm leading-relaxed font-mono dark:bg-gray-900" @scroll="onLogScroll">
            <div v-if="!allLogs.length" class="py-8 text-center text-gray-400">
              暂无日志
            </div>
            <div v-for="log in allLogs" :key="log._uiKey" class="mb-1.5 flex items-start gap-2 break-all">
              <span class="shrink-0 select-none text-gray-400">[{{ formatLogTime(log.time) }}]</span>
              <span class="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold" :class="getLogTagClass(getLogTag(log))">{{ getLogTag(log) }}</span>
              <span v-if="getLogLevel(log) !== 'info'" class="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold" :class="getLogLevelClass(getLogLevel(log))">{{ getLogLevelLabel(getLogLevel(log)) }}</span>
              <span v-if="log.meta?.event" class="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-500 dark:bg-blue-900/20 dark:text-blue-400">{{ getEventLabel(log.meta.event) }}</span>
              <span class="min-w-0" :class="getLogMsgClass(getLogLevel(log))">{{ log.msg }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Right Column Stack -->
      <div class="flex flex-col gap-6 md:w-1/4">
        <!-- Next Checks -->
        <div class="flex flex-col rounded-lg bg-white p-6 shadow dark:bg-gray-800">
          <h3 class="mb-4 flex items-center gap-2 text-lg font-medium">
            <div class="i-carbon-hourglass" />
            <span>下次巡查倒计时</span>
          </h3>
          <div class="flex flex-col justify-center gap-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-sprout text-lg text-green-500" />
                <span>农场</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextFarmCheck }}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-user-multiple text-lg text-blue-500" />
                <span>帮助</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextHelpCheck }}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-run text-lg text-orange-500" />
                <span>偷菜</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextStealCheck }}
              </div>
            </div>
          </div>
        </div>

        <!-- Operations Grid -->
        <div class="flex-1 rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <h3 class="mb-3 flex items-center gap-2 text-lg font-medium">
            <div class="i-carbon-chart-column" />
            <span>今日统计</span>
          </h3>
          <div v-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
            <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
            <div class="flex flex-col">
              <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
                账号未登录
              </div>
              <div class="mt-1 text-sm text-gray-400">
                请先运行账号或检查网络连接
              </div>
            </div>
          </div>
          <div v-else class="grid grid-cols-2 gap-2 2xl:gap-3">
            <div
              v-for="(val, key) in filteredOperations"
              :key="key"
              class="flex items-center justify-between rounded bg-gray-50 px-3 py-2 dark:bg-gray-700/30"
            >
              <div class="flex items-center gap-2">
                <div class="text-base 2xl:text-lg" :class="[getOpIcon(key), getOpColor(key)]" />
                <div class="text-xs text-gray-500 2xl:text-sm">
                  {{ getOpName(key) }}
                </div>
              </div>
              <div class="text-sm font-bold 2xl:text-base">
                {{ val }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
