<script setup lang="ts">
import { onClickOutside, useEventListener } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import LandCard from '@/components/LandCard.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { getLandOpMeta, ORGANIC_FERTILIZER_TONE } from '@/utils/land-ops'

/**
 * 农场棋盘 + 单地块操作面板。
 *
 * 为什么要这么摆:
 *   服务端只给到"一堆地块 id", 不给行列坐标, 但 2x2 合种作物是**一棵植物占 4 块地**,
 *   逐块平铺会让用户看到"4 块一模一样的土地", 而且只有其中 1 块能操作 —— 这就是
 *   "施肥干啥的都一个一个试,不知道点哪" 的根因。
 *   后端 land-layout 已经推断出棋盘列数并把整组合成一块跨格大地, 这里用 CSS Grid
 *   的 grid-area 把它铺成真正的 2x2 大方格。
 *
 * 操作面板:
 *   点任意一块地 → 弹出这块地(或这棵作物)能做的操作。按钮是**明确的文字**,
 *   不再依赖桌面 hover 才出现的悬浮条(移动端没有 hover, 以前在手机上根本点不到)。
 */
const props = defineProps<{
  lands: any[]
  board?: any
  seeds?: any[]
  /** 是否允许操作(好友农田只读) */
  interactive?: boolean
}>()
const emit = defineEmits<{
  (e: 'operate', payload: { op: string, landId: number, masterLandId?: number, seedId?: number, fertilizerId?: number }): void
}>()
const NORMAL_FERTILIZER_ID = 1011
const ORGANIC_FERTILIZER_ID = 1012

/** 种子在前端可能由 seedId / goodsId / id 任一字段标识 */
function seedIdOf(seed: any) {
  return Number(seed?.seedId || seed?.goodsId || seed?.id) || 0
}

const activeLand = ref<any>(null)
const pickedSeedId = ref<number>(0)
const panelEl = ref<HTMLElement | null>(null)

const columns = computed(() => Math.max(1, Number(props.board?.columns) || 6))

/**
 * 真正要渲染的格子。
 * - 没有 board(老接口)时退化成逐块平铺, 保持历史行为
 * - 有 board 时 slot 里**本来就只剩要渲染的格子**(副地块已被后端合并剔除)
 */
const tiles = computed(() => {
  const list = Array.isArray(props.lands) ? props.lands : []
  if (!props.board) {
    return list.map(land => ({
      land,
      style: {},
      rowSpan: 1,
      columnSpan: 1,
    }))
  }
  const slotByLandId = new Map<number, any>()
  for (const slot of (props.board.slots || []))
    slotByLandId.set(Number(slot.landId), slot)

  const tiles = []
  for (const land of list) {
    const slot = slotByLandId.get(Number(land.id))
    if (!slot)
      continue
    tiles.push({
      land,
      rowSpan: slot.rowSpan,
      columnSpan: slot.columnSpan,
      style: {
        gridRow: `${slot.row} / span ${slot.rowSpan}`,
        gridColumn: `${slot.column} / span ${slot.columnSpan}`,
      },
    })
  }
  return tiles
})

const currentSeeds = computed(() => {
  const list = Array.isArray(props.seeds) ? props.seeds : []
  const usable = list.filter((s: any) => s && (s.count === undefined || Number(s.count) > 0) && !s.locked && !s.soldOut)
  return usable.length ? usable : list
})

const seedOptions = computed(() => currentSeeds.value.map((s: any) => ({
  label: `${s.name || `#${seedIdOf(s)}`}${s.count !== undefined ? ` x${s.count}` : ''}`,
  value: seedIdOf(s),
})))

watch(currentSeeds, (list) => {
  if (!pickedSeedId.value && list.length)
    pickedSeedId.value = seedIdOf(list[0])
}, { immediate: true })

interface LandAction {
  op: string
  label: string
  description: string
  icon: string
  /** 直接给 class, 由 land-ops 的统一配色表决定 */
  toneClass: string
  fertilizerId?: number
  disabled?: boolean
}

/** 按操作名取统一配色, 有机肥单独一套 */
function toneOf(op: string, fertilizerId?: number) {
  if (op === 'fertilize' && fertilizerId === ORGANIC_FERTILIZER_ID)
    return ORGANIC_FERTILIZER_TONE
  return getLandOpMeta(op).tone
}

