<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandBoard from '@/components/LandBoard.vue'
import LoadingState from '@/components/ui/LoadingState.vue'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { getLandOpMeta } from '@/utils/land-ops'

const farmStore = useFarmStore()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { lands, summary, board, loading, seeds } = storeToRefs(farmStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, loading: statusLoading, realtimeConnected } = storeToRefs(statusStore)

const operating = ref(false)

// 棋盘概要(列数与要渲染的格子数都从 board 推导, 不再由后端下发重复字段)
const boardColumns = computed(() => Number(board.value?.columns) || 0)
const boardSlotCount = computed(() => (Array.isArray(board.value?.slots) ? board.value.slots.length : 0))

// 单地块操作(浇水/施肥/收获...) → 调接口 + 提示 + 刷新
async function handleLandOperate(payload: { op: string, landId: number, masterLandId?: number, seedId?: number, fertilizerId?: number }) {
  if (!currentAccountId.value) {
    toast.warning('请先选择账号')
    return
  }
  const opLabel: Record<string, string> = {
    water: '浇水',
    weed: '除草',
    bug: '除虫',
    harvest: '收获',
    clear: '铲除',
    fertilize: '施肥',
    plant: '种植',
    upgrade: '升级',
    unlock: '解锁',
  }
  const actionName = payload.op === 'fertilize' && payload.fertilizerId === 1012 ? '施有机肥' : (opLabel[payload.op] || '操作')
  try {
    const r = await farmStore.operateLand(currentAccountId.value, {
      landId: payload.landId,
      masterLandId: payload.masterLandId,
      op: payload.op,
      seedId: payload.seedId,
      fertilizerId: payload.fertilizerId,
    })
    toast.success(`${actionName}成功${r && r.action ? `（${r.action}）` : ''}`)
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || `${opLabel[payload.op] || '操作'}失败`)
  }
  finally {
    refresh()
  }
}

const confirmVisible = ref(false)
const confirmConfig = ref({
  title: '',
  message: '',
  opType: '',
})

async function executeOperate() {
  if (!currentAccountId.value || !confirmConfig.value.opType)
    return
  confirmVisible.value = false
  operating.value = true
  try {
    await farmStore.operate(currentAccountId.value, confirmConfig.value.opType)
  }
  finally {
    operating.value = false
  }
}

function handleOperate(opType: string) {
  if (!currentAccountId.value)
    return

  const confirmMap: Record<string, string> = {
    harvest: '确定要收获所有成熟作物吗？',
    clear: '确定要一键除草/除虫吗？',
    plant: '确定要一键种植吗？(根据策略配置)',
    upgrade: '确定要升级所有可升级的土地吗？(消耗金币)',
    all: '确定要一键全收吗？(包含收获、除草、种植等)',
  }

  confirmConfig.value = {
    title: '确认操作',
    message: confirmMap[opType] || '确定执行此操作吗？',
    opType,
  }
  confirmVisible.value = true
}

// 整田操作。名称/图标取自 land-ops 的统一表, 配色在这里单独定义(整田按钮比单地块按钮浅一档)
const operations = [
  { type: 'harvest', ...getLandOpMeta('harvest'), color: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50' },
  { type: 'clear', label: '除草/虫', icon: 'i-carbon-clean', color: 'border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-900/30 dark:text-teal-300 dark:hover:bg-teal-900/50' },
  { type: 'plant', ...getLandOpMeta('plant'), color: 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50' },
  { type: 'upgrade', ...getLandOpMeta('upgrade'), color: 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50' },
  { type: 'all', label: '一键全收', icon: 'i-carbon-flash', color: 'border-orange-600 bg-orange-600 text-white shadow-sm hover:border-orange-700 hover:bg-orange-700' },
]

async function refresh() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }

    if (acc.running && status.value?.connection?.connected) {
      farmStore.fetchLands(currentAccountId.value)
    }
  }
}

watch(currentAccountId, () => {
  refresh()
})

