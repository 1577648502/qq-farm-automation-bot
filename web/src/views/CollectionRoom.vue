<script setup lang="ts">
/**
 * 典藏室 —— 藏品陈列总览 + 展示/升星/评分奖励
 *
 * 数据来源(2026-11-07 抓包 20261107-155647_典藏室):
 *   CollectionService.GetCollections   → 藏品星级/激活/获得时间 + 当前展示位 + 评分
 *   CollectionService.UpgradeCollection → 升星(消耗背包里的同名精灵)
 *   CollectionService.SwitchSceneDisplay → 切换展示
 *   CollectionService.ClaimCollectionReward → 领评分奖励
 * 展台(type=34)与典藏收藏点(3002)仍在背包里, 由后端一并汇总。
 */
import { computed, ref } from 'vue'
import { usePageRefresh } from '@/composables/usePageRefresh'

import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useToastStore } from '@/stores/toast'

interface CollectionItem {
  id: number
  name: string
  desc: string
  image: string
  slot?: number
  owned: boolean
  activated: number
  star: number
  obtainedAt: number
  /** 背包里同名精灵数量 = 还能升几次星 */
  upgradable: number
}

interface CollectionSeries {
  series: number
  name: string
  total: number
  owned: number
  items: CollectionItem[]
}

interface Pedestal {
  id: number
  name: string
  desc: string
  image: string
  count: number
  owned: boolean
}

interface SceneDisplay { scene: number, slot: number, itemId: number, field3?: number }

interface CollectionOverview {
  updatedAt: number
  serverOk: boolean
  catalogTotal: number
  ownedTotal: number
  series: CollectionSeries[]
  extra: CollectionItem[]
  pedestals: Pedestal[]
  ownedPedestals: number
  points: { collection: number, normal: number }
  display: SceneDisplay | null
  displays: SceneDisplay[]
  score: { total: number, claimed: number, claimable: boolean }
}

const toast = useToastStore()
const loading = ref(false)
const busy = ref(false)
const running = ref(false)
const overview = ref<CollectionOverview | null>(null)

const fmtNum = (n: number) => (Number(n) || 0).toLocaleString('zh-CN')

