<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, triggerRef, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { formatCompactNumber } from '@/utils/number-format'
import {
  findQingmeiCrop,
  findQingmeiFruitItem,
  findQingmeiSeedItem,
  getQingmeiFruitCount,
} from '@/utils/qingniang'

interface ActivityItem {
  id: number
  name: string
  category: 'currency' | 'seed' | 'fruit' | 'gift' | 'reward' | 'item'
  count: number
  image: string
  description: string
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
  growTimeText: string
}

interface RewardItem {
  id: number
  name: string
  count: number
  image: string
}

interface LiveActivity {
  head: {
    id: number
    name: string
    description: string
    endTime: number
  } | null
  dailySignin?: {
    claimedToday: boolean
    rewards: Array<{
      id: number
      description: string
      items: RewardItem[]
    }>
  } | null
  shop?: {
    goods?: Array<{
      id: number
      cost?: Array<{id: number}>
    }>
  } | null
  qingmei?: {
    brewedGold: number
    brewedCount: number
    brewLimit: number
    hasCritical: boolean
  } | null
  bodyType?: string
}

interface ActivityOverview {
  updatedAt: number
  crops: ActivityCrop[]
  items: ActivityItem[]
  live?: {
    updatedAt: number
    activity?: {
      drawActivity?: LiveActivity | null
      dailySigninActivity?: LiveActivity | null
      shopActivity?: LiveActivity | null
    } | null
    season?: {
      name: string
      activeEndTime: number
    } | null
    errors?: Array<{ scope: string, message: string }>
  }
}

const QINGNIANG_NAME = '青酿换万金'
const DEFAULT_EXPECTED_GOLD = 250000

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const overview = ref<ActivityOverview | null>(null)
const loading = ref(false)
const error = ref('')
const actionLoading = ref('')
const brewFruitCount = ref(3)

const accountReady = computed(() => !!currentAccountId.value && !!currentAccount.value?.running)
const live = computed(() => overview.value?.live || null)
const drawActivity = computed(() => live.value?.activity?.drawActivity || null)
const dailySigninActivity = computed(() => live.value?.activity?.dailySigninActivity || null)
const dailySignin = computed(() => dailySigninActivity.value?.dailySignin || null)
const liveErrors = computed(() => live.value?.errors || [])
const qingCrop = computed(() => findQingmeiCrop(overview.value))
const qingSeed = computed(() => findQingmeiSeedItem(overview.value))
const qingFruit = computed(() => findQingmeiFruitItem(overview.value))
const fruitCount = computed(() => getQingmeiFruitCount(overview.value))
const selectedCount = computed(() => fruitCount.value > 0 ? 1 : 0)
const expectedGold = computed(() => fruitCount.value > 0 ? DEFAULT_EXPECTED_GOLD : 0)
const remainingEndTime = computed(() => Number(drawActivity.value?.head?.endTime || live.value?.season?.activeEndTime || 0))
const brewState = computed(() => drawActivity.value?.qingmei || null)
const brewedCount = computed(() => Math.max(0, Number(brewState.value?.brewedCount || 0)))
const brewLimit = computed(() => Math.max(0, Number(brewState.value?.brewLimit || 0)))
const remainingBrewCount = computed(() => brewLimit.value > 0 ? Math.max(0, brewLimit.value - brewedCount.value) : 0)
const canSellBrew = computed(() => brewedCount.value > 0 && remainingBrewCount.value === 0)

function formatNumber(value?: number | null) {
  return Math.max(0, Number(value) || 0).toLocaleString('zh-CN')
}

function formatGold(value: number) {
  return formatCompactNumber(value)
}