const { pause, resume } = useIntervalFn(() => {
  if (lands.value) {
    lands.value = lands.value.map((l: any) =>
      l.matureInSec > 0 ? { ...l, matureInSec: l.matureInSec - 1 } : l,
    )
  }
}, 1000)

const { pause: pauseRefresh, resume: resumeRefresh } = useIntervalFn(refresh, 60000)

onMounted(() => {
  if (currentAccountId.value)
    farmStore.fetchSeeds(currentAccountId.value)
  refresh()
  resume()
  resumeRefresh()
})

onUnmounted(() => {
  pause()
  pauseRefresh()
})
</script>

<template>
  <div class="space-y-4">
    <div class="rounded-lg bg-white shadow dark:bg-gray-800">
      <!-- Header with Title and Actions -->
      <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
        <div class="mb-2.5 flex items-center justify-between gap-2 sm:mb-3">
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <div class="i-carbon-grid text-xl" />
            土地详情
          </h3>
          <div v-if="board" class="text-[11px] text-gray-400">
            {{ boardColumns }} 列 · {{ boardSlotCount }} 块地
          </div>
        </div>
        <!-- 5 个整田操作: 手机上 3 列网格(不横向滚动, 免得要划半天才找到按钮) -->
        <div class="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <button
            v-for="op in operations"
            :key="op.type"
            type="button"
            class="min-h-[44px] flex items-center justify-center gap-1.5 border rounded-lg px-2 py-2 text-sm font-medium transition-colors active:scale-[0.98] disabled:cursor-not-allowed sm:px-3 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            :class="[op.color, op.type === 'all' ? 'col-span-3 sm:col-auto' : '']"
            :disabled="operating"
            :aria-label="op.label"
            @click="handleOperate(op.type)"
          >
            <i :class="op.icon" class="shrink-0 text-base" aria-hidden="true" />
            {{ op.label }}
          </button>
        </div>
      </div>

      <!-- Summary -->
      <div class="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2.5 text-xs sm:gap-3 dark:border-gray-700 dark:bg-gray-900/50 sm:px-4 sm:py-3 sm:text-sm">
        <div class="flex items-center gap-1 rounded-full bg-orange-100 px-2.5 py-1 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
          <div class="i-carbon-wheat" />
          <span class="font-medium">可收 {{ summary?.harvestable || 0 }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-400">
          <div class="i-carbon-sprout" />
          <span class="font-medium">生长 {{ summary?.growing || 0 }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-gray-200/70 px-2.5 py-1 text-gray-700 dark:bg-gray-800 dark:text-gray-400">
          <div class="i-carbon-checkbox" />
          <span class="font-medium">空闲 {{ summary?.empty || 0 }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          <div class="i-carbon-warning" />
          <span class="font-medium">枯萎 {{ summary?.dead || 0 }}</span>
        </div>
        <!-- 说明数字是按"作物"算的, 合种作物占 4 块地也只算 1 棵 -->
        <div class="ml-auto hidden text-[11px] text-gray-400 sm:block">
          合种作物按一棵计
        </div>
      </div>

      <!-- Grid -->
      <div class="p-3 sm:p-4">
        <LoadingState v-if="loading || statusLoading" />

        <div v-else-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
          <div class="i-carbon-user-offline text-4xl text-gray-400" />
          <div>
            <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
              未登录账号
            </div>
            <div class="mt-1 text-sm text-gray-400">
              请先添加农场账号
            </div>
          </div>
        </div>

        <div v-else-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
          <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
          <div>
            <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
              账号未登录
            </div>
            <div class="mt-1 text-sm text-gray-400">
              请先运行账号或检查网络连接
            </div>
          </div>
        </div>

        <div v-else-if="!lands || lands.length === 0" class="flex justify-center py-12 text-gray-500">
          暂无土地数据
        </div>

        <div v-else class="pb-2">
          <LandBoard
            :lands="lands"
            :board="board"
            :seeds="seeds"
            interactive
            @operate="handleLandOperate"
          />
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="confirmVisible"
      :title="confirmConfig.title"
      :message="confirmConfig.message"
      @confirm="executeOperate"
      @cancel="confirmVisible = false"
    />
  </div>
</template>
