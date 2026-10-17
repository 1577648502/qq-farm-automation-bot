<script setup lang="ts">
/**
 * 奶茶热销中（2026-10-15 新活动）—— 左侧栏独立页面
 *
 * ① 顶部信息: 店铺/等级/待领取收益/奶茶券余额/累计营业额/下次结算
 * ② 种子商店: 拾物小铺式卡片, 按货币分组, 卡内填数量兑换; 等级不足/已限购置灰
 * ③ 雇佣好友: 可折叠, 支持手动添加 GID + 勾选白名单 + 自动雇佣
 * ④ 任务: 卡片式 + 领取 / 一键领取 / 自动领取
 * 自动化开关与"立即执行"在 设置 → 自动控制
 *
 * 协议见 core/src/services/milk-tea.js
 */
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'
import { apiError } from '@/utils/api-result'

const toast = useToastStore()

const status = ref<any>(null)
const statusBusy = ref(false)
const actionResult = ref('')
const busy = ref('')

const shop = ref<any[]>([])
const shopBusy = ref(false)
const shopQty = ref<Record<number, number>>({})

const friends = ref<any[]>([])
const friendsBusy = ref(false)
const hireGids = ref<string[]>([])
const autoHire = ref(false)
const autoInteract = ref(false)
const friendsOpen = ref(false)   // 只折叠「好友列表」
const hireSaving = ref(false)
/** 互动事项(与后端一致) */
const INTERACT_OPTIONS = [
  { id: 1, name: '宣传推广', recommended: false },
  { id: 2, name: '花式摇杯', recommended: true },
  { id: 3, name: '招牌试饮', recommended: false },
  { id: 4, name: '划水摸鱼', recommended: false },
  { id: 5, name: '申请涨薪', recommended: false },
]

/** 互动(我的工作): 目标好友 + 互动类型(默认 2 花式摇杯) */
const interactGid = ref('')
const storeName = ref('奶茶小铺')
/** 好友列表(cmd=56 的 #161.#4): 含在岗状态/特长/下班时间 —— 用于标记可雇佣性(不是"我雇的人") */
const employees = ref<any[]>([])
/** 营业记录(cmd=67, 按天): 日期/售卖杯数/收益/奖励物品/雇员记录 */
const sales = ref<any>(null)
const salesLoading = ref(false)
const salesDay = ref<number>(0)   // 0 = 今天(由服务端算)
/** 店铺等级进度(来自 cmd=55: #1 等级 / #2 累计营业额 / #3 下一级所需) */
const upgradeInfo = ref<any>(null)
/** 等级进度百分比(0~100) */
function upgradePercent() {
  const i = upgradeInfo.value
  if (!i || !i.ok || !i.required) return 0
  return Math.max(0, Math.min(100, Math.round((Number(i.revenue) || 0) / Number(i.required) * 100)))
}
async function loadUpgradeInfo() {
  try {
    const res = await api.post('/api/activity/milk-tea/upgrade-info', {})
    const d = res.data?.data || {}
    if (!apiError(res, d)) upgradeInfo.value = d
  } catch (e: any) { /* 静默: 进度条拿不到不影响主流程 */ }
}
const employeesLoading = ref(false)
/** 我的员工数 —— 取服务端 #161.#1(权威); 列表(#4)含非本人雇佣的好友, 不用于展示员工 */
const employeeCount = ref(0)
/** 每日自动兑换种子(一天一次) + 每种兑换份数 */
const autoBuySeed = ref(false)
const seedBuyCount = ref(1)
const interactType = ref(2)

const KIND_LABEL: Record<string, string> = { seed: '种子', exchange: '装扮兑换' }
const kindLabel = (g: any) => KIND_LABEL[g.kind] || '道具'

function reportError(where: string, msg: string) {
  const text = msg ? `${where}：${msg}` : `${where}失败`
  actionResult.value = text
  toast.error(text)
}

const maxQty = (g: any) => {
  const lim = Math.floor(Number(g.limitCount) || 0)
  const bought = Math.floor(Number(g.boughtCount) || 0)
  const remain = lim > 0 ? lim - bought : 9999
  return remain > 0 ? remain : 1
}
const clampQty = (g: any) => {
  const n = Math.floor(Number(shopQty.value[g.goodsId]) || 1)
  return Math.min(Math.max(1, n), maxQty(g))
}
const totalCost = (g: any) => Number(g.unitPrice || 0) * clampQty(g)

const storeLevel = computed(() => Number(status.value?.storeLevel) || 0)
const pending = computed(() => Number(status.value?.cashier?.pending) || 0)
const capacity = computed(() => Number(status.value?.cashier?.capacity) || 0)
const milkCoupon = computed(() => Number(status.value?.milkCoupon) || 0)

