<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { usePlantBlacklistStore } from '@/stores/plant-blacklist'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const plantBlacklistStore = usePlantBlacklistStore()
const toast = useToastStore()
const statusStore = useStatusStore()
const { currentAccountId } = storeToRefs(accountStore)
const { blacklist } = storeToRefs(plantBlacklistStore)
const { status } = storeToRefs(statusStore)

const loading = ref(false)
const list = ref<any[]>([])
const sortKey = ref('exp')
const imageErrors = ref<Record<string | number, boolean>>({})
const searchKeyword = ref('')
const batchLoading = ref(false)

const activeTab = ref('crops')

// ===== 牧场幼崽分析(对照上面的作物分析) =====
const cubRows = ref<any[]>([])
const cubLoading = ref(false)
const cubError = ref('')
/** live = 实时商城价; offline = 抓包快照兜底(账号没跑时仍能看全部幼崽) */
const cubSource = ref<string>('')
const cubLiveError = ref<string>('')
// 排序键与农场 /api/analytics 同构(exp / fert_exp / profit / fert_profit)
const cubSort = ref<'exp' | 'fert_exp' | 'profit' | 'fert_profit' | 'ratio' | 'cost' | 'level'>('exp')

async function loadCubAnalytics() {
  const id = currentAccountId.value
  cubLoading.value = true
  cubError.value = ''
  try {
    const res = await api.get('/api/ranch/analytics', {
      headers: id ? { 'x-account-id': id } : {},
      params: { sort: cubSort.value },
      timeout: 20000,
    })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '获取失败')
    // 后端已对齐农场格式(返回 { data: rows }), 兼容旧的 rows
    cubRows.value = (Array.isArray(d.data) ? d.data : (d.data?.rows || d.data?.data)) || []
    // live = 实时商城价; offline = 账号没跑/商城拉不到, 用抓包快照的兜底价
    cubSource.value = d.source || 'live'
    cubLiveError.value = d.liveError || ''
  }
  catch (e: any) {
    cubSource.value = ''
    cubError.value = e?.response?.data?.error || e?.message || '获取失败'
  }
  finally {
    cubLoading.value = false
  }
}

watch(cubSort, () => {
  if (activeTab.value === 'ranch')
    void loadCubAnalytics()
})

// 切账号后重新拉(牧场 tab 默认显示的就是当前账号的实时价/兜底价)
watch(currentAccountId, () => {
  if (activeTab.value === 'ranch')
    void loadCubAnalytics()
})

const strategyLevel = ref(1)

watch(() => status.value?.status?.level, (newLevel) => {
  if (newLevel && Number(newLevel) > 0) {
    strategyLevel.value = Number(newLevel)
  }
}, { immediate: true })

const strategies = [
  {
    key: 'max_exp',
    label: '经验/时',
    metric: 'expPerHour',
    color: 'purple',
    icon: 'i-carbon-growth',
    unit: 'EXP',
    desc: '每小时经验收益最高',
  },
  {
    key: 'max_profit',
    label: '利润/时',
    metric: 'profitPerHour',
    color: 'amber',
    icon: 'i-carbon-currency',
    unit: '金币',
    desc: '每小时净利润最高',
  },
  {
    key: 'max_fert_exp',
    label: '普肥经验/时',
    metric: 'normalFertilizerExpPerHour',
    color: 'blue',
    icon: 'i-carbon-chemistry',
    unit: 'EXP',
    desc: '使用普通化肥后经验最高',
  },
  {
    key: 'max_fert_profit',
    label: '普肥利润/时',
    metric: 'normalFertilizerProfitPerHour',
    color: 'green',
    icon: 'i-carbon-piggy-bank',
    unit: '金币',
    desc: '使用普通化肥后利润最高',
  },
]

