<script setup lang="ts">
/**
 * 典藏室 —— 藏品陈列总览
 *
 * 数据来源:
 *   藏品/展台/进度 → 背包(type=35 藏品, type=34 展台, 3002 典藏收藏点)
 *   gamepb.collectionpb.CollectionService.GetCollections 目前只回空壳,
 *   仅作为"典藏室是否开放"的探测(页面上单独一行显示)
 *
 * 页面结构参考「公益小红花」「千星游记」: 顶部概览 → 系列卡片 → 展台/进度
 */
import { computed, ref } from 'vue'
import api from '@/api'

import BaseButton from '@/components/ui/BaseButton.vue'
import { usePageRefresh } from '@/composables/usePageRefresh'
import { useToastStore } from '@/stores/toast'

interface CollectionItem {
  id: number
  name: string
  desc: string
  image: string
  slot?: number
  count: number
  owned: boolean
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

interface CollectionOverview {
  updatedAt: number
  catalogTotal: number
  ownedTotal: number
  series: CollectionSeries[]
  extra: CollectionItem[]
  pedestals: Pedestal[]
  ownedPedestals: number
  points: { collection: number, normal: number }
  endpoint: { ok: boolean, skipped?: boolean, flag1?: number, text?: string, error?: string }
}

const toast = useToastStore()
const loading = ref(false)
const busy = ref(false)
const overview = ref<CollectionOverview | null>(null)

const fmtNum = (n: number) => (Number(n) || 0).toLocaleString('zh-CN')

const progress = computed(() => {
  const o = overview.value
  if (!o || !o.catalogTotal)
    return 0
  return Math.min(100, (o.ownedTotal / o.catalogTotal) * 100)
})

const endpointText = computed(() => {
  const e = overview.value?.endpoint
  if (!e || e.skipped)
    return '未探测'
  if (!e.ok)
    return `探测失败: ${e.error || '未知'}`
  return `已连通 (#1=${e.flag1 ?? 0}${e.text ? `, "${e.text}"` : ''})`
})

function extractError(e: any): string {
  return e?.response?.data?.error || e?.message || ''
}

async function loadOverview() {
  loading.value = true
  try {
    const { data } = await api.get('/api/collection/overview')
    if (data?.ok)
      overview.value = data.data
    else toast.error(data?.error || '加载失败')
  }
  catch (e: any) {
    toast.error(extractError(e) || '加载失败')
  }
  finally {
    loading.value = false
  }
}

/** 立即按限购买一次藏品礼包(顺便就把礼包开出来了) */
async function handleBuyPacks() {
  busy.value = true
  try {
    const { data } = await api.post('/api/mall/buy-limited-packs')
    if (data?.ok) {
      const d = data.data || {}
      if (d.bought > 0)
        toast.success(`已购买 ${d.bought} 个藏品礼包，开包 ${d.opened || 0} 个`)
      else toast.info(d.skipped || '已达限购上限，未购买')
      await loadOverview()
    }
    else {
      toast.error(data?.error || '购买失败')
    }
  }
  catch (e: any) {
    toast.error(extractError(e) || '购买失败')
  }
  finally {
    busy.value = false
  }
}

usePageRefresh('/collection', loadOverview)
</script>

<template>
  <div class="mx-auto max-w-5xl p-4 space-y-4">
    <!-- 标题 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl text-gray-900 font-bold dark:text-white">
          典藏室
        </h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          藏品陈列 · 限时藏品礼包 · 典藏进度
        </p>
      </div>
      <div class="flex gap-2">
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadOverview">
          刷新
        </BaseButton>
        <BaseButton variant="primary" size="sm" :loading="busy" @click="handleBuyPacks">
          买藏品礼包
        </BaseButton>
      </div>
    </div>