/** 等级不足 */
function isLocked(g: any) {
  const need = Number(g.requireLevel) || 0
  if (need <= 0) return false
  return storeLevel.value > 0 && storeLevel.value < need
}
/** 已限购(本会话已兑满) */
function isSoldOut(g: any) {
  const lim = Number(g.limitCount) || 0
  return lim > 0 && Number(g.boughtCount) >= lim
}
function isDisabled(g: any) {
  return isLocked(g) || isSoldOut(g)
}

const shopGroups = computed(() => {
  const map = new Map<number, any>()
  for (const g of shop.value) {
    const k = Number(g.currencyId) || 0
    if (!map.has(k)) map.set(k, { currencyId: k, currencyName: g.currencyName || `货币#${k}`, items: [] as any[] })
    map.get(k).items.push(g)
  }
  return Array.from(map.values())
})

function fmtTime(sec: number) {
  if (!sec) return '-'
  const d = new Date(sec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function loadStatus() {
  statusBusy.value = true
  try {
    const res = await api.get('/api/activity/milk-tea/status')
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('读取经营状态', err); status.value = null; return }
    status.value = d
  } catch (e: any) {
    reportError('读取经营状态', apiError(null, null, e))
  } finally {
    statusBusy.value = false
  }
}

async function loadShop() {
  shopBusy.value = true
  try {
    const res = await api.get('/api/activity/milk-tea/shop')
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('读取商店', err); shop.value = []; return }
    shop.value = Array.isArray(d.goods) ? d.goods : []
    for (const g of shop.value) if (!shopQty.value[g.goodsId]) shopQty.value[g.goodsId] = 1
  } catch (e: any) {
    reportError('读取商店', apiError(null, null, e))
  } finally {
    shopBusy.value = false
  }
}

/** 拉取好友列表(cmd=56) */
async function loadEmployees() {
  employeesLoading.value = true
  try {
    const res = await api.post('/api/activity/milk-tea/employees', {})
    const d = res.data?.data || {}
    if (!apiError(res, d)) {
      employees.value = d.friends || []
      employeeCount.value = Number(d.count) || 0
    }
  } catch (e: any) { /* 静默: 不影响主流程 */ } finally {
    employeesLoading.value = false
  }
}
/** 营业记录(cmd=67, 按天; day 省略=今天) */
async function loadSales(day?: number) {
  salesLoading.value = true
  try {
    const res = await api.post('/api/activity/milk-tea/sales-record', day ? { day } : {})
    const d = res.data?.data || {}
    if (apiError(res, d)) { sales.value = { ok: false, reason: `接口返回异常: ${JSON.stringify(res.data).slice(0, 120)}` }; return }
    if (!d || d.ok !== true) { sales.value = { ok: false, reason: d.reason || `接口返回体不含 ok 字段(可能后端未更新): ${JSON.stringify(res.data).slice(0, 120)}` }; return }
    sales.value = d
    salesDay.value = Number(d.day) || 0
  } catch (e: any) {
    const st = e.response?.status ? `HTTP ${e.response.status}` : ''
    sales.value = { ok: false, reason: `营业记录请求失败：${st} ${e.response?.data?.error || e.message || '未知错误'}` }
  } finally { salesLoading.value = false }
}
/** 前一天 / 后一天 */
function shiftSalesDay(delta: number) {
  const cur = salesDay.value || Math.floor(Date.now() / 1000)
  return loadSales(cur + delta * 86400)
}
/** 日期戳 → YYYY-MM-DD(北京时间) */
function fmtDay(ts: number) {
  if (!ts) return '—'
  const d = new Date((Number(ts) + 8 * 3600) * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
/** 时刻 → HH点MM分(北京时间) */
function fmtClock(ts: number) {
  if (!ts) return ''
  const d = new Date((Number(ts) + 8 * 3600) * 1000)
  return `${d.getUTCHours()}点${String(d.getUTCMinutes()).padStart(2, '0')}分`
}






async function loadHireConfig() {
  try {
    const res = await api.get('/api/activity/milk-tea/hire-config')
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('读取雇佣设置', err); return }
    hireGids.value = (d.hireGids || []).map((g: any) => String(g))
    autoHire.value = !!d.autoHire
    autoInteract.value = !!d.autoInteract
    if (d.interactType) interactType.value = Number(d.interactType)
    if (d.employerGid) interactGid.value = String(d.employerGid)
    if (d.storeName) storeName.value = String(d.storeName)
    autoBuySeed.value = !!d.autoBuySeed
    if (d.seedBuyCount) seedBuyCount.value = Number(d.seedBuyCount)
  } catch (e: any) {
    reportError('读取雇佣设置', apiError(null, null, e))
  }
}

async function loadFriends() {
  friendsBusy.value = true
  try {
    const res = await api.get('/api/activity/milk-tea/friends')
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('读取好友', err); friends.value = []; return }
    friends.value = Array.isArray(d.friends) ? d.friends : []
  } catch (e: any) {
    reportError('读取好友', apiError(null, null, e))
  } finally {
    friendsBusy.value = false
  }
}


