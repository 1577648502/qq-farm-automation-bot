<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'



const props = defineProps<{
  land: any
  seeds?: any[]
}>()
const emit = defineEmits<{ (e: 'operate', payload: { op: string, seedId?: number, fertilizerId?: number }): void }>()

type LandActionTone = 'water' | 'weed' | 'bug' | 'harvest' | 'fertilizer' | 'organic' | 'danger' | 'plant' | 'upgrade' | 'unlock'
interface LandAction {
  op: string
  label: string
  tip: string
  icon: string
  tone: LandActionTone
  fertilizerId?: number
}

const ACTION_TONE_CLASSES: Record<LandActionTone, string> = {
  water: 'border-sky-400/30 bg-sky-400/10 text-sky-600 hover:border-sky-400/70 hover:bg-sky-400/20 dark:text-sky-300',
  weed: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-600 hover:border-emerald-400/70 hover:bg-emerald-400/20 dark:text-emerald-300',
  bug: 'border-rose-400/30 bg-rose-400/10 text-rose-600 hover:border-rose-400/70 hover:bg-rose-400/20 dark:text-rose-300',
  harvest: 'border-amber-400/30 bg-amber-400/10 text-amber-600 hover:border-amber-400/70 hover:bg-amber-400/20 dark:text-amber-300',
  fertilizer: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-600 hover:border-cyan-400/70 hover:bg-cyan-400/20 dark:text-cyan-300',
  organic: 'border-lime-400/30 bg-lime-400/10 text-lime-600 hover:border-lime-400/70 hover:bg-lime-400/20 dark:text-lime-300',
  danger: 'border-red-400/30 bg-red-400/10 text-red-600 hover:border-red-400/70 hover:bg-red-400/20 dark:text-red-300',
  plant: 'border-green-400/30 bg-green-400/10 text-green-600 hover:border-green-400/70 hover:bg-green-400/20 dark:text-green-300',
  upgrade: 'border-violet-400/30 bg-violet-400/10 text-violet-600 hover:border-violet-400/70 hover:bg-violet-400/20 dark:text-violet-300',
  unlock: 'border-blue-400/30 bg-blue-400/10 text-blue-600 hover:border-blue-400/70 hover:bg-blue-400/20 dark:text-blue-300',
}

const ACTION_BUTTON_BASE = 'land-action-button font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40'

// 这块地能做哪些操作(按地块状态给)
const landActions = computed(() => {
  const l: any = land.value || {}
  const acts: LandAction[] = []
  if (l.status === 'locked') {
    acts.push({ op: 'unlock', label: '解锁', tip: '解锁这块地', icon: 'i-carbon-unlocked', tone: 'unlock' })
    return acts
  }
  if (l.needWater) acts.push({ op: 'water', label: '浇水', tip: '给这块地浇水', icon: 'i-carbon-rain-drop', tone: 'water' })
  if (l.needWeed) acts.push({ op: 'weed', label: '除草', tip: '清除这块地的杂草', icon: 'i-carbon-clean', tone: 'weed' })
  if (l.needBug) acts.push({ op: 'bug', label: '除虫', tip: '清除这块地的虫害', icon: 'i-carbon-warning-alt', tone: 'bug' })
  if (l.status === 'harvestable' || l.canHarvest) acts.push({ op: 'harvest', label: '收获', tip: '收获这块地', icon: 'i-carbon-wheat', tone: 'harvest' })
  if (l.plantName) {
    acts.push({ op: 'fertilize', label: '普通肥', tip: '给这块地施普通化肥', icon: 'i-carbon-chemistry', tone: 'fertilizer', fertilizerId: 1011 })
    acts.push({ op: 'fertilize', label: '有机肥', tip: '给这块地施有机化肥', icon: 'i-carbon-growth', tone: 'organic', fertilizerId: 1012 })
    acts.push({ op: 'clear', label: '铲除', tip: '铲除这块地的作物', icon: 'i-carbon-trash-can', tone: 'danger' })
  } else if (l.status !== 'locked') {
    acts.push({ op: 'plant', label: '种植', tip: '在这块地种下所选种子', icon: 'i-carbon-sprout', tone: 'plant' })
  }
  acts.push({ op: 'upgrade', label: '升级', tip: '升级这块地(消耗金币)', icon: 'i-carbon-upgrade', tone: 'upgrade' })
  return acts
})

