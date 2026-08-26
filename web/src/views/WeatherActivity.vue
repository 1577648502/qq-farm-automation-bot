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

interface ShopGoods {
  id: number
  name: string
  item: RewardItem
  cost: RewardItem
  purchaseLimit: number
  purchasedCount: number
  remaining: number
}

interface DailyTask {
  id: number
  name: string
  targetItemId: number
  targetCount: number
  reward: RewardItem
}

interface ResearchTier {
  tierId: number
  state: number
  upgradable: boolean
  upgraded: boolean
  cost: RewardItem
  reward: RewardItem
}

interface WeatherOverview {
  updatedAt: number
  weather: {
    type: number
    typeName: string
    beginTime: number
    endTime: number
    isThunder: boolean
  } | null
  activity: {
    groupId: number
    name: string
    startTime: number
    endTime: number
    shop: { goods: ShopGoods[] } | null
    taskProgress: {
      current: number
      target: number
      itemId: number
      stage: number
      stageReward: RewardItem | null
    } | null
    dailyTasks: { tasks: DailyTask[] } | null
    research: {
      currentTier: number
      tiers: ResearchTier[]
    } | null
  } | null
  bag: {
    collectBottle: number
    thunderBottle: number
    thunderBadge: number
    goldBean: number
  }
}

interface Friend {
  gid: number
  name: string
}

const toast = useToastStore()
const loading = ref(false)
const overview = ref<WeatherOverview | null>(null)
const friends = ref<Friend[]>([])
const selectedFriendGid = ref<number | ''>('')
const buyCount = ref(1)
const busy = ref(false)

const weatherActive = computed(() => !!overview.value?.activity)

