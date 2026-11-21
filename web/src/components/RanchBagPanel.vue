<script setup lang="ts">
/**
 * 牧场背包 —— 独立于农场仓库(ItemService.GetBag{global_scene_id:2})
 *
 * UI 与农场背包(BagPanel)保持一致:
 *   · 页签分类 + 搜索 + 刷新
 *   · 卡片右上角「用」/「售」按钮(由后端 usable / sellable 决定, 前端不猜类型)
 *   · 使用/出售走确认弹窗, 与农场同一套交互
 *
 * 数据来源: GET /api/ranch/bag       (items 含 itemType/usable/sellable/price/uid)
 *           GET /api/ranch/bag/tabs  (页签: 牧场产物/幼崽/饲料/道具)
 *           POST /api/ranch/bag/use  (使用道具)
 *           POST /api/ranch/bag/sell (出售产物)
 */
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LoadingState from '@/components/ui/LoadingState.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const toastStore = useToastStore()
const currentAccountId = computed(() => accountStore.currentAccountId)

const loading = ref(false)
const error = ref('')
const items = ref<any[]>([])
const tabs = ref<any[]>([])
const activeTab = ref(0)
const keyword = ref('')
const imageErrors = ref<Record<string | number, boolean>>({})

const confirmModal = ref({
  show: false,
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  loading: false,
  action: '' as '' | 'use' | 'sell',
  item: null as any,
})

const TAB_NAMES: Record<number, string> = {
  5: '牧场产物',
  6: '牧场幼崽',
  7: '牧场饲料',
  8: '牧场道具',
}

const filtered = computed(() => {
  let list = items.value
  if (activeTab.value !== -1) {
    const tab = tabs.value.find(t => toNumId(t.id) === activeTab.value)
    if (tab) {
      const types = Array.isArray(tab.itemTypes) ? tab.itemTypes.map(Number) : []
      list = types.length ? list.filter(it => types.includes(Number(it.itemType))) : list
    }
  }
  const kw = keyword.value.trim()
  if (kw)
    list = list.filter(it => String(it.name || '').includes(kw) || String(it.id).includes(kw))
  return list
})

function toNumId(v: any) {
  if (v && typeof v === 'object')
    return Number(v.low) || 0
  return Number(v) || 0
}

const totalCount = computed(() => items.value.reduce((n, it) => n + Number(it.count || 0), 0))

/** 能否使用 —— 后端 bakes 的 usable(排除容器/礼包/需选目标的类型) */
function canUse(item: any) {
  return item?.usable === true && Number(item?.count || 0) > 0
}

/** 能否出售 —— 后端 bakes 的 sellable */
function canSell(item: any) {
  return item?.sellable === true && Number(item?.count || 0) > 0
}

function getPriceClass(item: any) {
  const priceId = Number(item?.priceId || 0)
  if (priceId === 1005)
    return 'text-amber-400 dark:text-amber-300'
  if (priceId === 1002)
    return 'text-sky-400 dark:text-sky-300'
  return 'text-gray-400'
}

async function refresh() {
  const id = currentAccountId.value
  if (!id)
    return
  loading.value = true
  error.value = ''
  try {
    const [bagRes, tabRes] = await Promise.all([
      api.get('/api/ranch/bag', { headers: { 'x-account-id': id } }),
      api.get('/api/ranch/bag/tabs', { headers: { 'x-account-id': id } }).catch(() => null),
    ])
    const d = bagRes.data
    if (!d?.ok)
      throw new Error(d?.error || '获取失败')
    items.value = d.data?.items || []
    const t = tabRes?.data
    if (t?.ok)
      tabs.value = t.data?.tabs || []
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取失败'
  }
  finally {
    loading.value = false
  }
}

function tabLabel(id: number) {
  const t = tabs.value.find(x => toNumId(x.id) === id)
  return t?.name || TAB_NAMES[id] || `页签${id}`
}

