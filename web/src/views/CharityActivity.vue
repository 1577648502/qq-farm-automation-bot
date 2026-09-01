<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useToastStore } from '@/stores/toast'

interface RewardItem {
  id: number
  name: string
  count: number
  image: string
}

interface CharityTier {
  threshold: number
  reward: RewardItem
}

interface CharityActivity {
  groupId: number
  name: string
  startTime: number
  endTime: number
  hasBody: boolean
  loveItemId?: number
  giftClaimed?: boolean
  loveSent?: boolean
  serverLoveTotal?: number
  serverTarget?: number
  seedReward?: RewardItem
  dailyGift?: RewardItem
  tiers?: CharityTier[]
  serverReward?: CharityTier | null
  settlePack?: RewardItem
  redDot?: number
}

interface CharityOverview {
  updatedAt: number
  activity: CharityActivity | null
  bag: {
    love: number
    seed: number
    fruit: number
  }
}

const toast = useToastStore()
const loading = ref(false)
const busy = ref(false)
const overview = ref<CharityOverview | null>(null)

const active = computed(() => !!overview.value?.activity?.hasBody)

function fmtTime(sec: number) {
  if (!sec) return '-'
  const d = new Date(sec * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtRange(begin: number, end: number) {
  return `${fmtTime(begin)} ~ ${fmtTime(end)}`
}

function fmtNum(n: number) {
  return (Number(n) || 0).toLocaleString('zh-CN')
}

function extractError(e: any): string {
  return e?.response?.data?.error || e?.message || ''
}

const serverProgress = computed(() => {
  const a = overview.value?.activity
  if (!a || !a.serverTarget) return 0
  return Math.min(100, ((a.serverLoveTotal || 0) / Math.max(1, a.serverTarget)) * 100)
})

async function loadOverview() {
  loading.value = true
  try {
    const { data } = await api.get('/api/charity/overview')
    if (data?.ok) {
      overview.value = data.data
    } else {
      toast.error(data?.error || '加载失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '加载失败')
  } finally {
    loading.value = false
  }
}

async function handleClaimGift() {
  busy.value = true
  try {
    const { data } = await api.post('/api/charity/claim-gift')
    if (data?.ok) {
      toast.success('公益礼包领取成功')
      await loadOverview()
    } else {
      toast.error(data?.error || '领取失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '领取失败')
  } finally {
    busy.value = false
  }
}

async function handleSendLove() {
  busy.value = true
  try {
    const { data } = await api.post('/api/charity/send-love')
    if (data?.ok) {
      toast.success('已送出爱心')
      await loadOverview()
    } else {
      toast.error(data?.error || '送出失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '送出失败')
  } finally {
    busy.value = false
  }
}

async function handleShare() {
  busy.value = true
  try {
    const { data } = await api.post('/api/charity/share')
    if (data?.ok) {
      if (data.data?.shared) {
        toast.success('每日分享成功')
      } else {
        toast.info(data.data?.reason || '当前不可分享')
      }
      await loadOverview()
    } else {
      toast.error(data?.error || '分享失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '分享失败')
  } finally {
    busy.value = false
  }
}

async function handleRunNow() {
  busy.value = true
  try {
    const { data } = await api.post('/api/charity/run-now')
    if (data?.ok) {
      const r = data.data || {}
      toast.success(`已执行: 领礼包 ${r.claimed ? '是' : '否'}, 送爱心 ${r.loved ? '是' : '否'}, 分享 ${r.shared ? '是' : '否'}`)
      await loadOverview()
    } else {
      toast.error(data?.error || '执行失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '执行失败')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await loadOverview()
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-4 p-4">
    <!-- 标题 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl text-gray-900 font-bold dark:text-white">
          公益小红花
        </h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          腾讯公益 · 领公益礼包 · 送出爱心 · 每日分享
        </p>
      </div>
      <div class="flex gap-2">
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadOverview">
          刷新
        </BaseButton>
        <BaseButton variant="primary" size="sm" :loading="busy" @click="handleRunNow">
          执行每日任务
        </BaseButton>
      </div>
    </div>

    <!-- 公益提示 -->
    <div class="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
      本活动为腾讯公益真实慈善项目（免费午餐·小善大爱），涉及真实公益金。活动规则要求由本人参与，请知悉相关风险后谨慎使用自动化。
    </div>

    <!-- 未开启提示 -->
    <div v-if="!active && !loading" class="rounded border border-yellow-300 bg-yellow-50 p-4 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200">
      活动未开启或已结束。
    </div>

    <template v-if="active && overview && overview.activity">
      <!-- 全服进度 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">
            全服爱心值进度
          </h3>
          <span class="text-xs text-gray-500 dark:text-gray-400">
            {{ fmtRange(overview.activity.startTime, overview.activity.endTime) }}
          </span>
        </div>
        <div class="mb-1 flex items-baseline justify-between text-sm">
          <span class="text-rose-600 font-semibold dark:text-rose-400">{{ fmtNum(overview.activity.serverLoveTotal || 0) }}</span>
          <span class="text-gray-500 dark:text-gray-400">目标 {{ fmtNum(overview.activity.serverTarget || 0) }}</span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
          <div class="h-full bg-rose-500 transition-all" :style="{ width: `${serverProgress}%` }" />
        </div>
        <div v-if="overview.activity.settlePack" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          全服达标结算礼包：{{ overview.activity.settlePack.name }} × {{ overview.activity.settlePack.count }}（单角色限领1次）
        </div>
      </div>

      <!-- 背包摘要 -->
      <div class="grid grid-cols-3 gap-3">
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">爱心值</div>
          <div class="mt-1 text-xl font-bold">{{ overview.bag.love }}</div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">小红花种子</div>
          <div class="mt-1 text-xl font-bold">{{ overview.bag.seed }}</div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">小红花(果实)</div>
          <div class="mt-1 text-xl font-bold">{{ overview.bag.fruit }}</div>
        </div>
      </div>

      <!-- 每日操作 -->
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <!-- 领取公益礼包 -->
        <div class="flex flex-col rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">领取公益礼包</h3>
          <p class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
            <template v-if="overview.activity.dailyGift?.id">
              {{ overview.activity.dailyGift.name }} × {{ overview.activity.dailyGift.count }}
            </template>
            <template v-else>每日收获小红花后可领取</template>
          </p>
          <BaseButton
            class="mt-3"
            variant="primary"
            size="sm"
            :disabled="busy || overview.activity.giftClaimed"
            :loading="busy"
            @click="handleClaimGift"
          >
            {{ overview.activity.giftClaimed ? '今日已领取' : '领取礼包' }}
          </BaseButton>
        </div>

        <!-- 送出爱心 -->
        <div class="flex flex-col rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">送出爱心</h3>
          <p class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
            捐赠爱心值为公益项目助力（活动结束后结算）
          </p>
          <BaseButton
            class="mt-3"
            variant="primary"
            size="sm"
            :disabled="busy || overview.activity.loveSent"
            :loading="busy"
            @click="handleSendLove"
          >
            {{ overview.activity.loveSent ? '今日已送出' : '送出爱心' }}
          </BaseButton>
        </div>

        <!-- 每日分享 -->
        <div class="flex flex-col rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">每日分享</h3>
          <p class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
            <template v-if="overview.activity.seedReward?.id">
              分享可得 {{ overview.activity.seedReward.name }} × {{ overview.activity.seedReward.count }}
            </template>
            <template v-else>分享获得小红花种子</template>
          </p>
          <BaseButton
            class="mt-3"
            variant="primary"
            size="sm"
            :disabled="busy"
            :loading="busy"
            @click="handleShare"
          >
            分享
          </BaseButton>
        </div>
      </div>

      <!-- 个人爱心值档位奖励 -->
      <div v-if="overview.activity.tiers && overview.activity.tiers.length" class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          个人爱心值档位奖励
        </h3>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
          <div
            v-for="t in overview.activity.tiers"
            :key="t.threshold"
            class="flex flex-col rounded border border-gray-200 p-3 text-sm dark:border-gray-700"
            :class="(overview.bag.love || 0) >= t.threshold
              ? 'bg-rose-50 dark:bg-rose-900/20'
              : 'bg-gray-50 dark:bg-gray-900/40'"
          >
            <span class="font-medium">达 {{ t.threshold }} 爱心值</span>
            <span class="mt-1 text-xs text-gray-600 dark:text-gray-400">
              {{ t.reward.name }} × {{ t.reward.count }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
