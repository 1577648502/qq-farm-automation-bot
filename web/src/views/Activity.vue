<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

interface ActivityItem {
  id: number
  name: string
  category: 'currency' | 'seed' | 'fruit' | 'gift' | 'reward' | 'item'
  count: number
  image: string
  description: string
  type: number
  price: number
  priceUnit: string
}

interface ActivityCrop {
  plantId: number
  name: string
  seedId: number
  seedName: string
  seedCount: number
  fruitId: number
  fruitName: string
  fruitCount: number
  image: string
  fruitImage: string
  size: number
  requiredLevel: number
  seasons: number
  harvestCount: number
  growSeconds: number
  growTimeText: string
  exp: number
  price: number
  priceUnit: string
}

interface RewardItem {
  id: number
  name: string
  count: number
  image: string
}

interface LotteryState {
  freeRemaining: number
  freeDailyLimit: number
  paidRemaining: number
  paidDailyLimit: number
  paidCostId: number
  paidCostName: string
  paidCostImage: string
  paidCostCount: number
  paidDiamondCost: number
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

interface DailySigninState {
  claimedToday: boolean
  rewards: Array<{
    id: number
    description: string
    items: RewardItem[]
  }>
}

interface LiveActivity {
  head: {
    id: number
    name: string
    description: string
    endTime: number
  } | null
  lottery?: LotteryState | null
  shop?: { goods: ShopGoods[] } | null
  dailySignin?: DailySigninState | null
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
  freeClaimedLevel: number
  premiumClaimedLevel: number
  premiumPrice: number
  claimableCount: number
}

interface ActivityOverview {
  activity: {
    name: string
    aliases: string[]
  }
  updatedAt: number
  currencies: ActivityItem[]
  crops: ActivityCrop[]
  items: ActivityItem[]
  seedPriorityIds: number[]
  summary: {
    currencyCount: number
    cropCount: number
    itemCount: number
    heldKinds: number
  }
  live?: {
    updatedAt: number
    activity?: {
      lotteryActivity?: LiveActivity | null
      shopActivity?: LiveActivity | null
      dailySigninActivity?: LiveActivity | null
    } | null
    season?: {
      name: string
      activeEndTime: number
      battlePass?: BattlePassState | null
    } | null
    errors?: Array<{ scope: string, message: string }>
  }
}

type ItemCategory = 'all' | ActivityItem['category']

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const overview = ref<ActivityOverview | null>(null)
const loading = ref(false)
const error = ref('')
const activeCategory = ref<ItemCategory>('all')
const confirmSeedPriority = ref(false)
const exchangeTarget = ref<ShopGoods | null>(null)
const paidDrawCount = ref(0)
const applyLoading = ref(false)
const actionLoading = ref('')

const activityName = computed(() => overview.value?.activity?.name || '荷风游记')
const accountReady = computed(() => !!currentAccountId.value && !!currentAccount.value?.running)
const seedPriorityIds = computed(() => Array.from(new Set((overview.value?.seedPriorityIds || []).filter(Boolean))))
const live = computed(() => overview.value?.live || null)
const lotteryActivity = computed(() => live.value?.activity?.lotteryActivity || null)
const lottery = computed(() => lotteryActivity.value?.lottery || null)
const shopActivity = computed(() => live.value?.activity?.shopActivity || null)
const shopGoods = computed(() => shopActivity.value?.shop?.goods || [])
const dailySigninActivity = computed(() => live.value?.activity?.dailySigninActivity || null)
const dailySignin = computed(() => dailySigninActivity.value?.dailySignin || null)
const battlePass = computed(() => live.value?.season?.battlePass || null)
const liveErrors = computed(() => live.value?.errors || [])

const categoryOptions: Array<{ key: ItemCategory, label: string, icon: string }> = [
  { key: 'all', label: '全部', icon: 'i-carbon-apps' },
  { key: 'seed', label: '种子', icon: 'i-carbon-growth' },
  { key: 'fruit', label: '果实', icon: 'i-carbon-crop-growth' },
  { key: 'gift', label: '礼包', icon: 'i-carbon-gift' },
  { key: 'reward', label: '装扮', icon: 'i-carbon-badge' },
  { key: 'item', label: '其他', icon: 'i-carbon-cube' },
]

const itemCounts = computed(() => {
  const counts: Record<ItemCategory, number> = {
    all: overview.value?.items?.length || 0,
    currency: 0,
    seed: 0,
    fruit: 0,
    gift: 0,
    reward: 0,
    item: 0,
  }
  for (const item of overview.value?.items || [])
    counts[item.category] += 1
  return counts
})

const filteredItems = computed(() => {
  const items = overview.value?.items || []
  if (activeCategory.value === 'all')
    return items
  return items.filter(item => item.category === activeCategory.value)
})

const freeUsed = computed(() => {
  const l = lottery.value
  if (!l)
    return 0
  return Math.max(0, Number(l.freeDailyLimit || 0) - Number(l.freeRemaining || 0))
})

const seedPriorityMessage = computed(() => {
  const ids = seedPriorityIds.value.join('、')
  const account = currentAccount.value?.name || currentAccount.value?.nick || currentAccount.value?.uin || currentAccountId.value
  return `账号：${account}\n活动：${activityName.value}\n种子优先级：${ids || '无'}\n回退策略：最高经验\n\n确认后将立即保存当前账号的种植策略。`
})

const exchangeMessage = computed(() => {
  const goods = exchangeTarget.value
  if (!goods)
    return ''
  const cost = formatRewardList(goods.cost)
  const item = formatRewardList(goods.item)
  return `兑换：${goods.name}\n获得：${item || goods.name}\n消耗：${cost || '无'}\n数量：1`
})

const paidDrawMessage = computed(() => {
  const l = lottery.value
  const count = Math.max(1, Number(paidDrawCount.value) || 1)
  const costName = l?.paidCostName || '点券'
  const costCount = Math.max(0, Number(l?.paidCostCount || 0) * count)
  const diamondCost = Math.max(0, Number(l?.paidDiamondCost || 0) * count)
  const costText = costCount > 0 ? `${costName}×${formatNumber(costCount)}` : `${formatNumber(diamondCost)} 钻石`
  return `次数：${formatNumber(count)}\n消耗：${costText}`
})

function formatNumber(value?: number | null) {
  return Math.max(0, Number(value) || 0).toLocaleString('zh-CN')
}

function formatUpdatedAt(value?: number) {
  const ts = Number(value || 0)
  if (!ts)
    return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatProgress(current?: number, total?: number) {
  const c = Math.max(0, Number(current) || 0)
  const t = Math.max(0, Number(total) || 0)
  if (!t)
    return formatNumber(c)
  return `${formatNumber(c)} / ${formatNumber(t)}`
}

function formatRewardList(items?: RewardItem[]) {
  return (items || [])
    .filter(item => item && item.id)
    .map(item => `${item.name || `物品#${item.id}`}×${formatNumber(item.count)}`)
    .join('、')
}

function categoryLabel(category: ActivityItem['category']) {
  const labels: Record<ActivityItem['category'], string> = {
    currency: '货币',
    seed: '种子',
    fruit: '果实',
    gift: '礼包',
    reward: '装扮',
    item: '道具',
  }
  return labels[category] || '道具'
}

function setAction(key: string) {
  actionLoading.value = key
}

function clearAction(key: string) {
  if (actionLoading.value === key)
    actionLoading.value = ''
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
    const res = await api.get('/api/activity/overview', {
      params: { name: '荷风游记' },
      headers: { 'x-account-id': accountId },
    })
    if (accountId !== String(currentAccountId.value || ''))
      return
    if (!res.data?.ok)
      throw new Error(res.data?.error || '获取活动数据失败')
    overview.value = res.data.data
    await statusStore.fetchStatus(accountId)
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取活动数据失败'
  }
  finally {
    loading.value = false
  }
}

async function runAction(key: string, path: string, payload: Record<string, any>, success: (data: any) => string) {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || actionLoading.value)
    return
  setAction(key)
  try {
    const res = await api.post(path, payload, {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '操作失败')
    toast.success(success(res.data.data))
    await fetchOverview()
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '操作失败')
  }
  finally {
    clearAction(key)
  }
}

function openSeedPriorityConfirm() {
  if (!seedPriorityIds.value.length) {
    toast.warning('当前活动没有可设置的种子')
    return
  }
  confirmSeedPriority.value = true
}

async function applySeedPriority() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || applyLoading.value)
    return

  applyLoading.value = true
  try {
    await api.post('/api/settings/save', {
      plantingStrategy: 'bag_priority',
      bagSeedPriority: seedPriorityIds.value,
      bagSeedFallbackStrategy: 'max_exp',
    }, {
      headers: { 'x-account-id': accountId },
    })
    toast.success('已设置为活动种子优先')
    confirmSeedPriority.value = false
    await statusStore.fetchStatus(accountId)
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '设置失败')
  }
  finally {
    applyLoading.value = false
  }
}