function getActionButtonClass(action: LandAction) {
  return `${ACTION_BUTTON_BASE} ${ACTION_TONE_CLASSES[action.tone]}`
}

// 种植用的种子(取 seeds prop 的第一项为默认)
const pickedSeedId = ref<number>(0)
watchEffect(() => {
  const list = (props.seeds || []) as any[]
  if (!pickedSeedId.value && list.length) pickedSeedId.value = Number(list[0]?.goodsId || list[0]?.seedId || list[0]?.id) || 0
})
function doAction(act: LandAction) {
  emit('operate', {
    op: act.op,
    seedId: act.op === 'plant' ? pickedSeedId.value : undefined,
    fertilizerId: act.fertilizerId,
  })
}



const land = computed(() => props.land)
interface MutationDisplay {
  name: string
  label: string
  quality?: string
  effect?: string
  icon?: string
  color?: string
  description?: string
}

function formatMutationLabel(value: any) {
  const t = String(value || '').trim()
  if (!t)
    return '变异'
  if (t.startsWith('变异'))
    return t // 变异#14 等未识别枚举
  if (t === '变异')
    return '变异(类型待识别)'
  const base = t.includes('_') ? t.split('_')[0] : t // 黄金_天工 → 黄金 (与游戏显示一致)
  return `${base}变异`
}

const mutationItems = computed<MutationDisplay[]>(() => {
  const l: any = land.value || {}
  const source = Array.isArray(l.mutations) ? l.mutations : []
  const items = source
    .map((mutation: any): MutationDisplay | null => {
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
    .filter((mutation: MutationDisplay | null): mutation is MutationDisplay => !!mutation)

  if (items.length === 0 && l.mutationType) {
    items.push({
      name: String(l.mutationType),
      label: formatMutationLabel(l.mutationType),
      quality: l.mutationQuality || undefined,
      effect: l.mutationEffect || undefined,
      icon: l.mutationIcon || undefined,
      color: l.mutationColor || undefined,
      description: l.mutationDescription || undefined,
    })
  }
  if (items.length === 0 && l.isGolden) {
    items.push({ name: '黄金', label: '黄金变异', effect: '黄金果实', icon: '⭐', color: '#FF6B35' })
  }
  return items
})

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
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null



onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})



onUnmounted(() => {
  if (timer) {
    clearInterval(timer)
  }
})



const growProgress = computed(() => {
  const matureInSec = land.value.matureInSec || 0
  const totalGrowTime = land.value.totalGrowTime || 0

  

  if (totalGrowTime <= 0 || matureInSec <= 0) {
    return 0
  }

  

  const progress = Math.min(100, Math.max(0, (matureInSec / totalGrowTime) * 100))
  return progress
})



function getLandStatusClass(land: any) {
  const status = land.status
  const level = Number(land.level) || 0



  if (status === 'locked')
    return 'bg-gray-100 dark:bg-gray-800 opacity-60 border-dashed'



  let baseClass = 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'



  // 土地等级样式
  switch (level) {
    case 1: // 黄土地
      baseClass = 'bg-yellow-50/80 dark:bg-yellow-900/10 border-yellow-200 dark:border-yellow-800'
      break
    case 2: // 红土地
      baseClass = 'bg-red-50/80 dark:bg-red-900/10 border-red-200 dark:border-red-800'
      break
    case 3: // 黑土地
      baseClass = 'bg-slate-100 dark:bg-slate-800 border-slate-400 dark:border-slate-500'
      break
    case 4: // 金土地
      baseClass = 'bg-amber-100/80 dark:bg-amber-900/20 border-amber-300 dark:border-amber-600'
      break
    case 5: // 紫晶土地
      baseClass = 'bg-fuchsia-100/80 dark:bg-fuchsia-900/20 border-fuchsia-300 dark:border-fuchsia-600'
      break
  }



  // 状态叠加
  if (status === 'dead')
    return 'bg-gray-200 dark:bg-gray-700 border-gray-300 dark:border-gray-600 grayscale'



  if (status === 'harvestable')
    return `${baseClass} ring-2 ring-yellow-500 ring-offset-1 dark:ring-offset-gray-900`



  if (status === 'stealable')
    return `${baseClass} ring-2 ring-purple-500 ring-offset-1 dark:ring-offset-gray-900`



  if (status === 'growing')
    return baseClass



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
  const typeMap: Record<number, string> = {
    0: '普通',
    1: '黄土地',
    2: '红土地',
    3: '黑土地',
    4: '金土地',
    5: '紫晶土地',
  }
  return typeMap[Number(level) || 0] || ''
}
function getPlantSizeText(land: any) {
  const size = Number(land?.plantSize) || 1


  if (size <= 1)
    return ''
  return `${size}x${size}`
}
</script>