function fmtTime(sec: number) {
  if (!sec) return '-'
  const d = new Date(sec * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtRange(begin: number, end: number) {
  return `${fmtTime(begin)} ~ ${fmtTime(end)}`
}

function extractError(e: any): string {
  return e?.response?.data?.error || e?.message || ''
}

async function loadOverview() {
  loading.value = true
  try {
    const { data } = await api.get('/api/weather/overview')
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

async function loadFriends() {
  try {
    const { data } = await api.get('/api/friends')
    if (data?.ok && Array.isArray(data.data)) {
      friends.value = data.data.map((f: any) => ({ gid: Number(f.gid), name: String(f.name || f.gid) }))
    }
  } catch {}
}

async function handleBuyBottle() {
  const count = Math.max(1, Math.floor(Number(buyCount.value) || 1))
  busy.value = true
  try {
    const { data } = await api.post('/api/weather/buy-bottle', { count })
    if (data?.ok) {
      toast.success(`购买成功 x${count}`)
      await loadOverview()
    } else {
      toast.error(data?.error || '购买失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '购买失败')
  } finally {
    busy.value = false
  }
}

async function handleUseOnFriend() {
  if (!selectedFriendGid.value) {
    toast.error('请先选择好友')
    return
  }
  busy.value = true
  try {
    const { data } = await api.post('/api/weather/use-on-friend', { friendUid: selectedFriendGid.value })
    if (data?.ok) {
      toast.success('已对好友使用采集瓶')
      await loadOverview()
    } else {
      toast.error(data?.error || '使用失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '使用失败')
  } finally {
    busy.value = false
  }
}

async function handleUseThunder() {
  busy.value = true
  try {
    const { data } = await api.post('/api/weather/use-thunder')
    if (data?.ok) {
      toast.success('已使用雷雨召唤瓶')
      await loadOverview()
    } else {
      toast.error(data?.error || '使用失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '使用失败')
  } finally {
    busy.value = false
  }
}

async function handleUpgradeResearch(tierId: number) {
  busy.value = true
  try {
    const { data } = await api.post('/api/weather/upgrade-research', { tierId })
    if (data?.ok) {
      toast.success(`档位 ${tierId} 奖励已领取`)
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

async function handleRunTasksNow() {
  busy.value = true
  try {
    const { data } = await api.post('/api/weather/run-now')
    if (data?.ok) {
      const r = data.data || {}
      toast.success(`已执行: 购买 ${r.bought || 0}, 好友使用 ${r.usedOnFriends || 0}, 雷雨瓶 ${r.thunderUsed || 0}`)
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

async function handleRunResearchNow() {
  busy.value = true
  try {
    const { data } = await api.post('/api/weather/run-research')
    if (data?.ok) {
      const r = data.data || {}
      const cnt = (r.upgraded || r.claimed || []).length
      toast.success(cnt > 0 ? `已领取 ${cnt} 档达标奖励` : '当前无可领取的达标奖励')
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
  await loadFriends()
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-4 p-4">
    <!-- 标题 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl text-gray-900 font-bold dark:text-white">
          雨落成诗
        </h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          天气活动 · 采集瓶 · 雷雨召唤 · 气象研究
        </p>
      </div>
      <div class="flex gap-2">
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadOverview">
          刷新
        </BaseButton>
        <BaseButton variant="primary" size="sm" :loading="busy" @click="handleRunTasksNow">
          执行每日自动化
        </BaseButton>
      </div>
    </div>

    <!-- 未开启提示 -->
    <div v-if="!weatherActive && !loading" class="rounded border border-yellow-300 bg-yellow-50 p-4 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200">
      活动未开启或已结束。
    </div>

    <template v-if="weatherActive && overview">
      <!-- 天气状态 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div class="text-sm text-gray-500 dark:text-gray-400">
              当前天气
            </div>
            <div class="mt-1 flex items-baseline gap-3">
              <span class="text-xl font-bold" :class="overview.weather?.isThunder ? 'text-purple-600 dark:text-purple-400' : 'text-blue-600 dark:text-blue-400'">
                {{ overview.weather?.typeName || '未知' }}
              </span>
              <span v-if="overview.weather" class="text-xs text-gray-500 dark:text-gray-400">
                {{ fmtRange(overview.weather.beginTime, overview.weather.endTime) }}
              </span>
            </div>
          </div>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="overview.bag.thunderBottle <= 0 || busy || overview.weather?.isThunder"
            :loading="busy"
            @click="handleUseThunder"
          >
            <template v-if="overview.weather?.isThunder">已是雷雨天气，无需召唤</template>
            <template v-else>对自己使用雷雨召唤瓶（背包 {{ overview.bag.thunderBottle }}）</template>
          </BaseButton>
        </div>
      </div>

      <!-- 背包摘要 -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            天气采集瓶
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ overview.bag.collectBottle }}
          </div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            雷雨召唤瓶
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ overview.bag.thunderBottle }}
          </div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            雷电徽章
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ overview.bag.thunderBadge }}
          </div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            金豆豆
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ overview.bag.goldBean }}
          </div>
        </div>
      </div>

      <!-- 任务进度 -->
      <div v-if="overview.activity?.taskProgress" class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">
            采集瓶累计进度
          </h3>
          <span class="text-sm">
            {{ overview.activity.taskProgress.current }} / {{ overview.activity.taskProgress.target }}
          </span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
          <div
            class="h-full bg-blue-500 transition-all"
            :style="{ width: `${Math.min(100, (overview.activity.taskProgress.current / Math.max(1, overview.activity.taskProgress.target)) * 100)}%` }"
          />
        </div>
        <div v-if="overview.activity.taskProgress.stageReward" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          阶段奖励：{{ overview.activity.taskProgress.stageReward.name }} × {{ overview.activity.taskProgress.stageReward.count }}
        </div>
      </div>

      <!-- 商店 -->
      <div v-if="overview.activity?.shop" class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          天气商店
        </h3>
        <div v-for="g in overview.activity.shop.goods" :key="g.id" class="mb-2 flex items-center justify-between rounded border border-gray-200 p-3 dark:border-gray-700">
          <div>
            <div class="font-medium">
              {{ g.name || g.item.name || `物品 #${g.item.id}` }}
            </div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              消耗：{{ g.cost.name || `#${g.cost.id}` }} × {{ g.cost.count }} · 剩余 {{ g.remaining }}/{{ g.purchaseLimit }}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <input
              v-model.number="buyCount"
              type="number"
              min="1"
              :max="g.remaining || 1"
              class="w-16 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
            >
            <BaseButton
              variant="primary"
              size="sm"
              :disabled="g.remaining <= 0 || busy"
              :loading="busy"
              @click="handleBuyBottle"
            >
              购买
            </BaseButton>
          </div>
        </div>
      </div>

      <!-- 对好友使用采集瓶 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          对好友使用天气采集瓶
        </h3>
        <div class="flex flex-wrap items-center gap-2">
          <select
            v-model="selectedFriendGid"
            class="min-w-48 flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
          >
            <option value="">
              选择好友…
            </option>
            <option v-for="f in friends" :key="f.gid" :value="f.gid">
              {{ f.name }} ({{ f.gid }})
            </option>
          </select>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="!selectedFriendGid || overview.bag.collectBottle <= 0 || busy"
            :loading="busy"
            @click="handleUseOnFriend"
          >
            使用采集瓶
          </BaseButton>
        </div>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          背包剩余采集瓶：{{ overview.bag.collectBottle }} 个
        </p>
      </div>

      <!-- 每日任务列表 -->
      <div v-if="overview.activity?.dailyTasks" class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          每日任务（奖励自动发放）
        </h3>
        <div v-for="t in overview.activity.dailyTasks.tasks" :key="t.id" class="mb-2 flex items-center justify-between border-b border-gray-100 py-2 last:border-b-0 dark:border-gray-700">
          <div>
            <div class="text-sm">
              {{ t.name }}
            </div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              目标数量：{{ t.targetCount || 1 }}
            </div>
          </div>
          <div class="text-xs text-gray-500 dark:text-gray-400">
            奖励：{{ t.reward.name || `#${t.reward.id}` }} × {{ t.reward.count }}
          </div>
        </div>
      </div>

      <!-- 气象研究 -->
      <div v-if="overview.activity?.research" class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">
            气象研究（雷电徽章达标领奖）
          </h3>
          <BaseButton variant="secondary" size="sm" :loading="busy" @click="handleRunResearchNow">
            一键领取
          </BaseButton>
        </div>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div
            v-for="t in overview.activity.research.tiers"
            :key="t.tierId"
            class="flex flex-col rounded border p-3 text-sm"
            :class="t.upgraded
              ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/30'
              : t.upgradable
                ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/30'
                : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40'"
          >
            <div class="flex items-center justify-between">
              <span class="font-medium">档位 {{ t.tierId }}</span>
              <span class="text-xs">
                <template v-if="t.upgraded">已领取</template>
                <template v-else-if="t.upgradable">可领取</template>
                <template v-else>未达标</template>
              </span>
            </div>
            <div class="mt-1 text-xs text-gray-600 dark:text-gray-400">
              达标需 {{ t.cost.count }} 雷电徽章
            </div>
            <div class="text-xs text-gray-600 dark:text-gray-400">
              奖励 {{ t.reward.name || `#${t.reward.id}` }} × {{ t.reward.count }}
            </div>
            <BaseButton
              v-if="t.upgradable"
              class="mt-2"
              variant="primary"
              size="sm"
              :disabled="overview.bag.thunderBadge < t.cost.count || busy"
              :loading="busy"
              @click="handleUpgradeResearch(t.tierId)"
            >
              {{ overview.bag.thunderBadge < t.cost.count ? `徽章不足 (${overview.bag.thunderBadge}/${t.cost.count})` : '领取' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
