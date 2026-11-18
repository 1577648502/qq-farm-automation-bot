<script setup lang="ts">
/**
 * 牧场背包 —— 独立于农场仓库(ItemService.GetBag{global_scene_id:2})
 *
 * 数据来源: GET /api/ranch/bag (返回 items 含 itemType/name/count)
 *           GET /api/ranch/bag/tabs (页签: 牧场产物/幼崽/饲料/道具)
 *
 * 这是一个可嵌入的面板(被「我的背包」页当作一个页签使用, 不再自己渲染标题栏)。
 * mounted 时自动拉一次; 切账号时重拉。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import api from '@/api'
import LoadingState from '@/components/ui/LoadingState.vue'

const accountStore = useAccountStore()
const currentAccountId = computed(() => accountStore.currentAccountId)

const loading = ref(false)
const error = ref('')
const items = ref<any[]>([])
const tabs = ref<any[]>([])
const activeTab = ref(0)
const keyword = ref('')

const TAB_NAMES: Record<number, string> = {
  2: '牧场产物', 1: '牧场幼崽', 0: '牧场饲料', 6: '牧场道具',
}

const filtered = computed(() => {
  let list = items.value
  // tab 过滤: itemType 与页签 id 对应(实测 产物=2 / 幼崽=1 / 饲料=0 / 道具=6)
  if (activeTab.value !== -1) {
    const tab = tabs.value.find(t => t.id === activeTab.value)
    if (tab) list = list.filter(it => Number(it.itemType) === activeTab.value)
  }
  const kw = keyword.value.trim()
  if (kw) list = list.filter(it => String(it.name || '').includes(kw) || String(it.id).includes(kw))
  return list
})

const totalCount = computed(() => items.value.reduce((n, it) => n + Number(it.count || 0), 0))

async function refresh() {
  const id = currentAccountId.value
  if (!id) return
  loading.value = true
  error.value = ''
  try {
    const [bagRes, tabRes] = await Promise.all([
      api.get('/api/ranch/bag', { headers: { 'x-account-id': id } }),
      api.get('/api/ranch/bag/tabs', { headers: { 'x-account-id': id } }).catch(() => null),
    ])
    const d = bagRes.data
    if (!d?.ok) throw new Error(d?.error || '获取失败')
    items.value = d.data?.items || []
    const t = tabRes?.data
    if (t?.ok) tabs.value = t.data?.tabs || []
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取失败'
  } finally {
    loading.value = false
  }
}

function tabLabel(id: number) {
  const t = tabs.value.find(x => x.id === id)
  return t?.name || TAB_NAMES[id] || `页签${id}`
}

onMounted(refresh)
watch(currentAccountId, () => refresh())
</script>

<template>
  <div class="p-3 sm:p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <div class="i-carbon-archive text-xl text-amber-600" />
        <h2 class="text-lg font-bold">牧场背包</h2>
        <span class="text-xs text-gray-400">{{ items.length }} 种 · {{ totalCount }} 件</span>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="keyword"
          type="text"
          placeholder="搜索物品"
          class="h-9 w-32 border border-gray-300 rounded-lg bg-white px-2 text-sm outline-none dark:border-gray-600 dark:bg-gray-800 sm:w-40"
        >
        <button
          type="button"
          class="h-9 inline-flex items-center gap-1 border border-gray-300 rounded-lg bg-white px-3 text-sm transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
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
        :key="t.id"
        type="button"
        class="rounded-full px-3 py-1 text-xs transition"
        :class="activeTab === t.id ? 'bg-amber-600 text-white' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'"
        @click="activeTab = t.id"
      >
        {{ tabLabel(t.id) }}
      </button>
    </div>

    <div v-if="!currentAccountId" class="py-10 text-center text-sm text-gray-400">请先选择账号</div>
    <LoadingState v-else-if="loading && !items.length" text="加载中…" />
    <div v-else-if="error" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
      {{ error }}
    </div>
    <div v-else-if="!filtered.length" class="py-10 text-center text-sm text-gray-400">这个页签是空的</div>
    <div v-else class="grid gap-2 2xl:grid-cols-6 lg:grid-cols-4 md:grid-cols-3 sm:grid-cols-3 grid-cols-2">
      <div
        v-for="it in filtered"
        :key="`${it.id}-${it.uid || 0}`"
        class="flex flex-col items-center rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-800"
      >
        <div class="mb-1 h-10 w-10 flex items-center justify-center rounded bg-gray-50 dark:bg-gray-900/40">
          <span class="text-xl">📦</span>
        </div>
        <div class="w-full truncate text-center text-[11px] font-medium" :title="it.name">
          {{ it.name || `物品#${it.id}` }}
        </div>
        <div class="mt-0.5 text-[11px] text-gray-500">x{{ it.count }}</div>
        <div class="text-[10px] text-gray-300">#{{ it.id }}</div>
      </div>
    </div>
  </div>
</template>