/** 这块地(这棵作物)现在能做哪些操作 —— 按状态给, 不给用不了的操作 */
const activeActions = computed<LandAction[]>(() => {
  const l = activeLand.value
  if (!l)
    return []
  const acts: LandAction[] = []

  if (l.status === 'locked') {
    acts.push({ op: 'unlock', label: '解锁这块地', description: '花金币解锁', icon: getLandOpMeta('unlock').icon, toneClass: toneOf('unlock') })
    return acts
  }

  if (l.needWater)
    acts.push({ op: 'water', label: '浇水', description: '这块地缺水了', icon: getLandOpMeta('water').icon, toneClass: toneOf('water') })
  if (l.needWeed)
    acts.push({ op: 'weed', label: '除草', description: '这块地长草了', icon: getLandOpMeta('weed').icon, toneClass: toneOf('weed') })
  if (l.needBug)
    acts.push({ op: 'bug', label: '除虫', description: '这块地生虫了', icon: getLandOpMeta('bug').icon, toneClass: toneOf('bug') })
  if (l.status === 'harvestable' || l.canHarvest)
    acts.push({ op: 'harvest', label: '收获', description: '作物已成熟', icon: getLandOpMeta('harvest').icon, toneClass: toneOf('harvest') })

  if (l.plantName) {
    acts.push({ op: 'fertilize', label: '施普通化肥', description: '缩短成熟时间', icon: getLandOpMeta('fertilize').icon, toneClass: toneOf('fertilize', NORMAL_FERTILIZER_ID), fertilizerId: NORMAL_FERTILIZER_ID })
    acts.push({ op: 'fertilize', label: '施有机化肥', description: '大幅缩短成熟时间', icon: 'i-carbon-growth', toneClass: toneOf('fertilize', ORGANIC_FERTILIZER_ID), fertilizerId: ORGANIC_FERTILIZER_ID })
    acts.push({ op: 'clear', label: '铲除作物', description: '清掉这棵作物', icon: getLandOpMeta('clear').icon, toneClass: toneOf('clear') })
  }
  else if (l.status !== 'locked') {
    acts.push({ op: 'plant', label: '在这里种植', description: '用下面选中的种子', icon: getLandOpMeta('plant').icon, toneClass: toneOf('plant') })
  }

  // 2026-11-02 起服务端不再下发 could_upgrade, 用后端算出的 canUpgrade 判断
  const upgradeBlocked = l.canUpgrade === false || !!l.upgradeBlockedReason
  acts.push({
    op: 'upgrade',
    label: upgradeBlocked ? '升级（条件未满足）' : '升级这块地',
    description: upgradeBlocked
      ? `暂不能升级：${l.upgradeBlockedReason || '条件未满足'}${l.upgradeCostText ? `（条件 ${l.upgradeCostText}）` : ''}`
      : `升级这块地${l.upgradeCostText ? `（条件 ${l.upgradeCostText}）` : ''}`,
    icon: getLandOpMeta('upgrade').icon,
    toneClass: toneOf('upgrade'),
    disabled: upgradeBlocked,
  })
  return acts
})

const canPlant = computed(() => activeActions.value.some(a => a.op === 'plant'))

const panelTitle = computed(() => {
  const l = activeLand.value
  if (!l)
    return ''
  const span = Math.max(1, Number(l.plantSize) || 1)
  const groupNote = span > 1 ? `（${span}x${span} 合种，占 ${span * span} 块地）` : ''
  return `#${l.id} ${l.plantName || (l.status === 'locked' ? '未解锁土地' : '空地')}${groupNote}`
})

/** 面板副标题: 只写状态, 不重复标题里已经说明的作物名/空地 */
const panelSubtitle = computed(() => {
  const l = activeLand.value
  if (!l)
    return ''
  if (l.status === 'locked')
    return '这块地还没解锁'
  if (l.plantName) {
    const season = Number(l.totalSeason) > 1 ? ` · 季 ${l.currentSeason}/${l.totalSeason}` : ''
    return `${l.phaseName || ''}${season}`.trim().replace(/^·/, '') || '生长中'
  }
  return '这块地现在可以种植'
})

function openPanel(land: any) {
  if (!props.interactive)
    return
  activeLand.value = land
}

function closePanel() {
  activeLand.value = null
}

function runAction(action: LandAction) {
  const land = activeLand.value
  if (!land || action.disabled)
    return
  if (action.op === 'plant' && !pickedSeedId.value)
    return
  emit('operate', {
    op: action.op,
    landId: Number(land.id),
    // 后端据此直接定位整组的主地块, 省掉一次全量 AllLands
    masterLandId: Number(land.masterLandId) || undefined,
    seedId: action.op === 'plant' ? pickedSeedId.value : undefined,
    fertilizerId: action.fertilizerId,
  })
  closePanel()
}

// 点面板外部 / 按 Esc 关闭。种子下拉由 BaseSelect 自己处理"点外部收起"。
onClickOutside(panelEl, () => {
  if (activeLand.value)
    closePanel()
}, { ignore: ['.land-board__cell'] })

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape')
    closePanel()
}

