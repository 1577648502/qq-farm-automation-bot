<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useSeedShopStore } from '@/stores/seedShop'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const seedShopStore = useSeedShopStore()
const statusStore = useStatusStore()
const toastStore = useToastStore()

const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { items, availableItems, lockedItems, soldOutItems, loading } = storeToRefs(seedShopStore)
const { status, realtimeConnected } = storeToRefs(statusStore)

const imageErrors = ref<Record<number, boolean>>({})
const buyCounts = ref<Record<number, number>>({})
const buyingId = ref<number | null>(null)

function buyCount(seedId: number) {
  const n = Number(buyCounts.value[seedId])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
}

async function handleBuy(item: { seedId: number, goodsId: number, price: number | null }) {
  if (!currentAccountId.value || buyingId.value !== null)
    return
  const num = buyCount(item.seedId)
  buyingId.value = item.seedId
  try {
    const res = await seedShopStore.buySeed(currentAccountId.value, item.goodsId, num, item.price)
    if (res.ok) {
      toastStore.success(`购买成功 x${num}`)
      await load()
    }
    else {
      toastStore.error(`购买失败: ${res.error || '未知错误'}`)
    }
  }
  catch (e: any) {
    toastStore.error(`购买失败: ${e.message || '未知错误'}`)
  }
  finally {
    buyingId.value = null
  }
}

const FILTERS = [
  { label: '全部', value: 'all' },
  { label: '可购买', value: 'available' },
  { label: '未解锁', value: 'locked' },
  { label: '已售罄', value: 'soldout' },
] as const

type FilterValue = typeof FILTERS[number]['value']
const selectedFilter = ref<FilterValue>('all')

const filteredItems = computed(() => {
  switch (selectedFilter.value) {
    case 'available':
      return availableItems.value
    case 'locked':
      return lockedItems.value
    case 'soldout':
      return soldOutItems.value
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
    await seedShopStore.fetchSeeds(currentAccountId.value)
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
          <div class="i-carbon-shopping-cart text-xl" />
          种子商城
        </h3>
      </div>

      <!-- Summary -->
      <div class="flex flex-wrap gap-2 sm:gap-4 border-b border-gray-100 bg-gray-50 p-3 sm:p-4 text-xs sm:text-sm dark:border-gray-700 dark:bg-gray-900/50">
        <div class="flex items-center gap-1 rounded-full bg-blue-100 px-3 py-1 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
          <div class="i-carbon-shopping-cart" />
          <span class="font-medium">总计: {{ items.length }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-400">
          <div class="i-carbon-checkmark-outline" />
          <span class="font-medium">可购买: {{ availableItems.length }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-gray-200 px-3 py-1 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          <div class="i-carbon-locked" />
          <span class="font-medium">未解锁: {{ lockedItems.length }}</span>
        </div>
        <div class="flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          <div class="i-carbon-close-outline" />
          <span class="font-medium">已售罄: {{ soldOutItems.length }}</span>
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
          暂无种子商城数据
        </div>

        <div v-else class="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-8 md:grid-cols-6 sm:grid-cols-4">
          <div
            v-for="item in filteredItems"
            :key="item.seedId"
            class="relative flex flex-col items-center rounded-lg border p-2 transition"
            :class="item.locked || item.soldOut
              ? 'border-dashed border-gray-200 bg-gray-50 opacity-60 dark:border-gray-700 dark:bg-gray-900/40'
              : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'"
          >
            <span
              v-if="item.soldOut"
              class="absolute right-1 top-1 rounded bg-red-500 px-1 text-[9px] text-white"
            >售罄</span>
            <span
              v-else-if="item.locked"
              class="absolute right-1 top-1 rounded bg-gray-400 px-1 text-[9px] text-white"
            >锁定</span>
            <div class="h-12 w-12 flex items-center justify-center">
              <img
                v-if="item.image && !imageErrors[item.seedId]"
                :src="item.image"
                :alt="item.name"
                class="max-h-12 max-w-12 object-contain"
                :class="item.locked || item.soldOut ? 'grayscale' : ''"
                @error="imageErrors[item.seedId] = true"
              >
              <div v-else class="i-carbon-image text-2xl text-gray-300" />
            </div>
            <div class="mt-1 w-full truncate text-center text-xs text-gray-700 dark:text-gray-300" :title="item.name">
              {{ item.name || `种子${item.seedId}` }}
            </div>
            <div class="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
              <div class="i-carbon-piggy-bank" />
              <span v-if="item.price !== null && item.price !== undefined">{{ item.price }}</span>
              <span v-else>未知</span>
            </div>
            <div class="text-[10px] text-gray-400">
              <span v-if="item.requiredLevel">Lv.{{ item.requiredLevel }}</span>
              <span v-else>&nbsp;</span>
            </div>
            <div v-if="!item.locked && !item.soldOut && item.goodsId" class="mt-1 w-full flex items-center gap-1">
              <input
                v-model.number="buyCounts[item.seedId]"
                type="number"
                min="1"
                placeholder="1"
                class="w-10 rounded border border-gray-200 px-1 py-0.5 text-center text-[10px] dark:border-gray-600 dark:bg-gray-700"
              >
              <button
                class="min-h-[24px] flex flex-1 items-center justify-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-white transition disabled:cursor-not-allowed disabled:opacity-50"
                style="background-color: var(--theme-primary)"
                :disabled="buyingId !== null"
                @click="handleBuy(item)"
              >
                <div v-if="buyingId === item.seedId" class="i-svg-spinners-90-ring-with-bg" />
                <div v-else class="i-carbon-shopping-cart-plus" />
                购买
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
