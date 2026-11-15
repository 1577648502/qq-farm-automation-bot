<script setup lang="ts">
import { computed } from 'vue'
import { useLandTypes } from '@/composables/useLandTypes'

/**
 * 一块地(或一棵合种作物)在棋盘上的显示。
 *
 * 这里只管**画**, 不管操作: 点击后由父级的 LandBoard 弹出操作面板。
 * 合种作物(2x2/4x4)是一棵植物占多块地, 后端已经把它合成为一块跨格大地
 * (副地块在 board.groupedSlaveIds 里, 不再单独渲染), 所以这里只需按格子的
 * 实际大小自适应排版。
 */
const props = defineProps<{
  land: any
  /** 这块地跨几行/几列(合种作物 > 1) */
  rowSpan?: number
  columnSpan?: number
}>()

const land = computed(() => props.land || {})
const spanRows = computed(() => Math.max(1, Number(props.rowSpan) || 1))
const spanCols = computed(() => Math.max(1, Number(props.columnSpan) || 1))

const plantSize = computed(() => Math.max(1, Number(land.value.plantSize) || 1))
const isGrouped = computed(() => spanRows.value > 1 || spanCols.value > 1 || plantSize.value > 1)

const mutationItems = computed(() => {
  const source = Array.isArray(land.value.mutations) ? land.value.mutations : []
  const items = source
    .map((mutation: any) => {
      const name = String(mutation?.name || '').trim()
      if (!name)
        return null
      return {
        name,
        label: formatMutationLabel(name),
        quality: mutation.quality || undefined,
        effect: mutation.effect || undefined,
        icon: mutation.icon || undefined,
        color: mutation.color || undefined,
        description: mutation.description || undefined,
      }
    })
    .filter(Boolean) as Array<{ name: string, label: string, quality?: string, effect?: string, icon?: string, color?: string, description?: string }>

  if (items.length === 0 && land.value.mutationType) {
    items.push({
      name: String(land.value.mutationType),
      label: formatMutationLabel(land.value.mutationType),
      quality: land.value.mutationQuality || undefined,
      effect: land.value.mutationEffect || undefined,
      icon: land.value.mutationIcon || undefined,
      color: land.value.mutationColor || undefined,
      description: land.value.mutationDescription || undefined,
    })
  }
  if (items.length === 0 && land.value.isGolden)
    items.push({ name: '黄金', label: '黄金变异', effect: '黄金果实', icon: '⭐', color: '#FF6B35' })
  return items
})

function formatMutationLabel(value: any) {
  const t = String(value || '').trim()
  if (!t)
    return '变异'
  if (t === '变异')
    return '变异(类型待识别)'
  if (t.startsWith('变异'))
    return t
  const base = t.includes('_') ? t.split('_')[0] : t
  return `${base}变异`
}