function formatRewardList(items?: RewardItem[]) {
  return (items || [])
    .filter(item => item && item.id)
    .map(item => `${item.name || `物品#${item.id}`}×${formatNumber(item.count)}`)
    .join('、')
}

function formatRemaining(value?: number) {
  const ts = Number(value || 0)
  if (!ts)
    return '活动中'
  const seconds = Math.max(0, ts - Math.floor(Date.now() / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  if (days > 0)
    return `${days}天${hours}小时`
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}小时${minutes}分钟`
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
      params: { name: QINGNIANG_NAME },
      headers: { 'x-account-id': accountId },
    })
    if (accountId !== String(currentAccountId.value || ''))
      return
    if (!res.data?.ok)
      throw new Error(res.data?.error || '获取活动数据失败')
    overview.value = res.data.data
    await statusStore.fetchStatus(accountId)
      // 强制通知 Vue 响应式系统重新求值，确保页面立即刷新
    triggerRef(overview)
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
  actionLoading.value = key
  let responseData: any = null
  try {
    const res = await api.post(path, payload, {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '操作失败')
    responseData = res.data.data
    // 立即更新 overview 响应式对象，在 fetchOverview 之前让页面显示最新金额
    if (responseData?.goldAwarded > 0 && overview.value?.live?.activity?.drawActivity?.qingmei) {
      overview.value.live.activity.drawActivity.qingmei.brewedGold = responseData.goldAwarded
    }
    toast.success(success(responseData))
    await fetchOverview()
    if (responseData?.activity?.qingmei && overview.value?.live?.activity?.drawActivity) {
      overview.value.live.activity.drawActivity.qingmei = responseData.activity.qingmei
    }
    // 用操作返回的实际累计金币覆盖，独立于 qingmei 条件，避免卖出后 qingmei 为 null 时跳过
    if (responseData.goldAwarded > 0 && overview.value?.live?.activity?.drawActivity?.qingmei) {
      overview.value.live.activity.drawActivity.qingmei.brewedGold = responseData.goldAwarded
  }
        // 强制刷新页面响应式数据，确保金额立即更新
    triggerRef(overview)
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '操作失败')
  }
  finally {
    if (actionLoading.value === key)
      actionLoading.value = ''
  }
}

async function claimSeedReward() {
  const activityId = dailySigninActivity.value?.head?.id
  const rewardId = dailySignin.value?.rewards?.[0]?.id
  await runAction('daily-seed', '/api/activity/daily-signin/claim', {
    activityName: QINGNIANG_NAME,
    activityId,
    rewardId,
  }, (data) => {
    const awards = formatRewardList(data?.awards || [])
    return awards ? `领取成功：${awards}` : '青梅种子已领取'
  })
}

async function brewNormal() {
  await runAction('brew', '/api/activity/brew', {
    activityName: QINGNIANG_NAME,
    activityId: drawActivity.value?.head?.id,
    count: 1,
    fruitCount: brewFruitCount.value,
  }, (data) => {
    const gold = data?.goldAwarded || 0
    return gold ? `一次酿造完成，待卖出 ${formatGold(gold)} 金币` : '酿造完成'
  })
}

async function brewFine() {
  const maxBrew = remainingBrewCount.value > 0 ? remainingBrewCount.value : Math.min(fruitCount.value, 3)
  if (maxBrew <= 0) {
    toast.error(canSellBrew.value ? '已酿造完成，请先卖出' : '没有青梅果实可精酿')
    return
  }
  await runAction('brew-fine', '/api/activity/brew/fine', {
    activityName: QINGNIANG_NAME,
    activityId: drawActivity.value?.head?.id,
    count: maxBrew,
    fruitCount: brewFruitCount.value,
  }, (data) => {
    const sessions = data?.sessions || []
    const gold = data?.goldAwarded || 0
    const consumed = data?.fruitsConsumed || 0
    const prices = sessions.map((s: {price: number; gold: number; critical?: boolean}, i: number) => `第${i+1}次: ${formatGold(s.price)}${s.critical ? ' 暴击' : ''}`).join('、')
    return prices ? `精酿完成，消耗 ${consumed} 青梅\n${prices}\n待卖出 ${formatGold(gold)} 金币` : `精酿完成，待卖出 ${formatGold(gold)} 金币`
  })
}

async function sellBrew() {
  if (!canSellBrew.value) {
    toast.info(remainingBrewCount.value > 0 ? `还需继续酿造 ${remainingBrewCount.value} 次后才能卖出` : '请先完成酿造')
    return
  }
  const sellCount = Math.max(1, brewedCount.value)
  await runAction('sell', '/api/activity/brew/sell', {
    activityName: QINGNIANG_NAME,
    activityId: drawActivity.value?.head?.id,
    count: sellCount,
  }, (data) => {
    const awards = formatRewardList(data?.awards || [])
    const gold = data?.goldAwarded || 0
    return awards ? `出售成功：${awards}` : (gold ? `出售成功：${formatGold(gold)} 金币` : '出售完成')
  })
}

async function shareSellBrew() {
  if (!canSellBrew.value) {
    toast.info(remainingBrewCount.value > 0 ? `还需继续酿造 ${remainingBrewCount.value} 次后才能分享卖出` : '请先完成酿造')
    return
  }
  const sellCount = Math.max(1, brewedCount.value)
  await runAction('share-sell', '/api/activity/brew/share-sell', {
    activityName: QINGNIANG_NAME,
    activityId: drawActivity.value?.head?.id,
    count: sellCount,
  }, (data) => {
    const awards = formatRewardList(data?.awards || [])
    const multiplier = data?.shareMultiplier || 1
    return awards ? `分享卖出（${multiplier}x）成功：${awards}` : '分享卖出完成'
  })
}


watch([currentAccountId, () => currentAccount.value?.running], fetchOverview)

onMounted(async () => {
  if (!accountStore.accounts.length)
    await accountStore.fetchAccounts()
  await fetchOverview()
})
</script>

<template>
  <div class="mx-auto max-w-5xl w-full p-2 space-y-5 sm:p-4">
    <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div class="flex items-center gap-3">
        <span class="h-10 w-10 flex items-center justify-center rounded-xl bg-emerald-500 text-white shadow">
          <span class="i-carbon-crop-growth text-xl" />
        </span>
        <div>
          <p class="text-xs text-gray-500 font-medium dark:text-gray-400">
            限时活动
          </p>
          <h1 class="text-2xl text-gray-900 font-bold dark:text-white">
            青酿换万金
          </h1>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          剩余：{{ formatRemaining(remainingEndTime) }}
        </span>
        <BaseButton variant="secondary" :loading="loading" :disabled="!accountReady" @click="fetchOverview">
          <span class="i-carbon-renew mr-1" />刷新
        </BaseButton>
      </div>
    </div>

    <div v-if="loading" class="border border-gray-200 rounded-xl bg-white py-20 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="i-svg-spinners-ring-resize mx-auto text-4xl text-emerald-500" />
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
        {{ liveErrors.map(e => e.message).join('、') }}
      </div>

      <section class="overflow-hidden border border-emerald-100 rounded-xl bg-white shadow-sm dark:border-emerald-900/50 dark:bg-gray-800">
        <div class="grid grid-cols-1 lg:grid-cols-[1fr_220px]">
          <div class="p-5 sm:p-6">
            <div class="flex flex-col gap-5 sm:flex-row">
              <div class="h-36 w-full flex shrink-0 items-center justify-center rounded-xl bg-emerald-50 sm:w-44 dark:bg-emerald-900/20">
                <img v-if="qingCrop?.fruitImage || qingFruit?.image || qingCrop?.image" :src="qingCrop?.fruitImage || qingFruit?.image || qingCrop?.image" alt="青梅" class="h-28 w-28 object-contain">
                <span v-else class="i-carbon-crop-growth text-6xl text-emerald-400" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm text-emerald-600 font-bold dark:text-emerald-300">
                  种植青梅制佳酿，限时金币翻倍
                </p>
                <h2 class="mt-2 text-2xl text-gray-900 font-bold dark:text-white">
                  青梅酿
                </h2>
                <div class="mt-4 grid grid-cols-2 gap-3 text-sm sm:max-w-md">
                  <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
                    <p class="text-gray-500 dark:text-gray-400">
                      青梅果实
                    </p>
                    <strong class="mt-1 block text-lg text-gray-900 dark:text-white">{{ formatNumber(fruitCount) }}</strong>
                  </div>
                  <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
                    <p class="text-gray-500 dark:text-gray-400">
                      青梅种子
                    </p>
                    <strong class="mt-1 block text-lg text-gray-900 dark:text-white">{{ formatNumber(qingCrop?.seedCount || qingSeed?.count || 0) }}</strong>
                  </div>
                </div>
                <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  分享卖出可获取 1.5 倍收益
                </p>
              </div>
            </div>
          </div>

          <aside class="border-t border-emerald-100 bg-emerald-50/70 p-5 dark:border-emerald-900/50 dark:bg-emerald-900/20 lg:border-l lg:border-t-0">
            <p class="text-sm text-gray-500 dark:text-gray-400">
              青梅种子
            </p>
            <div class="mt-3 flex items-center gap-3">
              <div class="h-16 w-16 flex items-center justify-center rounded-xl bg-white shadow-sm dark:bg-gray-800">
                <img v-if="qingSeed?.image" :src="qingSeed.image" alt="青梅种子" class="h-12 w-12 object-contain">
                <span v-else class="i-carbon-growth text-3xl text-emerald-500" />
              </div>
              <div>
                <strong class="text-gray-900 dark:text-white">{{ qingSeed?.name || '青梅种子' }}</strong>
                <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {{ dailySignin ? (dailySignin.claimedToday ? '明日再来' : '今日可领') : (dailySigninActivity ? '可尝试领取' : '数据加载中') }}
                </p>
              </div>
            </div>
            <BaseButton class="mt-4 w-full" :loading="actionLoading === 'daily-seed'" :disabled="!accountReady || !dailySigninActivity || dailySignin?.claimedToday === true" @click="claimSeedReward">
              <span class="i-carbon-download mr-1" />{{ dailySignin?.claimedToday ? '已领取' : '领取种子' }}
            </BaseButton>
          </aside>
        </div>
      </section>

      <section class="border border-gray-200 rounded-xl bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm text-gray-500 dark:text-gray-400">
              当前选中：{{ selectedCount }}/1
            </p>
            <div class="mt-3 flex items-center gap-3">
              <div class="h-14 w-14 flex items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-900/20">
                <img v-if="qingCrop?.fruitImage || qingFruit?.image" :src="qingCrop?.fruitImage || qingFruit?.image" alt="青梅" class="h-11 w-11 object-contain">
                <span v-else class="i-carbon-crop-growth text-2xl text-emerald-500" />
              </div>
              <div>
                <strong class="text-gray-900 dark:text-white">{{ qingCrop?.fruitName || '青梅' }}</strong>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                  {{ formatNumber(fruitCount) }}
                </p>
              </div>
            </div>
          </div>
          <div class="text-left sm:text-right">
            <p class="text-sm text-gray-500 dark:text-gray-400">
              {{ brewedCount > 0 ? `酿造进度 ${brewedCount}/${brewLimit || 3}` : '预计可卖' }}
            </p>
            <strong class="mt-1 block text-2xl text-amber-500">{{ formatGold(brewState?.brewedGold || expectedGold) }}</strong>
<div class="mt-3 flex items-center gap-2 justify-end">
              <label class="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">果实:</label>
              <input v-model.number="brewFruitCount" type="number" min="1" :max="fruitCount" class="w-16 px-2 py-1 text-sm text-center border border-gray-300 rounded-md dark:border-gray-600 dark:bg-gray-700 dark:text-white" />
              <BaseButton :loading="actionLoading === 'brew'" :disabled="!accountReady || canSellBrew || (!fruitCount && brewedCount === 0)" @click="brewNormal" size="sm">
                <span class="i-carbon-shopping-cart mr-1" />酿造
              </BaseButton>
              <BaseButton :loading="actionLoading === 'brew-fine'" :disabled="!accountReady || canSellBrew || (!fruitCount && brewedCount === 0)" @click="brewFine" variant="secondary" size="sm">
                <span class="i-carbon-cafe mr-1" />精酿
              </BaseButton>
            </div>
            <div class="mt-2 flex flex-wrap gap-2 justify-end">
              <BaseButton :loading="actionLoading === 'sell'" :disabled="!accountReady || !canSellBrew" @click="sellBrew" variant="outline" size="sm">
                <span class="i-carbon-wallet mr-1" />卖出
              </BaseButton>
              <BaseButton :loading="actionLoading === 'share-sell'" :disabled="!accountReady || !canSellBrew" @click="shareSellBrew" variant="outline" size="sm">
                <span class="i-carbon-share mr-1" />分享卖出(1.5x)
              </BaseButton>
            </div>
            <p class="mt-2 text-xs text-gray-400 dark:text-gray-500">
              {{ remainingBrewCount > 0 ? `还有 ${remainingBrewCount} 次未完成，继续酿造后才能卖出` : '精酿最多3次，每次价格不同；分享卖出可获1.5倍收益' }}
            </p>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