function openUse(item: any) {
  // 罐头(80021~80034): 点"使用"= 直接喂给牧场里的动物(桶没余量会自动灌)
  const isCan = Number(item.id) >= 80021 && Number(item.id) <= 80034
  confirmModal.value = {
    show: true,
    title: '确认使用',
    message: isCan
      ? `把 ${item.name || `物品${item.id}`} 直接喂给牧场里的动物?\n数量：1（桶里没余量会自动装入 1 罐）`
      : `确定要使用 ${item.name || `物品${item.id}`} 吗?\n数量：${item.count || 0}`,
    type: 'primary',
    loading: false,
    action: 'use',
    item,
  }
}

function openSell(item: any) {
  confirmModal.value = {
    show: true,
    title: '确认出售',
    message: `确定要出售全部 ${item.name || `物品${item.id}`} 吗?\n数量：${item.count || 0}`,
    type: 'danger',
    loading: false,
    action: 'sell',
    item,
  }
}

function cancelModal() {
  confirmModal.value.show = false
}

async function confirmAction() {
  const { action, item } = confirmModal.value
  const id = currentAccountId.value
  if (!id || !item)
    return
  confirmModal.value.loading = true
  try {
    if (action === 'use') {
      const res = await api.post('/api/ranch/bag/use', { itemId: Number(item.id), count: Number(item.count || 1), uid: Number(item.uid || 0) }, { headers: { 'x-account-id': id } })
      const d = res.data
      if (d?.ok) {
        // 罐头走"直接喂动物"链路(后端自动灌桶+FeedAnimal), 提示带上实际效果
        const detail = d?.data?.detail || d?.data?.data?.detail
        toastStore.success(detail ? `已使用：${detail}` : `已使用 ${item.name || `物品${item.id}`}`)
        await refresh()
      }
      else {
        toastStore.error(`使用失败: ${d?.error || '未知错误'}`)
      }
    }
    else if (action === 'sell') {
      const res = await api.post('/api/ranch/bag/sell', { items: [{ id: Number(item.id), count: Number(item.count || 0), uid: Number(item.uid || 0) }] }, { headers: { 'x-account-id': id } })
      const d = res.data
      if (d?.ok) {
        toastStore.success(`已出售 ${item.name || `物品${item.id}`}`)
        await refresh()
      }
      else {
        toastStore.error(`出售失败: ${d?.error || '未知错误'}`)
      }
    }
  }
  catch (e: any) {
    toastStore.error(`操作失败: ${e?.response?.data?.error || e?.message || '未知错误'}`)
  }
  finally {
    confirmModal.value.loading = false
    confirmModal.value.show = false
  }
}

onMounted(refresh)
watch(currentAccountId, () => refresh())
</script>