function getStrategyBestPlant(strategyKey: string) {
  const strategy = strategies.find(s => s.key === strategyKey)
  if (!strategy)
    return null

  const metric = strategy.metric
  const filtered = list.value.filter((item) => {
    const level = item.level
    if (level === null || level === undefined)
      return true
    return Number(level) <= strategyLevel.value
  })

  if (filtered.length === 0)
    return null

  if (strategyKey === 'level') {
    return [...filtered].sort((a, b) => {
      const av = a.level ?? -1
      const bv = b.level ?? -1
      return bv - av
    })[0]
  }

  return [...filtered].sort((a, b) => {
    const av = Number(a[metric])
    const bv = Number(b[metric])
    if (!Number.isFinite(av) && !Number.isFinite(bv))
      return 0
    if (!Number.isFinite(av))
      return 1
    if (!Number.isFinite(bv))
      return -1
    return bv - av
  })[0]
}

function getStrategyAvailableCount() {
  return list.value.filter((item) => {
    const level = item.level
    if (level === null || level === undefined)
      return true
    return Number(level) <= strategyLevel.value
  }).length
}

function getColorClass(color: string, type: 'bg' | 'text' | 'border' | 'gradient') {
  const colorMap: Record<string, Record<string, string>> = {
    purple: {
      bg: 'bg-purple-100 dark:bg-purple-900/30',
      text: 'text-purple-600 dark:text-purple-400',
      border: 'border-purple-200 dark:border-purple-800',
      gradient: 'from-purple-500 to-purple-600',
    },
    blue: {
      bg: 'bg-blue-100 dark:bg-blue-900/30',
      text: 'text-blue-600 dark:text-blue-400',
      border: 'border-blue-200 dark:border-blue-800',
      gradient: 'from-blue-500 to-blue-600',
    },
    amber: {
      bg: 'bg-amber-100 dark:bg-amber-900/30',
      text: 'text-amber-600 dark:text-amber-400',
      border: 'border-amber-200 dark:border-amber-800',
      gradient: 'from-amber-500 to-amber-600',
    },
    green: {
      bg: 'bg-green-100 dark:bg-green-900/30',
      text: 'text-green-600 dark:text-green-400',
      border: 'border-green-200 dark:border-green-800',
      gradient: 'from-green-500 to-green-600',
    },
    rose: {
      bg: 'bg-rose-100 dark:bg-rose-900/30',
      text: 'text-rose-600 dark:text-rose-400',
      border: 'border-rose-200 dark:border-rose-800',
      gradient: 'from-rose-500 to-rose-600',
    },
  }
  return colorMap[color]?.[type] || ''
}

const filteredList = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  if (!keyword)
    return list.value

  return list.value.filter((item: any) => {
    const name = String(item?.name || '').toLowerCase()
    const seedId = String(item?.seedId || '')
    return name.includes(keyword) || seedId.includes(keyword)
  })
})

const sortOptions = [
  { value: 'exp', label: '经验/小时' },
  { value: 'fert', label: '普通肥经验/小时' },
  { value: 'profit', label: '利润/小时' },
  { value: 'fert_profit', label: '普通肥利润/小时' },
  { value: 'level', label: '等级' },
]

const sortOrder = ref<'desc' | 'asc'>('desc')

const sortOrderOptions = [
  { value: 'desc', label: '倒序' },
  { value: 'asc', label: '正序' },
]

const sortedList = computed(() => {
  const metricMap: Record<string, string> = {
    exp: 'expPerHour',
    fert: 'normalFertilizerExpPerHour',
    profit: 'profitPerHour',
    fert_profit: 'normalFertilizerProfitPerHour',
    level: 'level',
  }
  const metric = metricMap[sortKey.value]
  if (!metric)
    return filteredList.value

  const sorted = [...filteredList.value].sort((a, b) => {
    const av = Number(a[metric])
    const bv = Number(b[metric])
    if (!Number.isFinite(av) && !Number.isFinite(bv))
      return 0
    if (!Number.isFinite(av))
      return 1
    if (!Number.isFinite(bv))
      return -1
    return sortOrder.value === 'desc' ? bv - av : av - bv
  })
  return sorted
})

async function loadAnalytics() {
  if (!currentAccountId.value)
    return
  loading.value = true
  try {
    const res = await api.get(`/api/analytics`, {
      params: { sort: sortKey.value },
      headers: { 'x-account-id': currentAccountId.value },
    })
    const data = res.data.data
    if (Array.isArray(data)) {
      list.value = data
    }
    else {
      list.value = []
    }
  }
  catch (e) {
    console.error(e)
    list.value = []
  }
  finally {
    loading.value = false
  }
}