<template>
  <div
    class="land-card group relative min-h-[120px] sm:min-h-[140px] flex flex-col items-center border rounded-lg p-1.5 sm:p-2 transition dark:border-gray-700 hover:z-20 hover:shadow-md focus-within:z-20"
    :class="getLandStatusClass(land)"
  >
    <div class="absolute left-1 top-1 text-[10px] text-gray-400 font-mono">
      #{{ land.id }}
    </div>
    <div
      v-if="land.plantSize > 1"
      class="absolute right-1 top-1 rounded bg-pink-100 px-1 py-0.5 text-[10px] text-pink-700 dark:bg-pink-900/30 dark:text-pink-300"
    >
      合种 {{ getPlantSizeText(land) }}
    </div>
    <div class="mb-0.5 mt-3 sm:mb-1 sm:mt-4 h-8 w-8 sm:h-10 sm:w-10 flex items-center justify-center">
      <img
        v-if="land.seedImage"
        :src="getSafeImageUrl(land.seedImage)"
        class="max-h-full max-w-full object-contain"
        loading="lazy"
        referrerpolicy="no-referrer"
      >
      <div v-else class="i-carbon-sprout text-xl text-gray-300" />
    </div>



    <div class="w-full truncate px-1 text-center text-xs font-bold" :title="land.plantName">
      {{ land.plantName || '-' }}
    </div>



    <div class="mb-0.5 mt-0.5 w-full text-center text-[10px] text-gray-500">
      <span v-if="land.matureInSec > 0" class="text-orange-500">
        预计 {{ formatTime(land.matureInSec) }} 后成熟
      </span>
      <span v-else>
        {{ land.phaseName || (land.status === 'locked' ? '未解锁' : '未开垦') }}
      </span>
    </div>



    <div v-if="land.matureInSec > 0 && land.totalGrowTime > 0" class="w-full px-1">
      <div class="rainbow-progress-bar">
        <div 
          class="rainbow-progress-fill"
          :style="{ width: `${growProgress}%` }"
        />
      </div>
    </div>



    <!--    <div class="mb-1 text-[10px] text-gray-400"> -->
    <div class="text-[10px] text-gray-400">
      {{ getLandTypeName(land.level) }}
      <span v-if="Number(land.level) === 5" class="ml-0.5 text-fuchsia-500" title="紫晶土地">&#9670;</span>
    </div>



    <div
      v-if="mutationItems.length"
      class="mt-1 w-full text-[10px] space-y-1"
    >
      <div
        v-for="item in mutationItems"
        :key="`${item.name}-${item.effect || ''}`"
        class="min-w-0 leading-tight"
        :title="item.description || `${item.label}${item.effect ? ` · ${item.effect}` : ''}`"
      >
        <div class="flex min-w-0 items-center justify-center gap-1">
          <span class="shrink-0" :style="{ color: item.color || '#6B7280' }" aria-hidden="true">{{ item.icon || '?' }}</span>
          <span class="min-w-0 truncate font-semibold text-gray-700 dark:text-gray-200">{{ item.label }}</span>
          <span
            v-if="item.quality && item.quality !== '无'"
            class="shrink-0 rounded px-1 font-medium"
            :class="getMutationQualityClass(item.quality)"
          >
            {{ getMutationQualityLabel(item.quality) }}
          </span>
        </div>
        <div v-if="item.effect" class="mt-0.5 break-words text-center text-[9px] text-gray-600 dark:text-gray-300">
          {{ item.effect }}
        </div>
      </div>
    </div>
    <div class="mb-1 text-[10px] text-gray-400">
      季数 {{ land.totalSeason > 0 ? (`${land.currentSeason}/${land.totalSeason}`) : '-/-' }}
    </div>



    <!-- Status Badges -->
    <div class="mt-auto flex origin-bottom scale-85 sm:scale-90 gap-0.5 text-[9px] sm:text-[10px]">
      <span v-if="land.needWater" class="rounded bg-blue-100 px-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">水</span>
      <span v-if="land.needWeed" class="rounded bg-green-100 px-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">草</span>
      <span v-if="land.needBug" class="rounded bg-red-100 px-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-400">虫</span>
      <!-- For friends view -->
      <span v-if="land.status === 'harvestable'" class="rounded bg-orange-100 px-0.5 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">可偷</span>
    </div>

    <div class="land-action-hint" aria-hidden="true">
      <div class="i-carbon-settings-adjust text-sm" />
    </div>

    <!-- 单地块操作 -->
    <div class="land-action-dock">
      <div v-if="landActions.some(a => a.op === 'plant')" class="mb-1.5">
        <select
          v-model.number="pickedSeedId"
          class="land-seed-select"
          aria-label="选择种植种子"
          title="选择种植种子"
          @click.stop
        >
          <option v-for="sd in (seeds || [])" :key="sd.goodsId || sd.seedId || sd.id" :value="Number(sd.goodsId || sd.seedId || sd.id)">
            {{ sd.name || ('#' + (sd.goodsId || sd.seedId || sd.id)) }}
          </option>
        </select>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-1">
        <button
          v-for="act in landActions"
          :key="`${act.op}-${act.fertilizerId || act.label}`"
          type="button"
          :class="getActionButtonClass(act)"
          :aria-label="act.tip"
          :data-tip="act.label"
          :disabled="(act.op === 'plant' && !pickedSeedId)"
          @click.stop="doAction(act)"
        >
          <i :class="act.icon" class="shrink-0 text-sm" aria-hidden="true" />
          <span class="land-action-label">{{ act.label }}</span>
        </button>
      </div>
    </div>
  </div>
