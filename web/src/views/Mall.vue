<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { formatCompactNumber } from '@/utils/number-format'

interface MallPrice {
  itemId: number
  amount: number
  unit: string
  balanceKey: string
}

interface MallItem {
  id: number
  count: number
  name: string
  description: string
  image: string
}

interface MallGoods {
  goodsId: number
  source: 'mall' | 'shop'
  shopId: number
  shopName: string
  slotType: number
  name: string
  type: number
  isFree: boolean
  isLimited: boolean
  discount: string
  price: MallPrice
  items: MallItem[]
  image: string
  description: string
  unlocked: boolean
  boughtNum: number
  limitCount: number
  limitType?: 'daily' | 'permanent'
  remaining: number | null
}

type Category = 'all' | 'fertilizer' | 'dog-food' | 'gift' | 'other'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status } = storeToRefs(statusStore)

const goods = ref<MallGoods[]>([])
const loading = ref(false)
const error = ref('')
const activeCategory = ref<Category>('all')
const quantities = reactive<Record<string, number>>({})
const selectedGoods = ref<MallGoods | null>(null)
const purchaseLoading = ref(false)

const categoryOptions: Array<{ key: Category, label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'fertilizer', label: '化肥' },
  { key: 'dog-food', label: '狗粮' },
  { key: 'gift', label: '礼包' },
  { key: 'other', label: '其他' },
]

function categoryOf(item: MallGoods): Exclude<Category, 'all'> {
  const text = `${item.name} ${item.items.map(row => row.name).join(' ')}`
  if (text.includes('化肥'))
    return 'fertilizer'
  if (text.includes('狗粮'))
    return 'dog-food'
  if (/礼包|宝箱/.test(text))
    return 'gift'
  return 'other'
}

const categoryCounts = computed(() => {
  const counts: Record<Category, number> = { 'all': goods.value.length, 'fertilizer': 0, 'dog-food': 0, 'gift': 0, 'other': 0 }
  for (const item of goods.value)
    counts[categoryOf(item)] += 1
  return counts
})

const filteredGoods = computed(() => {
  if (activeCategory.value === 'all')
    return goods.value
  return goods.value.filter(item => categoryOf(item) === activeCategory.value)
})

const accountReady = computed(() => !!currentAccountId.value && !!currentAccount.value?.running)

function getQuantity(item: MallGoods) {
  if (item.isFree)
    return 1
  return Math.max(1, Math.min(maxQuantity(item), Math.floor(Number(quantities[goodsKey(item)]) || 1)))
}

function normalizeQuantity(item: MallGoods) {
  quantities[goodsKey(item)] = getQuantity(item)
}

function goodsKey(item: MallGoods) {
  return `${item.source || 'mall'}-${item.shopId || 0}-${item.goodsId}`
}

function balanceFor(item: MallGoods): number | null {
  const key = item.price?.balanceKey
  if (!key)
    return null
  const value = Number(status.value?.status?.[key])
  return Number.isFinite(value) ? Math.max(0, value) : null
}

function totalPrice(item: MallGoods) {
  return Math.max(0, Number(item.price?.amount) || 0) * getQuantity(item)
}

function maxQuantity(item: MallGoods) {
  if (item.remaining === null)
    return 99
  return Math.max(1, Math.min(99, Math.floor(Number(item.remaining) || 0)))
}

function isLimitReached(item: MallGoods) {
  return item.remaining !== null && Number(item.remaining) <= 0
}

function isInsufficient(item: MallGoods) {
  const balance = balanceFor(item)
  return balance !== null && totalPrice(item) > balance
}

function isPurchaseDisabled(item: MallGoods) {
  return isInsufficient(item) || item.unlocked === false || isLimitReached(item)
}

function formatNumber(value: number) {
  return Math.max(0, Number(value) || 0).toLocaleString('zh-CN')
}