async function handleToggleBlacklist(item: any) {
  await plantBlacklistStore.toggleBlacklist(item.seedId)
  if (plantBlacklistStore.isBlacklisted(item.seedId)) {
    toast.success(`${item.name} 已加入偷菜黑名单`)
  }
  else {
    toast.success(`${item.name} 已移出偷菜黑名单`)
  }
}

async function handleAddAllToBlacklist() {
  if (batchLoading.value)
    return
  batchLoading.value = true
  try {
    const allSeedIds = list.value.map((item: any) => item.seedId)
    await plantBlacklistStore.addAllToBlacklist(allSeedIds)
    toast.success(`已将 ${allSeedIds.length} 种作物加入偷菜黑名单`)
  }
  finally {
    batchLoading.value = false
  }
}

async function handleClearBlacklist() {
  if (batchLoading.value)
    return
  batchLoading.value = true
  try {
    await plantBlacklistStore.clearBlacklist()
    toast.success('已清空偷菜黑名单')
  }
  finally {
    batchLoading.value = false
  }
}

onMounted(() => {
  loadAnalytics()
  plantBlacklistStore.fetchBlacklist()
})

watch([currentAccountId, sortKey], () => {
  loadAnalytics()
})

function formatLv(level: any) {
  if (level === null || level === undefined || level === '' || Number(level) < 0)
    return '未知'
  return String(level)
}

function getSeedNameById(seedId: number) {
  const item = list.value.find((i: any) => i.seedId === seedId)
  return item?.name || `蔬菜ID:${seedId}`
}

function formatGrowTime(seconds: any) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0)
    return '0秒'
  if (s < 60)
    return `${s}秒`
  if (s < 3600) {
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return secs > 0 ? `${mins}分${secs}秒` : `${mins}分`
  }
  const hours = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  return mins > 0 ? `${hours}时${mins}分` : `${hours}时`
}
</script>