    <!-- 接口探测(GetCollections 目前只回空壳) -->
    <div class="border border-gray-200 rounded-lg bg-white p-3 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
      <span class="mr-2 text-gray-700 font-medium dark:text-gray-200">GetCollections 探测:</span>
      <span>{{ endpointText }}</span>
      <span class="ml-2 text-gray-400">（该接口暂未下发藏品明细，藏品数据取自背包 type=35 / 展台 type=34）</span>
    </div>

    <template v-if="overview">
      <!-- 概览 -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            已收藏款式
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ fmtNum(overview.ownedTotal) }}<span class="text-sm text-gray-400 font-normal"> / {{ fmtNum(overview.catalogTotal) }}</span>
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            典藏收藏点
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ fmtNum(overview.points.collection) }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            拥有展台
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ fmtNum(overview.ownedPedestals) }}<span class="text-sm text-gray-400 font-normal"> / {{ overview.pedestals.length }}</span>
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            普通收藏点
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ fmtNum(overview.points.normal) }}
          </div>
        </div>
      </div>

      <!-- 收集进度 -->
      <div class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex items-center justify-between text-sm">
          <span class="text-gray-900 font-medium dark:text-white">藏品收集进度</span>
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
        class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
      >
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">
            {{ s.name }}
          </h3>
          <span class="text-xs text-gray-500 dark:text-gray-400">
            已收集 {{ s.owned }} / {{ s.total }}
          </span>
        </div>
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <div
            v-for="it in s.items"
            :key="it.id"
            class="flex flex-col items-center border rounded p-2 text-center transition"
            :class="it.owned
              ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20'
              : 'border-gray-200 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-gray-900/40'"
            :title="`${it.name}｜${it.desc}`"
          >
            <img
              v-if="it.image"
              :src="it.image"
              :alt="it.name"
              class="h-12 w-12 object-contain"
              loading="lazy"
            >
            <div v-else class="i-carbon-image h-12 w-12 text-gray-300" />
            <div class="mt-1 w-full truncate text-xs text-gray-800 font-medium dark:text-gray-100">
              {{ it.name }}
            </div>
            <div class="text-[11px]" :class="it.owned ? 'text-amber-700 dark:text-amber-300' : 'text-gray-400'">
              {{ it.owned ? `×${it.count}` : '未收集' }}
            </div>
          </div>
        </div>
      </div>

      <!-- 目录未收录的藏品(配置同步滞后时兜底) -->
      <div v-if="overview.extra.length" class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          其他藏品
        </h3>
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <div
            v-for="it in overview.extra"
            :key="it.id"
            class="flex flex-col items-center border border-amber-300 rounded bg-amber-50 p-2 text-center dark:border-amber-700 dark:bg-amber-900/20"
          >
            <img v-if="it.image" :src="it.image" :alt="it.name" class="h-12 w-12 object-contain" loading="lazy">
            <div class="mt-1 w-full truncate text-xs font-medium">
              {{ it.name }}
            </div>
            <div class="text-[11px] text-amber-700 dark:text-amber-300">
              ×{{ it.count }}
            </div>
          </div>
        </div>
      </div>

      <!-- 展台 -->
      <div class="border border-gray-200 rounded-lg bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          藏品展台
        </h3>
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-5">
          <div
            v-for="p in overview.pedestals"
            :key="p.id"
            class="flex flex-col items-center border rounded p-2 text-center"
            :class="p.owned
              ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20'
              : 'border-gray-200 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-gray-900/40'"
            :title="p.desc"
          >
            <img v-if="p.image" :src="p.image" :alt="p.name" class="h-12 w-12 object-contain" loading="lazy">
            <div v-else class="i-carbon-image h-12 w-12 text-gray-300" />
            <div class="mt-1 w-full truncate text-xs text-gray-800 font-medium dark:text-gray-100">
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
      </div>
    </template>

    <div v-else-if="!loading" class="border border-yellow-300 rounded bg-yellow-50 p-4 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200">
      未取到典藏室数据（账号可能未运行）。
    </div>
  </div>
</template>
