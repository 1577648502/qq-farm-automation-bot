<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import LoadingState from '@/components/ui/LoadingState.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { useRanchStore, type RanchFacility } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

/**
 * 牧场面板(11-17 新玩法)。
 * 功能对照农场面板: 总览 + 每只动物按状态手动操作; 自动行为由设置里的牧场开关控制。
 * 喂食方式枚举(4/5/6)抓包还没确认完整语义, 界面先只提供"巡牧场"这一条经过验证的路径。
 */
const ranchStore = useRanchStore()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { overview, loading } = storeToRefs(ranchStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, loading: statusLoading, realtimeConnected } = storeToRefs(statusStore)
void currentAccount

/**
 * 嵌入模式: 由父页面(个人 → 我的牧场)传入。
 * 为 true 时只显示"总览"内容, 隐藏本页的页签栏 —— 否则会出现
 * 「个人页签 → 牧场页签」两层嵌套, 手机上没法用。
 */
withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const currentTab = ref<'overview' | 'cubShop' | 'tiers' | 'tasks' | 'buildings'>('overview')
const cubShopLoading = ref(false)
const cubShopError = ref('')
const cubShopList = ref<any[]>([])

// ===== 牧场商城(道具/幼崽分类) =====
// 商店分工(抓包实证): shop5=幼崽, shop6=道具(牧草)
const ranchShopCategory = ref<'all' | 'item' | 'cub'>('item')
const ranchShopItems = ref<any[]>([])
const ranchShopLoading = ref(false)
const ranchShopError = ref('')
const grassBuyCount = ref(10)
const grassBuying = ref(false)

async function loadRanchShop(category?: 'all' | 'item' | 'cub') {
  const id = currentAccountId.value
  if (!id) return
  if (category) ranchShopCategory.value = category
  ranchShopLoading.value = true
  ranchShopError.value = ''
  try {
    const res = await api.get('/api/ranch/shop', {
      params: { category: ranchShopCategory.value },
      headers: { 'x-account-id': id },
    })
    const d = res.data
    if (!d?.ok) throw new Error(d?.error || '获取牧场商城失败')
    ranchShopItems.value = d.data?.items || []
  } catch (e: any) {
    ranchShopError.value = e?.response?.data?.error || e?.message || '获取牧场商城失败'
  } finally {
    ranchShopLoading.value = false
  }
}

const ranchShopFiltered = computed(() =>
  ranchShopItems.value.filter((g: any) => ranchShopCategory.value === 'all' || g.category === ranchShopCategory.value))

const ranchShopCounts = computed(() => {
  const all = ranchShopItems.value
  return {
    all: all.length,
    item: all.filter((g: any) => g.category === 'item').length,
    cub: all.filter((g: any) => g.category === 'cub').length,
  }
})

/** 手动买牧草 */
async function buyGrassManually() {
  const id = currentAccountId.value
  if (!id || grassBuying.value) return
  const n = Math.max(1, Math.floor(Number(grassBuyCount.value) || 1))
  grassBuying.value = true
  try {
    const res = await api.post('/api/ranch/grass/buy', { count: n }, { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok) throw new Error(d?.error || '购买失败')
    const r = d.data || {}
    if (r.ok) toast.success(`已买牧草 ${r.bought} 个，花 ${r.spent}`)
    else toast.error(r.error || '购买失败')
    await loadRanchShop()
    await reloadCubShop()
  } catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '购买失败')
  } finally {
    grassBuying.value = false
  }
}

/** 手动买幼崽(复用加购流程) */
async function buyCubManually(g: any) {
  const id = currentAccountId.value
  if (!id) return
  try {
    const r = await ranchStore.operate(id, { op: 'buycub', goodsId: g.goodsId, count: 1, price: g.price })
    if (r?.ok === false) throw new Error(r.error || '购买失败')
    toast.success(`已买 ${g.name} x${(r as any)?.bought ?? 1}`)
    await loadRanchShop()
    await reloadCubShop()
  } catch (e: any) {
    toast.error(e?.message || '购买失败')
  }
}
// 幼崽商城筛选/排序(对照种子商城的 FILTERS)
const cubFilter = ref<'all' | 'available' | 'locked' | 'soldout'>('all')
const cubSort = ref<'ratio' | 'price' | 'profit'>('ratio')

/** 筛选后的幼崽列表 */
const cubShopFiltered = computed(() => {
  const all = Array.isArray(cubShopList.value) ? cubShopList.value : []
  const list = all.filter((g: any) => {
    if (!g) return false
    // 后端老版本可能没有 remaining / profit 字段, 一律做空值保护
    const remain = g.remaining
    const noLimit = remain === null || remain === undefined
    switch (cubFilter.value) {
      case 'available': return !!g.unlocked && (noLimit || Number(remain) > 0)
      case 'locked': return !g.unlocked
      case 'soldout': return !!g.unlocked && !noLimit && Number(remain) <= 0
      default: return true
    }
  })
  const copy = [...list]
  if (cubSort.value === 'price')
    copy.sort((a: any, b: any) => (Number(a?.price) || 0) - (Number(b?.price) || 0))
  else if (cubSort.value === 'profit')
    copy.sort((a: any, b: any) => (Number(b?.profit ?? -1) || -1) - (Number(a?.profit ?? -1) || -1))
  else
    copy.sort((a: any, b: any) => (Number(b?.valueRatio) || 0) - (Number(a?.valueRatio) || 0))
  return copy
})

const cubCounts = computed(() => {
  const all = Array.isArray(cubShopList.value) ? cubShopList.value : []
  const isAvail = (g: any) => {
    const remain = g?.remaining
    const noLimit = remain === null || remain === undefined
    return !!g?.unlocked && (noLimit || Number(remain) > 0)
  }
  return {
    all: all.length,
    available: all.filter(isAvail).length,
    locked: all.filter((g: any) => g && !g.unlocked).length,
    soldout: all.filter((g: any) => {
      const remain = g?.remaining
      return !!g?.unlocked && remain !== null && remain !== undefined && Number(remain) <= 0
    }).length,
  }
})

/** 筛选按钮配置(模板里只引用, 不在表达式里构造对象) */
const CUB_FILTERS: Array<{ key: 'all' | 'available' | 'locked' | 'soldout', label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'available', label: '可购买' },
  { key: 'locked', label: '未解锁' },
  { key: 'soldout', label: '已售罄' },
]
const cubBuyBusy = ref(0)
// 幼崽商城加购(对齐农场商城「道具商城」的交互架构):
//   quantities: goodsId -> 数量;  selectedCub: 待确认下单的商品;  确认弹窗
const cubQuantities = reactive<Record<number, number>>({})
const selectedCub = ref<any>(null)
const cubConfirmLoading = ref(false)
// 金券余额(后端 /api/ranch/cub-shop 一起返回); null = 读不到, 不做余额拦截
const voucherBalance = ref<number | null>(null)
const tiersLoading = ref(false)
const tiersError = ref('')
const tiersList = ref<Array<{ level: number, requiredWeight: number, rewards: Array<{ itemId: number, count: number }> }>>([])

function itemLabel(itemId: number) {
  if (itemId === 1002)
    return '点券'
  if (itemId === 80023)
    return '罐头(8h)'
  if (itemId === 80021)
    return '罐头(1h)'
  if (itemId === 80031)
    return '有机罐头(1h)'
  if (itemId === 1007)
    return '金券'
  return `#${itemId}`
}

async function openTiers() {
  currentTab.value = 'tiers'
  const id = currentAccountId.value
  if (!id || tiersList.value.length)
    return
  tiersLoading.value = true
  tiersError.value = ''
  try {
    const r = await ranchStore.fetchWeightScore(id)
    tiersList.value = r.tiers || []
  }
  catch (e: any) {
    tiersError.value = e?.message || '获取饲养档位失败'
  }
  finally {
    tiersLoading.value = false
  }
}

async function openCubShop() {
  currentTab.value = 'cubShop'
  await Promise.all([reloadCubShop(), loadRanchShop()])
}