function formatCurrencyNumber(value: unknown) {
  return formatCompactNumber(value)
}

function contentsText(item: MallGoods) {
  if (!item.items.length)
    return item.description || '商品内容以官方商城结算为准'
  return item.items.map(row => `${row.name} ×${row.count}`).join('、')
}

function limitText(item: MallGoods) {
  const limitCount = Math.max(0, Math.floor(Number(item.limitCount) || 0))
  if (limitCount <= 0 || item.remaining === null)
    return ''
  const remaining = Math.max(0, Math.min(limitCount, Math.floor(Number(item.remaining) || 0)))
  const label = item.limitType === 'daily' ? '每日限购' : '永久限购'
  return `${label} ${remaining}/${limitCount}`
}

function limitTextClass(item: MallGoods) {
  return isLimitReached(item)
    ? 'border-red-100 bg-red-50 text-red-600 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300'
    : 'border-emerald-100 bg-emerald-50 text-emerald-600 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-300'
}

async function fetchCatalog() {
  const accountId = String(currentAccountId.value || '')
  goods.value = []
  error.value = ''
  if (!accountId)
    return
  if (!currentAccount.value?.running) {
    error.value = '当前账号未运行，请先启动账号后再进入商城。'
    return
  }

  loading.value = true
  try {
    const res = await api.get('/api/mall/goods', {
      params: { slotType: 1 },
      headers: { 'x-account-id': accountId },
    })
    if (accountId !== String(currentAccountId.value || ''))
      return
    if (!res.data?.ok)
      throw new Error(res.data?.error || '获取商城商品失败')
    goods.value = Array.isArray(res.data.data) ? res.data.data : []
    for (const item of goods.value) {
      if (!quantities[goodsKey(item)])
        quantities[goodsKey(item)] = 1
      normalizeQuantity(item)
    }
    await statusStore.fetchStatus(accountId)
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取商城商品失败'
  }
  finally {
    loading.value = false
  }
}

function openPurchase(item: MallGoods) {
  normalizeQuantity(item)
  if (item.unlocked === false) {
    toast.warning('该商品尚未解锁')
    return
  }
  if (isLimitReached(item)) {
    toast.warning('该商品已达限购数量')
    return
  }
  if (isInsufficient(item)) {
    toast.warning(`${item.price.unit}余额不足`)
    return
  }
  selectedGoods.value = item
}

function closePurchase() {
  if (!purchaseLoading.value)
    selectedGoods.value = null
}

const purchaseMessage = computed(() => {
  const item = selectedGoods.value
  if (!item)
    return ''
  const quantity = getQuantity(item)
  const cost = item.isFree ? '免费' : `${formatNumber(totalPrice(item))} ${item.price.unit}`
  return `账号：${currentAccount.value?.name || currentAccount.value?.nick || currentAccount.value?.uin || currentAccountId.value}\n商品：${item.name} ×${quantity}\n内容：${contentsText(item)}\n合计：${cost}\n\n确认后将立即向官方商城下单。`
})

async function confirmPurchase() {
  const item = selectedGoods.value
  const accountId = String(currentAccountId.value || '')
  if (!item || !accountId || purchaseLoading.value)
    return

  purchaseLoading.value = true
  try {
    const count = getQuantity(item)
    const res = await api.post('/api/mall/purchase', {
      goodsId: item.goodsId,
      count,
      slotType: item.slotType || 1,
      source: item.source || 'mall',
      shopId: item.shopId || 0,
    }, {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '购买失败')
    const result = res.data.data || {}
    toast.success(`已购买 ${result.name || item.name} ×${result.count || count}`)
    selectedGoods.value = null
    await Promise.all([
      fetchCatalog(),
      statusStore.fetchStatus(accountId),
    ])
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '购买失败')
  }
  finally {
    purchaseLoading.value = false
  }
}

watch([currentAccountId, () => currentAccount.value?.running], fetchCatalog)

