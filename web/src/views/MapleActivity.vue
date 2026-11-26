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

/** ===== 出售记录 ===== */
const recordsLoading = ref(false)
const records = ref<any[]>([])
const recordSummary = ref<any>({})
const recordLimit = ref(50)
const recordTotal = ref(0)

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
/** 实卖单价 = 基础价 + 摊上存量(服务端算, cmd98#3) */
const sellPrice = computed(() => Number(state.value.sellPrice) || 0)
/** 摊上存量(好友卖到你摊上的蜜薯, 也是溢价的来源) */
const stallHolding = computed(() => Number(state.value.stallHolding) || 0)

/** 槽位状态: #7=1 的槽实测是已解锁可兑换 */
function slotVisible(s: any) {
  return !!s.visible
}
function slotSoldOut(s: any) {
  return s.limit > 0 && (s.sold || 0) >= s.limit
}
const exchangeableCount = computed(() =>
  slots.value.filter((s: any) => slotVisible(s) && !slotSoldOut(s)).length)

/** 分享暴击状态(服务端落盘, 每日自动一次): todayDone=今天已分享过 */
const shareState = computed<any>(() => data.value?.shareState || {})
const shareDoneToday = computed(() => !!shareState.value.todayDone)

/** ===== 兑换数量: 每槽独立, 默认 1, 上限 = limit-已购(无限制则 99) ===== */
const exchangeCounts = ref<Record<number, number>>({})
function maxExchange(s: any) {
  const limit = Number(s.limit) || 0
  const sold = Number(s.sold) || 0
  const remain = limit > 0 ? Math.max(0, limit - sold) : 99
  return Math.max(1, Math.min(remain, 99))
}
function exchangeCount(s: any) {
  const v = Number(exchangeCounts.value[s.slot]) || 1
  return Math.min(Math.max(1, v), maxExchange(s))
}
function setExchangeCount(s: any, v: any) {
  const n = Math.min(Math.max(1, Number(v) || 1), maxExchange(s))
  exchangeCounts.value = { ...exchangeCounts.value, [s.slot]: n }
}
function bumpExchange(s: any, delta: number) {
  setExchangeCount(s, exchangeCount(s) + delta)
}
function onCountInput(s: any, ev: Event) {
  setExchangeCount(s, (ev.target as HTMLInputElement).value)
}
/** 本次兑换总价 */
function exchangeCost(s: any) {
  return (Number(s.price) || 0) * exchangeCount(s)
}

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
    // 出售记录(独立文件持久化, 和主状态并行取)
    await fetchRecords()
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取失败'
  }
  finally {
    loading.value = false
  }
}

/** 蜜薯出售记录: 数量/单价/收入/卖给谁 */
async function fetchRecords() {
  const id = currentAccountId.value
  if (!id)
    return
  recordsLoading.value = true
  try {
    const res = await api.get('/api/activity/maple/sell-records', {
      headers: { 'x-account-id': id },
      params: { limit: recordLimit.value },
    })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '获取出售记录失败')
    records.value = d.data?.records || []
    recordSummary.value = d.data?.summary || {}
    recordTotal.value = Number(d.data?.total) || 0
  }
  catch {
    records.value = []
    recordSummary.value = {}
    recordTotal.value = 0
  }
  finally {
    recordsLoading.value = false
  }
}

async function clearRecords() {
  const id = currentAccountId.value
  if (!id)
    return
  try {
    await api.delete('/api/activity/maple/sell-records', { headers: { 'x-account-id': id } })
    toast.success('出售记录已清空')
    await fetchRecords()
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '清空失败')
  }
}