async function buy(g: any) {
  if (isLocked(g)) {
    toast.warning(`「${g.name}」需要奶茶店等级 ≥${g.requireLevel}（当前 Lv${storeLevel.value}）`)
    return
  }
  if (isSoldOut(g)) { toast.warning(`「${g.name}」已达限购 ${g.limitCount}`); return }
  const count = clampQty(g)
  busy.value = `buy-${g.goodsId}`
  actionResult.value = ''
  try {
    const res = await api.post('/api/activity/milk-tea/buy', { goodsId: g.goodsId, count })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError(`兑换「${g.name}」`, err); return }
    const got = d.got ? `${d.got.count} 个` : `${count} 个`
    const cost = d.cost ? `，花费 ${Number(d.cost.amount).toLocaleString()} ${g.currencyName}` : ''
    actionResult.value = `已兑换「${g.name}」${got}${cost}`
    toast.success(actionResult.value)
    await loadShop()
    await loadStatus()
  } catch (e: any) {
    reportError(`兑换「${g.name}」`, apiError(null, null, e))
  } finally {
    busy.value = ''
  }
}

/** 全选好友(列表里的全部) */
function selectAllFriends() {
  hireGids.value = friends.value.map((f: any) => String(f.gid))
}
/** 清空选择 */
function clearAllFriends() { hireGids.value = [] }
/** 反选 */
function invertFriends() {
  const cur = new Set(hireGids.value)
  hireGids.value = friends.value.map((f: any) => String(f.gid)).filter((g: string) => !cur.has(g))
}

/** 批量雇佣: 逐个雇(后台带节流, 单次最多 10 个) */
/** 领收银台收益(cmd=59, 真正的领取) */
async function claimCashierNow() {
  busy.value = 'cashier'
  try {
    const res = await api.post('/api/activity/milk-tea/cashier', {})
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('领收银台收益', err); return }
    if (d.skipped) { actionResult.value = d.reason || '暂无收益'; toast.warning(actionResult.value); return }
    const got = (d.gainedList || []).map((x: any) => x.name).join('、')
    actionResult.value = got ? `已领收银台收益 → ${got}` : '已领收银台收益'
    toast.success(actionResult.value)
    await loadStatus()
  } catch (e: any) {
    reportError('领收银台收益', apiError(null, null, e))
  } finally { busy.value = '' }
}

/** 制作奶茶(cmd=62): 把背包里所有活动果实都做掉 */
async function craftNow() {
  busy.value = 'craft'
  try {
    const res = await api.post('/api/activity/milk-tea/craft', { all: true })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('制作奶茶', err); return }
    actionResult.value = d.used ? `已制作奶茶（投入 ${d.used} 个果实）` : '制作奶茶完成'
    toast.success(actionResult.value)
  } catch (e: any) {
    reportError('制作奶茶', apiError(null, null, e))
  } finally { busy.value = '' }
}

/** 升级店铺(cmd=61) */
async function upgradeNow() {
  busy.value = 'upgrade'
  try {
    const res = await api.post('/api/activity/milk-tea/upgrade-store', {})
    const d = res.data?.data || {}
    if (apiError(res, d)) { actionResult.value = `升级店铺接口返回异常：${JSON.stringify(res.data).slice(0, 120)}`; return }
    if (d.ok) {
      actionResult.value = `店铺已升级到 Lv${d.level}${d.got && d.got.length ? `，奖励 ${d.got.join('、')}` : ''}`
      toast.success('店铺升级成功')
      await loadStatus()
      await loadUpgradeInfo()
    } else {
      actionResult.value = d.reason || '升级未成功'
      toast.warning(d.reason || '升级未成功')
    }
  } catch (e: any) {
    const st = e.response?.status ? `HTTP ${e.response.status}` : ''
    const msg = e.response?.data?.error || e.message || '未知错误'
    actionResult.value = `升级店铺请求失败：${st} ${msg}`
    toast.error(actionResult.value)
  } finally {
    busy.value = ''
  }
}