async function drawFree(count: number) {
  const activityId = lotteryActivity.value?.head?.id
  await runAction('draw', '/api/activity/draw', {
    activityName: '荷风游记',
    activityId,
    count,
    mode: 'free',
  }, (data) => {
    const rewards = formatRewardList(data?.rewards || [])
    return rewards ? `免费奇遇完成：${rewards}` : '免费奇遇完成'
  })
}

function openPaidDraw(count: number) {
  const available = Math.max(0, Number(lottery.value?.paidRemaining || 0))
  if (!available) {
    toast.warning('今日点券奇遇次数已用完')
    return
  }
  paidDrawCount.value = Math.min(Math.max(1, Math.floor(count) || 1), available)
}

async function confirmPaidDraw() {
  const activityId = lotteryActivity.value?.head?.id
  const count = Math.max(1, Number(paidDrawCount.value) || 1)
  await runAction('paid-draw', '/api/activity/draw', {
    activityName: '荷风游记',
    activityId,
    count,
    mode: 'paid',
    allowPaid: true,
  }, (data) => {
    const rewards = formatRewardList(data?.rewards || [])
    return rewards ? `点券奇遇完成：${rewards}` : '点券奇遇完成'
  })
  paidDrawCount.value = 0
}

async function claimBattlePass() {
  await runAction('battle-pass', '/api/activity/battle-pass/claim', {
    activityName: '荷风游记',
  }, (data) => {
    const count = Number(data?.claimedLevels?.length || 0)
    const rewards = formatRewardList(data?.rewards || [])
    return rewards ? `领取 ${count} 档：${rewards}` : `领取 ${count} 档游记奖励`
  })
}