</template>



<style scoped>
.land-action-dock {
  position: relative;
  z-index: 30;
  width: 100%;
  margin-top: 0.5rem;
  border: 1px solid rgb(148 163 184 / 0.3);
  border-radius: 0.75rem;
  background: rgb(255 255 255 / 0.9);
  padding: 0.35rem;
  box-shadow: 0 10px 28px rgb(15 23 42 / 0.14);
  backdrop-filter: blur(12px);
}

.land-action-hint {
  display: none;
  position: absolute;
  right: 0.45rem;
  bottom: 0.45rem;
  z-index: 10;
  height: 1.5rem;
  width: 1.5rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(148 163 184 / 0.25);
  border-radius: 9999px;
  background: rgb(255 255 255 / 0.72);
  color: rgb(100 116 139);
  opacity: 0.75;
  pointer-events: none;
  transition: opacity 0.18s ease;
}

.land-action-button {
  position: relative;
  display: flex;
  height: 2.25rem;
  min-width: 2.25rem;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.05rem;
  border-width: 1px;
  border-radius: 0.55rem;
  padding: 0 0.25rem;
}

.land-action-label {
  font-size: 8px;
  line-height: 1;
  white-space: nowrap;
}

.land-seed-select {
  width: 100%;
  min-height: 1.75rem;
  border: 1px solid rgb(148 163 184 / 0.4);
  border-radius: 0.45rem;
  background: rgb(255 255 255 / 0.88);
  padding: 0 0.5rem;
  color: rgb(51 65 85);
  font-size: 10px;
  outline: none;
}

.land-seed-select:focus {
  border-color: rgb(59 130 246 / 0.8);
  box-shadow: 0 0 0 2px rgb(59 130 246 / 0.16);
}