function getMutationQualityClass(quality?: string) {
  if (quality === '天工')
    return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300'
  if (quality === '珍品')
    return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
  if (quality === '稀有')
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
  return 'bg-gray-200/80 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

function getMutationQualityLabel(quality?: string) {
  return quality === '未知' ? '待确认' : quality
}

const growProgress = computed(() => {
  const matureInSec = Number(land.value.matureInSec) || 0
  const totalGrowTime = Number(land.value.totalGrowTime) || 0
  if (totalGrowTime <= 0 || matureInSec <= 0)
    return 0
  return Math.min(100, Math.max(0, (matureInSec / totalGrowTime) * 100))
})

// 土地等级只在这里映射"底色/角标"(纯前端样式); **等级名称**统一从
// useLandTypes 取(后端 land-types.js 是唯一来源), 不再本地抄一份名字。
const LAND_LEVEL_STYLES: Array<{ cls: string, dot?: string }> = [
  { cls: 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700' },
  { cls: 'bg-yellow-50/80 dark:bg-yellow-900/10 border-yellow-200 dark:border-yellow-800' },
  { cls: 'bg-red-50/80 dark:bg-red-900/10 border-red-200 dark:border-red-800' },
  { cls: 'bg-slate-100 dark:bg-slate-800 border-slate-400 dark:border-slate-500' },
  { cls: 'bg-amber-100/80 dark:bg-amber-900/20 border-amber-300 dark:border-amber-600' },
  { cls: 'bg-fuchsia-100/80 dark:bg-fuchsia-900/20 border-fuchsia-300 dark:border-fuchsia-600', dot: 'text-fuchsia-500' },
  { cls: 'bg-sky-100/80 dark:bg-sky-900/20 border-sky-300 dark:border-sky-600', dot: 'text-sky-500' },
]

const { getLandLevelName } = useLandTypes()

function getLandLevelStyle(level: any) {
  const idx = Math.min(Math.max(Number(level) || 0, 0), LAND_LEVEL_STYLES.length - 1)
  return LAND_LEVEL_STYLES[idx]!
}

function getLandStatusClass(l: any) {
  const status = l.status

  if (status === 'locked')
    return 'bg-gray-100 dark:bg-gray-800 opacity-60 border-dashed'
  if (status === 'dead')
    return 'bg-gray-200 dark:bg-gray-700 border-gray-300 dark:border-gray-600 grayscale'

  const baseClass = getLandLevelStyle(l.level).cls
  if (status === 'harvestable')
    return `${baseClass} ring-2 ring-yellow-500 ring-offset-1 dark:ring-offset-gray-900`
  if (status === 'stealable')
    return `${baseClass} ring-2 ring-purple-500 ring-offset-1 dark:ring-offset-gray-900`
  return baseClass
}

function formatTime(sec: number) {
  if (sec <= 0)
    return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h > 0 ? `${h}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function getSafeImageUrl(url: string) {
  if (!url)
    return ''
  if (url.startsWith('http://'))
    return url.replace('http://', 'https://')
  return url
}

function getLandTypeName(level: number) {
  return getLandLevelName(level)
}

const statusText = computed(() => {
  const l = land.value
  if (l.status === 'locked')
    return '未解锁'
  if (l.matureInSec > 0)
    return `预计 ${formatTime(l.matureInSec)} 后成熟`
  if (l.status === 'harvestable')
    return '可收获'
  if (l.status === 'dead')
    return '已枯萎'
  return l.phaseName || '空地'
})

/** 缺什么(缺水/草/虫/可收/枯), 用来在地块上直接标出来, 不需要点开才知道 */
const alerts = computed(() => {
  const l = land.value
  const list: Array<{ key: string, label: string, icon: string, tone: string }> = []
  if (l.status === 'harvestable')
    list.push({ key: 'harvest', label: '可收', icon: 'i-carbon-wheat', tone: 'bg-amber-500/90 text-white' })
  if (l.needWater)
    list.push({ key: 'water', label: '缺水', icon: 'i-carbon-rain-drop', tone: 'bg-sky-500/90 text-white' })
  if (l.needWeed)
    list.push({ key: 'weed', label: '有草', icon: 'i-carbon-clean', tone: 'bg-emerald-500/90 text-white' })
  if (l.needBug)
    list.push({ key: 'bug', label: '有虫', icon: 'i-carbon-warning-alt', tone: 'bg-rose-500/90 text-white' })
  if (l.status === 'dead')
    list.push({ key: 'dead', label: '枯萎', icon: 'i-carbon-close-outline', tone: 'bg-gray-500/90 text-white' })
  return list
})
</script>

<template>
  <div
    class="land-tile group relative flex flex-col items-center overflow-hidden border rounded-lg p-1.5 transition-colors sm:rounded-xl sm:p-2"
    :class="[getLandStatusClass(land), alerts.length ? 'land-tile--active' : '', isGrouped ? 'land-tile--grouped' : 'justify-center']"
  >
    <!-- 左上: 地块编号(合种作物标出整组 ID) -->
    <div class="absolute left-1 top-1 text-[10px] text-gray-400 font-mono">
      #{{ land.id }}<span v-if="isGrouped" class="ml-0.5 text-pink-500">组</span>
    </div>

    <!-- 右上: 合种标识 -->
    <div
      v-if="isGrouped"
      class="absolute right-1 top-1 rounded bg-pink-100 px-1 py-0.5 text-[10px] text-pink-700 dark:bg-pink-900/30 dark:text-pink-300"
    >
      {{ spanCols }}x{{ spanRows }}
    </div>

    <!-- 作物图标: 合种大地可以放得更显眼 -->
    <div
      class="mb-0.5 mt-3 h-8 w-8 flex shrink-0 items-center justify-center sm:mb-1 sm:mt-4 sm:h-10 sm:w-10"
      :class="isGrouped ? 'h-10 w-10 sm:h-14 sm:w-14' : ''"
    >
      <img
        v-if="land.seedImage"
        :src="getSafeImageUrl(land.seedImage)"
        class="max-h-full max-w-full object-contain"
        loading="lazy"
        referrerpolicy="no-referrer"
        alt=""
      >
      <div v-else class="i-carbon-sprout text-xl text-gray-300" />
    </div>

    <div class="w-full truncate px-1 text-center text-xs font-bold" :class="isGrouped ? 'sm:text-sm' : ''" :title="land.plantName">
      {{ land.plantName || (land.status === 'locked' ? '未解锁' : '-') }}
    </div>

    <div class="mb-0.5 mt-0.5 w-full text-center text-[10px] text-gray-500">
      <span :class="land.matureInSec > 0 ? 'text-orange-500' : ''">{{ statusText }}</span>
    </div>

    <div v-if="land.matureInSec > 0 && land.totalGrowTime > 0" class="w-full shrink-0 px-1">
      <div class="rainbow-progress-bar">
        <div class="rainbow-progress-fill" :style="{ width: `${growProgress}%` }" />
      </div>
    </div>

    <div class="text-[10px] text-gray-400">
      {{ getLandTypeName(land.level) }}
      <span
        v-if="getLandLevelStyle(land.level).dot"
        class="ml-0.5"
        :class="getLandLevelStyle(land.level).dot"
        :title="getLandTypeName(land.level)"
      >&#9670;</span>
    </div>

    <div v-if="mutationItems.length" class="mt-1 w-full text-[10px] space-y-1">
      <div
        v-for="item in mutationItems"
        :key="`${item.name}-${item.effect || ''}`"
        class="min-w-0 leading-tight"
        :title="item.description || `${item.label}${item.effect ? ` · ${item.effect}` : ''}`"
      >
        <div class="min-w-0 flex items-center justify-center gap-1">
          <span class="shrink-0" :style="{ color: item.color || '#6B7280' }" aria-hidden="true">{{ item.icon || '?' }}</span>
          <span class="min-w-0 truncate text-gray-700 font-semibold dark:text-gray-200">{{ item.label }}</span>
          <span
            v-if="item.quality && item.quality !== '无'"
            class="shrink-0 rounded px-1 font-medium"
            :class="getMutationQualityClass(item.quality)"
          >
            {{ getMutationQualityLabel(item.quality) }}
          </span>
        </div>
      </div>
    </div>

    <div class="mb-1 text-[10px] text-gray-400">
      季数 {{ land.totalSeason > 0 ? `${land.currentSeason}/${land.totalSeason}` : '-/-' }}
    </div>

    <!-- 待办标记: 让用户一眼看到哪块地要处理, 不用挨个点开 -->
    <div v-if="alerts.length" class="mt-auto flex flex-wrap items-center justify-center gap-0.5 pb-0.5">
      <span
        v-for="alert in alerts"
        :key="alert.key"
        class="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium"
        :class="alert.tone"
      >
        <i :class="alert.icon" class="text-[10px]" aria-hidden="true" />
        {{ alert.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.land-tile--active {
  box-shadow: 0 0 0 2px rgb(251 191 36 / 0.55);
}

/* 合种大地: 内容整体铺开, 待办标记贴底, 不要因为格子突然变高就挤成一坨 */
.land-tile--grouped {
  justify-content: space-evenly;
  padding-top: 1.25rem;
}

.rainbow-progress-bar {
  width: 80%;
  margin: 0 auto;
  height: 6px;
  background: linear-gradient(145deg, #f0f0f0, #e6e6e6);
  border-radius: 10px;
  overflow: hidden;
  box-shadow:
    inset 2px 2px 4px rgba(0, 0, 0, 0.1),
    inset -2px -2px 4px rgba(255, 255, 255, 0.9);
  position: relative;
}

.rainbow-progress-bar::before {
  content: '';
  position: absolute;
  top: 1px;
  left: 2px;
  right: 2px;
  height: 2px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.2));
  border-radius: 10px 10px 0 0;
  pointer-events: none;
}

.rainbow-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #ff6b9d 0%, #ff9f43 20%, #ffd32a 40%, #26de81 60%, #45aaf2 80%, #a55eea 100%);
  border-radius: 10px;
  transition: width 1s linear;
  position: relative;
}

@media (prefers-reduced-motion: reduce) {
  .rainbow-progress-fill {
    transition: none;
    animation: none;
  }
}

@media (prefers-color-scheme: dark) {
  .rainbow-progress-bar {
    background: linear-gradient(145deg, #2a2a2a, #1e1e1e);
    box-shadow:
      inset 2px 2px 4px rgba(0, 0, 0, 0.3),
      inset -2px -2px 4px rgba(60, 60, 60, 0.3);
  }
}
</style>
