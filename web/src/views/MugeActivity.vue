<script setup lang="ts">
/**
 * 牧歌初启(2026-11-17 新活动) —— 完成情况查看 + 手动领取
 *
 * 游戏内是 4 个子页面(活动说明原文):
 *   「本活动分为兴牧庆典、牧友同行、成长手册和牧场人格四大模块。」
 *
 * 页面 ↔ 协议数据:
 *   兴牧庆典  2026111702 全服饲养重量档位(tiers)
 *   成长手册  2026111704 里与牧场自身成长相关的任务
 *   牧友同行  2026111703 邀请助力(invites) + 2026111704 里好友互动相关任务
 *   牧场人格  2026111705 分享任务(shares)
 *
 * 用户要求: 成长手册要完整列出来; 其它页面能自动领奖就行。
 */
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import LoadingState from '@/components/ui/LoadingState.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const toast = useToastStore()
const currentAccountId = computed(() => accountStore.currentAccountId)

const loading = ref(false)
const claiming = ref(false)
const error = ref('')
const data = ref<any>(null)
const activePage = ref<'handbook' | 'festival' | 'friends' | 'persona'>('handbook')

/**
 * 状态语义(2026-11-19 抓包时间线定案):
 *   1 = 已开放、进行中(未达标)
 *   2 = 已完成、待领取
 *   3 = 已领取
 *   4 = 本批次尚未开放 —— 按天分批解锁, **与进度无关**
 *       (实测有 15/15、20/20 仍是 4; 到点整批 4→1)
 */
const STATUS_LABEL: Record<number, { text: string, cls: string }> = {
  0: { text: '未解锁', cls: 'text-gray-400' },
  1: { text: '进行中', cls: 'text-gray-500 dark:text-gray-400' },
  2: { text: '可领取', cls: 'text-amber-600 dark:text-amber-400 font-medium' },
  3: { text: '已领取', cls: 'text-green-600 dark:text-green-400' },
  4: { text: '未开放', cls: 'text-gray-300 dark:text-gray-600' },
}

function statusOf(s: number) {
  return STATUS_LABEL[s] || { text: `状态${s}`, cls: 'text-gray-400' }
}

/** 奖励文字 */
function rewardText(r: any) {
  if (!r)
    return '—'
  return itemName(r.id) + (r.count ? ` ×${r.count}` : '')
}

const ITEM_NAMES: Record<number, string> = {
  1007: '金券',
  1008: '松果币',
  1002: '点券',
  80021: '罐头(1h)',
  80022: '罐头(4h)',
  80023: '罐头(8h)',
  80024: '罐头(12h)',
  80031: '有机罐头(1h)',
  80032: '有机罐头(4h)',
  80033: '有机罐头(8h)',
  80034: '有机罐头(12h)',
}
function itemName(id: number) {
  return ITEM_NAMES[Number(id)] || `物品#${id}`
}

/**
 * 任务按页面分组。
 *
 * ⚠ 2026-11-20 修正(用户反馈"成长手册显示不全"):
 *   活动说明原文:「4. 成长手册：…完成牧场任务获取奖励」，而「3. 牧友同行：…
 *   拥有一定数量的已经开启牧场的好友，可以获得一定奖励」= **好友数量档位**，
 *   跟任务无关。所以 2026111704 的 24 条任务**全部属于成长手册**。
 *   之前按任务描述里有没有"好友/使坏"把 6 条分给牧友同行, 成长手册只剩 18 条。
 */
const tasksByModule = computed(() => {
  const tasks = data.value?.tasks || []
  return {
    growth: tasks,
    friend: [] as any[],
  }
})

/** 已完成(进度达标且已开放)数量 —— 用于成长手册的进度条 */
function doneCount(list: any[]) {
  return list.filter(t => Number(t.status) !== 4
    && Number(t.target) > 0 && Number(t.progress) >= Number(t.target)).length
}

/** 本批次尚未开放的数量(status=4, 与进度无关) */
function lockedCount(list: any[]) {
  return list.filter(t => Number(t.status) === 4).length
}

const claimableTotal = computed(() => {
  const s = data.value?.summary
  if (!s)
    return 0
  return (s.tiers?.claimable || 0) + (s.invites?.claimable || 0)
    + (s.tasks?.claimable || 0) + (s.growth?.claimable || 0)
    + (data.value?.shares?.filter((x: any) => Number(x.count) > 0).length || 0)
})

/** 成长值档位可领数(手册顶部领奖条) */
const growthClaimable = computed(() =>
  data.value?.growthTiers?.filter((t: any) => Number(t.status) === 2).length || 0)