/** 拉一次幼崽商店(带金券余额), 把每行的数量归一到合法区间 */
async function reloadCubShop() {
  const id = currentAccountId.value
  if (!id)
    return
  cubShopLoading.value = true
  cubShopError.value = ''
  try {
    const r = await ranchStore.fetchCubShop(id)
    cubShopList.value = r.shop || []
    voucherBalance.value = r.voucher ?? null
    for (const g of cubShopList.value) {
      if (!cubQuantities[g.goodsId])
        cubQuantities[g.goodsId] = 1
      normalizeCubQuantity(g)
    }
  }
  catch (e: any) {
    cubShopError.value = e?.message || '获取幼崽商店失败'
  }
  finally {
    cubShopLoading.value = false
  }
}

// ============ 幼崽商城加购(对齐农场商城「道具商城」) ============
/** 单次最多输入 99, 农场商城同口径 */
const CUB_MAX_QTY = 99

function cubMaxQuantity(g: any) {
  const remain = g?.remaining
  if (remain === null || remain === undefined)
    return CUB_MAX_QTY
  return Math.max(1, Math.min(CUB_MAX_QTY, Math.floor(Number(remain) || 0)))
}

function getCubQuantity(g: any) {
  const raw = Math.floor(Number(cubQuantities[g?.goodsId]) || 1)
  return Math.max(1, Math.min(cubMaxQuantity(g), raw))
}

function normalizeCubQuantity(g: any) {
  if (!g)
    return
  cubQuantities[g.goodsId] = getCubQuantity(g)
}

function cubTotalPrice(g: any) {
  return Math.max(0, Number(g?.price) || 0) * getCubQuantity(g)
}

function cubIsLimitReached(g: any) {
  return g?.remaining !== null && g?.remaining !== undefined && Number(g.remaining) <= 0
}

function cubIsInsufficient(g: any) {
  if (voucherBalance.value === null || voucherBalance.value === undefined)
    return false
  return cubTotalPrice(g) > Number(voucherBalance.value)
}

function cubIsDisabled(g: any) {
  return g?.unlocked === false || cubIsLimitReached(g) || cubIsInsufficient(g)
}

function formatNumber(value: number) {
  return Math.max(0, Number(value) || 0).toLocaleString('zh-CN')
}

/** 点"购买"→ 先弹确认, 不直接下单(与农场商城一致) */
function openCubPurchase(g: any) {
  if (g?.unlocked === false) {
    toast.warning('该幼崽尚未解锁')
    return
  }
  if (cubIsLimitReached(g)) {
    toast.warning('已达限购数量')
    return
  }
  if (cubIsInsufficient(g)) {
    toast.warning('金券不足')
    return
  }
  normalizeCubQuantity(g)
  selectedCub.value = g
}

function closeCubPurchase() {
  if (!cubConfirmLoading.value)
    selectedCub.value = null
}

const cubPurchaseMessage = computed(() => {
  const g = selectedCub.value
  if (!g)
    return ''
  const qty = getCubQuantity(g)
  const account = currentAccount.value?.name || currentAccount.value?.nick || currentAccountId.value
  return [
    `账号：${account}`,
    `幼崽：${g.name} ×${qty}`,
    `单价：金券 ${formatNumber(g.price)}`,
    `合计：金券 ${formatNumber(cubTotalPrice(g))}`,
    `余额：金券 ${voucherBalance.value === null ? '未知' : formatNumber(Number(voucherBalance.value))}`,
    '',
    '确认后将立即向官方商店下单。',
  ].join('\n')
})

async function confirmCubPurchase() {
  const g = selectedCub.value
  const id = currentAccountId.value
  if (!g || !id || cubConfirmLoading.value)
    return
  const qty = getCubQuantity(g)
  cubConfirmLoading.value = true
  cubBuyBusy.value = g.goodsId
  try {
    // 传 goodsId + count: 后端走"精确买这只、买几只", 不再按收益比自动挑
    const r = await ranchStore.operate(id, {
      op: 'buycub',
      goodsId: g.goodsId,
      count: qty,
      price: g.price,
    })
    if (r?.ok === false)
      throw new Error(r.error || '购买失败')
    toast.success(`已购买 ${(r as any).bought ?? qty} 只${g.name}`)
    selectedCub.value = null
    await reloadCubShop()
  }
  catch (e: any) {
    toast.error(e?.message || '购买失败')
  }
  finally {
    cubConfirmLoading.value = false
    cubBuyBusy.value = 0
  }
}
const operateLoading = ref(-1)
const opBusy = ref('')

// 产出倒计时本地递减: 数据刷新时基准归零, 每秒往后走 1 格(显示平滑, 不回读)
const elapsedSec = ref(0)
useIntervalFn(() => {
  elapsedSec.value++
}, 1000)
watch(overview, () => {
  elapsedSec.value = 0
})

/** 距下次产出秒数; null = 还没进入产出周期(幼年/未开轮), 不能当成"可收" */
function produceInSec(a: { harvestInSec?: number | null, produceInSec?: number | null }) {
  const raw = a.harvestInSec ?? a.produceInSec
  if (raw === null || raw === undefined)
    return null
  return Math.max(0, raw - elapsedSec.value)
}

/** 该动物现在能不能收 —— 以后端派生字段为准, 前端不再自己用秒数猜 */
function isHarvestable(a: { harvestable?: boolean, harvestInSec?: number | null, produceInSec?: number | null }) {
  if (typeof a.harvestable === 'boolean')
    return a.harvestable
  const sec = produceInSec(a)
  return sec !== null && sec <= 0
}