async function claimTasks() {
  await runAction('tasks', '/api/activity/tasks/claim', {
    activityName: '荷风游记',
  }, (data) => `领取 ${Number(data?.claimedCount || 0)} 个活动任务`)
}

async function claimDailySignin() {
  const activityId = dailySigninActivity.value?.head?.id
  const rewardId = dailySignin.value?.rewards?.[0]?.id
  await runAction('daily-signin', '/api/activity/daily-signin/claim', {
    activityName: '荷风游记',
    activityId,
    rewardId,
  }, (data) => {
    const awards = formatRewardList(data?.awards || [])
    return awards ? `领取活动赠礼：${awards}` : '活动赠礼已领取'
  })
}

function openExchange(goods: ShopGoods) {
  exchangeTarget.value = goods
}

async function confirmExchange() {
  const goods = exchangeTarget.value
  if (!goods)
    return
  await runAction(`exchange-${goods.id}`, '/api/activity/exchange', {
    activityName: '荷风游记',
    activityId: shopActivity.value?.head?.id,
    goodsId: goods.id,
    count: 1,
  }, (data) => {
    const awards = formatRewardList(data?.awards || [])
    return awards ? `兑换成功：${awards}` : '兑换成功'
  })
  exchangeTarget.value = null
}

watch([currentAccountId, () => currentAccount.value?.running], fetchOverview)

onMounted(async () => {
  if (!accountStore.accounts.length)
    await accountStore.fetchAccounts()
  await fetchOverview()
})
</script>

