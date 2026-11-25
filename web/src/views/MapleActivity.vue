<script setup lang="ts">
/**
 * 以薯换福(2026-11-25 新活动, 11/25 – 12/09) —— 状态查看 + 手动操作
 *
 * 协议: services/maple-market.js (group 2026111708, cmd 91/92/93/96/97/98)
 * 机制: 每日领红薯种子 → 种普通地 → 收蜜薯 → 卖自己摊位(服务端算价, 基础价+持有溢价)
 *      → 福气币兑换道具; 24:00 按 80 金清仓结算, 所以自动化策略是"有蜜薯就卖光"
 */
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import LoadingState from '@/components/ui/LoadingState.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const toast = useToastStore()
const currentAccountId = computed(() => accountStore.currentAccountId)

const loading = ref(false)
const busy = ref(false)
const error = ref('')
const data = ref<any>(null)

const ITEM_NAMES: Record<number, string> = {
  20307: '红薯种子',
  40307: '红薯',
  1032: '蜜薯',
  1033: '福气币',
  80001: '化肥(1h)',
  1001: '金币',
  1002: '点券',
}
/** 兑换结果物品名(服务端 got[].name 缺失时兜底) */
function itemName(id: number) {
  return ITEM_NAMES[Number(id)] || `物品#${id}`
}

const state = computed(() => data.value?.state || {})
const stall = computed(() => data.value?.stall || {})
const slots = computed<any[]>(() => data.value?.exchangeSlots || [])
const coin = computed(() => data.value?.coin || state.value.coin || 0)

const claimedToday = computed(() => !!state.value.seedClaimed)
const holding = computed(() => Number(state.value.holding) || 0)
const basePrice = computed(() => Number(state.value.basePrice) || 0)
const totalIncome = computed(() => Number(state.value.totalIncome) || 0)

/** 槽位状态: #7=1 的槽实测是已解锁可兑换 */
function slotVisible(s: any) {
  return !!s.visible
}
function slotSoldOut(s: any) {
  return s.limit > 0 && (s.sold || 0) >= s.limit
}
const exchangeableCount = computed(() =>
  slots.value.filter((s: any) => slotVisible(s) && !slotSoldOut(s)).length)