// 批量操作(对照农场整田操作): 只保留服务端确实支持的接口
const BATCH_OPS = [
  { key: 'harvest', label: '全部收获', icon: 'i-carbon-wheat', tone: 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  { key: 'produce', label: '全部催产', icon: 'i-carbon-flash', tone: 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
  { key: 'clean', label: '清理牧场', icon: 'i-carbon-clean', tone: 'border-teal-300 bg-teal-50 text-teal-700 hover:bg-teal-100 dark:border-teal-700 dark:bg-teal-900/30 dark:text-teal-300' },
  { key: 'feed', label: '全场喂有机罐头', icon: 'i-carbon-restaurant', tone: 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
]
async function runBatch(batch: string, extra: Record<string, any> = {}) {
  const id = currentAccountId.value
  if (!id) return
  opBusy.value = 'batch'
  try {
    const r = await ranchStore.operate(id, { op: 'batch', batch, ...extra })
    if (r && r.ok === false) toast.error(r.error || '操作未成功')
    else toast.success(`${r.action}：${r.detail || '完成'}`)
  }
  catch (e: any) {
    toast.error(e?.message || '操作失败')
  }
  finally {
    opBusy.value = ''
    void refresh()
  }
}

// 动物视觉标识: 游戏里动物是 Spine/3D 模型, 没有可用的静态图标资源
// → 用 emoji + 配色区分(用户确认先这样)
const ANIMAL_VISUAL: Record<string, { emoji: string, bg: string }> = {
  鸡: { emoji: '🐔', bg: 'bg-amber-100/60 dark:bg-amber-900/25' },
  鸭: { emoji: '🦆', bg: 'bg-yellow-100/60 dark:bg-yellow-900/25' },
  鹅: { emoji: '🦢', bg: 'bg-slate-100/60 dark:bg-slate-800/40' },
  猫: { emoji: '🐱', bg: 'bg-orange-100/60 dark:bg-orange-900/25' },
  乌龟: { emoji: '🐢', bg: 'bg-emerald-100/60 dark:bg-emerald-900/25' },
  龙猫: { emoji: '🐭', bg: 'bg-violet-100/60 dark:bg-violet-900/25' },
  松鼠: { emoji: '🐿️', bg: 'bg-amber-100/60 dark:bg-amber-900/25' },
  刺猬: { emoji: '🦔', bg: 'bg-stone-100/60 dark:bg-stone-800/40' },
  狐狸: { emoji: '🦊', bg: 'bg-orange-100/60 dark:bg-orange-900/25' },
  羊: { emoji: '🐑', bg: 'bg-gray-100/60 dark:bg-gray-800/40' },
  牛: { emoji: '🐄', bg: 'bg-neutral-100/60 dark:bg-neutral-800/40' },
  猴子: { emoji: '🐒', bg: 'bg-amber-100/60 dark:bg-amber-900/25' },
  迷你猪: { emoji: '🐷', bg: 'bg-pink-100/60 dark:bg-pink-900/25' },
  袋鼠: { emoji: '🦘', bg: 'bg-yellow-100/60 dark:bg-yellow-900/25' },
  驴: { emoji: '🫏', bg: 'bg-stone-100/60 dark:bg-stone-800/40' },
  梅花鹿: { emoji: '🦌', bg: 'bg-orange-100/60 dark:bg-orange-900/25' },
  羚羊: { emoji: '🐐', bg: 'bg-amber-100/60 dark:bg-amber-900/25' },
  长颈鹿: { emoji: '🦒', bg: 'bg-yellow-100/60 dark:bg-yellow-900/25' },
  鸵鸟: { emoji: '🦤', bg: 'bg-stone-100/60 dark:bg-stone-800/40' },
  牦牛: { emoji: '🐃', bg: 'bg-neutral-100/60 dark:bg-neutral-800/40' },
  浣熊: { emoji: '🦝', bg: 'bg-gray-100/60 dark:bg-gray-800/40' },
  兔子: { emoji: '🐰', bg: 'bg-pink-100/60 dark:bg-pink-900/25' },
}
function animalVisual(name: string) {
  const key = Object.keys(ANIMAL_VISUAL).find(k => String(name || '').includes(k))
  return key ? ANIMAL_VISUAL[key] : { emoji: '🐾', bg: 'bg-gray-100/60 dark:bg-gray-800/40' }
}

function formatTime(sec: number) {
  if (sec <= 0)
    return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h > 0 ? `${h}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

const careSummary = computed(() => {
  const ov = overview.value
  if (!ov)
    return { harvestable: 0, hungry: 0, mutant: 0 }
  return {
    harvestable: ov.animals.filter(a => isHarvestable(a)).length,
    hungry: ov.animals.filter(a => a.feedState === 1).length,
    mutant: ov.animals.filter(a => a.mutant).length,
  }
})

/** 窝/棚分组视图(对应农场的田地) */
interface PenView {
  key: string
  title: string
  icon: string
  capacity: number
  facility?: RanchFacility
  animals: any[]
  emptySlots: number
  /** 容量为 0 且没动物 = 该建筑还没解锁(棚需要玩家等级更高才开, 与窝不同步) */
  locked: boolean
  /** AllCells 里的真实建筑(没有 = 该建筑还没建造/没放置) */
  building?: { instId: number, buildingId: number, level: number, status: number, kind: string }
}

const pensView = computed<PenView[]>(() => {
  const ov = overview.value
  if (!ov)
    return []
  // 窝/棚的建筑容量来自 AllCells 的真实建筑(coopBuildings/penBuildings),
  // 不再用 coopCount/penCount 凑数 —— 那两个是"规划格数", 不代表已解锁。
  const coopB = (ov.coopBuildings || [])[0]
  const penB = (ov.penBuildings || [])[0]
  const pens = [
    {
      key: 'coop',
      title: '窝（小动物）',
      icon: 'i-carbon-home',
      // 有真实建筑就用它的占位容量, 否则回落到牧场详情
      capacity: ov.coopCount || 0,
      facility: (ov.facilities || []).find(f => f.slot === 10001),
      animals: ov.animals.filter(a => a.animalId < 70000 && a.animalId >= 60000),
      emptySlots: 0,
      locked: false,
      building: coopB,
    },
    {
      key: 'pen',
      title: '棚（大动物）',
      icon: 'i-carbon-home',
      capacity: ov.penCount || 0,
      // 棚的建筑实例不在固定槽位(10000/10001/10002)里, 用 penBuildings 判断
      facility: undefined,
      animals: ov.animals.filter(a => a.animalId >= 70000 && a.animalId < 80000),
      emptySlots: 0,
      locked: false,
      building: penB,
    },
  ]
  for (const p of pens) {
    // ⭐ 真实建筑缺失 = 该栏舍还没建/没解锁。
    //   之前直接用 penCount=4 渲染 4 个空位, 但游戏内棚是"未解锁" (用户现场反馈)。
    const hasBuilding = !!p.building
    p.emptySlots = hasBuilding ? Math.max(0, (p.capacity || 0) - p.animals.length) : 0
    p.locked = !hasBuilding || ((p.capacity || 0) === 0 && p.animals.length === 0)
  }
  return pens
})

const facilityText = computed(() => {
  // 留言板/装饰位没有等级概念, 不显示
  const fs = (overview.value?.facilities || []).filter(f => f.kind !== 'decor')
  if (!fs.length)
    return ''
  return fs.map(f => `${f.name || '建筑'}${f.level ? ` Lv${f.level}` : ''}`).join(' · ')
})

// 今日次数: op id(11003/11008/11009) 的官方语义未确认, 先不展示, 避免误导
const opLimitText = computed(() => '')

// 刷新防抖: 挂载/切账号/每次操作都会触发 refresh, 连点按钮会叠加请求;
// 后端虽有 10s 节流, 前端也压一下(1.5s 内的多次触发只发一次)
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function refresh(immediate = false) {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  const run = async () => {
    refreshTimer = null
    const id = currentAccountId.value
    if (!id)
      return
    const acc = currentAccount.value
    if (!acc)
      return
    if (!realtimeConnected.value)
      await statusStore.fetchStatus(id)
    if (acc.running && status.value?.connection?.connected)
      ranchStore.fetchOverview(id)
  }
  if (immediate) {
    void run()
    return
  }

  refreshTimer = setTimeout(() => {
    void run()
  }, 1500)
}

/** 单个操作(每只动物的丰收/催产、商城单买等) */
async function runOp(op: string, slot = 0, extra: Record<string, any> = {}) {
  const id = currentAccountId.value
  if (!id)
    return
  opBusy.value = op
  operateLoading.value = slot
  try {
    const r = await ranchStore.operate(id, { op, slot, ...extra })
    if (r && r.ok === false) {
      toast.error(r.error || '操作未成功')
    }
    else {
      toast.success(`${r.action}成功${r.detail ? `（${r.detail}）` : ''}`)
    }
  }
  catch (e: any) {
    toast.error(e?.message || '操作失败')
  }
  finally {
    opBusy.value = ''
    operateLoading.value = -1
    void refresh()
  }
}

watch(currentAccountId, () => refresh(true))

// ============ 出售动物(不可逆, 必须确认) ============
const sellTarget = ref<any>(null)
const sellConfirmLoading = ref(false)

const sellMessage = computed(() => {
  const a = sellTarget.value
  if (!a)
    return ''
  const account = currentAccount.value?.name || currentAccount.value?.nick || currentAccountId.value
  return [
    `账号：${account}`,
    `动物：${a.name}（槽位 ${a.slot}，${a.stageText || ''}）`,
    a.sellCost ? `预计回收：${a.sellCost.amount} 金券` : '回收金额以服务端结算为准',
    '',
    '出售后这只动物会从栏舍移除，无法撤回。',
  ].join('\n')
})

function openSellConfirm(a: any) {
  sellTarget.value = a
}

async function confirmSell() {
  const a = sellTarget.value
  if (!a || !currentAccountId.value || sellConfirmLoading.value)
    return
  sellConfirmLoading.value = true
  try {
    await runOp('donate', a.slot)
    sellTarget.value = null
  }
  finally {
    sellConfirmLoading.value = false
  }
}

// ============ 偷好友牧场产物(会遍历所有好友, 先确认) ============
const stealConfirming = ref(false)
const stealLoading = ref(false)

const stealMessage = computed(() => {
  const account = currentAccount.value?.name || currentAccount.value?.nick || currentAccountId.value
  return [
    `账号：${account}`,
    '将对**所有好友**的牧场逐个尝试偷取产物。',
    '',
    '这会在一段时间内连续访问每位好友的牧场。确认执行？',
  ].join('\n')
})

async function confirmSteal() {
  if (!currentAccountId.value || stealLoading.value)
    return
  stealLoading.value = true
  try {
    await runOp('steal')
    stealConfirming.value = false
  }
  finally {
    stealLoading.value = false
  }
}

// ============ 牧场任务(独立于农场任务, scene_id=2) ============
const ranchTasksLoading = ref(false)
const ranchTasksError = ref('')
const ranchTasks = ref<any[]>([])
const ranchTaskClaiming = ref(false)

async function openRanchTasks() {
  currentTab.value = 'tasks'
  await reloadRanchTasks()
}

async function reloadRanchTasks() {
  const id = currentAccountId.value
  if (!id)
    return
  ranchTasksLoading.value = true
  ranchTasksError.value = ''
  try {
    const res = await api.get('/api/ranch/tasks', { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '获取牧场任务失败')
    ranchTasks.value = d.data?.tasks || []
  }
  catch (e: any) {
    ranchTasksError.value = e?.response?.data?.error || e?.message || '获取牧场任务失败'
  }
  finally {
    ranchTasksLoading.value = false
  }
}

async function claimRanchTasks() {
  const id = currentAccountId.value
  if (!id || ranchTaskClaiming.value)
    return
  ranchTaskClaiming.value = true
  try {
    const res = await api.post('/api/ranch/tasks/claim', {}, { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '领取失败')
    const r = d.data || {}
    if (r.claimed > 0)
      toast.success(`已领取 ${r.claimed} 个牧场任务`)
    else
      toast.info(r.claimable > 0 ? '可领任务正在处理，请稍后刷新' : '当前没有可领取的牧场任务')
    await reloadRanchTasks()
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '领取失败')
  }
  finally {
    ranchTaskClaiming.value = false
  }
}

const ranchClaimableCount = computed(() => ranchTasks.value.filter(t => t.canClaim).length)

// ============ 牧场建筑 & 地块 ============
// 数据就在 overview 里(toRanchView 已经带 buildings/cells/regionQuota), 不再单独拉一次
const buildingsLoading = ref(false)
const buildingsError = ref('')

async function openBuildings() {
  currentTab.value = 'buildings'
  buildingsLoading.value = true
  buildingsError.value = ''
  try {
    const id = currentAccountId.value
    if (!id)
      return
    await ranchStore.fetchOverview(id)
  }
  catch (e: any) {
    buildingsError.value = e?.message || '获取建筑数据失败'
  }
  finally {
    buildingsLoading.value = false
  }
}

const ranchBuildings = computed(() => (overview.value as any)?.buildings || [])
const ranchCells = computed(() => (overview.value as any)?.cells || [])
const unlockedCells = computed(() => ranchCells.value.filter((c: any) => c.unlocked).length)
const totalCells = computed(() => ranchCells.value.length)

const BUILDING_KIND_LABEL: Record<string, string> = {
  coop: '窝',
  pen: '棚',
  feed: '牧草机',
}

onMounted(() => refresh(true))

onUnmounted(() => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
})
</script>

<template>
  <div class="space-y-4">
    <!-- 牧场内部页签栏。
         嵌入模式(个人 → 我的牧场)下**保留**这排页签 —— 牧场的全部功能
         (总览/幼崽商城/兴牧档位/牧场任务/建筑与地块)都通过它切换,
         这样个人页只需要一个"我的牧场"入口就够, 不用再摊成 5 个顶级页签。
         嵌入时做成小一号, 与个人页的顶级页签形成视觉层级区分。 -->
    <div
      class="mb-1 flex flex-wrap gap-2"
      :class="embedded ? 'rounded-lg bg-white p-1.5 dark:bg-gray-800' : ''"
    >
      <button
        class="flex items-center rounded-lg font-medium transition-colors space-x-2"
        :class="[embedded ? 'min-h-[36px] px-3 py-1.5 text-sm' : 'min-h-[44px] px-4 py-2',
          currentTab === 'overview' ? 'text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700']"
        :style="currentTab === 'overview' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'overview'"
      >
        <div class="i-carbon-home text-lg" />
        <span>牧场总览</span>
      </button>
      <button
        class="flex items-center rounded-lg font-medium transition-colors space-x-2"
        :class="[embedded ? 'min-h-[36px] px-3 py-1.5 text-sm' : 'min-h-[44px] px-4 py-2',
          currentTab === 'cubShop' ? 'text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700']"
        :style="currentTab === 'cubShop' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="openCubShop"
      >
        <div class="i-carbon-shopping-cart text-lg" />
        <span>牧场商城</span>
      </button>
      <button
        class="flex items-center rounded-lg font-medium transition-colors space-x-2"
        :class="[embedded ? 'min-h-[36px] px-3 py-1.5 text-sm' : 'min-h-[44px] px-4 py-2',
          currentTab === 'tiers' ? 'text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700']"
        :style="currentTab === 'tiers' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="openTiers"
      >
        <div class="i-carbon-chart-bar text-lg" />
        <span>兴牧档位</span>
      </button>
      <button
        class="flex items-center rounded-lg font-medium transition-colors space-x-2"
        :class="[embedded ? 'min-h-[36px] px-3 py-1.5 text-sm' : 'min-h-[44px] px-4 py-2',
          currentTab === 'tasks' ? 'text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700']"
        :style="currentTab === 'tasks' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="openRanchTasks"
      >
        <div class="i-carbon-task text-lg" />
        <span>牧场任务</span>
        <span
          v-if="ranchClaimableCount > 0"
          class="rounded-full bg-amber-500 px-1.5 text-xs text-white"
        >{{ ranchClaimableCount }}</span>
      </button>
      <button
        class="flex items-center rounded-lg font-medium transition-colors space-x-2"
        :class="[embedded ? 'min-h-[36px] px-3 py-1.5 text-sm' : 'min-h-[44px] px-4 py-2',
          currentTab === 'buildings' ? 'text-white shadow-md' : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700']"
        :style="currentTab === 'buildings' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="openBuildings"
      >
        <div class="i-carbon-building text-lg" />
        <span>建筑与地块</span>
      </button>
    </div>

    <div v-if="currentTab === 'tiers'" class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
        <h3 class="flex items-center gap-2 text-lg font-bold">
          <div class="i-carbon-chart-bar text-xl text-sky-500" />
          兴牧档位（全服饲养重量奖励）
        </h3>
      </div>
      <div class="p-3 sm:p-4">
        <LoadingState v-if="tiersLoading" />
        <div v-else-if="tiersError" class="py-8 text-center text-sm text-gray-500">
          {{ tiersError }}
        </div>
        <div v-else-if="!tiersList.length" class="py-8 text-center text-sm text-gray-500">
          暂无档位数据
        </div>
        <div v-else class="grid grid-cols-1 gap-2 md:grid-cols-2">
          <div
            v-for="t in tiersList"
            :key="t.level"
            class="flex items-center justify-between gap-2 border border-gray-200 rounded-lg px-3 py-2 dark:border-gray-700"
          >
            <div class="flex items-center gap-2">
              <span class="h-7 w-7 flex items-center justify-center rounded-full bg-sky-100 text-xs text-sky-700 font-bold dark:bg-sky-900/40 dark:text-sky-300">
                {{ t.level }}
              </span>
              <span class="text-sm text-gray-600 dark:text-gray-300">重量 {{ t.requiredWeight }}</span>
            </div>
            <div class="flex flex-wrap justify-end gap-1">
              <span
                v-for="r in t.rewards"
                :key="r.itemId"
                class="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300"
              >
                {{ itemLabel(r.itemId) }} ×{{ r.count }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 牧场任务(scene_id=2, 独立于农场任务) ===== -->
    <div v-if="currentTab === 'tasks'" class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <div class="i-carbon-task text-xl text-sky-500" />
            牧场任务
            <span v-if="ranchTasks.length" class="text-xs text-gray-400 font-normal">
              可领 {{ ranchClaimableCount }} / 共 {{ ranchTasks.length }}
            </span>
          </h3>
          <div class="flex gap-2">
            <BaseButton variant="secondary" size="sm" :loading="ranchTasksLoading" @click="reloadRanchTasks">
              <span class="i-carbon-renew mr-1" />刷新
            </BaseButton>
            <BaseButton size="sm" :disabled="ranchTaskClaiming || ranchClaimableCount === 0" @click="claimRanchTasks">
              <span class="i-carbon-gift mr-1" />
              {{ ranchTaskClaiming ? '领取中…' : '一键领取' }}
            </BaseButton>
          </div>
        </div>
        <p class="mt-1 text-xs text-gray-400">
          牧场任务与农场任务完全独立（服务端按 scene_id=2 拉取）。日常自动流程已包含领取，这里是手动补领。
        </p>
      </div>
      <div class="p-3 sm:p-4">
        <LoadingState v-if="ranchTasksLoading && !ranchTasks.length" />
        <div v-else-if="ranchTasksError" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
          {{ ranchTasksError }}
        </div>
        <div v-else-if="!ranchTasks.length" class="py-10 text-center text-sm text-gray-400">
          暂无牧场任务（可能等级不足，或服务端未下发）
        </div>
        <div v-else class="space-y-1.5">
          <div
            v-for="t in ranchTasks"
            :key="t.id"
            class="flex flex-wrap items-center gap-2 rounded border px-2.5 py-2 text-xs"
            :class="t.canClaim
              ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20'
              : 'border-gray-100 dark:border-gray-700'"
          >
            <span class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
              {{ t.typeLabel }}
            </span>
            <span class="min-w-0 flex-1 text-gray-700 dark:text-gray-200">{{ t.desc }}</span>
            <span class="text-gray-400">{{ t.progress }}/{{ t.totalProgress }}</span>
            <span v-if="t.rewardText" class="text-emerald-600 dark:text-emerald-400">{{ t.rewardText }}</span>
            <span
              class="shrink-0"
              :class="t.isClaimed
                ? 'text-green-600 dark:text-green-400'
                : (t.canClaim ? 'text-amber-600 font-medium dark:text-amber-400' : 'text-gray-400')"
            >
              {{ t.isClaimed ? '已领取' : (t.canClaim ? '可领取' : '进行中') }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 牧场建筑 & 地块 ===== -->
    <div v-if="currentTab === 'buildings'" class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <div class="i-carbon-building text-xl text-indigo-500" />
            建筑与地块
          </h3>
          <div class="flex flex-wrap items-center gap-2">
            <span v-if="totalCells" class="text-xs text-gray-500">
              地块已解锁 {{ unlockedCells }}/{{ totalCells }}
            </span>
            <span v-if="(overview as any)?.regionQuota" class="text-xs text-gray-500">
              占用 {{ (overview as any).regionOccupied }}/{{ (overview as any).regionQuota }}
            </span>
            <BaseButton variant="secondary" size="sm" :loading="buildingsLoading" @click="openBuildings">
              <span class="i-carbon-renew mr-1" />刷新
            </BaseButton>
          </div>
        </div>
        <p class="mt-1 text-xs text-gray-400">
          AllCells 只返回状态不返回倒计时，所以这里不显示剩余时间；升级/解锁请用总览页的操作按钮。
        </p>
      </div>
      <div class="p-3 sm:p-4 space-y-4">
        <LoadingState v-if="buildingsLoading && !ranchBuildings.length" />
        <div v-else-if="buildingsError" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
          {{ buildingsError }}
        </div>

        <section>
          <h4 class="mb-2 text-sm font-semibold">建筑</h4>
          <div v-if="!ranchBuildings.length" class="py-6 text-center text-xs text-gray-400">
            暂无建筑数据
          </div>
          <div v-else class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="b in ranchBuildings"
              :key="b.instId"
              class="flex items-center justify-between rounded border border-gray-100 px-2.5 py-2 text-xs dark:border-gray-700"
            >
              <div class="flex items-center gap-2">
                <span class="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300">
                  {{ BUILDING_KIND_LABEL[b.kind] || '建筑' }}
                </span>
                <span class="text-gray-500">#{{ b.instId }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-gray-700 font-medium dark:text-gray-200">Lv{{ b.level }}</span>
                <!-- 建筑 status 实测是 9/10/11(不是地块的 1/2), 且语义无权威定义:
                     不翻译成"升级中", 直接显示状态码, 避免误导 -->
                <span class="text-gray-400 text-[10px]">状态{{ b.status }}</span>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h4 class="mb-2 text-sm font-semibold">地块</h4>
          <div v-if="!ranchCells.length" class="py-6 text-center text-xs text-gray-400">
            暂无地块数据
          </div>
          <div v-else class="grid grid-cols-3 gap-1.5 sm:grid-cols-5 lg:grid-cols-8">
            <div
              v-for="c in ranchCells"
              :key="c.regionId + '-' + c.seq"
              class="rounded border px-1 py-1.5 text-center text-[10px]"
              :class="c.unlocked
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
                : 'border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-900/30'"
              :title="`region ${c.regionId} · seq ${c.seq}${c.capacity ? ` · 容量 ${c.capacity}` : ''}`"
            >
              <div class="font-mono">{{ c.seq }}</div>
              <div>{{ c.unlocked ? '已解锁' : '未解锁' }}</div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <div v-if="currentTab === 'cubShop'" class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <div class="i-fas-paw text-xl text-amber-500" />
            牧场商城
          </h3>
          <div class="flex flex-wrap items-center gap-3">
            <!-- 金券余额: 余额未知时不显示, 避免误导(与不拦截余额的策略一致) -->
            <span class="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              金券 <strong>{{ voucherBalance === null ? '未知' : formatNumber(Number(voucherBalance)) }}</strong>
            </span>
            <span class="text-xs text-gray-400">
              按收益比排序（整只回收 ÷ 幼崽成本）
            </span>
            <BaseButton variant="secondary" size="sm" :loading="cubShopLoading" @click="reloadCubShop">
              <span class="i-carbon-renew mr-1" />刷新
            </BaseButton>
          </div>
        </div>
        <!-- 分类切换: 道具 / 幼崽(抓包实证: shop6=道具 牧草, shop5=幼崽) -->
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            v-for="c in [
              { key: 'item', label: '道具' },
              { key: 'cub', label: '幼崽' },
            ]"
            :key="c.key"
            type="button"
            class="rounded-lg px-3 py-1 text-xs font-medium transition"
            :class="ranchShopCategory === c.key
              ? 'bg-amber-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'"
            @click="loadRanchShop(c.key as any)"
          >
            {{ c.label }} <span class="opacity-70">{{ c.key === 'item' ? ranchShopCounts.item : ranchShopCounts.cub }}</span>
          </button>
          <div class="flex-1" />
          <span class="text-xs text-gray-400">
            {{ ranchShopCategory === 'cub' ? '按收益比排序（整只回收 ÷ 幼崽成本）' : '牧场道具（牧草等）' }}
          </span>
          <BaseButton variant="secondary" size="sm" :loading="cubShopLoading || ranchShopLoading" @click="openCubShop">
            <span class="i-carbon-renew mr-1" />刷新
          </BaseButton>
        </div>

        <!-- 道具: 牧草手动购买 -->
        <div v-if="ranchShopCategory === 'item'" class="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-800 dark:bg-emerald-900/20">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0 flex-1">
              <div class="text-sm text-emerald-900 font-semibold dark:text-emerald-200">
                牧草 · 单价 60 金券
              </div>
              <p class="mt-0.5 text-xs text-emerald-700/90 dark:text-emerald-300/90">
                买完自动进牧草机（auto_add）。牧场牧草断了会自动买，这里是手动补。
              </p>
            </div>
            <label class="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
              数量
              <input
                v-model.number="grassBuyCount"
                type="number"
                min="1"
                class="h-9 w-20 border border-gray-300 rounded-lg bg-white px-2 text-center text-sm dark:border-gray-600 dark:bg-gray-800"
              >
            </label>
            <BaseButton size="sm" :loading="grassBuying" @click="buyGrassManually">
              {{ grassBuying ? '购买中…' : '购买牧草' }}
            </BaseButton>
          </div>
        </div>

        <div v-if="ranchShopError" class="mt-2 text-xs text-red-500">
          {{ ranchShopError }}
        </div>

        <!-- 筛选 + 排序(对照种子商城的 FILTERS) -->
        <div v-if="ranchShopCategory === 'cub'" class="mt-2 flex flex-wrap items-center gap-2">
          <button
            v-for="f in CUB_FILTERS"
            :key="f.key"
            type="button"
            class="rounded-lg px-2.5 py-1 text-xs font-medium transition"
            :class="cubFilter === f.key
              ? 'bg-amber-500 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'"
            @click="cubFilter = f.key"
          >
            {{ f.label }} <span class="opacity-70">{{ cubCounts[f.key] }}</span>
          </button>
          <div class="flex-1"></div>
          <select
            v-model="cubSort"
            class="h-8 border border-gray-300 rounded-lg bg-white px-2 text-xs dark:border-gray-600 dark:bg-gray-800"
          >
            <option value="ratio">按收益比</option>
            <option value="profit">按单只净赚</option>
            <option value="price">按价格</option>
          </select>
        </div>
      </div>

      <div class="p-3 sm:p-4">
        <!-- 道具分类: 列出商店道具(牧场商店 shop6) -->
        <template v-if="ranchShopCategory === 'item'">
          <LoadingState v-if="ranchShopLoading && !ranchShopItems.length" />
          <div v-else-if="!ranchShopFiltered.length" class="py-8 text-center text-sm text-gray-500">
            商店暂无在售道具
          </div>
          <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-4 sm:grid-cols-2">
            <div
              v-for="g in ranchShopFiltered"
              :key="g.goodsId"
              class="flex flex-col border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
            >
              <div class="mb-1 flex items-start justify-between">
                <span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">道具</span>
                <span class="text-[10px] text-gray-400">#{{ g.goodsId }}</span>
              </div>
              <div class="text-sm font-bold text-gray-800 dark:text-gray-100">{{ g.name }}</div>
              <div class="mt-0.5 text-[11px] text-gray-500">单价 {{ g.price }} 金券</div>
              <div class="text-[10px] text-gray-400">
                {{ g.limit > 0 ? `限购 ${g.bought}/${g.limit}` : '不限购' }}
              </div>
              <BaseButton
                class="mt-2 w-full"
                size="sm"
                :disabled="!g.unlocked || grassBuying || g.itemId !== 7001"
                @click="buyGrassManually()"
              >
                {{ g.itemId === 7001 ? `买 ${grassBuyCount} 个` : '暂不支持' }}
              </BaseButton>
            </div>
          </div>
        </template>

        <!-- 幼崽分类: 原加购界面 -->
        <template v-else>
        <LoadingState v-if="cubShopLoading && !cubShopList.length" />
        <div v-else-if="cubShopError" class="py-8 text-center text-sm text-gray-500">
          {{ cubShopError }}
        </div>
        <div v-else-if="!cubShopList.length" class="py-8 text-center text-sm text-gray-500">
          商店暂无在售幼崽
        </div>
        <div v-else-if="!cubShopFiltered.length" class="py-8 text-center text-sm text-gray-500">
          该筛选条件下没有幼崽
        </div>
        <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-4 sm:grid-cols-2">
          <div
            v-for="g in cubShopFiltered"
            :key="g.goodsId"
            class="flex flex-col border rounded-lg p-3 text-center transition"
            :class="g.valueRatio >= 2.4
              ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-900/20'
              : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'"
          >
            <div class="flex items-start justify-between">
              <span
                v-if="g.valueRatio >= 2.4"
                class="rounded bg-amber-500 px-1 py-0.5 text-[10px] text-white"
              >
                高收益
              </span>
              <span v-else />
              <span
                v-if="g.limit > 0"
                class="rounded px-1 py-0.5 text-[10px]"
                :class="cubIsLimitReached(g)
                  ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300'
                  : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'"
              >
                限购 {{ g.bought }}/{{ g.limit }}
              </span>
            </div>

            <div class="mb-1 mt-1 h-10 w-10 flex items-center justify-center self-center">
              <div class="i-fas-paw text-3xl text-amber-500" />
            </div>
            <div class="text-xs font-bold">
              {{ g.name }}
            </div>
            <div class="mt-0.5 text-[11px] text-gray-500">
              金券 {{ formatNumber(g.price) }} / 只
            </div>
            <div class="mt-0.5 text-[10px] text-gray-400">
              回收比 {{ (g.valueRatio || 0).toFixed(2) }}
            </div>
            <div v-if="g.profit !== null && g.profit !== undefined" class="text-[10px] text-emerald-600 dark:text-emerald-400">
              单只净赚 {{ formatNumber(g.profit) }} 金券
            </div>
            </div>

            <!-- 加购区: 数量步进 + 合计 + 购买(对齐农场商城) -->
            <div class="mt-2 flex items-center justify-center gap-1">
              <button
                type="button"
                class="h-7 w-7 flex items-center justify-center border border-gray-200 rounded-md text-gray-600 dark:border-gray-600 dark:text-gray-300 disabled:opacity-40"
                :disabled="cubIsDisabled(g) || getCubQuantity(g) <= 1"
                @click="cubQuantities[g.goodsId] = getCubQuantity(g) - 1"
              >
                −
              </button>
              <input
                v-model.number="cubQuantities[g.goodsId]"
                type="number"
                min="1"
                :max="cubMaxQuantity(g)"
                :disabled="cubIsDisabled(g)"
                class="h-7 w-12 border border-gray-200 rounded-md bg-white px-1 text-center text-xs text-gray-900 outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                @blur="normalizeCubQuantity(g)"
              >
              <button
                type="button"
                class="h-7 w-7 flex items-center justify-center border border-gray-200 rounded-md text-gray-600 dark:border-gray-600 dark:text-gray-300 disabled:opacity-40"
                :disabled="cubIsDisabled(g) || getCubQuantity(g) >= cubMaxQuantity(g)"
                @click="cubQuantities[g.goodsId] = getCubQuantity(g) + 1"
              >
                +
              </button>
            </div>

            <div class="mt-1 h-4 text-[10px]">
              <span v-if="cubIsLimitReached(g)" class="text-red-500">已售罄</span>
              <span v-else-if="cubIsInsufficient(g)" class="text-red-500">金券不足</span>
              <span v-else class="text-gray-400">
                合计 {{ formatNumber(cubTotalPrice(g)) }} 金券
              </span>
            </div>

            <BaseButton
              class="mt-2 w-full"
              size="sm"
              :disabled="cubIsDisabled(g) || cubBuyBusy === g.goodsId"
              @click="openCubPurchase(g)"
            >
              <template v-if="g.unlocked === false">
                未解锁
              </template>
              <template v-else-if="cubIsLimitReached(g)">
                已售罄
              </template>
              <template v-else-if="cubBuyBusy === g.goodsId">
                购买中…
              </template>
              <template v-else>
                购买
              </template>
            </BaseButton>
          </div>
        </template>   <!-- 幼崽分类结束 -->
        </div>
      </div>

    <div v-if="currentTab === 'overview'" class="space-y-4">
      <div class="rounded-lg bg-white shadow dark:bg-gray-800">
        <!-- 头部 -->
        <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
          <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2 sm:mb-3">
            <h3 class="flex items-center gap-2 text-lg font-bold">
              <div class="i-carbon-home text-xl" />
              牧场总览
            </h3>
            <div v-if="overview" class="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
              <span>窝 {{ overview.coopCount }} · 棚 {{ overview.penCount }}</span>
              <span>牧草 {{ overview.grassCount }}</span>
              <span v-if="overview.ranchLevel">牧场 Lv{{ overview.ranchLevel }} <span class="text-gray-400">{{ overview.ranchLevelExp }}/{{ overview.ranchLevelNeeded }}</span></span>
              <span v-else>经验 {{ overview.ranchExp }}</span>
            </div>
          </div>
        </div>

        <!-- 摘要 -->
        <div
          v-if="overview"
          class="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2.5 text-xs dark:border-gray-700 dark:bg-gray-900/50 sm:px-4 sm:text-sm"
        >
          <div class="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
            <i class="i-fas-egg" />
            <span class="font-medium">可收 {{ careSummary.harvestable }}</span>
          </div>
          <div class="flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <i class="i-carbon-sprout" />
            <span class="font-medium">饥饿 {{ careSummary.hungry }}</span>
          </div>
          <div class="flex items-center gap-1 rounded-full bg-fuchsia-100 px-2.5 py-1 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-400">
            <i class="i-carbon-star" />
            <span class="font-medium">变异 {{ careSummary.mutant }}</span>
          </div>
          <div
            v-if="overview?.facilities?.length"
            class="flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
          >
            <i class="i-carbon-home" />
            <span class="font-medium">{{ facilityText }}</span>
          </div>
          <div v-if="opLimitText" class="ml-auto text-[11px] text-gray-400">
            今日次数 {{ opLimitText }}
          </div>
        </div>

        <!-- 内容 -->
        <div class="p-3 sm:p-4">
          <LoadingState v-if="loading || statusLoading" />
          <div v-else-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 rounded-lg p-12 text-center text-gray-500">
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
          <div v-else-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 rounded-lg p-12 text-center text-gray-500">
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
          <div v-else-if="!overview" class="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <div class="i-carbon-warning-alt text-4xl text-gray-300" />
            <div class="text-base text-gray-600 font-medium dark:text-gray-300">
              暂无牧场数据
            </div>
            <div class="max-w-md text-xs text-gray-400 leading-relaxed">
              牧场需要农场主 25 级解锁；若已解锁，请更新账号 Code 并确保账号在运行中，
              然后刷新本页重试（首次进入服务端可能返回空数据，已自动重试）。
            </div>
          </div>
          <!-- 只有"连建筑都没有"才是真空态; 有窝/棚但没动物时仍要显示建筑视图 -->
          <div
            v-else-if="overview.animals.length === 0 && (overview.coopCount || 0) === 0 && (overview.penCount || 0) === 0"
            class="flex flex-col items-center justify-center gap-3 py-10 text-center"
          >
            <div class="i-fas-paw text-4xl text-gray-300" />
            <div class="text-base text-gray-600 font-medium dark:text-gray-300">
              牧场还没有动物
            </div>
            <div class="max-w-md text-xs text-gray-400 leading-relaxed">
              去「幼崽商城」页签逐个购买，或开启设置里的「自动买幼崽」；
              也可以去游戏里的牧场手动摆放。
            </div>
          </div>

        <!-- 建筑视图(对应农场的"田地"): 窝 / 棚 分组。
             批量操作条和建筑网格必须包在同一个 v-else 里 —— 它们之间不能再插
             独立 v-if 节点, 否则会把上面那条 "空态 v-else-if" 链切断。 -->
          <div v-else class="space-y-4">
            <!-- 批量操作(对照农场"整田操作") -->
            <div class="flex flex-wrap gap-2 border-b border-gray-100 pb-2.5 dark:border-gray-700">
              <button
                v-for="op in BATCH_OPS"
                :key="op.key"
                type="button"
                class="min-h-[38px] inline-flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
                :class="op.tone"
                :disabled="opBusy !== ''"
                @click="op.key === 'feed' ? runBatch('feed', { feedType: 5 }) : runBatch(op.key)"
              >
                <div :class="op.icon" />
                {{ op.label }}
              </button>
              <!-- 游商兑换: 用便便向流动商贩换物, 是牧场唯一的"便便变现"路径。
                   autoBuyRotationShop 会自己判断是否营业/有没有便便。 -->
              <button
                type="button"
                class="min-h-[38px] inline-flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
                :disabled="opBusy !== ''"
                @click="runOp('rotation')"
              >
                <div class="i-carbon-store" />
                游商兑换
              </button>
              <!-- 偷好友牧场产物: 自动流程由 ranch_steal 开关控制, 这里给手动补跑一次 -->
              <button
                type="button"
                class="min-h-[38px] inline-flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 border-pink-300 bg-pink-50 text-pink-700 hover:bg-pink-100 dark:border-pink-700 dark:bg-pink-900/30 dark:text-pink-300"
                :disabled="opBusy !== ''"
                @click="stealConfirming = true"
              >
                <div class="i-carbon-arrow-down-left" />
                偷好友牧场
              </button>
              <!-- 建筑升级 / 地块解锁: 后端是一键(先领竣工再升级), 不传 instId 即整场 -->
              <button
                type="button"
                class="min-h-[38px] inline-flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                :disabled="opBusy !== ''"
                @click="runOp('upgrade')"
              >
                <div class="i-carbon-upgrade" />
                建筑升级
              </button>
              <button
                type="button"
                class="min-h-[38px] inline-flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 border-cyan-300 bg-cyan-50 text-cyan-700 hover:bg-cyan-100 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300"
                :disabled="opBusy !== ''"
                @click="runOp('unlock')"
              >
                <div class="i-carbon-unlocked" />
                解锁地块
              </button>
            </div>

            <div
              v-for="pen in pensView"
              :key="pen.key"
              class="border border-gray-200 rounded-lg p-3 dark:border-gray-700 sm:p-4"
            >
              <div class="mb-3 flex items-center justify-between gap-2">
                <h4 class="flex items-center gap-1.5 text-sm text-gray-700 font-bold dark:text-gray-200">
                  <i :class="pen.icon" class="text-base" aria-hidden="true" />
                  {{ pen.title }}
                  <span v-if="!pen.locked" class="text-xs text-gray-400 font-normal">{{ pen.animals.length }}/{{ pen.capacity }} 在养</span>
                  <span
                    v-else
                    class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-400 font-normal dark:bg-gray-800"
                  >
                    未解锁
                  </span>
                </h4>
                <div v-if="pen.facility || pen.building" class="flex items-center gap-1 text-[11px] text-gray-400">
                  <span v-if="pen.facility">{{ pen.facility.name || pen.title }}{{ pen.facility.level ? ` Lv${pen.facility.level}` : '' }}</span>
                  <span v-else-if="pen.building">{{ pen.title.slice(0, 1) }} Lv{{ pen.building.level }}</span>
                  <span
                    v-if="pen.facility?.upgrading"
                    class="rounded bg-sky-100 px-1 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                  >
                    升级中
                  </span>
                </div>
              </div>

              <!-- 未解锁: 占位说明, 不渲染槽位 -->
              <div
                v-if="pen.locked"
                class="min-h-[80px] flex flex-col items-center justify-center border border-gray-200 rounded-lg border-dashed p-4 text-gray-300 dark:border-gray-700"
              >
                <div class="i-carbon-lock text-2xl" />
                <div class="mt-2 text-[11px] text-gray-400">
                  该栏舍尚未建造或未解锁
                </div>
              </div>

              <div v-else class="grid grid-cols-2 gap-3 md:grid-cols-4 sm:grid-cols-3">
                <!-- 已养的动物 -->
                <div
                  v-for="a in pen.animals"
                  :key="a.slot"
                  class="relative min-h-[150px] flex flex-col items-center border rounded-lg p-2 transition sm:min-h-[170px]"
                  :class="a.mutant
                    ? 'border-fuchsia-300 bg-fuchsia-50/80 dark:border-fuchsia-700 dark:bg-fuchsia-900/20'
                    : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'"
                >
                  <div class="absolute left-1 top-1 text-[10px] text-gray-400 font-mono">
                    槽{{ a.slot }}
                  </div>
                  <div
                    v-if="a.mutant"
                    class="absolute right-1 top-1 rounded bg-fuchsia-100 px-1 py-0.5 text-[10px] text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300"
                  >
                    变异
                  </div>

                  <div class="mb-1 mt-3 h-10 w-10 flex items-center justify-center rounded-full sm:h-12 sm:w-12" :class="animalVisual(a.name)?.bg || 'bg-gray-100/60'">
                    <span class="text-2xl leading-none sm:text-3xl">{{ animalVisual(a.name)?.emoji || '🐾' }}</span>
                  </div>

                  <div class="w-full truncate px-1 text-center text-xs font-bold" :title="`#${a.animalId}`">
                    {{ a.name }}
                  </div>
                  <div class="mt-0.5 text-[10px] text-gray-500">
                    {{ a.stageText }}
                  </div>

                  <div class="mt-1 text-center text-[10px]">
                    <!-- 四阶段(照农场倒计时思想: #10 = 当前阶段结束时刻, 倒计时=未来值-当前) -->
                    <span v-if="isHarvestable(a)" class="text-amber-600 font-medium dark:text-amber-400">可收获</span>
                    <span v-else-if="a.grown && a.feedState === 3 && (a.deliverInSec ?? 0) > 0" class="text-orange-500" title="生产期：蛋/崽产出中(#25 下次产出时刻)，到点可收">生产期 {{ formatTime(a.deliverInSec) }}</span>
                    <span v-else-if="!a.grown && (a.stageEndInSec ?? 0) > 0" class="text-sky-600 dark:text-sky-400" title="成长期倒计时（长成后自动开始生产期）">成长期 {{ formatTime(a.stageEndInSec) }}</span>
                    <span v-else-if="!a.grown" class="text-sky-600 dark:text-sky-400" title="幼年动物正在成长（服务端未下发成长结束时刻）">成长中</span>
                    <span v-else-if="a.produceUnknownReason === 'justHarvested'" class="text-gray-400" title="刚收获过，吃草后会进入下一轮产出">已收获·待下一轮</span>
                    <span v-else-if="a.produceUnknownReason === 'hungry'" class="text-red-500" title="动物没吃上牧草，停止产出。牧草断了会自动购买">饥饿·缺牧草</span>
                    <span v-else class="text-gray-400" title="等待服务端刷新状态">产出待定</span>
                  </div>

                  <div
                    v-if="a.sellCost"
                    class="mt-0.5 text-[10px] text-gray-400"
                    title="产物出售参考价"
                  >
                    金券 {{ a.sellCost.amount }}
                  </div>

                  <!-- 单只收获: 服务端未提供该接口(CollectProduce/HarvestAnimal 实测不存在),
                       收获由设置里的「自动收获」开关统一执行, 这里只显示状态 -->
                  <div class="mt-auto w-full flex gap-1 pt-2">
                    <button
                      v-if="a.canProduce"
                      type="button"
                      class="min-h-[36px] flex-1 border border-sky-300 rounded-lg bg-sky-50 px-2 py-1.5 text-xs text-sky-700 font-medium transition dark:border-sky-700 dark:bg-sky-900/30 hover:bg-sky-100 dark:text-sky-300 disabled:opacity-40"
                      :disabled="operateLoading === a.slot || opBusy !== ''"
                      @click="runOp('produce', a.slot)"
                    >
                      催产
                    </button>
                    <!-- 喂罐头(FeedAnimal, 单只实测可用)
                         两种罐头限制不同(抓包实测):
                           4 = 普通罐头, 每只动物只能用一次
                           5/6 = 有机罐头, 不限次数 -->
                    <button
                      type="button"
                      class="min-h-[36px] flex-1 border border-orange-300 rounded-lg bg-orange-50 px-2 py-1.5 text-xs text-orange-700 font-medium transition dark:border-orange-700 dark:bg-orange-900/30 hover:bg-orange-100 dark:text-orange-300 disabled:opacity-40"
                      :disabled="operateLoading === a.slot || opBusy !== ''"
                      title="普通罐头：每只动物只能用一次（推快本次产出 1 小时）"
                      @click="runOp('feed', a.slot, { feedType: 4 })"
                    >
                      普通罐头
                    </button>
                    <button
                      type="button"
                      class="min-h-[36px] flex-1 border border-amber-300 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700 font-medium transition dark:border-amber-700 dark:bg-amber-900/30 hover:bg-amber-100 dark:text-amber-300 disabled:opacity-40"
                      :disabled="operateLoading === a.slot || opBusy !== ''"
                      title="有机罐头：不限次数（累积罐头加成时长）"
                      @click="runOp('feed', a.slot, { feedType: 5 })"
                    >
                      有机罐头
                    </button>
                    <!-- 出售动物(donate): 卖栏里的这只换金券。按农场"整块操作"的习惯放在卡片内联 -->
                    <button
                      type="button"
                      class="min-h-[36px] flex-1 border border-rose-300 rounded-lg bg-rose-50 px-2 py-1.5 text-xs text-rose-700 font-medium transition dark:border-rose-700 dark:bg-rose-900/30 hover:bg-rose-100 dark:text-rose-300 disabled:opacity-40"
                      :disabled="operateLoading === a.slot || opBusy !== ''"
                      :title="a.sellCost ? `约 ${a.sellCost.amount} 金券` : '出售这只动物'"
                      @click="openSellConfirm(a)"
                    >
                      出售
                    </button>
                  </div>
                </div>

                <!-- 空槽 -->
                <div
                  v-for="n in pen.emptySlots"
                  :key="`empty-${pen.key}-${n}`"
                  class="min-h-[150px] flex flex-col items-center justify-center border border-gray-200 rounded-lg border-dashed p-2 text-gray-300 sm:min-h-[170px] dark:border-gray-700"
                >
                  <div class="i-fas-paw text-3xl" />
                  <div class="mt-2 text-[11px] text-gray-400">
                    空位
                  </div>
                </div>
              </div>
            </div>

            <!-- 牧草机等建筑状态 -->
            <div
              v-for="f in (overview.facilities || []).filter((x: any) => x.slot === 10002)"
              :key="`fac-${f.slot}`"
              class="flex flex-wrap items-center justify-between gap-2 border border-gray-200 rounded-lg px-3 py-2.5 text-xs dark:border-gray-700"
            >
              <div class="flex items-center gap-2">
                <i class="i-carbon-zap text-base text-amber-500" aria-hidden="true" />
                <span class="text-gray-700 font-medium dark:text-gray-200">{{ f.name || '牧草机' }}</span>
                <span v-if="f.level" class="text-gray-400">Lv{{ f.level }}</span>
                <span
                  v-if="f.upgrading"
                  class="rounded bg-sky-100 px-1 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                >
                  升级中
                </span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-gray-500 dark:text-gray-400">
                  {{ f.slot === 10002 ? '牧草' : '占位' }} {{ f.stored }} / {{ f.capacity || '?' }}
                </span>
                <!-- 补草(feedmachine): 把背包里的牧草投进机器, 是栏舍「缺草」的唯一解 -->
                <button
                  v-if="f.slot === 10002"
                  type="button"
                  class="min-h-[30px] border border-emerald-300 rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 font-medium transition dark:border-emerald-700 dark:bg-emerald-900/30 hover:bg-emerald-100 dark:text-emerald-300 disabled:opacity-40"
                  :disabled="opBusy !== ''"
                  @click="runOp('feedmachine', 0, { count: 100 })"
                >
                  补草
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="!!selectedCub"
      :loading="cubConfirmLoading"
      title="确认购买幼崽"
      :message="cubPurchaseMessage"
      confirm-text="确认下单"
      type="primary"
      @cancel="closeCubPurchase"
      @confirm="confirmCubPurchase"
    />

    <ConfirmModal
      :show="!!sellTarget"
      :loading="sellConfirmLoading"
      title="确认出售动物"
      :message="sellMessage"
      confirm-text="确认出售"
      type="danger"
      @cancel="sellTarget = null"
      @confirm="confirmSell"
    />

    <ConfirmModal
      :show="stealConfirming"
      :loading="stealLoading"
      title="确认偷取好友牧场产物"
      :message="stealMessage"
      confirm-text="确认偷取"
      type="primary"
      @cancel="stealConfirming = false"
      @confirm="confirmSteal"
    />

  </div>
</template>
