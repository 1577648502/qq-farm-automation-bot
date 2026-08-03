<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

interface RewardItem {
  id: number
  name: string
  count: number
  image: string
}

interface StarDay {
  day: number
  unlocked: boolean
  claimed: boolean
  items: RewardItem[]
  star: {
    day: number
    name: string
    category: string
    explain: string
  } | null
}

interface StarRegister {
  totalDays: number
  unlockedCount: number
  claimedCount: number
  claimableCount: number
  days: StarDay[]
}

interface ShopGoods {
  id: number
  name: string
  description: string
  item: RewardItem[]
  cost: RewardItem[]
  purchaseLimit: number
  purchasedCount: number
  remaining: number | null
  soldOut: boolean
  diamondCostCount: number
}

interface SolarTerm {
  id: number
  name: string
  status: number
  startTime: number
  endTime: number
  active: boolean
  claimable: boolean
  claimed: boolean
  items: RewardItem[]
}

interface BattlePassState {
  battlepassId: number
  name: string
  description: string
  level: number
  currentLevelExp: number
  nextLevelNeedExp: number
  maxLevel: number
  isPremium: boolean
  claimableCount: number
}

interface StarOverview {
  updatedAt: number
  active: boolean
  group: {
    id: number
    name: string
    endTime: number
  } | null
  register: {
    head: { id: number, name: string, endTime: number } | null
    starRegister: StarRegister | null
  } | null
  shop: {
    head: { id: number, name: string } | null
    shop: { goods: ShopGoods[] } | null
  } | null
  currency: {
    id: number
    name: string
    image: string
    count: number
  } | null
  season: {
    seasonId: number
    name: string
    activeEndTime: number
  } | null
  battlePass: BattlePassState | null
}

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const overview = ref<StarOverview | null>(null)
const loading = ref(false)
const error = ref('')
const exchangeTarget = ref<ShopGoods | null>(null)
const actionLoading = ref('')
const solarTerms = ref<SolarTerm[]>([])

const accountReady = computed(() => !!currentAccountId.value && !!currentAccount.value?.running)
const activityName = computed(() => overview.value?.group?.name || '心许千灯星垂野')
const register = computed(() => overview.value?.register?.starRegister || null)
const battlePass = computed(() => overview.value?.battlePass || null)
const shopGoods = computed(() => overview.value?.shop?.shop?.goods || [])
const currency = computed(() => overview.value?.currency || null)

const exchangeMessage = computed(() => {
  const goods = exchangeTarget.value
  if (!goods)
    return ''
  const cost = formatRewardList(goods.cost)
  const item = formatRewardList(goods.item)
  return `兑换：${goods.name}\n获得：${item || goods.name}\n消耗：${cost || '无'}\n数量：1`
})

function formatNumber(value?: number | null) {
  return Math.max(0, Number(value) || 0).toLocaleString('zh-CN')
}

function formatEndTime(value?: number) {
  const ts = Number(value || 0)
  if (!ts)
    return ''
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
}

