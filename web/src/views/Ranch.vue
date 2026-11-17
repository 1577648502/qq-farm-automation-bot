<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import LoadingState from '@/components/ui/LoadingState.vue'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

/**
 * 牧场面板(11-17 新玩法)。
 * 功能对照农场面板: 总览 + 一键巡牧场(收获→催产→喂食) + 每只动物手动操作。
 * 喂食方式枚举(4/5/6)抓包还没确认完整语义, 界面先只提供"巡牧场"这一条经过验证的路径。
 */
const ranchStore = useRanchStore()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { overview, loading } = storeToRefs(ranchStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, loading: statusLoading, realtimeConnected } = storeToRefs(statusStore)
void currentAccount

const currentTab = ref<'overview' | 'cubShop' | 'tiers'>('overview')
const cubShopLoading = ref(false)
const cubShopError = ref('')
const cubShopList = ref<any[]>([])
const cubBuyBusy = ref(0)
const tiersLoading = ref(false)
const tiersError = ref('')
const tiersList = ref<Array<{ level: number, requiredWeight: number, rewards: Array<{ itemId: number, count: number }> }>>([])

function itemLabel(itemId: number) {
  if (itemId === 1002)
    return '点券'
  if (itemId === 80023)
    return '罐头(8h)'
  if (itemId === 80021)
    return '罐头(1h)'
  if (itemId === 80031)
    return '有机罐头(1h)'
  if (itemId === 1007)
    return '金券'
  return `#${itemId}`
}

async function openTiers() {
  currentTab.value = 'tiers'
  const id = currentAccountId.value
  if (!id || tiersList.value.length)
    return
  tiersLoading.value = true
  tiersError.value = ''
  try {
    const r = await ranchStore.fetchWeightScore(id)
    tiersList.value = r.tiers || []
  }
  catch (e: any) {
    tiersError.value = e?.message || '获取饲养档位失败'
  }
  finally {
    tiersLoading.value = false
  }
}

async function openCubShop() {
  currentTab.value = 'cubShop'
  const id = currentAccountId.value
  if (!id || cubShopList.value.length)
    return
  cubShopLoading.value = true
  cubShopError.value = ''
  try {
    const r = await ranchStore.fetchCubShop(id)
    cubShopList.value = r.shop || []
  }
  catch (e: any) {
    cubShopError.value = e?.message || '获取幼崽商店失败'
  }
  finally {
    cubShopLoading.value = false
  }
}

async function buyCub(g: any) {
  const id = currentAccountId.value
  if (!id)
    return
  cubBuyBusy.value = g.goodsId
  try {
    const r = await ranchStore.operate(id, { op: 'buycub', maxSpend: g.price })
    toast.success(`${r.action}成功${r.detail ? `（${r.detail}）` : ''}`)
  }
  catch (e: any) {
    toast.error(e?.message || '购买失败')
  }
  finally {
    cubBuyBusy.value = 0
    refresh()
  }
}
const careVisible = ref(false)
const careLoading = ref(false)
const operateLoading = ref(-1)
const opBusy = ref('')

// 产出倒计时本地递减: 数据刷新时基准归零, 每秒往后走 1 格(显示平滑, 不回读)
const elapsedSec = ref(0)
useIntervalFn(() => {
  elapsedSec.value++
}, 1000)
watch(overview, () => {
  elapsedSec.value = 0
})

function produceInSec(a: { produceInSec: number }) {
  return Math.max(0, a.produceInSec - elapsedSec.value)
}