async function refresh() {
  const id = currentAccountId.value
  if (!id)
    return
  loading.value = true
  error.value = ''
  try {
    const res = await api.get('/api/activity/maple', { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '获取失败')
    data.value = d.data
    if (data.value?.error)
      error.value = data.value.error
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取失败'
  }
  finally {
    loading.value = false
  }
}

async function doAction(path: string, body: any, doneMsg: (d: any) => string) {
  const id = currentAccountId.value
  if (!id)
    return
  busy.value = true
  try {
    const res = await api.post(path, body, { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '操作失败')
    const inner = d.data
    if (inner && inner.ok === false)
      throw new Error(inner.reason || '操作失败')
    toast.success(doneMsg(inner))
    await refresh()
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '操作失败')
  }
  finally {
    busy.value = false
  }
}

const claimSeed = () => doAction('/api/activity/maple/claim-seed', {}, () => '已领红薯种子')
function sellAll() {
  return doAction('/api/activity/maple/sell', { count: 0 }, d =>
    `已卖出蜜薯 ×${d?.soldCount || 0}（+${d?.income || 0} 福气币）`)
}
const runAuto = () => doAction('/api/activity/maple/run-auto', {}, () => '已执行自动流程（领种子+卖薯）')

async function exchangeSlot(s: any) {
  await doAction('/api/activity/maple/exchange', { slot: s.slot, count: 1 }, d =>
    `兑换成功：${(d?.got || []).map((g: any) => `${itemName(g.id)}×${g.count}`).join('、') || '空'}（- ${d?.spend || 0} 福气币）`)
}

onMounted(refresh)
watch(currentAccountId, () => refresh())
</script>

<template>
  <div class="p-3 sm:p-4">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="i-carbon-sprout text-xl text-amber-600" />
        <h2 class="text-lg font-bold">
          以薯换福
        </h2>
        <span class="text-xs text-gray-400">11/25 – 12/09</span>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 disabled:opacity-50 dark:hover:bg-gray-700"
          :disabled="loading"
          @click="refresh"
        >
          <div class="i-carbon-renew" :class="{ 'animate-spin': loading }" />
          刷新
        </button>
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-amber-500 rounded-lg bg-amber-600 px-3 py-2 text-sm text-white font-medium transition hover:bg-amber-700 disabled:opacity-50"
          :disabled="busy || loading"
          @click="claimSeed"
        >
          <div class="i-carbon-gift" />
          领种子
        </button>
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-orange-500 rounded-lg bg-orange-600 px-3 py-2 text-sm text-white font-medium transition hover:bg-orange-700 disabled:opacity-50"
          :disabled="busy || loading || holding <= 0"
          :title="holding <= 0 ? '没有蜜薯' : `卖出全部 ${holding} 个蜜薯`"
          @click="sellAll"
        >
          <div class="i-carbon-shopping-cart" />
          卖蜜薯（{{ holding }}）
        </button>
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-gray-400 rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium transition dark:border-gray-600 dark:bg-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:hover:bg-gray-600"
          :disabled="busy || loading"
          @click="runAuto"
        >
          <div class="i-carbon-play" />
          跑一遍自动
        </button>
      </div>
    </div>

    <div v-if="!currentAccountId" class="py-12 text-center text-sm text-gray-400">
      请先选择账号
    </div>
    <LoadingState v-else-if="loading && !data" text="加载中…" />
    <div v-else-if="error" class="border border-red-200 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
      {{ error }}
    </div>
    <div v-else-if="data" class="space-y-3">
      <!-- 概览卡片 -->
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-6 sm:grid-cols-3">
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            福气币
          </div>
          <div class="mt-1 text-xl text-amber-600 font-bold">
            {{ coin }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            持有蜜薯
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ holding }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            今日基础价
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ basePrice }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            今日种子
          </div>
          <div class="mt-1 text-xl font-bold" :class="claimedToday ? 'text-green-600' : 'text-amber-600'">
            {{ claimedToday ? '已领' : '未领' }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            摊位接收额度
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ stall.quotaLeft ?? '—' }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            累计收益
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ totalIncome }}
          </div>
        </div>
      </div>

      <!-- 兑换商店 -->
      <section class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex items-center gap-2">
          <h4 class="flex items-center gap-1.5 text-sm font-semibold">
            <div class="i-carbon-store text-amber-600" />
            福气兑换
          </h4>
          <span class="text-xs text-gray-400">可兑换 {{ exchangeableCount }} 项 · 福气币 {{ coin }}</span>
        </div>
        <div class="grid grid-cols-1 gap-2 lg:grid-cols-3 sm:grid-cols-2">
          <div
            v-for="s in slots"
            :key="s.slot"
            class="flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2 dark:border-gray-700"
            :class="slotSoldOut(s) ? 'opacity-50' : ''"
          >
            <div>
              <div class="text-sm font-medium">
                {{ s.price }} 福气币
              </div>
              <div class="text-xs text-gray-400">
                {{ slotSoldOut(s) ? '已兑完' : slotVisible(s) ? '可兑换' : '未解锁' }}
              </div>
            </div>
            <button
              type="button"
              class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white font-medium transition disabled:cursor-not-allowed hover:bg-amber-700 disabled:opacity-40"
              :disabled="busy || !slotVisible(s) || slotSoldOut(s) || coin < s.price"
              @click="exchangeSlot(s)"
            >
              兑换
            </button>
          </div>
        </div>
      </section>

      <div class="text-xs text-gray-400">
        说明: 卖出价由服务端结算（今日基础价 + 持有量溢价）。每日 24:00 系统按 80 金收购剩余蜜薯并清仓，远低于摊位价 — 建议每天卖光。每日首次分享有暴击加成（未实现）。
      </div>
    </div>
  </div>
</template>