<template>
  <div class="mx-auto max-w-7xl w-full p-2 space-y-5 sm:p-4">
    <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div class="flex items-center gap-3">
        <span class="h-10 w-10 flex items-center justify-center rounded-xl text-white shadow" style="background: var(--theme-primary)">
          <span class="i-carbon-events text-xl" />
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
          v-for="currency in overview?.currencies || []"
          :key="currency.id"
          class="h-11 flex items-center gap-2 border border-gray-200 rounded-xl bg-white px-2 sm:px-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <img v-if="currency.image" :src="currency.image" :alt="currency.name" class="h-6 w-6 object-contain">
          <span v-else class="i-carbon-wallet text-lg text-gray-400" />
          <span class="text-gray-500 dark:text-gray-400">{{ currency.name }}</span>
          <strong class="text-gray-900 dark:text-white">{{ formatNumber(currency.count) }}</strong>
        </div>
        <BaseButton variant="secondary" :loading="loading" :disabled="!accountReady" @click="fetchOverview">
          <span class="i-carbon-renew mr-1" />刷新
        </BaseButton>
        <BaseButton :disabled="!accountReady || !seedPriorityIds.length" @click="openSeedPriorityConfirm">
          <span class="i-carbon-growth mr-1" />优先种活动种子
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

    <template v-else-if="overview">
      <div v-if="liveErrors.length" class="border border-amber-200 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
        {{ liveErrors.map(e => e.message).join('；') }}
      </div>

      <section class="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <article class="border border-gray-200 rounded-xl bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                奇遇礼莲
              </p>
              <h2 class="mt-1 text-lg text-gray-900 font-bold dark:text-white">
                免费 {{ formatNumber(lottery?.freeRemaining) }} / {{ formatNumber(lottery?.freeDailyLimit || 4) }}
              </h2>
            </div>
            <span class="i-carbon-growth text-3xl text-emerald-500" />
          </div>
          <div class="mt-4 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              class="h-full rounded-full bg-emerald-500"
              :style="{ width: `${Math.min(100, lottery?.freeDailyLimit ? (freeUsed / lottery.freeDailyLimit) * 100 : 0)}%` }"
            />
          </div>
          <div class="mt-4 flex flex-wrap gap-2">
            <BaseButton size="sm" :loading="actionLoading === 'draw'" :disabled="!accountReady || !lottery?.freeRemaining" @click="drawFree(1)">
              <span class="i-carbon-play mr-1" />免费一次
            </BaseButton>
            <BaseButton size="sm" variant="secondary" :loading="actionLoading === 'draw'" :disabled="!accountReady || !lottery?.freeRemaining" @click="drawFree(lottery?.freeRemaining || 1)">
              <span class="i-carbon-flash mr-1" />免费全部
            </BaseButton>
          </div>
          <p class="mt-3 text-xs text-gray-500 dark:text-gray-400">
            今日总次数 {{ formatNumber((lottery?.freeRemaining || 0) + (lottery?.paidRemaining || 0)) }} / {{ formatNumber((lottery?.freeDailyLimit || 0) + (lottery?.paidDailyLimit || 0)) }}
          </p>
          <div class="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700">
            <p class="text-xs text-gray-500 dark:text-gray-400">
              点券 {{ formatNumber(lottery?.paidRemaining) }} / {{ formatNumber(lottery?.paidDailyLimit || 4) }}
              <span v-if="lottery?.paidCostCount"> · {{ lottery.paidCostName || '点券' }}×{{ formatNumber(lottery.paidCostCount) }}/次</span>
            </p>
            <div class="mt-2 flex flex-wrap gap-2">
              <BaseButton size="sm" variant="secondary" :loading="actionLoading === 'paid-draw'" :disabled="!accountReady || !lottery?.paidRemaining" @click="openPaidDraw(1)">
                <span class="i-carbon-ticket mr-1" />点券一次
              </BaseButton>
              <BaseButton size="sm" variant="secondary" :loading="actionLoading === 'paid-draw'" :disabled="!accountReady || !lottery?.paidRemaining" @click="openPaidDraw(lottery?.paidRemaining || 1)">
                <span class="i-carbon-ticket mr-1" />点券全部
              </BaseButton>
            </div>
          </div>
        </article>

        <article class="border border-gray-200 rounded-xl bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                荷风游记
              </p>
              <h2 class="mt-1 text-lg text-gray-900 font-bold dark:text-white">
                Lv{{ formatNumber(battlePass?.level) }}
              </h2>
            </div>
            <span class="i-carbon-book text-3xl text-sky-500" />
          </div>
          <p class="mt-4 text-sm text-gray-600 dark:text-gray-300">
            {{ formatProgress(battlePass?.currentLevelExp, battlePass?.nextLevelNeedExp) }}
          </p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            可领取 {{ formatNumber(battlePass?.claimableCount) }} 档
          </p>
          <BaseButton class="mt-4" size="sm" :loading="actionLoading === 'battle-pass'" :disabled="!accountReady || !battlePass?.claimableCount" @click="claimBattlePass">
            <span class="i-carbon-download mr-1" />一键领取
          </BaseButton>
        </article>

        <article class="border border-gray-200 rounded-xl bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                活动任务
              </p>
              <h2 class="mt-1 text-lg text-gray-900 font-bold dark:text-white">
                荷露 / 积分
              </h2>
            </div>
            <span class="i-carbon-task-complete text-3xl text-amber-500" />
          </div>
          <p class="mt-4 text-sm text-gray-600 dark:text-gray-300">
            {{ live?.season?.name || activityName }}
          </p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            更新时间 {{ formatUpdatedAt(live?.updatedAt) }}
          </p>
          <BaseButton class="mt-4" size="sm" variant="secondary" :loading="actionLoading === 'tasks'" :disabled="!accountReady" @click="claimTasks">
            <span class="i-carbon-checkmark mr-1" />领取任务
          </BaseButton>
        </article>

        <article class="border border-gray-200 rounded-xl bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                节令赠礼
              </p>
              <h2 class="mt-1 text-lg text-gray-900 font-bold dark:text-white">
                {{ dailySignin?.claimedToday ? '已领取' : '待领取' }}
              </h2>
            </div>
            <span class="i-carbon-gift text-3xl text-rose-500" />
          </div>
          <p class="mt-4 line-clamp-2 min-h-10 text-sm text-gray-600 dark:text-gray-300">
            {{ formatRewardList(dailySignin?.rewards?.[0]?.items || []) || '当前无赠礼' }}
          </p>
          <BaseButton class="mt-4" size="sm" variant="secondary" :loading="actionLoading === 'daily-signin'" :disabled="!accountReady || !dailySignin || dailySignin.claimedToday" @click="claimDailySignin">
            <span class="i-carbon-download mr-1" />领取赠礼
          </BaseButton>
        </article>
      </section>

      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg text-gray-900 font-bold dark:text-white">
            荷露商店
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
            <div class="h-20 w-20 flex shrink-0 items-center justify-center rounded-xl bg-teal-50 dark:bg-teal-900/20">
              <img v-if="goods.item?.[0]?.image" :src="goods.item[0].image" :alt="goods.name" class="h-16 w-16 object-contain">
              <span v-else class="i-carbon-store text-3xl text-teal-500" />
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
                {{ goods.description || formatRewardList(goods.item) }}
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

      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg text-gray-900 font-bold dark:text-white">
            活动作物
          </h2>
          <span class="text-sm text-gray-500 dark:text-gray-400">{{ overview.crops.length }} 种</span>
        </div>

        <div v-if="!overview.crops.length" class="border border-gray-200 rounded-xl bg-white py-14 text-center text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          当前配置没有识别到活动作物
        </div>

        <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <article
            v-for="crop in overview.crops"
            :key="crop.plantId"
            class="flex flex-col border border-gray-200 rounded-xl bg-white p-4 shadow-sm transition dark:border-gray-700 dark:bg-gray-800 hover:shadow-md"
          >
            <div class="flex gap-4">
              <div class="h-24 w-24 flex shrink-0 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-900/20">
                <img v-if="crop.image" :src="crop.image" :alt="crop.name" class="h-20 w-20 object-contain">
                <span v-else class="i-carbon-crop-growth text-4xl text-emerald-400" />
              </div>
              <div class="min-w-0 flex-1">
                <h3 class="truncate text-lg text-gray-900 font-bold dark:text-white">
                  {{ crop.name }}
                </h3>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {{ crop.seedName || '活动投放作物' }}
                </p>
                <div class="mt-3 flex flex-wrap gap-2 text-xs">
                  <span class="rounded-md bg-emerald-50 px-2 py-1 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">{{ crop.size }}×{{ crop.size }}</span>
                  <span class="rounded-md bg-blue-50 px-2 py-1 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300">{{ crop.growTimeText || '-' }}</span>
                  <span class="rounded-md bg-amber-50 px-2 py-1 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300">Lv{{ crop.requiredLevel }}</span>
                  <span v-if="crop.seasons > 1" class="rounded-md bg-violet-50 px-2 py-1 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300">{{ crop.seasons }}季</span>
                </div>
              </div>
            </div>

            <div class="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
                <p class="text-gray-500 dark:text-gray-400">
                  背包种子
                </p>
                <strong class="mt-1 block text-gray-900 dark:text-white">{{ formatNumber(crop.seedCount) }}</strong>
              </div>
              <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
                <p class="text-gray-500 dark:text-gray-400">
                  活动果实
                </p>
                <strong class="mt-1 block text-gray-900 dark:text-white">{{ formatNumber(crop.fruitCount) }}</strong>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section class="space-y-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="text-lg text-gray-900 font-bold dark:text-white">
            活动物品
          </h2>
          <div class="flex flex-nowrap gap-2 overflow-x-auto pb-1 snap-x snap-mandatory scrollbar-none sm:flex-wrap sm:overflow-visible sm:pb-0">
      <button v-for="option in categoryOptions" :key="option.key" class="min-h-[44px] h-auto flex items-center gap-1 rounded-lg px-3 text-sm font-medium transition whitespace-nowrap sm:whitespace-normal"
              :class="activeCategory === option.key
                ? 'text-white shadow-sm'
                : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
              :style="activeCategory === option.key ? { background: 'var(--theme-primary)' } : {}"
              @click="activeCategory = option.key"
            >
              <span :class="option.icon" />
              <span>{{ option.label }}</span>
              <span class="opacity-70">{{ itemCounts[option.key] }}</span>
            </button>
          </div>
        </div>

        <div v-if="!filteredItems.length" class="border border-gray-200 rounded-xl bg-white py-14 text-center text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          当前分类暂无活动物品
        </div>

        <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <article
            v-for="item in filteredItems"
            :key="item.id"
            class="flex gap-4 border border-gray-200 rounded-xl bg-white p-4 shadow-sm transition dark:border-gray-700 dark:bg-gray-800 hover:shadow-md"
          >
            <div class="relative h-20 w-20 flex shrink-0 items-center justify-center rounded-xl bg-sky-50 dark:bg-sky-900/20">
              <img v-if="item.image" :src="item.image" :alt="item.name" class="h-16 w-16 object-contain">
              <span v-else class="i-carbon-cube text-3xl text-sky-400" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-2">
                <h3 class="truncate text-gray-900 font-bold dark:text-white">
                  {{ item.name }}
                </h3>
                <span class="shrink-0 rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">{{ categoryLabel(item.category) }}</span>
              </div>
              <p class="line-clamp-2 mt-2 min-h-10 text-sm text-gray-500 leading-5 dark:text-gray-400">
                {{ item.description || '活动道具' }}
              </p>
              <div class="mt-3 flex items-center justify-between text-sm">
                <span class="text-gray-500 dark:text-gray-400">持有</span>
                <strong class="text-lg text-gray-900 dark:text-white">{{ formatNumber(item.count) }}</strong>
              </div>
            </div>
          </article>
        </div>
      </section>

    </template>

    <ConfirmModal
      :show="confirmSeedPriority"
      :loading="applyLoading"
      title="设置活动种子优先"
      :message="seedPriorityMessage"
      confirm-text="保存设置"
      type="primary"
      @cancel="confirmSeedPriority = false"
      @confirm="applySeedPriority"
    />

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

    <ConfirmModal
      :show="paidDrawCount > 0"
      :loading="actionLoading === 'paid-draw'"
      title="点券奇遇"
      :message="paidDrawMessage"
      confirm-text="确认奇遇"
      type="primary"
      @cancel="paidDrawCount = 0"
      @confirm="confirmPaidDraw"
    />
  </div>
</template>