function formatRewardList(items?: RewardItem[]) {
  return (items || [])
    .filter(item => item && item.id)
    .map(item => `${item.name || `物品#${item.id}`}×${formatNumber(item.count)}`)
    .join('、')
}

function termStatus(term: SolarTerm) {
  if (term.claimed)
    return { label: '已领取', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' }
  if (term.claimable)
    return { label: '可领取', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' }
  if (term.status === 1)
    return { label: '未开始', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
  return { label: '已结束', cls: 'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500' }
}

function formatDateRange(start: number, end: number) {
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  if (!start || !end)
    return ''
  return `${fmt(start)} - ${fmt(end)}`
}

function dayStatus(day: StarDay) {
  if (day.claimed)
    return { label: '已领取', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' }
  if (day.unlocked)
    return { label: '可领取', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' }
  return { label: '未开放', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
}

async function fetchOverview() {
  const accountId = String(currentAccountId.value || '')
  overview.value = null
  error.value = ''
  if (!accountId)
    return
  if (!currentAccount.value?.running) {
    error.value = '当前账号未运行，请先启动账号后再查看活动。'
    return
  }

  loading.value = true
  try {
    const res = await api.get('/api/activity/star', {
      headers: { 'x-account-id': accountId },
    })
    if (accountId !== String(currentAccountId.value || ''))
      return
    if (!res.data?.ok)
      throw new Error(res.data?.error || '获取活动数据失败')
    overview.value = res.data.data
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取活动数据失败'
  }
  finally {
    loading.value = false
  }
}

async function fetchSolarTerms() {
  const accountId = String(currentAccountId.value || '')
  solarTerms.value = []
  if (!accountId || !currentAccount.value?.running)
    return
  try {
    const res = await api.get('/api/solar-terms', {
      headers: { 'x-account-id': accountId },
    })
    if (accountId !== String(currentAccountId.value || ''))
      return
    if (res.data?.ok)
      solarTerms.value = res.data.data?.terms || []
  }
  catch {
    // 节令小礼读取失败不阻断页面
  }
}

async function lightUpStar() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || actionLoading.value)
    return
  actionLoading.value = 'light-up'
  try {
    const res = await api.post('/api/activity/star/light-up', {}, {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '点亮失败')
    const awards = formatRewardList(res.data.data?.awards)
    toast.success(awards ? `点亮成功，今日奖励：${awards}` : '点亮成功')
    await fetchOverview()
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '点亮失败')
  }
  finally {
    actionLoading.value = ''
  }
}

async function claimBattlePass() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || actionLoading.value)
    return
  actionLoading.value = 'battle-pass'
  try {
    const res = await api.post('/api/activity/battle-pass/claim', {}, {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '领取失败')
    const rewards = formatRewardList(res.data.data?.rewards)
    if (res.data.data?.bagOverflow)
      toast.error('背包已满，部分奖励未能领取')
    else
      toast.success(rewards ? `领取成功：${rewards}` : '已领取游记进度奖励')
    await fetchOverview()
    await statusStore.fetchStatus(accountId)
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '领取失败')
  }
  finally {
    actionLoading.value = ''
  }
}

async function claimSolarTerm(term: SolarTerm) {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || actionLoading.value)
    return
  actionLoading.value = `solar-${term.id}`
  try {
    const res = await api.post('/api/solar-terms/claim', { id: term.id }, {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '领取失败')
    const awards = formatRewardList(res.data.data?.awards)
    toast.success(awards ? `领取成功：${awards}` : `已领取 ${term.name} 节令小礼`)
    await fetchSolarTerms()
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '领取失败')
  }
  finally {
    actionLoading.value = ''
  }
}

function openExchange(goods: ShopGoods) {
  exchangeTarget.value = goods
}

async function confirmExchange() {
  const goods = exchangeTarget.value
  const accountId = String(currentAccountId.value || '')
  if (!goods || !accountId || actionLoading.value)
    return
  actionLoading.value = `exchange-${goods.id}`
  try {
    const res = await api.post('/api/activity/star/exchange', {
      goodsId: goods.id,
      count: 1,
    }, {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '兑换失败')
    const awards = formatRewardList(res.data.data?.awards)
    toast.success(awards ? `兑换成功：${awards}` : `已兑换 ${goods.name}`)
    exchangeTarget.value = null
    await fetchOverview()
    await statusStore.fetchStatus(accountId)
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '兑换失败')
  }
  finally {
    actionLoading.value = ''
  }
}

function refreshAll() {
  fetchOverview()
  fetchSolarTerms()
}

onMounted(refreshAll)
watch(currentAccountId, refreshAll)
</script>

<template>
  <div class="mx-auto max-w-7xl w-full p-2 space-y-5 sm:p-4">
    <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div class="flex items-center gap-3">
        <span class="h-10 w-10 flex items-center justify-center rounded-xl text-white shadow" style="background: var(--theme-primary)">
          <span class="i-carbon-star text-xl" />
        </span>
        <div>
          <p class="text-xs text-gray-500 font-medium dark:text-gray-400">
            活动
          </p>
          <h1 class="text-2xl text-gray-900 font-bold dark:text-white">
            {{ activityName }}
          </h1>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div
          v-if="currency"
          class="h-11 flex items-center gap-2 border border-gray-200 rounded-xl bg-white px-2 text-sm shadow-sm sm:px-3 dark:border-gray-700 dark:bg-gray-800"
        >
          <img v-if="currency.image" :src="currency.image" :alt="currency.name" class="h-6 w-6 object-contain">
          <span v-else class="i-carbon-wallet text-lg text-gray-400" />
          <span class="text-gray-500 dark:text-gray-400">{{ currency.name }}</span>
          <strong class="text-gray-900 dark:text-white">{{ formatNumber(currency.count) }}</strong>
        </div>
        <BaseButton variant="secondary" :loading="loading" :disabled="!accountReady" @click="refreshAll">
          <span class="i-carbon-renew mr-1" />刷新
        </BaseButton>
        <BaseButton :loading="actionLoading === 'light-up'" :disabled="!accountReady" @click="lightUpStar">
          <span class="i-carbon-star-filled mr-1" />点亮并领取
        </BaseButton>
      </div>
    </div>

    <div v-if="loading" class="border border-gray-200 rounded-xl bg-white py-20 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="i-svg-spinners-ring-resize mx-auto text-4xl" style="color: var(--theme-primary)" />
      <p class="mt-3 text-gray-500 dark:text-gray-400">
        正在读取活动数据...
      </p>
    </div>

    <div v-else-if="error" class="border border-amber-200 rounded-xl bg-amber-50 px-6 py-12 text-center dark:border-amber-800 dark:bg-amber-900/20">
      <div class="i-carbon-warning-alt mx-auto text-4xl text-amber-500" />
      <p class="mt-3 text-amber-800 dark:text-amber-300">
        {{ error }}
      </p>
    </div>

    <div v-else-if="overview && !overview.active" class="border border-gray-200 rounded-xl bg-white py-20 text-center text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
      当前没有进行中的星宿活动
    </div>

    <template v-else-if="overview">
      <section v-if="battlePass" class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-lg text-gray-900 font-bold dark:text-white">
            游记进度
          </h2>
          <span v-if="overview.season?.activeEndTime" class="text-sm text-gray-500 dark:text-gray-400">
            截止 {{ formatEndTime(overview.season.activeEndTime) }}
          </span>
        </div>

        <article class="border border-gray-200 rounded-xl bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="text-lg text-gray-900 font-bold dark:text-white">
                Lv{{ formatNumber(battlePass.level) }}
                <span class="text-sm text-gray-400 font-normal dark:text-gray-500">/ {{ formatNumber(battlePass.maxLevel) }}</span>
              </h3>
              <p class="mt-1 text-sm text-gray-600 dark:text-gray-300">
                本级进度 {{ formatNumber(battlePass.currentLevelExp) }} / {{ formatNumber(battlePass.nextLevelNeedExp) }}
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <span v-if="battlePass.isPremium" class="rounded-md bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">已购进阶</span>
              <span :class="battlePass.claimableCount ? 'rounded-md bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : ''">
                可领取 {{ formatNumber(battlePass.claimableCount) }} 档
              </span>
            </div>
          </div>

          <div class="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              class="h-full rounded-full"
              :style="{
                background: 'var(--theme-primary)',
                width: `${battlePass.nextLevelNeedExp ? Math.min(100, (battlePass.currentLevelExp / battlePass.nextLevelNeedExp) * 100) : 0}%`,
              }"
            />
          </div>

          <BaseButton
            class="mt-4"
            size="sm"
            :loading="actionLoading === 'battle-pass'"
            :disabled="!accountReady || !battlePass.claimableCount"
            @click="claimBattlePass"
          >
            <span class="i-carbon-download mr-1" />一键领取
          </BaseButton>
        </article>
      </section>

      <section v-if="register" class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-lg text-gray-900 font-bold dark:text-white">
            观星礼录
          </h2>
          <div class="flex flex-wrap items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <span>共 {{ register.totalDays }} 宿</span>
            <span>已开放 {{ register.unlockedCount }}</span>
            <span>已领取 {{ register.claimedCount }}</span>
            <span v-if="register.claimableCount > 0" class="rounded-md bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              可领取 {{ register.claimableCount }}
            </span>
            <span v-if="overview.group?.endTime" class="hidden sm:inline">截止 {{ formatEndTime(overview.group.endTime) }}</span>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          <article
            v-for="day in register.days"
            :key="day.day"
            class="border border-gray-200 rounded-xl bg-white p-3 shadow-sm transition dark:border-gray-700 dark:bg-gray-800 hover:shadow-md"
            :title="day.star?.explain || ''"
          >
            <div class="flex items-center justify-between gap-1">
              <span class="text-xs text-gray-400 dark:text-gray-500">第{{ day.day }}宿</span>
              <span class="shrink-0 rounded px-1.5 py-0.5 text-xs" :class="dayStatus(day).cls">
                {{ dayStatus(day).label }}
              </span>
            </div>
            <div class="mt-1 flex items-baseline gap-1">
              <h3 class="text-gray-900 font-bold dark:text-white">
                {{ day.star?.name || `星宿${day.day}` }}
              </h3>
              <span v-if="day.star?.category" class="text-xs text-gray-400 dark:text-gray-500">{{ day.star.category }}</span>
            </div>
            <div class="mt-2 space-y-1">
              <div v-for="item in day.items" :key="item.id" class="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                <img v-if="item.image" :src="item.image" :alt="item.name" class="h-4 w-4 object-contain">
                <span class="truncate">{{ item.name }}×{{ formatNumber(item.count) }}</span>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section v-if="solarTerms.length" class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg text-gray-900 font-bold dark:text-white">
            节令小礼
          </h2>
          <span class="text-sm text-gray-500 dark:text-gray-400">{{ solarTerms.length }} 个节令</span>
        </div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          <article
            v-for="term in solarTerms"
            :key="term.id"
            class="border border-gray-200 rounded-xl bg-white p-3 shadow-sm transition dark:border-gray-700 dark:bg-gray-800 hover:shadow-md"
          >
            <div class="flex items-center justify-between gap-1">
              <h3 class="text-gray-900 font-bold dark:text-white">
                {{ term.name }}
              </h3>
              <span class="shrink-0 rounded px-1.5 py-0.5 text-xs" :class="termStatus(term).cls">
                {{ termStatus(term).label }}
              </span>
            </div>
            <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
              {{ formatDateRange(term.startTime, term.endTime) }}
            </p>
            <div class="mt-2 space-y-1">
              <div v-for="item in term.items" :key="item.id" class="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                <img v-if="item.image" :src="item.image" :alt="item.name" class="h-4 w-4 object-contain">
                <span class="truncate">{{ item.name }}×{{ formatNumber(item.count) }}</span>
              </div>
            </div>
            <BaseButton
              v-if="term.claimable"
              size="sm"
              class="mt-2 w-full"
              :loading="actionLoading === `solar-${term.id}`"
              :disabled="!accountReady"
              @click="claimSolarTerm(term)"
            >
              <span class="i-carbon-gift mr-1" />领取
            </BaseButton>
          </article>
        </div>
      </section>

      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg text-gray-900 font-bold dark:text-white">
            兑换商店
          </h2>
          <span class="text-sm text-gray-500 dark:text-gray-400">{{ shopGoods.length }} 件</span>
        </div>

        <div v-if="!shopGoods.length" class="border border-gray-200 rounded-xl bg-white py-14 text-center text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          当前没有读取到商店商品
        </div>

        <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <article
            v-for="goods in shopGoods"
            :key="goods.id"
            class="flex gap-4 border border-gray-200 rounded-xl bg-white p-4 shadow-sm transition dark:border-gray-700 dark:bg-gray-800 hover:shadow-md"
          >
            <div class="h-20 w-20 flex shrink-0 items-center justify-center rounded-xl bg-indigo-50 dark:bg-indigo-900/20">
              <img v-if="goods.item?.[0]?.image" :src="goods.item[0].image" :alt="goods.name" class="h-16 w-16 object-contain">
              <span v-else class="i-carbon-store text-3xl text-indigo-500" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-2">
                <h3 class="truncate text-gray-900 font-bold dark:text-white">
                  {{ goods.name }}
                </h3>
                <span class="shrink-0 rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                  {{ goods.soldOut ? '售罄' : (goods.remaining === null ? '不限' : `剩 ${formatNumber(goods.remaining)}`) }}
                </span>
              </div>
              <p class="line-clamp-2 mt-2 min-h-10 text-sm text-gray-500 leading-5 dark:text-gray-400">
                {{ formatRewardList(goods.item) }}
              </p>
              <div class="mt-3 flex items-center justify-between gap-3">
                <span class="truncate text-sm text-gray-600 dark:text-gray-300">{{ formatRewardList(goods.cost) || `${formatNumber(goods.diamondCostCount)} 钻石` }}</span>
                <BaseButton size="sm" :loading="actionLoading === `exchange-${goods.id}`" :disabled="!accountReady || goods.soldOut" @click="openExchange(goods)">
                  <span class="i-carbon-shopping-cart mr-1" />兑换
                </BaseButton>
              </div>
            </div>
          </article>
        </div>
      </section>
    </template>

    <ConfirmModal
      :show="!!exchangeTarget"
      :loading="actionLoading.startsWith('exchange-')"
      title="兑换活动物品"
      :message="exchangeMessage"
      confirm-text="确认兑换"
      type="primary"
      @cancel="exchangeTarget = null"
      @confirm="confirmExchange"
    />
  </div>
</template>
