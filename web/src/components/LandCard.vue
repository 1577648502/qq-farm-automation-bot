<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watchEffect } from 'vue'



const props = defineProps<{
  land: any
  seeds?: any[]
}>()
const emit = defineEmits<{ (e: 'operate', payload: { op: string, seedId?: number, fertilizerId?: number }): void }>()

type LandActionTone = 'water' | 'weed' | 'bug' | 'harvest' | 'fertilizer' | 'organic' | 'danger' | 'plant' | 'upgrade' | 'unlock'
type LandAction = {
  op: string
  label: string
  tip: string
  icon: string
  tone: LandActionTone
  fertilizerId?: number
}

const ACTION_TONE_CLASSES: Record<LandActionTone, string> = {
  water: 'border-sky-200 bg-sky-50 text-sky-700 hover:border-sky-300 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300 dark:hover:bg-sky-900/50',
  weed: 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50',
  bug: 'border-rose-200 bg-rose-50 text-rose-700 hover:border-rose-300 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50',
  harvest: 'border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50',
  fertilizer: 'border-cyan-200 bg-cyan-50 text-cyan-700 hover:border-cyan-300 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50',
  organic: 'border-lime-200 bg-lime-50 text-lime-700 hover:border-lime-300 hover:bg-lime-100 dark:border-lime-800 dark:bg-lime-900/30 dark:text-lime-300 dark:hover:bg-lime-900/50',
  danger: 'border-red-200 bg-red-50 text-red-700 hover:border-red-300 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50',
  plant: 'border-green-200 bg-green-50 text-green-700 hover:border-green-300 hover:bg-green-100 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50',
  upgrade: 'border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-300 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50',
  unlock: 'border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50',
}

const ACTION_BUTTON_BASE = 'min-h-8 w-full flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-45'

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
// 变异标签: 服务端给的 mutationType 已是"变异"(配置ID存在但名字未识别)时不再重复加"变异"二字
const mutationLabel = computed(() => {
  const t = String((land.value as any)?.mutationType || '').trim()
  if (!t) return '变异'
  if (t.startsWith('变异')) return t                        // 变异#14 等未识别枚举
  if (t === '变异') return '变异(类型待识别)'
  const base = t.includes('_') ? t.split('_')[0] : t        // 黄金_天工 → 黄金 (与游戏显示一致)
  return `${base}变异`
})
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
    class="relative min-h-[120px] sm:min-h-[140px] flex flex-col items-center border rounded-lg p-1.5 sm:p-2 transition dark:border-gray-700 hover:shadow-md"
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



    <div v-if="land.isGolden" class="w-full text-center text-[10px] font-bold text-amber-600 dark:text-amber-400">★ 黄金变异 ★</div>
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



    <div v-if="land.isMutant && land.mutationType" class="flex items-center justify-center gap-0.5 text-[10px] px-1 truncate max-w-full">
      <span v-if="land.mutationQuality === '天工'" class="rounded bg-orange-100 px-1 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 font-medium">天工</span>
      <span v-else-if="land.mutationQuality === '珍品'" class="rounded bg-purple-100 px-1 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 font-medium">珍品</span>
      <span v-else-if="land.mutationQuality === '稀有'" class="rounded bg-blue-100 px-1 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 font-medium">稀有</span>
      <span class="text-gray-600 dark:text-gray-400">{{ mutationLabel }}</span>
    </div>
    <div class="mb-1 text-[10px] text-gray-400">
      季数 {{ land.totalSeason > 0 ? (`${land.currentSeason}/${land.totalSeason}`) : '-/-' }}
    </div>



    <!-- 单地块操作 -->
    <div
      class="mt-2 grid w-full gap-1 border-t border-gray-200/80 pt-2 dark:border-gray-700"
      :class="landActions.length === 1 ? 'grid-cols-1' : 'grid-cols-2'"
    >
      <template v-if="landActions.some(a => a.op === 'plant')">
        <select
          v-model.number="pickedSeedId"
          class="col-span-full min-h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-[11px] text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          aria-label="选择种植种子"
          title="选择种植种子"
          @click.stop
        >
          <option v-for="sd in (seeds || [])" :key="sd.goodsId || sd.seedId || sd.id" :value="Number(sd.goodsId || sd.seedId || sd.id)">
            {{ sd.name || ('#' + (sd.goodsId || sd.seedId || sd.id)) }}
          </option>
        </select>
      </template>
      <button
        v-for="act in landActions"
        :key="`${act.op}-${act.fertilizerId || act.label}`"
        type="button"
        :class="getActionButtonClass(act)"
        :title="act.tip"
        :aria-label="act.tip"
        :disabled="(act.op === 'plant' && !pickedSeedId)"
        @click.stop="doAction(act)"
      >
        <i :class="act.icon" class="shrink-0 text-sm" aria-hidden="true" />
        {{ act.label }}
      </button>
    </div>
    <!-- Status Badges -->
    <div class="mt-auto flex origin-bottom scale-85 sm:scale-90 gap-0.5 text-[9px] sm:text-[10px]">
      <span v-if="land.needWater" class="rounded bg-blue-100 px-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">水</span>
      <span v-if="land.needWeed" class="rounded bg-green-100 px-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">草</span>
      <span v-if="land.needBug" class="rounded bg-red-100 px-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-400">虫</span>
      <!-- For friends view -->
      <span v-if="land.status === 'harvestable'" class="rounded bg-orange-100 px-0.5 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">可偷</span>
    </div>
  </div>
</template>



<style scoped>
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