function formatTime(sec: number) {
  if (sec <= 0)
    return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h > 0 ? `${h}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

const careSummary = computed(() => {
  const ov = overview.value
  if (!ov)
    return { harvestable: 0, hungry: 0, mutant: 0 }
  return {
    harvestable: ov.animals.filter(a => a.produceInSec === 0 && a.stage >= 1).length,
    hungry: ov.animals.filter(a => a.feedState === 1).length,
    mutant: ov.animals.filter(a => a.mutant).length,
  }
})

/** 窝/棚分组视图(对应农场的田地) */
interface PenView {
  key: string
  title: string
  icon: string
  capacity: number
  facility?: { slot: number, name: string, level: number, stored: number, capacity: number }
  animals: any[]
  emptySlots: number
  /** 容量为 0 且没动物 = 该建筑还没解锁(如棚要牧场等级更高才开) */
  locked: boolean
}

const pensView = computed<PenView[]>(() => {
  const ov = overview.value
  if (!ov)
    return []
  const pens = [
    {
      key: 'coop',
      title: '窝（小动物）',
      icon: 'i-carbon-home',
      capacity: ov.coopCount || 0,
      facility: (ov.facilities || []).find(f => f.slot === 10001),
      animals: ov.animals.filter(a => a.animalId < 70000 && a.animalId >= 60000),
      emptySlots: 0,
      locked: false,
    },
    {
      key: 'pen',
      title: '棚（大动物）',
      icon: 'i-carbon-home',
      capacity: ov.penCount || 0,
      facility: (ov.facilities || []).find(f => f.slot === 10002),
      animals: ov.animals.filter(a => a.animalId >= 70000 && a.animalId < 80000),
      emptySlots: 0,
      locked: false,
    },
  ]
  for (const p of pens) {
    p.emptySlots = Math.max(0, (p.capacity || 0) - p.animals.length)
    // 容量 0 且没动物: 棚比窝晚解锁(等级门槛), 显示"未解锁"而不是整组隐藏
    p.locked = (p.capacity || 0) === 0 && p.animals.length === 0
  }
  return pens
})

const facilityText = computed(() => {
  const fs = overview.value?.facilities || []
  if (!fs.length)
    return ''
  return fs.map(f => `${f.name || '建筑'}${f.level ? ` Lv${f.level}` : ''}`).join(' · ')
})

const opLimitText = computed(() => {
  const ov = overview.value
  if (!ov?.opLimits?.length)
    return ''
  return ov.opLimits.map(l => `${l.opId}: ${l.used}/${l.limit}`).join(' · ')
})

// 刷新防抖: 挂载/切账号/每次操作都会触发 refresh, 连点按钮会叠加请求;
// 后端虽有 10s 节流, 前端也压一下(1.5s 内的多次触发只发一次)
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function refresh(immediate = false) {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  const run = async () => {
    refreshTimer = null
    const id = currentAccountId.value
    if (!id)
      return
    const acc = currentAccount.value
    if (!acc)
      return
    if (!realtimeConnected.value)
      await statusStore.fetchStatus(id)
    if (acc.running && status.value?.connection?.connected)
      ranchStore.fetchOverview(id)
  }
  if (immediate) {
    void run()
    return
  }

  refreshTimer = setTimeout(() => {
    void run()
  }, 1500)
}

async function handleCare() {
  const id = currentAccountId.value
  if (!id)
    return
  careVisible.value = false
  careLoading.value = true
  try {
    const r = await ranchStore.care(id)
    const parts: string[] = []
    if (r.harvested > 0)
      parts.push(`收获 ${r.harvested}`)
    if (r.produced > 0)
      parts.push(`催产 ${r.produced}`)
    if (r.fed > 0)
      parts.push(`喂食 ${r.fed}`)
    toast.success(`巡牧场完成${parts.length ? `：${parts.join('，')}` : '（本轮无可做操作）'}`)
  }
  catch (e: any) {
    toast.error(e?.message || '巡牧场失败')
  }
  finally {
    careLoading.value = false
    refresh()
  }
}

async function runOp(op: string, slot = 0) {
  const id = currentAccountId.value
  if (!id)
    return
  opBusy.value = op
  operateLoading.value = slot
  try {
    const r = await ranchStore.operate(id, { op, slot })
    toast.success(`${r.action}成功${r.detail ? `（${r.detail}）` : ''}`)
  }
  catch (e: any) {
    toast.error(e?.message || '操作失败')
  }
  finally {
    opBusy.value = ''
    operateLoading.value = -1
    refresh()
  }
}

function confirmCare() {
  careVisible.value = true
}

watch(currentAccountId, () => refresh(true))

onMounted(() => refresh(true))

onUnmounted(() => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
})
</script>

<template>
  <div class="space-y-4">
    <div class="mb-1 flex flex-wrap gap-2">
      <button
        class="min-h-[44px] flex items-center rounded-lg px-4 py-2 font-medium transition-colors space-x-2"
        :class="currentTab === 'overview' ? 'text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'overview' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'overview'"
      >
        <div class="i-carbon-home text-lg" />
        <span>牧场总览</span>
      </button>
      <button
        class="min-h-[44px] flex items-center rounded-lg px-4 py-2 font-medium transition-colors space-x-2"
        :class="currentTab === 'cubShop' ? 'text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'cubShop' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="openCubShop"
      >
        <div class="i-carbon-shopping-cart text-lg" />
        <span>幼崽商城</span>
      </button>
      <button
        class="min-h-[44px] flex items-center rounded-lg px-4 py-2 font-medium transition-colors space-x-2"
        :class="currentTab === 'tiers' ? 'text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'tiers' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="openTiers"
      >
        <div class="i-carbon-chart-bar text-lg" />
        <span>兴牧档位</span>
      </button>
    </div>

    <div v-if="currentTab === 'tiers'" class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
        <h3 class="flex items-center gap-2 text-lg font-bold">
          <div class="i-carbon-chart-bar text-xl text-sky-500" />
          兴牧档位（全服饲养重量奖励）
        </h3>
      </div>
      <div class="p-3 sm:p-4">
        <LoadingState v-if="tiersLoading" />
        <div v-else-if="tiersError" class="py-8 text-center text-sm text-gray-500">
          {{ tiersError }}
        </div>
        <div v-else-if="!tiersList.length" class="py-8 text-center text-sm text-gray-500">
          暂无档位数据
        </div>
        <div v-else class="grid grid-cols-1 gap-2 md:grid-cols-2">
          <div
            v-for="t in tiersList"
            :key="t.level"
            class="flex items-center justify-between gap-2 border border-gray-200 rounded-lg px-3 py-2 dark:border-gray-700"
          >
            <div class="flex items-center gap-2">
              <span class="h-7 w-7 flex items-center justify-center rounded-full bg-sky-100 text-xs text-sky-700 font-bold dark:bg-sky-900/40 dark:text-sky-300">
                {{ t.level }}
              </span>
              <span class="text-sm text-gray-600 dark:text-gray-300">重量 {{ t.requiredWeight }}</span>
            </div>
            <div class="flex flex-wrap justify-end gap-1">
              <span
                v-for="r in t.rewards"
                :key="r.itemId"
                class="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300"
              >
                {{ itemLabel(r.itemId) }} ×{{ r.count }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="currentTab === 'cubShop'" class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
        <div class="flex items-center justify-between gap-2">
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <div class="i-fas-paw text-xl text-amber-500" />
            幼崽商城
          </h3>
          <div class="text-xs text-gray-400">
            按收益比排序（整只回收 ÷ 幼崽成本）
          </div>
        </div>
      </div>
      <div class="p-3 sm:p-4">
        <LoadingState v-if="cubShopLoading" />
        <div v-else-if="cubShopError" class="py-8 text-center text-sm text-gray-500">
          {{ cubShopError }}
        </div>
        <div v-else-if="!cubShopList.length" class="py-8 text-center text-sm text-gray-500">
          商店暂无在售幼崽
        </div>
        <div v-else class="grid grid-cols-2 gap-3 md:grid-cols-4 sm:grid-cols-3">
          <div
            v-for="g in cubShopList"
            :key="g.goodsId"
            class="flex flex-col items-center border rounded-lg p-3 text-center transition"
            :class="g.valueRatio >= 2.4
              ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-900/20'
              : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'"
          >
            <div
              v-if="g.valueRatio >= 2.4"
              class="mb-1 self-start rounded bg-amber-500 px-1 py-0.5 text-[10px] text-white"
            >
              高收益
            </div>
            <div class="mb-1 mt-1 h-10 w-10 flex items-center justify-center">
              <div class="i-fas-paw text-3xl text-amber-500" />
            </div>
            <div class="text-xs font-bold">
              {{ g.name }}
            </div>
            <div class="mt-0.5 text-[11px] text-gray-500">
              金券 {{ g.price }}
            </div>
            <div class="mt-0.5 text-[10px] text-gray-400">
              回收比 {{ g.valueRatio.toFixed(2) }}
            </div>
            <div class="text-[10px] text-gray-400">
              {{ g.limit > 0 ? `限购 ${g.bought}/${g.limit}` : '不限购' }}
            </div>
            <BaseButton
              class="mt-2 w-full"
              size="sm"
              :disabled="g.unlocked === false || cubBuyBusy === g.goodsId"
              @click="buyCub(g)"
            >
              {{ cubBuyBusy === g.goodsId ? '购买中…' : '买 1 只' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="space-y-4">
      <div class="rounded-lg bg-white shadow dark:bg-gray-800">
        <!-- 头部 -->
        <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
          <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2 sm:mb-3">
            <h3 class="flex items-center gap-2 text-lg font-bold">
              <div class="i-carbon-home text-xl" />
              牧场总览
            </h3>
            <div v-if="overview" class="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
              <span>窝 {{ overview.coopCount }} · 棚 {{ overview.penCount }}</span>
              <span>牧草 {{ overview.grassCount }}</span>
              <span>经验 {{ overview.ranchExp }}</span>
            </div>
          </div>
          <!-- 整场操作(对照农场的整田操作): 有牧场数据才显示 -->
          <div v-if="overview" class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <button
              type="button"
              class="col-span-2 min-h-[44px] flex items-center justify-center gap-1.5 border border-orange-600 rounded-lg bg-orange-600 px-3 py-2 text-sm text-white font-medium shadow-sm transition-colors sm:col-auto active:scale-[0.98] disabled:cursor-not-allowed hover:border-orange-700 hover:bg-orange-700 disabled:opacity-50"
              :disabled="careLoading || opBusy !== ''"
              @click="confirmCare"
            >
              <i class="i-carbon-flash shrink-0 text-base" aria-hidden="true" />
              一键巡牧场（收获 → 催产 → 喂食）
            </button>
            <button
              type="button"
              class="min-h-[44px] flex items-center justify-center gap-1.5 border border-green-300 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 font-medium transition-colors active:scale-[0.98] disabled:cursor-not-allowed dark:border-green-700 dark:bg-green-900/30 hover:bg-green-100 dark:text-green-300 disabled:opacity-40"
              :disabled="careLoading || opBusy !== ''"
              @click="runOp('buycub')"
            >
              <i class="i-fas-paw shrink-0 text-base" aria-hidden="true" />
              买幼崽（收益最大）
            </button>
            <button
              type="button"
              class="min-h-[44px] flex items-center justify-center gap-1.5 border border-amber-300 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 font-medium transition-colors active:scale-[0.98] disabled:cursor-not-allowed dark:border-amber-700 dark:bg-amber-900/30 hover:bg-amber-100 dark:text-amber-300 disabled:opacity-40"
              :disabled="careLoading || opBusy !== ''"
              @click="runOp('feedmachine')"
            >
              <i class="i-carbon-zap shrink-0 text-base" aria-hidden="true" />
              牧草机补草
            </button>
            <button
              type="button"
              class="min-h-[44px] flex items-center justify-center gap-1.5 border border-lime-300 rounded-lg bg-lime-50 px-3 py-2 text-sm text-lime-700 font-medium transition-colors active:scale-[0.98] disabled:cursor-not-allowed dark:border-lime-700 dark:bg-lime-900/30 hover:bg-lime-100 dark:text-lime-300 disabled:opacity-40"
              :disabled="careLoading || opBusy !== ''"
              @click="runOp('rotation')"
            >
              <i class="i-carbon-shopping-cart shrink-0 text-base" aria-hidden="true" />
              游商兑换
            </button>
          </div>
        </div>

        <!-- 摘要 -->
        <div
          v-if="overview"
          class="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2.5 text-xs dark:border-gray-700 dark:bg-gray-900/50 sm:px-4 sm:text-sm"
        >
          <div class="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
            <i class="i-fas-egg" />
            <span class="font-medium">可收 {{ careSummary.harvestable }}</span>
          </div>
          <div class="flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <i class="i-carbon-sprout" />
            <span class="font-medium">饥饿 {{ careSummary.hungry }}</span>
          </div>
          <div class="flex items-center gap-1 rounded-full bg-fuchsia-100 px-2.5 py-1 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-400">
            <i class="i-carbon-star" />
            <span class="font-medium">变异 {{ careSummary.mutant }}</span>
          </div>
          <div
            v-if="overview?.facilities?.length"
            class="flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
          >
            <i class="i-carbon-home" />
            <span class="font-medium">{{ facilityText }}</span>
          </div>
          <div v-if="opLimitText" class="ml-auto text-[11px] text-gray-400">
            今日次数 {{ opLimitText }}
          </div>
        </div>

        <!-- 内容 -->
        <div class="p-3 sm:p-4">
          <LoadingState v-if="loading || statusLoading" />
          <div v-else-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 rounded-lg p-12 text-center text-gray-500">
            <div class="i-carbon-user-offline text-4xl text-gray-400" />
            <div>
              <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
                未登录账号
              </div>
              <div class="mt-1 text-sm text-gray-400">
                请先添加农场账号
              </div>
            </div>
          </div>
          <div v-else-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 rounded-lg p-12 text-center text-gray-500">
            <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
            <div>
              <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
                账号未登录
              </div>
              <div class="mt-1 text-sm text-gray-400">
                请先运行账号或检查网络连接
              </div>
            </div>
          </div>
          <div v-else-if="!overview" class="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <div class="i-carbon-warning-alt text-4xl text-gray-300" />
            <div class="text-base text-gray-600 font-medium dark:text-gray-300">
              暂无牧场数据
            </div>
            <div class="max-w-md text-xs text-gray-400 leading-relaxed">
              牧场需要农场主 25 级解锁；若已解锁，请更新账号 Code 并确保账号在运行中，
              然后刷新本页重试（首次进入服务端可能返回空数据，已自动重试）。
            </div>
          </div>
          <div v-else-if="overview.animals.length === 0" class="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div class="i-fas-paw text-4xl text-gray-300" />
            <div class="text-base text-gray-600 font-medium dark:text-gray-300">
              牧场还没有动物
            </div>
            <div class="max-w-md text-xs text-gray-400 leading-relaxed">
              点击上方「买幼崽（收益最大）」自动买入收益最高的幼崽；
              也可以去 QQ 农场的牧场里手动摆放。
            </div>
          </div>

          <!-- 建筑视图(对应农场的"田地"): 窝 / 棚 分组 -->
          <div v-else class="space-y-4">
            <div
              v-for="pen in pensView"
              :key="pen.key"
              class="border border-gray-200 rounded-lg p-3 dark:border-gray-700 sm:p-4"
            >
              <div class="mb-3 flex items-center justify-between gap-2">
                <h4 class="flex items-center gap-1.5 text-sm text-gray-700 font-bold dark:text-gray-200">
                  <i :class="pen.icon" class="text-base" aria-hidden="true" />
                  {{ pen.title }}
                  <span v-if="!pen.locked" class="text-xs text-gray-400 font-normal">{{ pen.animals.length }}/{{ pen.capacity }} 在养</span>
                  <span
                    v-else
                    class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-400 font-normal dark:bg-gray-800"
                  >
                    未解锁
                  </span>
                </h4>
                <div v-if="pen.facility" class="text-[11px] text-gray-400">
                  {{ pen.facility.name || pen.title }}{{ pen.facility.level ? ` Lv${pen.facility.level}` : '' }}
                </div>
              </div>

              <!-- 未解锁: 占位说明, 不渲染槽位 -->
              <div
                v-if="pen.locked"
                class="min-h-[80px] flex flex-col items-center justify-center border border-gray-200 rounded-lg border-dashed p-4 text-gray-300 dark:border-gray-700"
              >
                <div class="i-carbon-lock text-2xl" />
                <div class="mt-2 text-[11px] text-gray-400">
                  该建筑尚未解锁(提升牧场等级后开放)
                </div>
              </div>

              <div v-else class="grid grid-cols-2 gap-3 md:grid-cols-4 sm:grid-cols-3">
                <!-- 已养的动物 -->
                <div
                  v-for="a in pen.animals"
                  :key="a.slot"
                  class="relative min-h-[150px] flex flex-col items-center border rounded-lg p-2 transition sm:min-h-[170px]"
                  :class="a.mutant
                    ? 'border-fuchsia-300 bg-fuchsia-50/80 dark:border-fuchsia-700 dark:bg-fuchsia-900/20'
                    : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'"
                >
                  <div class="absolute left-1 top-1 text-[10px] text-gray-400 font-mono">
                    槽{{ a.slot }}
                  </div>
                  <div
                    v-if="a.mutant"
                    class="absolute right-1 top-1 rounded bg-fuchsia-100 px-1 py-0.5 text-[10px] text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300"
                  >
                    变异
                  </div>

                  <div class="mb-1 mt-3 h-10 w-10 flex items-center justify-center sm:h-12 sm:w-12">
                    <div class="i-fas-paw text-4xl text-amber-500" />
                  </div>

                  <div class="w-full truncate px-1 text-center text-xs font-bold" :title="`#${a.animalId}`">
                    {{ a.name }}
                  </div>
                  <div class="mt-0.5 text-[10px] text-gray-500">
                    {{ a.stageText }}
                  </div>

                  <div class="mt-1 text-center text-[10px]">
                    <span v-if="produceInSec(a) > 0" class="text-orange-500">{{ formatTime(produceInSec(a)) }} 后产出</span>
                    <span v-else class="text-amber-600 font-medium dark:text-amber-400">待产出 / 可收</span>
                  </div>

                  <div
                    v-if="a.sellCost"
                    class="mt-0.5 text-[10px] text-gray-400"
                    title="产物出售参考价"
                  >
                    金券 {{ a.sellCost.amount }}
                  </div>

                  <div class="mt-auto w-full flex gap-1 pt-2">
                    <button
                      type="button"
                      class="min-h-[36px] flex-1 border border-amber-300 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700 font-medium transition dark:border-amber-700 dark:bg-amber-900/30 hover:bg-amber-100 dark:text-amber-300 disabled:opacity-40"
                      :disabled="operateLoading === a.slot || opBusy !== ''"
                      @click="runOp('harvest', a.slot)"
                    >
                      收获
                    </button>
                    <button
                      type="button"
                      class="min-h-[36px] flex-1 border border-sky-300 rounded-lg bg-sky-50 px-2 py-1.5 text-xs text-sky-700 font-medium transition dark:border-sky-700 dark:bg-sky-900/30 hover:bg-sky-100 dark:text-sky-300 disabled:opacity-40"
                      :disabled="operateLoading === a.slot || opBusy !== ''"
                      @click="runOp('produce', a.slot)"
                    >
                      催产
                    </button>
                  </div>
                </div>

                <!-- 空槽 -->
                <div
                  v-for="n in pen.emptySlots"
                  :key="`empty-${pen.key}-${n}`"
                  class="min-h-[150px] flex flex-col items-center justify-center border border-gray-200 rounded-lg border-dashed p-2 text-gray-300 sm:min-h-[170px] dark:border-gray-700"
                >
                  <div class="i-fas-paw text-3xl" />
                  <div class="mt-2 text-[11px] text-gray-400">
                    空位
                  </div>
                </div>
              </div>
            </div>

            <!-- 牧草机等建筑状态 -->
            <div
              v-for="f in (overview.facilities || []).filter(x => x.slot === 10002)"
              :key="`fac-${f.slot}`"
              class="flex flex-wrap items-center justify-between gap-2 border border-gray-200 rounded-lg px-3 py-2.5 text-xs dark:border-gray-700"
            >
              <div class="flex items-center gap-2">
                <i class="i-carbon-zap text-base text-amber-500" aria-hidden="true" />
                <span class="text-gray-700 font-medium dark:text-gray-200">{{ f.name || '牧草机' }}</span>
                <span v-if="f.level" class="text-gray-400">Lv{{ f.level }}</span>
              </div>
              <div class="text-gray-500 dark:text-gray-400">
                存量 {{ f.stored }} / {{ f.capacity || '?' }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="careVisible"
      title="一键巡牧场"
      message="依次执行：收获可收产物 → 催产 → 喂食。确定执行吗？"
      :loading="careLoading"
      confirm-text="开始"
      @confirm="handleCare"
      @cancel="careVisible = false"
    />
  </div>
</template>