onMounted(async () => {
  if (!accountStore.accounts.length)
    await accountStore.fetchAccounts()
  await fetchCatalog()
})
</script>

<template>
  <div class="mx-auto max-w-7xl w-full p-2 space-y-5 sm:p-4">
    <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <h1 class="flex items-center gap-3 text-2xl text-gray-900 font-bold dark:text-white">
          <span class="h-10 w-10 flex items-center justify-center rounded-xl text-white shadow" style="background: var(--theme-primary)">
            <span class="i-carbon-shopping-cart text-xl" />
          </span>
          道具商城
        </h1>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          商品和价格实时读取自官方商城，购买后直接发放到当前账号。
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="border border-gray-200 rounded-xl bg-white px-2 sm:px-4 py-2 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <span class="text-gray-500 dark:text-gray-400">金币</span>
          <strong class="ml-2 text-amber-500">{{ formatCurrencyNumber(status?.status?.gold) }}</strong>
        </div>
        <div class="border border-gray-200 rounded-xl bg-white px-2 sm:px-4 py-2 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <span class="text-gray-500 dark:text-gray-400">点券</span>
          <strong class="ml-2 text-emerald-500">{{ formatCurrencyNumber(status?.status?.coupon) }}</strong>
        </div>
        <div class="border border-gray-200 rounded-xl bg-white px-2 sm:px-4 py-2 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <span class="text-gray-500 dark:text-gray-400">钻石</span>
          <strong class="ml-2 text-blue-500">{{ formatCurrencyNumber(status?.status?.diamond) }}</strong>
        </div>
        <div class="border border-gray-200 rounded-xl bg-white px-2 sm:px-4 py-2 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <span class="text-gray-500 dark:text-gray-400">金豆豆</span>
          <strong class="ml-2 text-violet-500">{{ formatCurrencyNumber(status?.status?.goldBean) }}</strong>
        </div>
        <BaseButton variant="secondary" :loading="loading" :disabled="!accountReady" @click="fetchCatalog">
          <span class="i-carbon-renew mr-1" />刷新
        </BaseButton>
      </div>
    </div>

    <div class="flex flex-nowrap gap-2 overflow-x-auto pb-1 snap-x snap-mandatory scrollbar-none sm:flex-wrap sm:overflow-visible sm:pb-0">
      <button v-for="option in categoryOptions"
        :key="option.key"
        class="rounded-xl px-4 py-2 text-sm font-medium transition"
        :class="activeCategory === option.key
          ? 'text-white shadow-sm'
          : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="activeCategory === option.key ? { background: 'var(--theme-primary)' } : {}"
        @click="activeCategory = option.key"
      >
        {{ option.label }} <span class="ml-1 opacity-70">{{ categoryCounts[option.key] }}</span>
      </button>
    </div>

    <div v-if="loading" class="border border-gray-200 rounded-2xl bg-white py-20 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="i-svg-spinners-ring-resize mx-auto text-4xl" style="color: var(--theme-primary)" />
      <p class="mt-3 text-gray-500 dark:text-gray-400">
        正在同步官方商城...
      </p>
    </div>

    <div v-else-if="error" class="border border-amber-200 rounded-2xl bg-amber-50 px-6 py-12 text-center dark:border-amber-800 dark:bg-amber-900/20">
      <div class="i-carbon-warning-alt mx-auto text-4xl text-amber-500" />
      <p class="mt-3 text-amber-800 dark:text-amber-300">
        {{ error }}
      </p>
    </div>

    <div v-else-if="!filteredGoods.length" class="border border-gray-200 rounded-2xl bg-white py-20 text-center text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
      当前分类暂无可购买商品
    </div>

    <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <article
        v-for="item in filteredGoods"
        :key="goodsKey(item)"
        class="group flex flex-col overflow-hidden border border-gray-200 rounded-2xl bg-white shadow-sm transition dark:border-gray-700 dark:bg-gray-800 hover:shadow-lg hover:-translate-y-0.5"
      >
        <div class="flex gap-4 p-5">
          <div class="relative h-24 w-24 flex shrink-0 items-center justify-center overflow-hidden rounded-2xl from-amber-50 to-orange-100 bg-gradient-to-br dark:from-gray-700 dark:to-gray-700/60">
            <img v-if="item.image" :src="item.image" :alt="item.name" class="h-20 w-20 object-contain transition group-hover:scale-105">
            <span v-else class="i-carbon-gift text-4xl text-orange-300" />
            <span v-if="item.isFree" class="absolute right-1 top-1 rounded-lg bg-emerald-500 px-2 py-0.5 text-xs text-white font-bold">免费</span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-2">
              <h2 class="truncate text-lg text-gray-900 font-bold dark:text-white">
                {{ item.name }}
              </h2>
              <span v-if="item.isLimited && !limitText(item)" class="shrink-0 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-500 dark:bg-rose-900/30">限购</span>
            </div>
            <p class="line-clamp-2 mt-2 min-h-10 text-sm text-gray-500 leading-5 dark:text-gray-400" :title="contentsText(item)">
              {{ contentsText(item) }}
            </p>
            <div
              v-if="limitText(item)"
              class="mt-3 inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-bold"
              :class="limitTextClass(item)"
            >
              {{ limitText(item) }}
            </div>
            <div class="mt-3 flex items-end gap-2">
              <strong class="text-xl text-orange-500">{{ item.isFree ? '免费' : formatNumber(item.price.amount) }}</strong>
              <span v-if="!item.isFree" class="pb-0.5 text-sm text-gray-500 dark:text-gray-400">{{ item.price.unit }}</span>
              <span v-if="item.discount" class="mb-0.5 rounded bg-orange-50 px-1.5 py-0.5 text-xs text-orange-500 dark:bg-orange-900/20">{{ item.discount }}</span>
            </div>
            <div class="mt-2 text-xs text-gray-400">
              {{ item.shopName || '道具商城' }}
            </div>
          </div>
        </div>

        <div class="mt-auto flex items-center gap-3 border-t border-gray-100 bg-gray-50/80 px-5 py-4 dark:border-gray-700 dark:bg-gray-900/20">
          <label class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            数量
            <input
              v-model.number="quantities[goodsKey(item)]"
              type="number"
              min="1"
              :max="maxQuantity(item)"
              :disabled="item.isFree || isLimitReached(item)"
              class="h-10 w-16 sm:w-20 border border-gray-200 rounded-lg bg-white px-2 text-center text-gray-900 outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white focus:ring-2"
              style="--tw-ring-color: var(--theme-primary)"
              @blur="normalizeQuantity(item)"
            >
          </label>
          <div class="min-w-0 flex-1 text-right text-xs text-gray-400">
            <span v-if="isLimitReached(item)" class="text-red-500">已达限购</span>
            <span v-else-if="isInsufficient(item)" class="text-red-500">余额不足</span>
            <span v-else-if="!item.isFree">合计 {{ formatNumber(totalPrice(item)) }} {{ item.price.unit }}</span>
          </div>
          <BaseButton :disabled="isPurchaseDisabled(item)" @click="openPurchase(item)">
            <template v-if="item.unlocked === false">
              未解锁
            </template>
            <template v-else-if="isLimitReached(item)">
              已达限购
            </template>
            <template v-else>
              {{ item.isFree ? '领取' : '购买' }}
            </template>
          </BaseButton>
        </div>
      </article>
    </div>

    <ConfirmModal
      :show="!!selectedGoods"
      :loading="purchaseLoading"
      title="确认购买道具"
      :message="purchaseMessage"
      confirm-text="确认下单"
      type="primary"
      @cancel="closePurchase"
      @confirm="confirmPurchase"
    />
  </div>
</template>

