<script setup lang="ts">
/**
 * 牧歌初启(2026-11-17 新活动) —— 完成情况查看 + 手动领取
 *
 * 活动结构(4 个子活动):
 *   1702 全服饲养重量档位(cmd=85)  1703 邀请好友助力(cmd=84)
 *   1704 活动任务(cmd=82)          1705 分享任务(cmd=86/87/89)
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import api from '@/api'
import { useToastStore } from '@/stores/toast'
import LoadingState from '@/components/ui/LoadingState.vue'

const accountStore = useAccountStore()
const toast = useToastStore()
const currentAccountId = computed(() => accountStore.currentAccountId)

const loading = ref(false)
const claiming = ref(false)
const error = ref('')
const data = ref<any>(null)

const STATUS_LABEL: Record<number, { text: string, cls: string }> = {
  0: { text: '未解锁', cls: 'text-gray-400' },
  1: { text: '未达标', cls: 'text-gray-500' },
  2: { text: '可领取', cls: 'text-amber-600 dark:text-amber-400 font-medium' },
  3: { text: '已领取', cls: 'text-green-600 dark:text-green-400' },
}

function statusOf(s: number) {
  return STATUS_LABEL[s] || { text: `状态${s}`, cls: 'text-gray-400' }
}

const claimableTotal = computed(() => {
  const s = data.value?.summary
  if (!s) return 0
  return (s.tiers?.claimable || 0) + (s.invites?.claimable || 0)
    + (s.tasks?.claimable || 0) + (data.value?.shares?.filter((x: any) => x.count > 0).length || 0)
})

async function refresh() {
  const id = currentAccountId.value
  if (!id) return
  loading.value = true
  error.value = ''
  try {
    const res = await api.get('/api/activity/muge', { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok) throw new Error(d?.error || '获取失败')
    data.value = d.data
    if (data.value?.error) error.value = data.value.error
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取失败'
  } finally {
    loading.value = false
  }
}

async function claimAll() {
  const id = currentAccountId.value
  if (!id) return
  claiming.value = true
  try {
    const res = await api.post('/api/activity/muge/claim', {}, { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok) throw new Error(d?.error || '领取失败')
    const r = d.data || {}
    const parts: string[] = []
    if (r.tiers) parts.push(`档位${r.tiers}`)
    if (r.invites) parts.push(`助力${r.invites}`)
    if (r.tasks) parts.push(`任务${r.tasks}`)
    if (r.shares) parts.push(`分享${r.shares}`)
    toast.success(parts.length ? `领取成功：${parts.join('，')}` : '没有可领取的奖励')
    await refresh()
  } catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '领取失败')
  } finally {
    claiming.value = false
  }
}

onMounted(refresh)
watch(currentAccountId, () => refresh())
</script>

<template>
  <div class="p-3 sm:p-4">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="i-carbon-music text-xl text-emerald-600" />
        <h2 class="text-lg font-bold">牧歌初启</h2>
        <span v-if="data" class="text-xs text-gray-400">
          可领 {{ claimableTotal }} 项
        </span>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
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
    <div v-else-if="error" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
      {{ error }}
    </div>
    <div v-else-if="data" class="space-y-4">
      <!-- 全服饲养重量档位 -->
      <section class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <div class="i-carbon-scale text-amber-600" />
          全服饲养重量档位
          <span v-if="data.totalWeight" class="text-xs text-gray-400 font-normal">
            全服 {{ data.totalWeight }}
          </span>
          <span v-if="data.summary?.tiers" class="ml-auto text-xs text-gray-400 font-normal">
            {{ data.summary.tiers.claimed }}/{{ data.summary.tiers.total }} 已领
          </span>
        </h3>
        <div class="grid gap-1.5 2xl:grid-cols-3 md:grid-cols-2 sm:grid-cols-2">
          <div
            v-for="t in data.tiers"
            :key="t.seq"
            class="flex items-center justify-between rounded border border-gray-100 px-2 py-1.5 text-xs dark:border-gray-700"
          >
            <span class="text-gray-600 dark:text-gray-300">档位 {{ t.seq }} · 需 {{ t.requiredWeight }}</span>
            <span :class="statusOf(t.status).cls">{{ statusOf(t.status).text }}</span>
          </div>
        </div>
      </section>

      <!-- 活动任务 -->
      <section class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <div class="i-carbon-task text-sky-600" />
          活动任务
          <span v-if="data.summary?.tasks" class="ml-auto text-xs text-gray-400 font-normal">
            {{ data.summary.tasks.claimed }}/{{ data.summary.tasks.total }} 已领
          </span>
        </h3>
        <div class="space-y-1.5">
          <div
            v-for="t in data.tasks"
            :key="t.seq"
            class="flex items-center justify-between rounded border border-gray-100 px-2 py-1.5 text-xs dark:border-gray-700"
          >
            <span class="text-gray-600 dark:text-gray-300">{{ t.desc || `任务${t.seq}` }}</span>
            <div class="flex items-center gap-2">
              <span class="text-gray-400">{{ t.progress }}/{{ t.target }}</span>
              <span :class="statusOf(t.status).cls">{{ statusOf(t.status).text }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 邀请助力 -->
      <section v-if="data.invites?.length" class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <div class="i-carbon-user-multiple text-violet-600" />
          邀请好友助力
          <span v-if="data.summary?.invites" class="ml-auto text-xs text-gray-400 font-normal">
            {{ data.summary.invites.claimed }}/{{ data.summary.invites.total }} 已领
          </span>
        </h3>
        <div class="grid gap-1.5 2xl:grid-cols-3 md:grid-cols-2 sm:grid-cols-2">
          <div
            v-for="t in data.invites"
            :key="t.seq"
            class="flex items-center justify-between rounded border border-gray-100 px-2 py-1.5 text-xs dark:border-gray-700"
          >
            <span class="text-gray-600 dark:text-gray-300">需 {{ t.required }} 人</span>
            <span :class="statusOf(t.status).cls">{{ statusOf(t.status).text }}</span>
          </div>
        </div>
      </section>

      <!-- 分享任务 -->
      <section v-if="data.shares?.length" class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <div class="i-carbon-share text-pink-600" />
          分享奖励
        </h3>
        <div class="grid gap-1.5 2xl:grid-cols-4 md:grid-cols-3 sm:grid-cols-3">
          <div
            v-for="t in data.shares"
            :key="t.seq"
            class="flex items-center justify-between rounded border border-gray-100 px-2 py-1.5 text-xs dark:border-gray-700"
          >
            <span class="text-gray-600 dark:text-gray-300">#{{ t.seq }}</span>
            <span :class="t.count > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-400'">
              {{ t.count > 0 ? '已分享' : '未完成' }}
            </span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