/** 领工资(cmd=64): 实测 奶茶券×120 */
async function claimWageNow() {
  busy.value = 'wage'
  try {
    const res = await api.post('/api/activity/milk-tea/wage', {})
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('领工资', err); return }
    actionResult.value = d.gained ? `已领工资 ${d.gained.count} 奶茶券` : '领工资完成'
    toast.success(actionResult.value)
  } catch (e: any) {
    reportError('领工资', apiError(null, null, e))
  } finally {
    busy.value = ''
  }
}

/** 互动(我的工作, cmd=65): 每班一次, 影响工资 */
async function interactNow() {
  if (status.value && status.value.ok && status.value.employed === false) {
    toast.warning('当前没有被好友雇佣（【我的工作】为空），不能互动')
    return
  }
  const w = (status.value && status.value.work) || {}
  // ⚠ 互动的前提是"当前有进行中的班次"(被好友雇佣): 手填 GID 也不能绕过 —— 否则服务端会回 1034147
  if (!w.employer || !w.employer.gid) {
    toast.warning('当前没有进行中的兼职（未被好友雇佣），不能互动')
    return
  }
  if (w.endAt && Math.floor(Date.now() / 1000) >= w.endAt) {
    toast.warning('本班工作已结束, 请等新的班次开始后再互动')
    return
  }
  if (w.interactTotal > 0 && w.interactUsed >= w.interactTotal) {
    toast.warning(`本班互动次数已用完（${w.interactUsed}/${w.interactTotal}），等下一班`)
    return
  }
  // 目标: 手填优先, 否则当前老板(权威)
  const gid = String(interactGid.value || w.employer.gid).trim()
  busy.value = 'interact'
  try {
    const res = await api.post('/api/activity/milk-tea/interact', { friendGid: gid, type: Number(interactType.value) || 5 })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('互动', err); return }
    const wage = d.interact && d.interact.wage ? `（底薪 ${d.interact.wage.base} / 加成 ${d.interact.wage.extra}）` : ''
    actionResult.value = `已与好友 ${d.friendGid || gid} 互动${wage}`
    toast.success(actionResult.value)
  } catch (e: any) {
    reportError('互动', apiError(null, null, e))
  } finally {
    busy.value = ''
  }
}

async function hireAllNow() {
  if (!hireGids.value.length) { toast.warning('请先勾选好友（或点全选）'); return }
  busy.value = 'hire-all'
  try {
    const res = await api.post('/api/activity/milk-tea/hire-all', { hireGids: hireGids.value, limit: 10 })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('批量雇佣', err); return }
    actionResult.value = `批量雇佣完成：${d.hired}/${d.total} 成功`
    toast.success(actionResult.value)
  } catch (e: any) {
    reportError('批量雇佣', apiError(null, null, e))
  } finally {
    busy.value = ''
  }
}

function toggleGid(gid: string) {
  const i = hireGids.value.indexOf(gid)
  if (i >= 0) hireGids.value.splice(i, 1)
  else hireGids.value.push(gid)
}


async function saveHireConfig() {
  hireSaving.value = true
  try {
    const res = await api.post('/api/activity/milk-tea/hire-config', {
      hireGids: hireGids.value,
      autoHire: autoHire.value,
      autoInteract: autoInteract.value,
      interactType: Number(interactType.value) || 5,
      employerGid: String(interactGid.value || ''),
      storeName: String(storeName.value || ''),
    })
    const err = apiError(res, res.data?.data)
    if (err) { reportError('保存设置', err); return }
    toast.success(`已保存：好友 ${hireGids.value.length} 位${autoHire.value ? '，自动雇佣开' : ''}`)
  } catch (e: any) {
    reportError('保存设置', apiError(null, null, e))
  } finally {
    hireSaving.value = false
  }
}

async function hireNow() {
  busy.value = 'hire-auto'
  try {
    const res = await api.post('/api/activity/milk-tea/hire-auto', { hireGids: hireGids.value })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('雇佣好友', err); return }
    actionResult.value = `已雇佣好友 ${d.friendGid}`
    toast.success(actionResult.value)
  } catch (e: any) {
    reportError('雇佣好友', apiError(null, null, e))
  } finally {
    busy.value = ''
  }
}



/** 串行 + 错开加载: 避免一次性并发多个游戏请求把队列打满(队列已满→心跳异常掉线) */
async function refreshAll() {
  await loadStatus()
  await new Promise((r) => setTimeout(r, 400))
  await loadShop()
  await new Promise((r) => setTimeout(r, 400))
  await loadHireConfig()
  // 好友列表首次会做重同步(约 6 个请求) → 只在展开"雇佣好友"时按需拉
  if (friendsOpen.value) await loadFriends()
}