/** 时间戳 → MM-DD HH:mm */
function fmtTime(ts: number) {
  const n = Number(ts) || 0
  if (!n)
    return '—'
  const d = new Date(n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function num(v: any) {
  return Number(v) || 0
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
/** 分享暴击: 上报「分享收购价」→ 当日收购价上涨(每日首次) */
function shareCrit() {
  return doAction('/api/activity/maple/share-crit', {}, (d) => {
    if (d?.ok === false)
      return d?.reason || '分享未生效'
    const before = d?.basePriceBefore ?? 0
    const after = d?.basePriceAfter ?? 0
    const crit = Number(d?.crit) || 0
    if (crit > 0)
      return `分享暴击生效：基础价 ${before} → ${after}（+${crit}）`
    return `已分享（今日第 ${d?.shareCount ?? 1} 次），基础价 ${after} 未变（实测首分享也不涨）`
  })
}
function sellAll() {
  return doAction('/api/activity/maple/sell', { count: 0 }, (d) => {
    const where = d?.targetName ? `卖给 ${d.targetName}${d.selfStall ? '（自己摊）' : ''}，` : ''
    const left = Number(d?.remaining) > 0 ? `，还剩 ${d.remaining} 个` : ''
    return `已卖出蜜薯 ×${d?.soldCount || 0}（${where}+${d?.income || 0} 福气币）${left}`
  })
}
const runAuto = () => doAction('/api/activity/maple/run-auto', {}, () => '已执行自动流程（领种子+卖薯）')

async function exchangeSlot(s: any) {
  const count = exchangeCount(s)
  await doAction('/api/activity/maple/exchange', { slot: s.slot, count }, d =>
    `兑换成功：${(d?.got || []).map((g: any) => `${itemName(g.id)}×${g.count}`).join('、') || '空'}（- ${d?.spend || 0} 福气币）`)
  setExchangeCount(s, 1)
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
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-rose-500 rounded-lg bg-rose-600 px-3 py-2 text-sm text-white font-medium transition hover:bg-rose-700 disabled:opacity-50"
          :disabled="busy || loading"
          :title="`上报「分享收购价」（每日自动一次${shareDoneToday ? '，今天已分享' : ''}；实测基础价不变，保留按钮可手动补一次）`"
          @click="shareCrit"
        >
          <div class="i-carbon-share" />
          分享暴击
          <span
            v-if="shareDoneToday"
            class="ml-0.5 rounded bg-white/25 px-1.5 py-0.5 text-[10px] font-normal"
          >今日已分享</span>
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
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4 sm:grid-cols-3">
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
            拥有蜜薯
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
            实卖单价
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ sellPrice }}
          </div>
          <div class="text-xs text-gray-400">
            基础 {{ basePrice }} + 存量 {{ stallHolding }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            今日种子
          </div>
          <div class="mt-1 text-xl font-bold" :class="claimedToday ? 'text-green-600' : 'text-amber-600'">
            {{ claimedToday ? '已领' : '未领' }}
          </div>
          <div class="text-xs text-gray-400">
            背包种子 {{ state.bagSeedCount ?? '—' }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            剩余接收额度
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ stall.quotaLeft ?? '—' }}
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            游戏累计收益
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ totalIncome }}
          </div>
          <div class="text-xs text-gray-400">
            cmd98#5（实测不随卖薯变化）
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            今日卖出
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ num(recordSummary.todayCount) }}
          </div>
          <div class="text-xs text-gray-400">
            {{ num(recordSummary.todayBatches) }} 批
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            记录累计收入
          </div>
          <div class="mt-1 text-xl font-bold">
            {{ num(recordSummary.income) }}
          </div>
          <div class="text-xs text-gray-400">
            共 {{ recordTotal }} 批
          </div>
        </div>
        <div class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-400">
            今日收入
          </div>
          <div class="mt-1 text-xl text-amber-600 font-bold">
            {{ num(recordSummary.todayIncome) }}
          </div>
          <div class="text-xs text-gray-400">
            福气币
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
            class="flex flex-col gap-2 border border-gray-200 rounded-lg px-3 py-2 dark:border-gray-700"
            :class="slotSoldOut(s) ? 'opacity-50' : ''"
          >
            <div>
              <div class="text-sm font-medium">
                {{ s.goodsName || `槽位${s.slot}` }}
              </div>
              <div class="text-xs text-gray-400">
                {{ s.price }} 福气币 · {{ slotSoldOut(s) ? '已兑完' : slotVisible(s) ? '可兑换' : '未解锁' }}
                <span v-if="s.limit > 0"> · 已购 {{ num(s.sold) }}/{{ s.limit }}</span>
              </div>
            </div>
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="h-7 w-7 border border-gray-300 rounded-md text-sm leading-none transition dark:border-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-700"
                  :disabled="busy || exchangeCount(s) <= 1"
                  title="减少"
                  @click="bumpExchange(s, -1)"
                >
                  −
                </button>
                <input
                  type="number"
                  class="h-7 w-12 border border-gray-300 rounded-md bg-white px-1 text-center text-xs dark:border-gray-600 dark:bg-gray-900"
                  min="1"
                  :max="maxExchange(s)"
                  :value="exchangeCount(s)"
                  :disabled="busy || !slotVisible(s) || slotSoldOut(s)"
                  @input="onCountInput(s, $event)"
                  @blur="setExchangeCount(s, exchangeCount(s))"
                >
                <button
                  type="button"
                  class="h-7 w-7 border border-gray-300 rounded-md text-sm leading-none transition dark:border-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-700"
                  :disabled="busy || exchangeCount(s) >= maxExchange(s)"
                  title="增加"
                  @click="bumpExchange(s, 1)"
                >
                  +
                </button>
                <button
                  type="button"
                  class="h-7 border border-gray-300 rounded-md px-1.5 text-[11px] transition dark:border-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-700"
                  :disabled="busy || exchangeCount(s) >= maxExchange(s)"
                  title="买到上限"
                  @click="setExchangeCount(s, maxExchange(s))"
                >
                  最大
                </button>
              </div>
              <button
                type="button"
                class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white font-medium transition disabled:cursor-not-allowed hover:bg-amber-700 disabled:opacity-40"
                :disabled="busy || !slotVisible(s) || slotSoldOut(s) || coin < exchangeCost(s)"
                @click="exchangeSlot(s)"
              >
                兑换{{ exchangeCount(s) > 1 ? `×${exchangeCount(s)}` : '' }}（{{ num(exchangeCost(s)) }}）
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 出售记录: 卖了多少 / 单价 / 收入 / 卖给谁 -->
      <section class="border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 class="flex items-center gap-1.5 text-sm font-semibold">
            <div class="i-carbon-receipt text-emerald-600" />
            出售记录
            <span class="text-xs text-gray-400 font-normal">
              记录累计 {{ num(recordSummary.count) }} 个 · {{ num(recordSummary.income) }} 福气币 · 共 {{ recordTotal }} 批
            </span>
          </h4>
          <div class="flex items-center gap-2">
            <select v-model.number="recordLimit" class="border border-gray-300 rounded-lg bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800" @change="fetchRecords">
              <option :value="20">
                最近 20
              </option>
              <option :value="50">
                最近 50
              </option>
              <option :value="200">
                最近 200
              </option>
            </select>
            <button
              type="button"
              class="inline-flex items-center gap-1 border border-gray-300 rounded-lg px-2 py-1 text-xs transition dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
              :disabled="recordsLoading"
              @click="fetchRecords"
            >
              <div class="i-carbon-renew" :class="{ 'animate-spin': recordsLoading }" />
              刷新
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1 border border-red-300 rounded-lg px-2 py-1 text-xs text-red-600 transition dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
              :disabled="recordsLoading || !records.length"
              @click="clearRecords"
            >
              <div class="i-carbon-trash-can" />
              清空
            </button>
          </div>
        </div>

        <div v-if="recordSummary.targets && recordSummary.targets.length" class="mb-2 flex flex-wrap gap-2">
          <span
            v-for="t in recordSummary.targets"
            :key="t.name"
            class="inline-flex items-center gap-1 border border-gray-200 rounded-full px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300"
          >
            {{ t.name }}
            <span class="text-gray-400">{{ t.count }} 个 / {{ t.income }} 币</span>
          </span>
        </div>

        <div v-if="!records.length" class="py-6 text-center text-xs text-gray-400">
          {{ recordsLoading ? '加载中…' : '还没有出售记录（自动流程卖出后会自动记账）' }}
        </div>
        <div v-else class="space-y-1.5">
          <div
            v-for="(r, i) in records"
            :key="`${r.at}-${i}`"
            class="flex flex-wrap items-center justify-between gap-2 border border-gray-100 rounded px-2.5 py-2 text-xs dark:border-gray-700"
          >
            <div class="flex items-center gap-2">
              <span class="text-gray-400">{{ fmtTime(r.at) }}</span>
              <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {{ r.source === 'auto' ? '自动' : '手动' }}
              </span>
              <span class="font-medium">×{{ r.soldCount }}</span>
              <span class="text-gray-400">@</span>
              <span class="font-medium">{{ r.unitPrice }}</span>
              <span v-if="r.stallBasePrice != null" class="text-[11px] text-gray-400">
                ({{ r.stallBasePrice }}基础 + {{ r.stallHolding ?? 0 }}存量)
              </span>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-emerald-600 font-semibold">+{{ r.income }}</span>
              <span class="text-gray-500">
                卖给 <span class="font-medium">{{ r.targetName }}</span>
                <span v-if="r.selfStall" class="text-[11px] text-gray-400">(自己摊)</span>
              </span>
              <span class="text-[11px] text-gray-400">余额 {{ r.coinAfter }}</span>
            </div>
          </div>
        </div>
      </section>

      <div class="text-xs text-gray-400">
        说明: 卖出价由服务端结算（今日基础价 + 摊上存量）。每日 24:00 系统按 80 金收购剩余蜜薯并清仓，远低于摊位价 — 建议每天卖光。分享收购价已接入自动流程（游戏文案写「每日首次可暴击」，实测分享前后基础价不变，效果待观察）。
      </div>
    </div>
  </div>
</template>