@media (hover: hover) and (pointer: fine) {
  .land-action-dock {
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
    left: 0.5rem;
    width: auto;
    margin-top: 0;
    opacity: 0;
    pointer-events: none;
    transform: translateY(0.4rem) scale(0.98);
    transition: opacity 0.18s ease, transform 0.18s ease;
  }

  .land-card:hover .land-action-dock,
  .land-card:focus-within .land-action-dock {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0) scale(1);
  }

  .land-action-hint {
    display: flex;
  }

  .land-card:hover .land-action-hint,
  .land-card:focus-within .land-action-hint {
    opacity: 0;
  }

  .land-action-button {
    height: 2rem;
    min-width: 2rem;
    border-radius: 9999px;
    padding: 0;
  }

  .land-action-label {
    display: none;
  }

  .land-action-button::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 0.4rem);
    left: 50%;
    z-index: 50;
    border-radius: 0.35rem;
    background: rgb(15 23 42 / 0.94);
    padding: 0.2rem 0.4rem;
    color: white;
    font-size: 9px;
    line-height: 1.2;
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, 0.2rem);
    transition: opacity 0.12s ease, transform 0.12s ease;
    white-space: nowrap;
  }

  .land-action-button:hover::after,
  .land-action-button:focus-visible::after {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .land-action-dock,
  .land-action-button::after,
  .land-action-hint {
    transition: none;
  }
}

.rainbow-progress-bar {
  width: 80%;
  margin: 0 auto;
  height: 8px;
  background: linear-gradient(145deg, #f0f0f0, #e6e6e6);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 
    inset 3px 3px 6px rgba(0, 0, 0, 0.1),
    inset -3px -3px 6px rgba(255, 255, 255, 0.9),
    2px 2px 4px rgba(0, 0, 0, 0.05);
  position: relative;
}



.rainbow-progress-bar::before {
  content: '';
  position: absolute;
  top: 1px;
  left: 2px;
  right: 2px;
  height: 3px;
  background: linear-gradient(90deg, rgba(255,255,255,0.8), rgba(255,255,255,0.2));
  border-radius: 10px 10px 0 0;
  pointer-events: none;
}



.rainbow-progress-fill {
  height: 100%;
  background: linear-gradient(
    90deg,
    #ff6b9d 0%,
    #ff9f43 20%,
    #ffd32a 40%,
    #26de81 60%,
    #45aaf2 80%,
    #a55eea 100%
  );
  border-radius: 10px;
  transition: width 1s linear;
  position: relative;
  box-shadow: 
    inset 0 2px 4px rgba(255, 255, 255, 0.6),
    inset 0 -1px 2px rgba(0, 0, 0, 0.1);
  animation: cute-pulse 2s ease-in-out infinite;
}



.rainbow-progress-fill::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.4) 50%,
    transparent 100%
  );
  animation: shimmer 2s infinite;
  border-radius: 10px;
}



@keyframes cute-pulse {
  0%, 100% {
    filter: brightness(1) saturate(1);
  }
  50% {
    filter: brightness(1.1) saturate(1.1);
  }
}



@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}



@media (prefers-color-scheme: dark) {
  .rainbow-progress-bar {
    background: linear-gradient(145deg, #2a2a2a, #1e1e1e);
    box-shadow: 
      inset 3px 3px 6px rgba(0, 0, 0, 0.3),
      inset -3px -3px 6px rgba(60, 60, 60, 0.3),
      2px 2px 4px rgba(0, 0, 0, 0.2);
  }



  .rainbow-progress-bar::before {
    background: linear-gradient(90deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02));
  }



  .rainbow-progress-fill {
    box-shadow: 
      inset 0 2px 4px rgba(255, 255, 255, 0.2),
      inset 0 -1px 2px rgba(0, 0, 0, 0.2);
  }
}
</style>

<style>
.dark .land-action-dock {
  border-color: rgb(148 163 184 / 0.24);
  background: rgb(17 24 39 / 0.92);
  box-shadow: 0 12px 30px rgb(0 0 0 / 0.32);
}

.dark .land-action-hint {
  border-color: rgb(148 163 184 / 0.32);
  background: rgb(30 41 59 / 0.9);
  color: rgb(203 213 225);
}

.dark .land-seed-select {
  border-color: rgb(100 116 139 / 0.55);
  background: rgb(30 41 59 / 0.92);
  color: rgb(226 232 240);
}
</style>