function fmtTime(sec: number) {
  if (!sec) return '-'
  const d = new Date(sec * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function extractError(e: any): string {
  return e?.response?.data?.error || e?.message || ''
}

const progress = computed(() => {
  const o = overview.value
  if (!o || !o.catalogTotal) return 0
  return Math.min(100, (o.ownedTotal / o.catalogTotal) * 100)
})

const displayItem = computed(() => {
  const o = overview.value
  if (!o || !o.display || !o.display.itemId) return null
  const hit = o.series.flatMap(s => s.items).concat(o.extra as any[])
    .find((x: any) => Number(x.id) === Number(o.display!.itemId))
  return hit || null
})

const starText = (n: number) => (n > 0 ? '★'.repeat(Math.min(5, n)) : '未升星')

async function loadOverview() {
  loading.value = true
  try {
    const { data } = await api.get('/api/collection/overview')
    if (data?.ok) overview.value = data.data
    else toast.error(data?.error || '加载失败')
  }
  catch (e: any) {
    toast.error(extractError(e) || '加载失败')
  }
  finally {
    loading.value = false
  }
}

async function post(path: string, body: any = {}, okText?: string) {
  busy.value = true
  try {
    const { data } = await api.post(path, body)
    if (data?.ok) {
      if (okText) toast.success(okText)
      await loadOverview()
      return data.data
    }
    toast.error(data?.error || '操作失败')
    return null
  }
  catch (e: any) {
    toast.error(extractError(e) || '操作失败')
    return null
  }
  finally {
    busy.value = false
  }
}

/** 展示这一款 */
async function handleDisplay(item: CollectionItem) {
  await post('/api/collection/display', { itemId: item.id }, `已展示「${item.name}」`)
}

/** 升 1 星(消耗背包 1 个同名精灵) */
async function handleUpgrade(item: CollectionItem) {
  await post('/api/collection/upgrade', { itemId: item.id }, `「${item.name}」升星成功`)
}

async function handleClaim() {
  const r = await post('/api/collection/claim-reward')
  if (r) toast.success(`已领取评分奖励(覆盖到 ${r.claimedScore} 档)`)
}

/** 一键: 展示 → 升星 → 领评分奖励 */
async function handleRunAll() {
  running.value = true
  try {
    const { data } = await api.post('/api/collection/run', {})
    if (data?.ok) {
      const r = data.data || {}
      if (r.ok === false) {
        toast.error(r.reason || '执行失败')
      }
      else {
        const parts = []
        if (r.display) parts.push('已设置展示')
        if (r.upgraded?.length) parts.push(`升星 ${r.upgraded.length} 次`)
        if (r.claimed) parts.push('已领评分奖励')
        toast.success(parts.length ? parts.join('，') : (r.skipped?.[0] || '没有需要处理的'))
      }
      await loadOverview()
    }
    else {
      toast.error(data?.error || '执行失败')
    }
  }
  catch (e: any) {
    toast.error(extractError(e) || '执行失败')
  }
  finally {
    running.value = false
  }
}

usePageRefresh('/collection', loadOverview)
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-4 p-4">
    <!-- 标题 -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-2xl text-gray-900 font-bold dark:text-white">
          典藏室
        </h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          藏品陈列 · 升星 · 评分奖励
        </p>
      </div>
      <div class="flex gap-2">
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadOverview">
          刷新
        </BaseButton>
        <BaseButton variant="primary" size="sm" :loading="running" @click="handleRunAll">
          一键处理
        </BaseButton>
      </div>
    </div>

    <template v-if="overview">
      <!-- 服务器未连通提示 -->
      <div
        v-if="!overview.serverOk"
        class="rounded border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200"
      >
        未取到典藏室服务端数据(账号可能未运行)。下方星级/展示位信息不可用。
      </div>

      <!-- 概览 -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">已激活藏品</div>
          <div class="mt-1 text-xl font-bold">
            {{ fmtNum(overview.ownedTotal) }}<span class="text-sm font-normal text-gray-400"> / {{ fmtNum(overview.catalogTotal) }}</span>
          </div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">藏品评分</div>
          <div class="mt-1 text-xl font-bold">
            {{ fmtNum(overview.score.total) }}
            <span class="text-sm font-normal text-gray-400">已领 {{ fmtNum(overview.score.claimed) }}</span>
          </div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">典藏收藏点</div>
          <div class="mt-1 text-xl font-bold">
            {{ fmtNum(overview.points.collection) }}
          </div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">拥有展台</div>
          <div class="mt-1 text-xl font-bold">
            {{ fmtNum(overview.ownedPedestals) }}<span class="text-sm font-normal text-gray-400"> / {{ overview.pedestals.length }}</span>
          </div>
        </div>
      </div>

      <!-- 评分奖励 -->
      <div
        class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
        :class="overview.score.claimable
          ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'"
      >
        <div>
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">
            藏品评分奖励
          </h3>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            当前评分 {{ fmtNum(overview.score.total) }}，已领到 {{ fmtNum(overview.score.claimed) }}
            <span v-if="overview.score.claimable" class="ml-1 font-medium text-amber-700 dark:text-amber-300">有新的可领取</span>
          </p>
        </div>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="busy || !overview.score.claimable"
          :loading="busy"
          @click="handleClaim"
        >
          {{ overview.score.claimable ? '领取评分奖励' : '暂无可领' }}
        </BaseButton>
      </div>

      <!-- 当前展示 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">
            当前展示位
          </h3>
          <span class="text-xs text-gray-400">
            <template v-if="overview.display">
              场景 {{ overview.display.scene }} / 位 {{ overview.display.slot }}
            </template>
            <template v-else>未读取</template>
          </span>
        </div>
        <div v-if="displayItem" class="flex items-center gap-3">
          <img v-if="displayItem.image" :src="displayItem.image" :alt="displayItem.name" class="h-16 w-16 object-contain">
          <div>
            <div class="text-sm font-medium">{{ displayItem.name }}</div>
            <div class="text-xs text-amber-600 dark:text-amber-400">{{ starText((displayItem as any).star) }}</div>
          </div>
        </div>
        <div v-else class="text-xs text-gray-500 dark:text-gray-400">
          展示位为空。点下方任意藏品的「展示」即可摆上去。
        </div>
      </div>

      <!-- 收集进度 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex items-center justify-between text-sm">
          <span class="font-medium text-gray-900 dark:text-white">藏品收集进度</span>
          <span class="text-gray-500 dark:text-gray-400">{{ progress.toFixed(1) }}%</span>
        </div>
        <div class="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
          <div class="h-full bg-amber-500 transition-all" :style="{ width: `${progress}%` }" />
        </div>
      </div>

      <!-- 各系列 -->
      <div
        v-for="s in overview.series"
        :key="s.series"
        class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
      >
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">
            {{ s.name }}
          </h3>
          <span class="text-xs text-gray-500 dark:text-gray-400">
            已激活 {{ s.owned }} / {{ s.total }}
          </span>
        </div>
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <div
            v-for="it in s.items"
            :key="it.id"
            class="flex flex-col items-center rounded border p-2 text-center transition"
            :class="it.owned
              ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20'
              : 'border-gray-200 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-gray-900/40'"
            :title="`${it.name}｜${it.desc}｜获得 ${fmtTime(it.obtainedAt)}`"
          >
            <img
              v-if="it.image"
              :src="it.image"
              :alt="it.name"
              class="h-12 w-12 object-contain"
              loading="lazy"
            >
            <div v-else class="i-carbon-image h-12 w-12 text-gray-300" />
            <div class="mt-1 w-full truncate text-xs font-medium text-gray-800 dark:text-gray-100">
              {{ it.name }}
            </div>
            <div class="text-[11px]" :class="it.owned ? 'text-amber-700 dark:text-amber-300' : 'text-gray-400'">
              {{ it.owned ? starText(it.star) : '未激活' }}
            </div>
            <!-- 可升星(背包有同名精灵) -->
            <div v-if="it.owned && it.upgradable > 0" class="mt-1 flex w-full flex-col gap-1">
              <BaseButton
                variant="secondary"
                size="sm"
                :disabled="busy"
                @click="handleUpgrade(it)"
              >
                升星 (×{{ it.upgradable }})
              </BaseButton>
            </div>
            <BaseButton
              v-if="it.owned"
              class="mt-1 w-full"
              variant="text"
              size="sm"
              :disabled="busy"
              @click="handleDisplay(it)"
            >
              展示
            </BaseButton>
          </div>
        </div>
      </div>

      <!-- 目录未收录的藏品 -->
      <div v-if="overview.extra.length" class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          其他藏品
        </h3>
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <div
            v-for="it in overview.extra"
            :key="it.id"
            class="flex flex-col items-center rounded border border-amber-300 bg-amber-50 p-2 text-center dark:border-amber-700 dark:bg-amber-900/20"
          >
            <img v-if="it.image" :src="it.image" :alt="it.name" class="h-12 w-12 object-contain" loading="lazy">
            <div class="mt-1 w-full truncate text-xs font-medium">{{ it.name }}</div>
            <div class="text-[11px] text-amber-700 dark:text-amber-300">{{ starText(it.star) }}</div>
          </div>
        </div>
      </div>

      <!-- 展台 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          藏品展台
        </h3>
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-5">
          <div
            v-for="p in overview.pedestals"
            :key="p.id"
            class="flex flex-col items-center rounded border p-2 text-center"
            :class="p.owned
              ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20'
              : 'border-gray-200 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-gray-900/40'"
            :title="p.desc"
          >
            <img v-if="p.image" :src="p.image" :alt="p.name" class="h-12 w-12 object-contain" loading="lazy">
            <div v-else class="i-carbon-image h-12 w-12 text-gray-300" />
            <div class="mt-1 w-full truncate text-xs font-medium text-gray-800 dark:text-gray-100">
              {{ p.name }}
            </div>
            <div class="text-[11px]" :class="p.owned ? 'text-emerald-700 dark:text-emerald-300' : 'text-gray-400'">
              {{ p.owned ? (p.id === 610100 ? '默认' : `×${p.count}`) : '未拥有' }}
            </div>
          </div>
        </div>
      </div>

      <div class="text-center text-xs text-gray-400">
        更新于 {{ new Date(overview.updatedAt).toLocaleString('zh-CN') }}
        · 升星消耗背包里的同名精灵
      </div>
    </template>

    <div v-else-if="!loading" class="rounded border border-yellow-300 bg-yellow-50 p-4 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200">
      未取到典藏室数据（账号可能未运行）。
    </div>
  </div>
</template>