onMounted(() => {
  loadStatus()
  setTimeout(() => loadHireConfig(), 500)
  setTimeout(() => loadEmployees(), 900)
  setTimeout(() => loadSales(), 1200)
  setTimeout(() => loadUpgradeInfo(), 1400)
  setTimeout(() => loadShop(), 1000)
})
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1500px] grid-cols-1 items-start gap-4 xl:grid-cols-2">
    <!-- 页头 -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-xl text-gray-900 font-bold dark:text-gray-100">
        奶茶热销中
        <span class="ml-2 text-xs text-gray-500 font-normal dark:text-gray-400">
          营业 10/15–11/14 · 结算 11/15–11/16
        </span>
      </h2>
      <BaseButton variant="secondary" size="sm" :loading="statusBusy" @click="refreshAll">
        刷新
      </BaseButton>
    </div>

    <!-- 结算期提醒 -->
    <div
      v-if="status && status.settleAt && Date.now() / 1000 >= status.settleAt"
      class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
    >
      已进入**结算期**（11/15–11/16）：自动营业、宣传、雇佣、互动、购买专属种子都会停止；
      未领收益会通过邮件补发，请在结算期结束前完成兑换。
    </div>

    <!-- ① 顶部信息 -->
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 order-1 col-span-full">
      <div v-if="status" class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">店铺</div>
          <div class="text-base text-gray-900 font-bold dark:text-gray-100">
            {{ status.storeName || '未开业' }}
            <span v-if="status.storeLevel" class="ml-1 text-xs text-gray-500 font-normal">Lv{{ status.storeLevel }}</span>
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">
            待领取收益<span v-if="capacity"> （容量 {{ capacity }}）</span>
          </div>
          <div
            class="text-base font-bold"
            :class="pending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100'"
          >
            {{ pending.toLocaleString() }}
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">奶茶券余额</div>
          <div class="text-base text-gray-900 font-bold dark:text-gray-100">{{ milkCoupon.toLocaleString() }}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">累计营业额</div>
          <div class="text-base text-gray-900 font-bold dark:text-gray-100">
            {{ Number(status.value || 0).toLocaleString() }}
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">下次结算</div>
          <div class="text-sm text-gray-900 font-medium dark:text-gray-100">{{ fmtTime(status.nextAt) }}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">最近更新</div>
          <div class="text-sm text-gray-900 font-medium dark:text-gray-100">{{ fmtTime(status.at) }}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">结算期开始</div>
          <div class="text-sm text-gray-900 font-medium dark:text-gray-100">{{ fmtTime(status.settleAt) }}</div>
        </div>
        <!-- 顶部只显示员工数量; 员工名单在下方"雇佣好友"卡片里 -->
        <!-- 店铺等级进度(Lv N → Lv N+1: 累计营业额 / 下一级所需) -->
        <div class="col-span-2 md:col-span-2">
          <div class="mb-1 flex items-center justify-between text-xs">
            <span class="text-gray-500 dark:text-gray-400">
              店铺等级
              <span class="ml-1 font-medium text-gray-900 dark:text-gray-100">Lv{{ upgradeInfo && upgradeInfo.ok ? upgradeInfo.level : (status.storeLevel || '—') }}</span>
              <template v-if="upgradeInfo && upgradeInfo.ok && upgradeInfo.required">
                <span class="text-gray-400"> → Lv{{ Number(upgradeInfo.level) + 1 }}</span>
              </template>
            </span>
            <span v-if="upgradeInfo && upgradeInfo.ok && upgradeInfo.required" class="text-gray-500 dark:text-gray-400">
              {{ Number(upgradeInfo.revenue).toLocaleString() }} / {{ Number(upgradeInfo.required).toLocaleString() }}
              <span class="ml-1 font-medium" :class="upgradePercent() >= 100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-700 dark:text-gray-200'">{{ upgradePercent() }}%</span>
            </span>
            <span v-else class="text-gray-400">—</span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
            <div
              class="h-full rounded transition-all"
              :class="upgradePercent() >= 100 ? 'bg-emerald-500' : 'bg-blue-500'"
              :style="{ width: upgradePercent() + '%' }"
            />
          </div>
          <div v-if="upgradeInfo && upgradeInfo.ok && upgradeInfo.canUpgrade" class="mt-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            营业额已达标，可升级（点下方「升级店铺」或等自动升级）
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">我雇佣的员工</div>
          <div class="text-sm text-gray-900 font-medium dark:text-gray-100">{{ employeeCount }} 位</div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">受雇状态</div>
          <div
            class="text-sm font-medium"
            :class="status.employed ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400'"
          >
            {{ status.employed ? '已被雇佣（可互动）' : '未受雇' }}
            <span
              v-if="(status.work && status.work.employer) || (status.employer && status.employer.gid)"
              class="ml-1 text-xs text-gray-500 font-normal"
            >
              老板 {{ (status.work && status.work.employer ? status.work.employer.name : status.employer.name) || '' }}
              {{ status.work && status.work.employer ? status.work.employer.gid : status.employer.gid }}
              <template v-if="status.work && status.work.wage"> · 工资 {{ status.work.wage }}</template>
              <template v-if="status.work && status.work.titleName"> · 特长 {{ status.work.titleName }}</template>
              <template v-if="status.work && status.work.interactTotal > 0">
                · 互动 {{ status.work.interactUsed }}/{{ status.work.interactTotal }}{{ status.work.canInteract ? '（可互动）' : '（已用完）' }}
              </template>
            </span>
          </div>
        </div>
      </div>
      <div v-else class="text-xs text-gray-500 dark:text-gray-400">
        {{ statusBusy ? '读取中…' : (status?.reason || '暂无状态（账号需在线）') }}
      </div>
      <div v-if="status && pending > 0" class="mt-2 text-xs text-amber-600 dark:text-amber-400">
        收银台还有 {{ pending.toLocaleString() }} 待领取 —— 满载会暂停营业且不补发，建议在「设置 → 自动控制」开启自动领取。
      </div>
    </div>

    <!-- ①c 营业记录(cmd=67 按天: 今日售卖 + 营业收益 + 雇员记录) -->
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 order-3 col-span-full xl:col-span-1">
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">营业记录</h3>
        <div class="flex items-center gap-1">
          <BaseButton variant="secondary" size="sm" @click="shiftSalesDay(-1)">◀ 前一天</BaseButton>
          <span class="px-1 text-xs text-gray-600 dark:text-gray-300">{{ fmtDay(salesDay) }}</span>
          <BaseButton variant="secondary" size="sm" @click="shiftSalesDay(1)">后一天 ▶</BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="salesLoading" @click="loadSales()">刷新</BaseButton>
        </div>
      </div>
      <template v-if="sales && sales.ok">
        <!-- 正在热卖(本小时杯数, 来自 cmd=67 的 #6 按小时分布) -->
        <div class="mb-3 flex flex-wrap items-center gap-2 rounded bg-rose-50 px-2 py-1.5 dark:bg-rose-900/20">
          <span class="text-xs font-medium text-rose-700 dark:text-rose-300">正在热卖</span>
          <span class="text-xs text-rose-700 dark:text-rose-300">本小时 {{ sales.currentHourCups || 0 }} 杯</span>
          <span v-if="sales.hourly && sales.hourly.length" class="text-[10px] text-gray-500 dark:text-gray-400">
            最近几小时：{{ sales.hourly.map((h: any) => h.hour === 0 ? `本小时 ${h.cups}杯` : `${h.hour}小时前 ${h.cups}杯`).join(' · ') }}
          </span>
        </div>
        <!-- 今日售卖(按品类杯数) -->
        <div class="mb-3">
          <div class="mb-1 text-xs text-gray-500 dark:text-gray-400">今日售卖（共 {{ sales.cups }} 杯）</div>
          <div v-if="sales.items && sales.items.length" class="flex flex-wrap gap-2">
            <span v-for="c in sales.items" :key="c.id" class="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              {{ c.name }} {{ c.cups }}杯
            </span>
          </div>
          <div v-else class="text-xs text-gray-500 dark:text-gray-400">当日无售卖</div>
        </div>
        <!-- 营业收益 -->
        <div class="mb-3">
          <div class="mb-1 text-xs text-gray-500 dark:text-gray-400">营业收益</div>
          <div class="flex flex-wrap gap-2">
            <span class="rounded bg-yellow-50 px-2 py-1 text-xs text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300">金币 {{ sales.gold }}</span>
            <span class="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">奶茶券 {{ sales.coupon }}</span>
            <span v-for="rw in (sales.rewards || [])" :key="rw.id" class="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">
              {{ rw.name }}
            </span>
          </div>
        </div>
        <!-- 雇员记录 -->
        <div>
          <div class="mb-1 text-xs text-gray-500 dark:text-gray-400">雇员记录</div>
          <div v-if="sales.records && sales.records.length" class="space-y-1">
            <div v-for="r in sales.records" :key="`${r.gid}-${r.startAt}`" class="flex flex-wrap items-center gap-2 rounded border border-gray-100 px-2 py-1 text-xs dark:border-gray-700">
              <span class="text-gray-400">{{ fmtClock(r.startAt) }}</span>
              <span class="rounded bg-sky-50 px-1 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">{{ r.titleName }}</span>
              <span class="text-gray-900 font-medium dark:text-gray-100">{{ r.name }}</span>
              <span class="text-gray-500">工作时长 {{ r.hours }}小时</span>
              <span class="text-gray-500">支付工资 +{{ r.wage }}</span>
              <span v-if="r.soldCups" class="text-gray-500">互动售出 {{ r.soldCups }} 杯</span>
            </div>
          </div>
          <div v-else class="text-xs text-gray-500 dark:text-gray-400">暂无记录</div>
        </div>
      </template>
      <div v-else class="text-xs text-gray-500 dark:text-gray-400">
        {{ salesLoading ? '读取中…' : (sales && sales.reason ? sales.reason : '点「刷新」读取营业记录') }}
      </div>
    </div>

    <!-- ② 活动种子商店 -->
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 order-4 col-span-full xl:col-span-1">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">
          活动种子商店
          <span class="ml-2 text-xs text-gray-500">填数量后点「兑换」；等级不足 / 已限购的不可兑换</span>
        </h3>
        <BaseButton variant="secondary" size="sm" :loading="shopBusy" @click="loadShop">
          刷新商品
        </BaseButton>
      </div>
      <div v-if="!shop.length" class="text-xs text-gray-500 dark:text-gray-400">
        {{ shopBusy ? '读取中…' : '暂无商品（账号需在线）' }}
      </div>
      <div v-else class="space-y-4">
        <div v-for="grp in shopGroups" :key="grp.currencyId">
          <div class="mb-2 flex items-center gap-2">
            <span class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 font-medium dark:bg-gray-700 dark:text-gray-200">
              {{ grp.currencyName }}
            </span>
            <span class="text-xs text-gray-400">{{ grp.items.length }} 件</span>
          </div>
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div
              v-for="g in grp.items"
              :key="g.goodsId"
              class="flex flex-col rounded border p-3"
              :class="isDisabled(g)
                ? 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40'
                : 'border-gray-200 dark:border-gray-700'"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="flex min-w-0 items-center gap-2">
                  <img
                    v-if="g.image"
                    :src="g.image"
                    :alt="g.name"
                    loading="lazy"
                    class="h-10 w-10 shrink-0 rounded object-contain"
                  >
                  <span class="truncate text-sm font-medium">{{ g.name }}</span>
                </div>
                <span class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                  {{ kindLabel(g) }}
                </span>
              </div>
              <div class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
                <template v-if="g.itemNameKnown">内容：{{ g.itemName }}<br></template>
                <template v-if="g.limitCount">
                  限购 {{ g.limitCount }}
                </template>
                <span v-if="isLocked(g)" class="text-amber-600 dark:text-amber-400">
                  · 需奶茶店等级 ≥{{ g.requireLevel }}（当前 Lv{{ storeLevel }}）
                </span>
                <span v-else-if="isSoldOut(g)" class="text-red-500 dark:text-red-400"> · 已限购</span>
              </div>
              <div class="mt-2 flex items-end justify-between gap-2">
                <div class="flex flex-col gap-1">
                  <span class="text-sm text-amber-600 dark:text-amber-400">
                    {{ Number(g.unitPrice).toLocaleString() }} {{ g.currencyName }}
                  </span>
                  <span class="text-[10px] text-gray-400">合计 {{ totalCost(g).toLocaleString() }}</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <input
                    v-model.number="shopQty[g.goodsId]"
                    type="number"
                    min="1"
                    :disabled="isDisabled(g)"
                    :max="maxQty(g)"
                    class="w-16 rounded border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-900"
                    title="兑换数量"
                  >
                  <BaseButton
                    variant="primary"
                    size="sm"
                    :disabled="isDisabled(g)"
                    :loading="busy === `buy-${g.goodsId}`"
                    @click="buy(g)"
                  >
                    {{ isSoldOut(g) ? '已限购' : (isLocked(g) ? '未解锁' : '兑换') }}
                  </BaseButton>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ③ 雇佣好友（可折叠） -->
    <div class="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 order-2 col-span-full">
      <div class="flex w-full items-center justify-between px-4 py-3 text-left">
        <span class="text-sm text-gray-900 font-medium dark:text-white">
          员工与雇佣
          <span class="ml-2 text-xs text-gray-500 font-normal">
            员工 {{ employeeCount }} 位 · 已勾选 {{ hireGids.length }} 位{{ autoHire ? ' · 自动雇佣已开' : '' }}
          </span>
        </span>
      </div>
      <div class="border-t border-gray-100 px-4 py-3 dark:border-gray-700/60">
        <div class="mb-2 flex flex-wrap items-center gap-3">
          <BaseSwitch v-model="autoHire" label="自动雇佣（按白名单依次尝试）" />
          <BaseSwitch v-model="autoInteract" label="自动互动（被雇佣后每轮一次）" />
          <BaseButton variant="secondary" size="sm" :loading="busy === 'hire-auto'" @click="hireNow">
            立即雇佣一个
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="!hireGids.length"
            :loading="busy === 'hire-all'"
            @click="hireAllNow"
          >
            全部雇佣（最多 10 个/次）
          </BaseButton>

          <BaseButton variant="secondary" size="sm" :loading="friendsBusy" @click="loadFriends">
            刷新好友
          </BaseButton>
          <BaseButton variant="primary" size="sm" :loading="hireSaving" @click="saveHireConfig">
            保存设置
          </BaseButton>
        </div>
        <!-- 手动操作 -->
      <div class="mb-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <BaseButton variant="secondary" size="sm" :loading="busy === 'cashier'" @click="claimCashierNow">领收银台收益</BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="busy === 'craft'" @click="craftNow">制作奶茶（全部果实）</BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="busy === 'wage'" @click="claimWageNow">领工资</BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="busy === 'interact'" @click="interactNow">互动一次</BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="busy === 'upgrade'" @click="upgradeNow">升级店铺</BaseButton>
      </div>
      <div v-if="actionResult" class="mb-2 rounded bg-gray-50 px-2 py-1 text-xs text-gray-700 dark:bg-gray-900/40 dark:text-gray-200">{{ actionResult }}</div>
        <!-- 参数: 互动事项 / 店名(雇主 GID 已改为自动探测, 不再手填) -->
        <div class="mb-2 flex flex-wrap items-center gap-2 rounded border border-gray-200 px-2.5 py-2 dark:border-gray-700">
          <label class="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
            店名
            <input v-model="storeName" type="text" class="w-32 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900">
          </label>
          <label class="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
            互动事项
            <select v-model.number="interactType" class="rounded border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-900">
              <option v-for="op in INTERACT_OPTIONS" :key="op.id" :value="op.id">{{ op.name }}{{ op.recommended ? '（推荐）' : '' }}</option>
            </select>
          </label>
          <BaseButton variant="primary" size="sm" :loading="hireSaving" @click="saveHireConfig">保存参数</BaseButton>
        </div>
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <BaseButton variant="secondary" size="sm" :loading="employeesLoading" @click="loadEmployees">刷新好友</BaseButton>
          <BaseButton variant="secondary" size="sm" @click="friendsOpen = !friendsOpen; if (friendsOpen && !friends.length) loadFriends()">
            {{ friendsOpen ? '收起好友列表 ▲' : '展开好友列表 ▼' }}
          </BaseButton>
        </div>
        <div v-if="friends.length" v-show="friendsOpen" class="mb-2 flex flex-wrap items-center gap-2">
          <BaseButton variant="secondary" size="sm" @click="selectAllFriends">全选</BaseButton>
          <BaseButton variant="secondary" size="sm" @click="clearAllFriends">清空</BaseButton>
          <BaseButton variant="secondary" size="sm" @click="invertFriends">反选</BaseButton>
          <span class="text-xs text-gray-500 dark:text-gray-400">
            共 {{ friends.length }} 位好友，已勾选 {{ hireGids.length }} 位（改完记得点「保存设置」）
          </span>
        </div>
        <div v-if="!friends.length" v-show="friendsOpen" class="text-xs text-gray-500 dark:text-gray-400">
          {{ friendsBusy ? '读取中…' : '未读到好友列表（账号需在线；QQ 端可用上面的输入框手动添加 GID）' }}
        </div>
        <div v-else v-show="friendsOpen" class="grid grid-cols-2 gap-1 md:grid-cols-3 xl:grid-cols-4">
          <label
            v-for="f in friends"
            :key="f.gid"
            class="flex cursor-pointer items-center gap-2 rounded border border-gray-200 px-2 py-1.5 text-xs dark:border-gray-700"
          >
            <input
              type="checkbox"
              class="h-3.5 w-3.5"
              :checked="hireGids.includes(String(f.gid))"
              @change="toggleGid(String(f.gid))"
            >
            <span class="truncate">{{ f.name || `好友 ${f.gid}` }}</span>
            <span v-if="f.level" class="ml-auto shrink-0 text-[10px] text-gray-400">Lv{{ f.level }}</span>
          </label>
        </div>
        <div v-if="hireGids.length" v-show="friendsOpen" class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="gid in hireGids"
            :key="gid"
            class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-700 dark:text-gray-300"
          >
            {{ gid }}
          </span>
        </div>
      </div>
    </div>

    <div v-if="actionResult" class="text-xs text-gray-600 dark:text-gray-300">{{ actionResult }}</div>
  </div>
</template>