useEventListener(document, 'keydown', onKeydown)
</script>

<template>
  <div class="land-board" :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }">
    <button
      v-for="tile in tiles"
      :key="tile.land.id"
      type="button"
      class="land-board__cell text-left"
      :style="tile.style"
      :class="{ 'land-board__cell--readonly': !interactive }"
      :disabled="!interactive"
      :aria-label="`地块 ${tile.land.id} ${tile.land.plantName || ''}`"
      @click="openPanel(tile.land)"
    >
      <LandCard
        :land="tile.land"
        :row-span="tile.rowSpan"
        :column-span="tile.columnSpan"
      />
    </button>
  </div>

  <!-- 单地块操作面板: 点开一块地才出现, 手机上也能点 -->
  <Teleport to="body">
    <div
      v-if="activeLand"
      class="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      @click.self="closePanel"
    >
      <div
        ref="panelEl"
        class="land-panel max-w-md w-full rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl dark:bg-gray-800"
        role="dialog"
        aria-modal="true"
        :aria-label="panelTitle"
      >
        <div class="flex items-start justify-between gap-3 border-b border-gray-100 p-4 dark:border-gray-700">
          <div class="min-w-0">
            <div class="truncate text-base text-gray-900 font-bold dark:text-gray-100">
              {{ panelTitle }}
            </div>
            <div class="mt-0.5 text-xs text-gray-500">
              {{ panelSubtitle }}
            </div>
          </div>
          <button
            type="button"
            class="h-9 w-9 flex shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            aria-label="关闭"
            @click="closePanel"
          >
            <div class="i-carbon-close text-lg" />
          </button>
        </div>

        <div class="max-h-[65vh] overflow-y-auto p-4">
          <!-- 种植前先选种子(否则不知道种什么)。下拉复用全站统一的 BaseSelect -->
          <div v-if="canPlant" class="mb-3">
            <BaseSelect
              v-model="pickedSeedId"
              label="种植使用的种子"
              :options="seedOptions"
              placeholder="没有可用种子"
            />
          </div>

          <!-- 操作按钮: 全是大字 + 说明, 不用猜 -->
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              v-for="act in activeActions"
              :key="`${act.op}-${act.fertilizerId || act.label}`"
              type="button"
              class="min-h-[52px] flex items-center gap-3 border rounded-xl px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40"
              :class="act.toneClass"
              :disabled="act.disabled || (act.op === 'plant' && !pickedSeedId)"
              @click="runAction(act)"
            >
              <i :class="act.icon" class="shrink-0 text-xl" aria-hidden="true" />
              <span class="min-w-0">
                <span class="block text-sm font-semibold">{{ act.label }}</span>
                <span class="block text-[11px] opacity-70">{{ act.description }}</span>
              </span>
            </button>
          </div>

          <div v-if="!activeActions.length" class="py-6 text-center text-sm text-gray-400">
            这块地现在没有可执行的操作
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.land-board {
  display: grid;
  gap: 0.375rem;
}

@media (min-width: 640px) {
  .land-board {
    gap: 0.75rem;
  }
}

.land-board__cell {
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  min-width: 0;
  /* 统一格子高度, 合种大格一定比小格高, 用 stretch 让它自然填满 */
  height: 100%;
}

/* 4 列棋盘在 360px 手机上每格只有 ~78px 宽, 内容要收紧一点否则会顶出格子 */
.land-board__cell > :deep(.land-tile) {
  height: 100%;
  min-height: 108px;
}

@media (min-width: 640px) {
  .land-board__cell > :deep(.land-tile) {
    min-height: 148px;
  }
}

/* 超窄屏(小屏手机竖屏): 只保留最关键的信息 */
@media (max-width: 379px) {
  .land-board__cell > :deep(.land-tile) {
    min-height: 98px;
    padding: 0.25rem;
  }
}

.land-board__cell--readonly {
  cursor: default;
}

.land-board__cell:focus-visible {
  outline: 2px solid var(--theme-primary, #3b82f6);
  outline-offset: 2px;
  border-radius: 0.75rem;
}

@media (prefers-reduced-motion: no-preference) {
  .land-board__cell:active > :deep(.land-tile) {
    transform: scale(0.98);
  }

  .land-board__cell > :deep(.land-tile) {
    transition: transform 0.12s ease;
  }
}

.land-panel {
  animation: land-panel-in 0.18s ease-out;
}

@keyframes land-panel-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .land-panel {
    animation: none;
  }
}

/* iOS 底部安全区 */
@supports (padding: env(safe-area-inset-bottom)) {
  .land-panel {
    padding-bottom: env(safe-area-inset-bottom);
  }
}
</style>