async function refresh() {
  const id = currentAccountId.value
  if (!id)
    return
  loading.value = true
  error.value = ''
  try {
    const res = await api.get('/api/activity/muge', { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '获取失败')
    data.value = d.data
    if (data.value?.error)
      error.value = data.value.error
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取失败'
  }
  finally {
    loading.value = false
  }
}

async function claimAll() {
  const id = currentAccountId.value
  if (!id)
    return
  claiming.value = true
  try {
    const res = await api.post('/api/activity/muge/claim', {}, { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '领取失败')
    toast.success('已执行领取(四个子页面各领一次)')
    await refresh()
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '领取失败')
  }
  finally {
    claiming.value = false
  }
}

const PAGES = [
  { key: 'handbook', label: '成长手册', icon: 'i-carbon-notebook' },
  { key: 'festival', label: '兴牧庆典', icon: 'i-carbon-calendar-heat' },
  { key: 'friends', label: '牧友同行', icon: 'i-carbon-user-multiple' },
  { key: 'persona', label: '牧场人格', icon: 'i-carbon-user-avatar' },
] as const

onMounted(refresh)
watch(currentAccountId, () => refresh())
</script>

<template>
  <div class="p-3 sm:p-4">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="i-carbon-music text-xl text-emerald-600" />
        <h2 class="text-lg font-bold">
          牧歌初启
        </h2>
        <span v-if="data" class="text-xs text-gray-400">
          可领 {{ claimableTotal }} 项
        </span>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 disabled:opacity-50 dark:hover:bg-gray-700"
          :disabled="loading"
          @click="refresh"
        >
          <div class="i-carbon-renew" :class="{ 'animate-spin': loading }" />
          刷新
        </button>
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-emerald-500 rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white font-medium transition hover:bg-emerald-700 disabled:opacity-50"
          :disabled="claiming || loading"
          @click="claimAll"
        >
          <div class="i-carbon-gift" />
          {{ claiming ? '领取中…' : '一键领取' }}
        </button>
      </div>
    </div>

    <div v-if="!currentAccountId" class="py-12 text-center text-sm text-gray-400">
      请先选择账号
    </div>
    <LoadingState v-else-if="loading && !data" text="加载中…" />
    <div v-else-if="error" class="border border-red-200 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
      {{ error }}
    </div>
    <div v-else-if="data" class="space-y-3">
      <!-- 四个子页面切换 -->
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="p in PAGES"
          :key="p.key"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition"
          :class="activePage === p.key
            ? 'bg-emerald-600 text-white'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'"
          @click="activePage = p.key"
        >
          <div :class="p.icon" />
          {{ p.label }}
        </button>
      </div>

      <!-- ===== 成长手册(重点页面: 完整列出全部任务) ===== -->
      <section v-if="activePage === 'handbook'" class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <!-- 成长值档位奖励(游戏内手册顶部的领奖条): 完成任务攒成长值, 达标领档位奖励 -->
        <div v-if="data.growthTiers?.length" class="mb-3 border border-amber-200 rounded-lg bg-amber-50/60 p-3 dark:border-amber-800/50 dark:bg-amber-900/10">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <h4 class="flex items-center gap-1.5 text-sm text-amber-900 font-semibold dark:text-amber-200">
              <div class="i-carbon-progress-bar text-amber-600" />
              成长值奖励
            </h4>
            <span class="text-xs text-amber-700/90 dark:text-amber-300/90">
              当前 {{ data.growthValue }} 点 · 完成任务攒成长值，达标领奖励
            </span>
            <span v-if="growthClaimable" class="ml-auto rounded bg-amber-500 px-2 py-0.5 text-xs text-white">
              可领 {{ growthClaimable }} 档
            </span>
          </div>
          <div class="grid gap-1.5 2xl:grid-cols-4 md:grid-cols-2 sm:grid-cols-2">
            <div
              v-for="t in data.growthTiers"
              :key="t.seq"
              class="flex items-center justify-between border border-amber-100 rounded px-2 py-1.5 text-xs dark:border-amber-800/50"
            >
              <span class="text-gray-600 dark:text-gray-300">{{ t.requiredGrowth }} 点 · {{ rewardText(t.reward) }}</span>
              <span :class="statusOf(t.status).cls">{{ statusOf(t.status).text }}</span>
            </div>
          </div>
        </div>
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <h3 class="flex items-center gap-1.5 text-sm font-semibold">
            <div class="i-carbon-notebook text-emerald-600" />
            成长手册 · 牧场个人成长
          </h3>
          <span class="text-xs text-gray-400">
            已完成 {{ doneCount(tasksByModule.growth) }}/{{ tasksByModule.growth.length }}
          </span>
          <span v-if="lockedCount(tasksByModule.growth)" class="text-xs text-gray-300 dark:text-gray-600">
            · 未开放 {{ lockedCount(tasksByModule.growth) }}
          </span>
          <span class="ml-auto text-xs text-gray-400">
            共 {{ tasksByModule.growth.length }} 条任务 · 批次按天开放 · 奖励由「一键领取」自动领取
          </span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full whitespace-nowrap text-left text-xs">
            <thead class="border-b bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-700/50 dark:text-gray-400">
              <tr>
                <th class="px-2 py-1.5 font-medium">
                  任务
                </th>
                <th class="w-32 px-2 py-1.5 text-right font-medium">
                  进度
                </th>
                <th class="px-2 py-1.5 text-right font-medium">
                  奖励
                </th>
                <th class="w-20 px-2 py-1.5 text-center font-medium">
                  状态
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
              <tr
                v-for="t in tasksByModule.growth"
                :key="t.seq"
                class="hover:bg-gray-50 dark:hover:bg-gray-700/40"
                :class="{ 'opacity-60': Number(t.status) === 4 }"
              >
                <td class="px-2 py-1.5 text-gray-700 dark:text-gray-300">
                  {{ t.desc || `任务${t.seq}` }}
                </td>
                <td class="px-2 py-1.5 text-right text-gray-500 tabular-nums">
                  {{ t.progress }}/{{ t.target }}
                </td>
                <td class="px-2 py-1.5 text-right text-amber-600 dark:text-amber-400">
                  {{ rewardText(t.reward) }}
                </td>
                <td class="px-2 py-1.5 text-center" :class="statusOf(t.status).cls">
                  {{ statusOf(t.status).text }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ===== 兴牧庆典(全服饲养重量档位) ===== -->
      <section v-else-if="activePage === 'festival'" class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <div class="i-carbon-calendar-heat text-amber-600" />
          兴牧庆典 · 全服饲养
          <span v-if="data.totalWeight" class="text-xs text-gray-400 font-normal">
            全服 {{ data.totalWeight.toLocaleString() }}
          </span>
          <span class="ml-auto text-xs text-gray-400 font-normal">
            {{ data.summary?.tiers?.claimed }}/{{ data.summary?.tiers?.total }} 已领
          </span>
        </h3>
        <div class="grid gap-1.5 2xl:grid-cols-3 md:grid-cols-2 sm:grid-cols-2">
          <div
            v-for="t in data.tiers"
            :key="t.seq"
            class="flex items-center justify-between border border-gray-100 rounded px-2 py-1.5 text-xs dark:border-gray-700"
          >
            <span class="text-gray-600 dark:text-gray-300">档位 {{ t.seq }} · 需 {{ Number(t.requiredWeight).toLocaleString() }}</span>
            <span :class="statusOf(t.status).cls">{{ statusOf(t.status).text }}</span>
          </div>
        </div>
      </section>

      <!-- ===== 牧友同行(好友数量档位) =====
           活动说明原文:「拥有一定数量的已经开启牧场的好友，可以获得一定奖励，
           好友关系解除不影响已计数好友数量」—— 这里**没有任务**, 只有好友数量档位。 -->
      <section v-else-if="activePage === 'friends'" class="space-y-3">
        <div v-if="data.invites?.length" class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <div class="i-carbon-user-follow text-fuchsia-600" />
            好友数量档位
            <span class="ml-auto text-xs text-gray-400 font-normal">
              {{ data.summary?.invites?.claimed }}/{{ data.summary?.invites?.total }} 已领
            </span>
          </h3>
          <div class="grid gap-1.5 2xl:grid-cols-3 md:grid-cols-2 sm:grid-cols-2">
            <div
              v-for="t in data.invites"
              :key="t.seq"
              class="flex items-center justify-between border border-gray-100 rounded px-2 py-1.5 text-xs dark:border-gray-700"
            >
              <span class="text-gray-600 dark:text-gray-300">需 {{ t.required }} 人</span>
              <span :class="statusOf(t.status).cls">{{ statusOf(t.status).text }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ===== 牧场人格(分享) ===== -->
      <section v-else class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <div class="i-carbon-user-avatar text-pink-600" />
          牧场人格 · 分享
        </h3>
        <div v-if="data.shares?.length" class="grid gap-1.5 2xl:grid-cols-4 md:grid-cols-3 sm:grid-cols-3">
          <div
            v-for="t in data.shares"
            :key="t.seq"
            class="flex items-center justify-between border border-gray-100 rounded px-2 py-1.5 text-xs dark:border-gray-700"
          >
            <span class="text-gray-600 dark:text-gray-300">#{{ t.seq }}</span>
            <span :class="t.count > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-400'">
              {{ t.count > 0 ? '已完成' : '未完成' }}
            </span>
          </div>
        </div>
        <div v-else class="py-6 text-center text-xs text-gray-400">
          这一页面只有分享奖励，已由「一键领取」自动处理
        </div>
      </section>
    </div>
  </div>
</template>