<template>
  <div class="p-3 sm:p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <div class="i-carbon-archive text-xl text-amber-600" />
        <h2 class="text-lg font-bold">
          牧场背包
        </h2>
        <span class="text-xs text-gray-400">{{ items.length }} 种 · {{ totalCount }} 件</span>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="keyword"
          type="text"
          placeholder="搜索物品"
          class="h-9 w-32 border border-gray-300 rounded-lg bg-white px-2 text-sm outline-none sm:w-40 dark:border-gray-600 dark:bg-gray-800"
        >
        <button
          type="button"
          class="h-9 inline-flex items-center gap-1 border border-gray-300 rounded-lg bg-white px-3 text-sm transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 disabled:opacity-50"
          :disabled="loading"
          @click="refresh"
        >
          <div class="i-carbon-renew" :class="{ 'animate-spin': loading }" />
          刷新
        </button>
      </div>
    </div>

    <!-- 页签 -->
    <div class="mb-3 flex flex-wrap gap-1.5">
      <button
        type="button"
        class="rounded-full px-3 py-1 text-xs transition"
        :class="activeTab === -1 ? 'bg-amber-600 text-white' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'"
        @click="activeTab = -1"
      >
        全部 {{ items.length }}
      </button>
      <button
        v-for="t in tabs"
        :key="toNumId(t.id)"
        type="button"
        class="rounded-full px-3 py-1 text-xs transition"
        :class="activeTab === toNumId(t.id) ? 'bg-amber-600 text-white' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'"
        @click="activeTab = toNumId(t.id)"
      >
        {{ tabLabel(toNumId(t.id)) }}
      </button>
    </div>

    <div v-if="!currentAccountId" class="py-10 text-center text-sm text-gray-400">
      请先选择账号
    </div>
    <LoadingState v-else-if="loading && !items.length" text="加载中…" />
    <div v-else-if="error" class="border border-red-200 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
      {{ error }}
    </div>
    <div v-else-if="!filtered.length" class="py-10 text-center text-sm text-gray-400">
      这个页签是空的
    </div>
    <div v-else class="grid grid-cols-2 gap-2 2xl:grid-cols-6 lg:grid-cols-4 md:grid-cols-3 sm:grid-cols-3">
      <div
        v-for="it in filtered"
        :key="`${it.id}-${it.uid || 0}`"
        class="relative flex flex-col items-center border border-gray-200 rounded-lg bg-white p-2 transition dark:border-gray-700 hover:border-amber-300 dark:bg-gray-800 dark:hover:border-amber-700"
      >
        <div class="absolute left-2 top-2 text-xs text-gray-400 font-mono">
          #{{ it.id }}
        </div>

        <!-- 使用 / 出售(与农场背包同一套按钮) -->
        <div class="absolute right-1 top-1 flex gap-1">
          <button
            v-if="canSell(it)"
            class="rounded bg-red-500 px-1.5 py-0.5 text-[10px] text-white opacity-70 transition dark:bg-red-600 hover:opacity-100"
            title="出售全部"
            @click.stop="openSell(it)"
          >
            售
          </button>
          <button
            v-if="canUse(it)"
            class="rounded bg-green-500 px-1.5 py-0.5 text-[10px] text-white opacity-70 transition dark:bg-green-600 hover:opacity-100"
            title="使用全部"
            @click.stop="openUse(it)"
          >
            用
          </button>
        </div>

        <div class="mb-1 mt-6 h-14 w-14 flex items-center justify-center overflow-hidden rounded-full bg-gray-50 dark:bg-gray-900/40">
          <img
            v-if="it.image && !imageErrors[it.id]"
            :src="it.image"
            :alt="it.name"
            class="max-h-full max-w-full object-contain"
            loading="lazy"
            @error="imageErrors[it.id] = true"
          >
          <span v-else class="text-2xl text-gray-400 font-bold">{{ (it.name || '物').slice(0, 1) }}</span>
        </div>

        <div class="w-full truncate px-1 text-center text-xs font-bold" :title="it.name">
          {{ it.name || `物品#${it.id}` }}
        </div>

        <div class="mb-1 mt-0.5 flex flex-col items-center gap-0.5 text-[10px] text-gray-400">
          <span>
            类型 {{ it.itemType || 0 }}
            <span v-if="it.level > 0"> · Lv{{ it.level }}</span>
            <span v-if="it.price > 0" :class="getPriceClass(it)"> · {{ it.price }}{{ it.priceUnit || '金' }}</span>
          </span>
        </div>

        <div class="mt-auto text-xs font-medium" :class="it.hoursText ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'">
          {{ it.hoursText || `x${it.count || 0}` }}
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="confirmModal.show"
      :title="confirmModal.title"
      :message="confirmModal.message"
      :type="confirmModal.type"
      :loading="confirmModal.loading"
      :confirm-text="confirmModal.action === 'sell' ? '确认出售' : '确认使用'"
      @confirm="confirmAction"
      @cancel="cancelModal"
    />
  </div>
</template>
