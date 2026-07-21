<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useIllustratedStore } from '@/stores/illustrated'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const illustratedStore = useIllustratedStore()
const statusStore = useStatusStore()

const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { items, total, unlocked, claimable, loading } = storeToRefs(illustratedStore)
const { status, realtimeConnected } = storeToRefs(statusStore)

const imageErrors = ref<Record<number, boolean>>({})

const FILTERS = [
  { label: '全部', value: 'all' },
  { label: '已解锁', value: 'unlocked' },
  { label: '未解锁', value: 'locked' },
  { label: '可领奖', value: 'claimable' },
] as const

type FilterValue = typeof FILTERS[number]['value']
const selectedFilter = ref<FilterValue>('all')

const filteredItems = computed(() => {
  switch (selectedFilter.value) {
    case 'unlocked':
      return items.value.filter(i => i.planted)
    case 'locked':
      return items.value.filter(i => !i.planted)
    case 'claimable':
      return items.value.filter(i => i.canClaim)
    default:
      return items.value
  }
})

const connected = computed(() => !!status.value?.connection?.connected)

async function load() {
  if (!currentAccountId.value)
    return
  const acc = currentAccount.value
  if (!acc)
    return
  if (!realtimeConnected.value)
    await statusStore.fetchStatus(currentAccountId.value)
  if (acc.running && status.value?.connection?.connected)
    await illustratedStore.fetchIllustrated(currentAccountId.value)
  imageErrors.value = {}
}

onMounted(load)
watch(currentAccountId, load)
useIntervalFn(load, 60000)
</script>

<template>
  <div class="space-y-4">
    <div class="rounded-lg bg-white shadow dark:bg-gray-800">
      <!-- Header -->
      <div class="flex flex-col items-center justify-between gap-3 border-b border-gray-100 p-3 sm:p-4 sm:flex-row dark:border-gray-700">
        <h3 class="flex items-center gap-2 text-lg font-bold">
          <div class="i-carbon-catalog text-xl" />
          图鉴
        </h3>
      </div>

      <!-- Summary -->
      <div class="flex flex-wrap gap-2 sm:gap-4 border-b border-gray-100 bg-gray-50 p-3 sm:p-4 text-xs sm:text-sm dark:border-gray-700 dark:bg-gray-900/50">
        <div class="flex items-center gap-1 rounded-full bg-blue-100 px-3 py-1 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
          <div class="i-carbon-catalog" />
          <span class="font-medium">总计: {{ total }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-400">
          <div class="i-carbon-unlocked" />
          <span class="font-medium">已解锁: {{ unlocked }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          <div class="i-carbon-gift" />
          <span class="font-medium">可领奖: {{ claimable }}</span>
        </div>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap gap-2 border-b border-gray-100 p-3 sm:p-4 dark:border-gray-700">
        <button
          v-for="f in FILTERS"
          :key="f.value"
          class="rounded-full px-3 py-1 text-xs font-medium transition-colors"
          :class="selectedFilter === f.value
            ? 'text-white'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'"
          :style="selectedFilter === f.value ? { backgroundColor: 'var(--theme-primary)' } : {}"
          @click="selectedFilter = f.value"
        >
          {{ f.label }}
        </button>
      </div>

      <!-- Content -->
      <div class="p-3 sm:p-4">
        <div v-if="loading" class="flex justify-center py-12">
          <div class="i-svg-spinners-90-ring-with-bg text-4xl text-blue-500" />
        </div>

        <div v-else-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 py-12 text-center text-gray-500">
          <div class="i-carbon-user-offline text-4xl text-gray-400" />
          <div class="text-sm font-medium">
            未登录账号，请先添加农场账号
          </div>
        </div>

        <div v-else-if="!connected" class="flex flex-col items-center justify-center gap-4 py-12 text-center text-gray-500">
          <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
          <div class="text-sm font-medium">
            账号未登录，请先运行账号或检查网络连接
          </div>
        </div>

        <div v-else-if="!filteredItems.length" class="flex justify-center py-12 text-gray-500">
          暂无图鉴数据
        </div>

        <div v-else class="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-8 md:grid-cols-6 sm:grid-cols-4">
          <div
            v-for="item in filteredItems"
            :key="item.seedId"
            class="relative flex flex-col items-center rounded-lg border p-2 transition"
            :class="item.planted
              ? 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
              : 'border-dashed border-gray-200 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-gray-900/40'"
          >
            <span
              v-if="item.canClaim"
              class="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500"
              title="有可领取奖励"
            />
            <div class="h-12 w-12 flex items-center justify-center">
              <img
                v-if="item.image && !imageErrors[item.seedId]"
                :src="item.image"
                :alt="item.name"
                class="max-h-12 max-w-12 object-contain"
                :class="item.planted ? '' : 'grayscale'"
                @error="imageErrors[item.seedId] = true"
              >
              <div v-else class="i-carbon-image text-2xl text-gray-300" />
            </div>
            <div class="mt-1 w-full truncate text-center text-xs text-gray-700 dark:text-gray-300" :title="item.name">
              {{ item.name || `种子${item.seedId}` }}
            </div>
            <div class="text-[10px] text-gray-400">
              <span v-if="item.planted">已收 {{ item.harvestCount }}</span>
              <span v-else>未解锁</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