<template>
  <div class="space-y-4">
    <div class="scrollbar-none flex flex-nowrap snap-x snap-mandatory gap-2 overflow-x-auto border-b border-gray-200 dark:border-gray-700">
      <button
        class="min-h-[44px] snap-start whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors"
        :class="activeTab === 'crops'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'crops'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-sprout h-6 w-6 flex items-center justify-center text-lg" />
          <span>全部作物</span>
          <span v-if="list.length" class="ml-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/50 dark:text-green-300">
            {{ list.length }}
          </span>
        </div>
      </button>
      <button
        class="border-b-2 px-4 py-2 text-sm font-medium transition-colors"
        :class="activeTab === 'blacklist'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'blacklist'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-subtract-alt h-6 w-6 flex items-center justify-center text-lg" />
          <span>黑名单</span>
          <span v-if="blacklist.length" class="ml-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/50 dark:text-red-300">
            {{ blacklist.length }}
          </span>
        </div>
      </button>
      <button
        class="border-b-2 px-4 py-2 text-sm font-medium transition-colors"
        :class="activeTab === 'strategy'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'strategy'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-chart-line h-6 w-6 flex items-center justify-center text-lg" />
          <span>种植策略</span>
        </div>
      </button>
      <!-- 牧场幼崽分析 -->
      <button
        class="border-b-2 px-4 py-2 text-sm font-medium transition-colors"
        :class="activeTab === 'ranch'
          ? 'border-amber-500 text-amber-600 dark:border-amber-400 dark:text-amber-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'ranch'; loadCubAnalytics()"
      >
        <div class="flex items-center space-x-2">
          <div class="i-fas-paw h-6 w-6 flex items-center justify-center text-lg" />
          <span>牧场幼崽</span>
          <span v-if="cubRows.length" class="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            {{ cubRows.length }}
          </span>
        </div>
      </button>
    </div>

    <div>
      <LoadingState v-if="loading" />

      <div v-else-if="!currentAccountId" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
        请选择账号后查看数据分析
      </div>

      <div v-else-if="list.length === 0" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
        暂无数据
      </div>

      <div v-else-if="activeTab === 'crops'" class="space-y-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-3">
            <div class="i-carbon-sprout text-xl text-green-500" />
            <div>
              <h3 class="text-gray-700 font-semibold dark:text-gray-300">
                全部作物信息
              </h3>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                共 {{ list.length }} 种作物
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <div class="relative">
              <div class="i-carbon-search absolute left-3 top-1/2 text-gray-400 -translate-y-1/2" />
              <input
                v-model="searchKeyword"
                type="text"
                placeholder="搜索作物..."
                class="w-full border border-gray-300 rounded-lg bg-white py-2 pl-10 pr-4 text-sm sm:w-64 dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
            </div>
            <div v-if="list.length" class="text-sm text-gray-500">
              {{ sortedList.length }}/{{ list.length }}
            </div>
            <label class="whitespace-nowrap text-sm font-medium">排序:</label>
            <BaseSelect
              v-model="sortKey"
              :options="sortOptions"
              class="w-40"
            />
            <BaseSelect
              v-model="sortOrder"
              :options="sortOrderOptions"
              class="w-20"
            />
          </div>
        </div>

        <div class="p-4 space-y-4">
          <div class="block sm:hidden space-y-4">
            <div v-for="(item, idx) in sortedList" :key="idx" class="border border-gray-200 rounded-lg bg-white p-4 shadow dark:border-gray-700 dark:bg-gray-800">
              <div class="mb-3 flex items-start gap-3">
                <div class="relative h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                  <img
                    v-if="item.image && !imageErrors[item.seedId]"
                    :src="item.image"
                    class="h-10 w-10 object-contain"
                    loading="lazy"
                    @error="imageErrors[item.seedId] = true"
                  >
                  <div v-else class="i-carbon-sprout text-2xl text-gray-400" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center justify-between">
                    <div class="truncate text-gray-900 font-bold dark:text-gray-100">
                      {{ item.name }}
                      <span v-if="blacklist.includes(item.seedId)" class="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400">黑名单</span>
                    </div>
                    <div class="text-xs text-gray-500">
                      ID:{{ item.seedId }}
                    </div>
                  </div>
                  <div class="mt-1 flex items-center gap-2">
                    <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 font-medium dark:bg-gray-700">Lv{{ formatLv(item.level) }}</span>
                    <span class="text-xs text-gray-400">{{ item.seasons }}季</span>
                  </div>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div class="flex flex-col">
                  <span class="text-xs text-gray-500">时间</span>
                  <span class="text-gray-700 font-medium dark:text-gray-300">{{ formatGrowTime(item.growTime) }}</span>
                </div>
                <div class="flex flex-col">
                  <span class="text-xs text-gray-500">经验/时</span>
                  <span class="text-purple-600 font-bold dark:text-purple-400">{{ item.expPerHour }}</span>
                </div>
                <div class="flex flex-col">
                  <span class="text-xs text-gray-500">净利润/时</span>
                  <span class="text-amber-500 font-bold">{{ item.profitPerHour ?? '-' }}</span>
                </div>
                <div class="flex flex-col">
                  <span class="text-xs text-gray-500">普肥经验/时</span>
                  <span class="text-blue-600 font-bold dark:text-blue-400">{{ item.normalFertilizerExpPerHour ?? '-' }}</span>
                </div>
                <div class="flex flex-col">
                  <span class="text-xs text-gray-500">普肥利润/时</span>
                  <span class="text-green-500 font-bold">{{ item.normalFertilizerProfitPerHour ?? '-' }}</span>
                </div>
              </div>

              <div class="mt-3">
                <button
                  class="w-full rounded px-3 py-2 text-sm transition"
                  :class="blacklist.includes(item.seedId)
                    ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
                  @click="handleToggleBlacklist(item)"
                >
                  {{ blacklist.includes(item.seedId) ? '移出偷菜黑名单' : '加入偷菜黑名单' }}
                </button>
              </div>
            </div>
          </div>

          <div class="hidden overflow-hidden border border-gray-200 rounded-lg bg-white shadow sm:block dark:border-gray-700 dark:bg-gray-800">
            <div class="overflow-x-auto -mx-3 sm:mx-0">
              <table class="w-full whitespace-nowrap text-left text-sm">
                <thead class="border-b bg-gray-50 text-xs text-gray-500 uppercase dark:border-gray-700 dark:bg-gray-700/50 dark:text-gray-400">
                  <tr>
                    <th class="sticky left-0 z-10 bg-gray-50 px-4 py-3 font-medium shadow-[1px_0_0_0_rgba(0,0,0,0.05)] dark:bg-gray-800 dark:shadow-[1px_0_0_0_rgba(255,255,255,0.05)]">
                      作物 (Lv)
                    </th>
                    <th class="px-4 py-3 font-medium">
                      时间
                    </th>
                    <th class="px-4 py-3 text-right font-medium">
                      经验/时
                    </th>
                    <th class="px-4 py-3 text-right font-medium">
                      普通肥经验/时
                    </th>
                    <th class="px-4 py-3 text-right font-medium">
                      净利润/时
                    </th>
                    <th class="px-4 py-3 text-right font-medium">
                      普通肥净利润/时
                    </th>
                    <th class="px-4 py-3 text-center font-medium">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
                  <tr v-for="(item, idx) in sortedList" :key="idx" class="group transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td class="sticky left-0 bg-white px-4 py-2 shadow-[1px_0_0_0_rgba(0,0,0,0.05)] transition-colors dark:bg-gray-800 group-hover:bg-gray-50 dark:shadow-[1px_0_0_0_rgba(255,255,255,0.05)] dark:group-hover:bg-gray-700/50">
                      <div class="flex items-center gap-3">
                        <div class="relative h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                          <img
                            v-if="item.image && !imageErrors[item.seedId]"
                            :src="item.image"
                            class="h-8 w-8 object-contain"
                            loading="lazy"
                            @error="imageErrors[item.seedId] = true"
                          >
                          <div v-else class="i-carbon-sprout text-xl text-gray-400" />
                        </div>
                        <div>
                          <div class="text-gray-900 font-bold dark:text-gray-100">
                            {{ item.name }}
                            <span v-if="blacklist.includes(item.seedId)" class="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400">黑名单</span>
                          </div>
                          <div class="mt-0.5 flex items-center gap-1.5">
                            <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 font-medium dark:bg-gray-700">Lv{{ formatLv(item.level) }}</span>
                            <span class="text-[10px] text-gray-400">ID:{{ item.seedId }}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td class="px-4 py-2 text-gray-600 dark:text-gray-300">
                      <div class="font-medium">
                        {{ formatGrowTime(item.growTime) }}
                      </div>
                      <div class="text-xs text-gray-400">
                        {{ item.seasons }}季
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right">
                      <div class="text-purple-600 font-bold dark:text-purple-400">
                        {{ item.expPerHour }}
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right">
                      <div class="text-blue-600 font-bold dark:text-blue-400">
                        {{ item.normalFertilizerExpPerHour ?? '-' }}
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right">
                      <div class="text-amber-500 font-bold">
                        {{ item.profitPerHour ?? '-' }}
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right">
                      <div class="text-green-500 font-bold">
                        {{ item.normalFertilizerProfitPerHour ?? '-' }}
                      </div>
                    </td>
                    <td class="px-4 py-2 text-center">
                      <button
                        class="rounded px-3 py-1.5 text-xs transition"
                        :class="blacklist.includes(item.seedId)
                          ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
                        @click="handleToggleBlacklist(item)"
                      >
                        {{ blacklist.includes(item.seedId) ? '移出黑名单' : '加入黑名单' }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'blacklist'" class="overflow-hidden border border-gray-200 rounded-lg bg-white shadow dark:border-gray-700 dark:bg-gray-800">
        <div class="border-b border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-700/50">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="i-carbon-subtract-alt text-xl text-red-500" />
              <div>
                <h3 class="text-gray-700 font-semibold dark:text-gray-300">
                  偷菜黑名单
                </h3>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  加入黑名单的蔬菜在自动偷菜时会被跳过，但不会影响自己种植
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button
                class="flex items-center gap-1 rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-600 transition dark:bg-orange-900/20 hover:bg-orange-100 dark:text-orange-400 disabled:opacity-50 dark:hover:bg-orange-900/30"
                :disabled="batchLoading || list.length === 0"
                @click="handleAddAllToBlacklist"
              >
                <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg" />
                <div v-else class="i-carbon-add" />
                一键全部加入黑名单
              </button>
              <button
                v-if="blacklist.length > 0"
                class="flex items-center gap-1 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 transition dark:bg-red-900/20 hover:bg-red-100 dark:text-red-400 disabled:opacity-50 dark:hover:bg-red-900/30"
                :disabled="batchLoading"
                @click="handleClearBlacklist"
              >
                <div class="i-carbon-trash-can" />
                清空黑名单
              </button>
            </div>
          </div>
        </div>

        <div class="p-4">
          <div v-if="blacklist.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
            暂无黑名单蔬菜
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="seedId in blacklist"
              :key="seedId"
              class="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3 dark:bg-gray-700/50"
            >
              <div class="flex items-center gap-3">
                <div class="relative h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-gray-100 dark:border-gray-600 dark:bg-gray-700">
                  <img
                    v-if="list.find(i => i.seedId === seedId)?.image"
                    :src="list.find(i => i.seedId === seedId)?.image"
                    class="h-8 w-8 object-contain"
                    loading="lazy"
                  >
                  <div v-else class="i-carbon-sprout text-xl text-gray-400" />
                </div>
                <div>
                  <div class="text-sm text-gray-900 font-medium dark:text-white">
                    {{ getSeedNameById(seedId) }}
                  </div>
                  <div class="text-xs text-gray-400">
                    ID: {{ seedId }}
                  </div>
                </div>
              </div>
              <button
                class="rounded bg-red-100 px-3 py-1.5 text-sm text-red-700 transition dark:bg-red-900/30 hover:bg-red-200 dark:text-red-400 dark:hover:bg-red-900/50"
                @click="plantBlacklistStore.removeFromBlacklist(seedId)"
              >
                移出黑名单
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 牧场幼崽分析(与农场"全部作物"同构) ===== -->
      <div v-if="activeTab === 'ranch'" class="space-y-3">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-gray-700 font-medium dark:text-gray-300">全部幼崽</span>
          <BaseSelect
            v-model="cubSort"
            class="w-52"
            :options="[
              { label: '最大经验/时', value: 'exp' },
              { label: '最大普通肥经验/时', value: 'fert_exp' },
              { label: '最大净利润/时', value: 'profit' },
              { label: '最大普通肥净利润/时', value: 'fert_profit' },
              { label: '收益比', value: 'ratio' },
              { label: '幼崽成本', value: 'cost' },
              { label: '最高等级', value: 'level' },
            ]"
          />
          <span class="text-xs text-gray-400">
            与「全部作物」同一套指标：经验/时 = 收获经验 ÷ 完整周期；净利润/时 =（整只回收 − 幼崽成本）÷ 周期；
            普通肥 = 周期缩短 3600 秒（普通罐头）
          </span>
          <span
            v-if="cubSource === 'offline'"
            class="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
            :title="cubLiveError ? `实时商城拉取失败: ${cubLiveError}` : '账号未运行, 使用抓包快照的商城价'"
          >离线价格快照（账号未运行）</span>
          <span
            v-else-if="cubSource === 'live'"
            class="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
          >实时商城价</span>
          <span
            v-else-if="cubSource === 'live+snapshot'"
            class="rounded bg-sky-50 px-2 py-0.5 text-xs text-sky-600 dark:bg-sky-900/30 dark:text-sky-400"
            title="实时商城缺的动物用抓包快照补齐(价格可能过期)"
          >实时价 + 快照补齐</span>
        </div>

        <div v-if="cubLoading" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
          加载中…
        </div>
        <div v-else-if="cubError" class="rounded-lg bg-white p-8 text-center text-red-500 shadow dark:bg-gray-800">
          {{ cubError }}
        </div>
        <div v-else-if="!cubRows.length" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
          暂无幼崽数据（配置缺失）
        </div>
        <div v-else class="overflow-hidden border border-gray-200 rounded-lg bg-white shadow dark:border-gray-700 dark:bg-gray-800">
          <div class="overflow-x-auto">
            <table class="w-full whitespace-nowrap text-left text-sm">
              <thead class="border-b bg-gray-50 text-xs text-gray-500 uppercase dark:border-gray-700 dark:bg-gray-700/50 dark:text-gray-400">
                <tr>
                  <th class="px-4 py-3 font-medium">
                    幼崽 (Lv)
                  </th>
                  <th class="px-4 py-3 font-medium">
                    周期
                  </th>
                  <th class="px-4 py-3 text-right font-medium">
                    经验/时
                  </th>
                  <th class="px-4 py-3 text-right font-medium">
                    普通肥经验/时
                  </th>
                  <th class="px-4 py-3 text-right font-medium">
                    净利润/时
                  </th>
                  <th class="px-4 py-3 text-right font-medium">
                    普通肥净利润/时
                  </th>
                  <th class="px-4 py-3 text-right font-medium">
                    成本
                  </th>
                  <th class="px-4 py-3 text-right font-medium">
                    整只回收
                  </th>
                  <th class="px-4 py-3 text-right font-medium">
                    收益比
                  </th>
                  <th class="px-4 py-3 text-center font-medium">
                    状态
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
                <tr
                  v-for="r in cubRows"
                  :key="r.goodsId"
                  class="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <td class="px-4 py-2 font-medium">
                    {{ r.name }}
                    <span class="text-xs text-gray-400">Lv{{ r.level ?? '-' }}</span>
                  </td>
                  <td class="px-4 py-2 text-gray-500">
                    <span class="inline-flex items-center gap-1">
                      {{ r.cycleSec ? formatGrowTime(r.cycleSec) : '—' }}
                      <span
                        v-if="r.cycleSource === 'config'"
                        class="rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                        title="来自官方客户端配置 MCAnimalConfig(幼崽+成长+成熟)"
                      >官方表</span>
                      <span
                        v-else-if="r.cycleSource === 'learned'"
                        class="rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                        title="官方表未收录, 由实际养过的抓包样本推算"
                      >实养推算</span>
                    </span>
                    <div v-if="r.cycleParts" class="text-[10px] text-gray-400">
                      幼{{ r.cycleParts.infantSec }}s + 长{{ r.cycleParts.growSec }}s + 成{{ r.cycleParts.matureSec }}s
                    </div>
                  </td>
                  <td class="px-4 py-2 text-right text-purple-600 font-bold tabular-nums dark:text-purple-400">
                    {{ r.expPerHour ?? '-' }}
                  </td>
                  <td class="px-4 py-2 text-right text-blue-600 font-bold tabular-nums dark:text-blue-400">
                    {{ r.normalFertilizerExpPerHour ?? '-' }}
                  </td>
                  <td class="px-4 py-2 text-right text-amber-500 font-bold tabular-nums">
                    {{ r.profitPerHour ?? '-' }}
                  </td>
                  <td class="px-4 py-2 text-right text-green-500 font-bold tabular-nums">
                    {{ r.normalFertilizerProfitPerHour ?? '-' }}
                  </td>
                  <td class="px-4 py-2 text-right tabular-nums">
                    {{ r.cost }}
                  </td>
                  <td class="px-4 py-2 text-right tabular-nums">
                    {{ r.grownValue || '-' }}
                  </td>
                  <td class="px-4 py-2 text-right tabular-nums" :class="r.ratio >= 2 ? 'text-emerald-600 font-medium dark:text-emerald-400' : ''">
                    {{ r.ratio ? r.ratio.toFixed(2) : '-' }}
                  </td>
                  <td class="px-4 py-2 text-center text-xs">
                    <span v-if="!r.unlocked" class="text-gray-400">未解锁</span>
                    <span v-else-if="r.remaining !== null && r.remaining <= 0" class="text-red-500">已售罄</span>
                    <span v-else class="text-emerald-600 dark:text-emerald-400">可购买</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="border-t border-gray-100 px-4 py-2 text-xs text-gray-400 dark:border-gray-700">
            周期来自官方客户端配置 <code>mcRes/mcconfig/MCAnimalConfig</code>（幼崽 + 成长 + 成熟三段，全部 28 种动物已收录，无需先养过）；
            官方表未收录的新动物才用服务端 <code>infant/grow/mature_ready_at_ms</code> 的实养样本推算，两者都没有时显示「-」，不编造。
            经验取服务端 <code>expected_harvest_exp</code>，缺省时用官方表的 <code>harvest_exp</code>。
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'strategy'" class="overflow-hidden border border-gray-200 rounded-lg bg-white shadow dark:border-gray-700 dark:bg-gray-800">
        <div class="border-b border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-700/50">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="i-carbon-calculation text-xl text-blue-500" />
              <div>
                <h3 class="text-gray-700 font-semibold dark:text-gray-300">
                  策略推荐
                </h3>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  根据等级推荐最优种植策略
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-sm text-gray-500">参考等级:</span>
              <input
                v-model.number="strategyLevel"
                type="number"
                min="1"
                max="100"
                class="w-16 border border-gray-300 rounded-lg bg-white px-3 py-1.5 text-center text-sm outline-none dark:border-gray-600 focus:border-blue-400 dark:bg-gray-700 dark:text-gray-200"
              >
            </div>
          </div>
        </div>

        <div class="p-4">
          <div class="grid grid-cols-1 gap-3 lg:grid-cols-4 sm:grid-cols-2">
            <div
              v-for="strategy in strategies"
              :key="strategy.key"
              class="overflow-hidden border rounded-lg bg-white transition-shadow dark:bg-gray-800 hover:shadow-md"
              :class="getColorClass(strategy.color, 'border')"
            >
              <div class="p-3">
                <div class="mb-2 flex items-center gap-2">
                  <div
                    class="h-7 w-7 flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white"
                    :class="getColorClass(strategy.color, 'gradient')"
                  >
                    <div class="text-sm" :class="strategy.icon" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-semibold" :class="getColorClass(strategy.color, 'text')">
                      {{ strategy.label }}
                    </div>
                  </div>
                </div>

                <div v-if="getStrategyBestPlant(strategy.key)" class="space-y-2">
                  <div class="flex items-center gap-2">
                    <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden border rounded-lg bg-gray-50 dark:border-gray-600 dark:bg-gray-700" :class="getColorClass(strategy.color, 'border')">
                      <img
                        v-if="getStrategyBestPlant(strategy.key)?.image && !imageErrors[getStrategyBestPlant(strategy.key)?.seedId]"
                        :src="getStrategyBestPlant(strategy.key)?.image"
                        class="h-8 w-8 object-contain"
                        loading="lazy"
                        @error="imageErrors[getStrategyBestPlant(strategy.key)?.seedId] = true"
                      >
                      <div v-else class="i-carbon-sprout text-lg text-gray-400" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm text-gray-800 font-medium dark:text-gray-200">
                        {{ getStrategyBestPlant(strategy.key)?.name }}
                      </div>
                      <div class="text-xs text-gray-500">
                        Lv{{ formatLv(getStrategyBestPlant(strategy.key)?.level) }}
                      </div>
                    </div>
                  </div>
                  <div class="rounded-md bg-gray-50 px-2 py-1.5 dark:bg-gray-900/50">
                    <div class="flex items-baseline justify-between">
                      <span class="text-xs text-gray-500">{{ strategy.unit }}/时</span>
                      <span class="text-base font-bold" :class="getColorClass(strategy.color, 'text')">
                        {{ getStrategyBestPlant(strategy.key)?.[strategy.metric] }}
                      </span>
                    </div>
                  </div>
                </div>
                <div v-else class="py-3 text-center text-xs text-gray-400">
                  暂无可种植作物
                </div>
              </div>
            </div>
          </div>

          <div class="mt-3 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <div class="i-carbon-information" />
            <span>可种植 {{ getStrategyAvailableCount() }}/{{ list.length }} 种作物 · 策略计算与设置页面种植策略一致</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
