<script setup lang="ts">
/**
 * 奶茶热销中（2026-10-15 新活动）—— 左侧栏独立页面
 *
 * ① 顶部信息: 店铺/等级/待领取收益/奶茶券余额/累计营业额/结算期开始
 * ② 种子商店: 拾物小铺式卡片, 按货币分组, 卡内填数量兑换; 等级不足/已限购置灰
 * ③ 雇佣好友: 可折叠, 支持勾选白名单 + 自动雇佣
 * ④ 任务: 卡片式展示; 领取协议未确认, 页面不发送领取请求
 * 自动化开关与"立即执行"在 设置 → 自动控制
 *
 * 协议见 core/src/services/milk-tea.js
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'
import { apiError } from '@/utils/api-result'

const toast = useToastStore()

const status = ref<any>(null)
const statusBusy = ref(false)
const statusError = ref('')
const actionResult = ref('')
const busy = ref('')
const refreshing = ref(false)
let statusRequestId = 0
let workRequestId = 0
let workRefreshTimer: ReturnType<typeof setInterval> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null

const shop = ref<any[]>([])
const shopBusy = ref(false)
const shopError = ref('')
const shopQty = ref<Record<number, number>>({})
let shopRequestId = 0

const tasks = ref<any[]>([])
const tasksLoading = ref(false)
const tasksError = ref('')
let tasksRequestId = 0

const rankings = ref<any[]>([])
const rankingsLoading = ref(false)
const rankingsError = ref('')
const rankingCurrentPage = ref(1)
const rankingMyRank = ref(0)
const rankingHasNext = ref(false)
const rankingServerTime = ref(0)
let rankingsRequestId = 0

const friends = ref<any[]>([])
const friendsBusy = ref(false)
const friendsError = ref('')
let friendsRequestId = 0
/** 当前时刻(秒): 用于在岗员工剩余班次时间倒计时 */
const nowTick = ref(Math.floor(Date.now() / 1000))
/** 招聘班次档位(cmd=162 请求 #2); 2026-10-18 抓包只确认 duration=1(4 小时班)。 */
const hireDuration = ref<number>(1)
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

function interactionName(type: any) {
  return INTERACT_OPTIONS.find((op) => op.id === Number(type))?.name || `类型 ${type || 0}`
}

function formatWageChange(wage: any) {
  if (!wage || wage.change === null || wage.change === undefined) return ''
  const change = Number(wage.change)
  const signed = `${change >= 0 ? '+' : ''}${change}`
  if (wage.before !== null && wage.before !== undefined && wage.after !== null && wage.after !== undefined) {
    return `（工资 ${wage.before} → ${wage.after}，${signed}）`
  }
  return `（工资变化 ${signed}）`
}

/** 互动(我的工作): 目标固定为当前雇主, 互动类型默认 2 花式摇杯 */
const storeName = ref('奶茶小铺')
/** 营业记录(cmd=67, 按天): 日期/售卖杯数/收益/奖励物品/雇员记录 */
const sales = ref<any>(null)
const salesLoading = ref(false)
const salesDay = ref<number>(0)   // 0 = 尚未读取
let salesRequestId = 0
/** 店铺等级进度(来自 cmd=55: #1 等级 / #2 累计营业额 / #3 下一级所需) */
const upgradeInfo = ref<any>(null)
let upgradeRequestId = 0
let hireConfigRequestId = 0
const DAY_SECONDS = 86400
const BEIJING_OFFSET_SECONDS = 8 * 3600

/** 秒级时间戳 → 北京时间当日 00:00 */
function beijingDayStart(ts: number) {
  return Math.floor((Number(ts || 0) + BEIJING_OFFSET_SECONDS) / DAY_SECONDS) * DAY_SECONDS - BEIJING_OFFSET_SECONDS
}

const todayStart = ref(beijingDayStart(Math.floor(Date.now() / 1000)))

/** 等级进度百分比(0~100) */
function upgradePercent() {
  const i = upgradeInfo.value
  if (!i || !i.ok || !i.required) return 0
  return Math.max(0, Math.min(100, Math.round((Number(i.revenue) || 0) / Number(i.required) * 100)))
}
async function loadUpgradeInfo() {
  const requestId = ++upgradeRequestId
  try {
    const res = await api.post('/api/activity/milk-tea/upgrade-info', {})
    if (requestId !== upgradeRequestId) return
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) {
      upgradeInfo.value = { ok: false, reason: err }
      reportError('读取店铺升级信息', err)
      return
    }
    upgradeInfo.value = d
  } catch (e: any) {
    if (requestId !== upgradeRequestId) return
    const err = apiError(null, null, e)
    upgradeInfo.value = { ok: false, reason: err }
    reportError('读取店铺升级信息', err)
  }
}
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

/** 待领取/收益条目统一成「名称×数量」；兼容后端旧字段里的 `name` 已带数量。 */
function rewardText(r: any) {
  if (!r) return ''
  if (typeof r === 'string') return r
  const id = Number(r.id) || 0
  const count = Number(r.count) || 0
  const base = String(r.name || '').replace(/×\d+$/, '')
  const label = base || `物品#${id}`
  return count > 0 ? `${label}×${count}` : label
}

function taskStatusText(task: any) {
  if (task?.statusText) return String(task.statusText)
  const status = Number(task?.status)
  if (status === 1) return '进行中'
  if (status === 2) return '可领取'
  if (status === 3) return '已领取'
  return '状态未知'
}

function taskStatusClass(task: any) {
  const status = Number(task?.status)
  if (status === 2) return 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
  if (status === 3) return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
  return 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
}

function taskRewardsText(task: any) {
  const list = Array.isArray(task?.rewards)
    ? task.rewards
    : Array.isArray(task?.reward)
      ? task.reward
      : []
  return list.map((reward: any) => rewardText(reward)).filter(Boolean).join('、') || '奖励待确认'
}

/** 在岗员工按班次结束时间实时倒计时；静态 remainSeconds 仅作为缺少 endAt 时的回退。 */
function employeeRemainSeconds(e: any) {
  const endAt = Number(e?.endAt) || 0
  if (endAt > 0) return Math.max(0, endAt - nowTick.value)
  const remainSeconds = Number(e?.remainSeconds)
  return Number.isFinite(remainSeconds) ? Math.max(0, remainSeconds) : 0
}

/** 在岗判断：有 endAt 时以实时班次结束时间为准，避免跨班后仍显示在岗。 */
function employeeOnDuty(e: any) {
  if (!e) return false
  const endAt = Number(e.endAt) || 0
  if (endAt > 0) return endAt > nowTick.value
  if (typeof e.onDuty === 'boolean') return e.onDuty
  return Number(e.remainSeconds) > 0
}

/** 员工来源优先读明确类型字段；旧数据没有类型标记时统一标为“员工”，不再按 gid 猜测。 */
function employeeTypeLabel(e: any) {
  const type = String(e?.employeeType || '').toLowerCase()
  if (type === 'friend') return '好友'
  if (type === 'npc') return 'NPC'
  if (type === 'unknown') return '类型未知'
  if (e?.isFriend === true) return '好友'
  if (e?.isNpc === true) return 'NPC'
  return '员工'
}

const storeLevel = computed(() => Number(status.value?.storeLevel) || 0)
const totalRevenue = computed(() => Number(status.value?.value) || 0)
const cashierDetail = computed(() => status.value?.cashierDetail || {})

function pendingListFrom(source: any) {
  if (Array.isArray(source?.pendingRewards)) return source.pendingRewards
  if (Array.isArray(source?.pending)) return source.pending
  return []
}

const pendingRewards = computed(() => {
  return pendingListFrom(cashierDetail.value).filter((r: any) => r && (r.id || r.name))
})
const hasPending = computed(() => pendingRewards.value.length > 0)
const pendingSummary = computed(() => {
  return pendingRewards.value.map((r: any) => rewardText(r)).join('、') || '无'
})
const currentEmployees = computed(() => {
  const statusEmployees = status.value?.employees
  const list = Array.isArray(status.value?.currentEmployees)
    ? status.value.currentEmployees
    : Array.isArray(statusEmployees?.currentEmployees)
      ? statusEmployees.currentEmployees
      : Array.isArray(statusEmployees?.employees)
        ? statusEmployees.employees
        : Array.isArray(statusEmployees)
          ? statusEmployees
          : Array.isArray(cashierDetail.value.currentEmployees)
            ? cashierDetail.value.currentEmployees
            : Array.isArray(cashierDetail.value.employees)
              ? cashierDetail.value.employees
              : []
  const seen = new Set<string>()
  return list.filter((e: any) => {
    const key = String(e?.shiftUid || `${e?.gid || ''}-${e?.startAt || ''}`)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
})
const onDutyEmployeeCount = computed(() => currentEmployees.value.filter((e: any) => employeeOnDuty(e)).length)
const employeeCount = computed(() => {
  const value = Number(status.value?.employeeCount ?? status.value?.employees?.employeeCount
    ?? cashierDetail.value.employeeCount)
  return Number.isFinite(value) && value > 0 ? value : currentEmployees.value.length
})
const employeeCapacity = computed(() => {
  const value = Number(status.value?.employeeCapacity ?? status.value?.employees?.employeeCapacity
    ?? cashierDetail.value.employeeCapacity)
  if (Number.isFinite(value) && value > 0) return value
  return storeLevel.value >= 3 ? 2 : 1
})
const employeesFull = computed(() => employeeCount.value >= employeeCapacity.value)
const milkCoupon = computed(() => Number(status.value?.milkCoupon) || 0)
const work = computed(() => status.value?.work || {})
const hasEmployer = computed(() => work.value.hasEmployer === true
  && Number(work.value.employer?.gid) > 0)
const interactionCompleted = computed(() => work.value.interactionCompleted === true)
const canInteract = computed(() => hasEmployer.value && !interactionCompleted.value)
const workStateText = computed(() => {
  if (!status.value || !status.value.work) return '未读取'
  if (work.value.ok === false) return '读取失败'
  if (!hasEmployer.value) return '未受雇'
  return interactionCompleted.value ? '已受雇，本班已互动' : '已受雇，可互动'
})
const selectedSalesDay = computed(() => Number(salesDay.value) || Number(todayStart.value))
const isTodaySales = computed(() => Number(selectedSalesDay.value) === Number(todayStart.value))
const canGoNextSalesDay = computed(() => {
  return Number(selectedSalesDay.value) < Number(todayStart.value)
})
const isSettling = computed(() => {
  const settleAt = Number(status.value?.settleAt) || 0
  return settleAt > 0 && nowTick.value >= settleAt
})

/** 等级不足 */
function isLocked(g: any) {
  const need = Number(g.requireLevel) || 0
  if (need <= 0) return false
  return storeLevel.value < need
}
/** 已限购(本会话已兑满) */
function isSoldOut(g: any) {
  const lim = Number(g.limitCount) || 0
  return g.soldOut === true || (lim > 0 && Number(g.boughtCount) >= lim)
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
  const normalized = Number(sec) > 1_000_000_000_000 ? Number(sec) : Number(sec) * 1000
  const d = new Date(normalized + BEIJING_OFFSET_SECONDS * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function fmtDuration(sec: any) {
  const total = Math.max(0, Math.round(Number(sec) || 0))
  if (!total) return '0分钟'
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours && minutes) return `${hours}小时${minutes}分钟`
  if (hours) return `${hours}小时`
  return minutes ? `${minutes}分钟` : '不足1分钟'
}

async function loadStatus() {
  const requestId = ++statusRequestId
  statusBusy.value = true
  statusError.value = ''
  try {
    const res = await api.get('/api/activity/milk-tea/status')
    if (requestId !== statusRequestId) return
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) {
      statusError.value = err
      reportError('读取经营状态', err)
      return
    }
    status.value = d
    nowTick.value = Math.floor(Date.now() / 1000)
  } catch (e: any) {
    if (requestId !== statusRequestId) return
    statusError.value = apiError(null, null, e)
    reportError('读取经营状态', statusError.value)
  } finally {
    if (requestId === statusRequestId) statusBusy.value = false
  }
}

async function loadWorkStatus() {
  const requestId = ++workRequestId
  try {
    const res = await api.get('/api/activity/milk-tea/work')
    if (requestId !== workRequestId) return
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) {
      status.value = { ...(status.value || {}), work: { ok: false, hasEmployer: false, reason: err } }
      return
    }
    status.value = { ...(status.value || {}), work: d }
  } catch (e: any) {
    if (requestId !== workRequestId) return
    status.value = {
      ...(status.value || {}),
      work: { ok: false, hasEmployer: false, reason: apiError(null, null, e) },
    }
  }
}

async function loadShop() {
  const requestId = ++shopRequestId
  shopBusy.value = true
  shopError.value = ''
  try {
    const res = await api.get('/api/activity/milk-tea/shop')
    if (requestId !== shopRequestId) return
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) {
      shop.value = []
      shopError.value = err
      reportError('读取商店', err)
      return
    }
    shop.value = Array.isArray(d.goods) ? d.goods : []
    for (const g of shop.value) if (!shopQty.value[g.goodsId]) shopQty.value[g.goodsId] = 1
  } catch (e: any) {
    if (requestId !== shopRequestId) return
    shop.value = []
    shopError.value = apiError(null, null, e)
    reportError('读取商店', shopError.value)
  } finally {
    if (requestId === shopRequestId) shopBusy.value = false
  }
}

async function loadTasks() {
  const requestId = ++tasksRequestId
  tasksLoading.value = true
  tasksError.value = ''
  try {
    const res = await api.get('/api/activity/milk-tea/tasks')
    if (requestId !== tasksRequestId) return
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) {
      tasks.value = []
      tasksError.value = err
      return
    }
    tasks.value = Array.isArray(d.tasks) ? d.tasks : Array.isArray(d) ? d : []
  } catch (e: any) {
    if (requestId !== tasksRequestId) return
    tasks.value = []
    tasksError.value = apiError(null, null, e)
  } finally {
    if (requestId === tasksRequestId) tasksLoading.value = false
  }
}

async function loadRankings(page = rankingCurrentPage.value) {
  const targetPage = Math.max(1, Math.floor(Number(page) || 1))
  const requestId = ++rankingsRequestId
  rankingsLoading.value = true
  rankingsError.value = ''
  try {
    const res = await api.get('/api/activity/milk-tea/rankings', { params: { page: targetPage } })
    if (requestId !== rankingsRequestId) return
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) {
      rankings.value = []
      rankingsError.value = err
      rankingMyRank.value = 0
      rankingHasNext.value = false
      rankingServerTime.value = 0
      return
    }
    rankings.value = Array.isArray(d.entries) ? d.entries : []
    rankingMyRank.value = Math.max(0, Number(d.myRank) || 0)
    rankingCurrentPage.value = Math.max(1, Number(d.currentPage) || targetPage)
    rankingHasNext.value = d.hasNext === true
    rankingServerTime.value = Number(d.serverTime) || 0
  } catch (e: any) {
    if (requestId !== rankingsRequestId) return
    rankings.value = []
    rankingMyRank.value = 0
    rankingHasNext.value = false
    rankingServerTime.value = 0
    rankingsError.value = apiError(null, null, e) || '排行榜读取失败'
  } finally {
    if (requestId === rankingsRequestId) rankingsLoading.value = false
  }
}

function shiftRankingPage(delta: number) {
  const target = rankingCurrentPage.value + delta
  if (target < 1 || (delta > 0 && !rankingHasNext.value)) return
  void loadRankings(target)
}

/** 营业记录(cmd=67, 按天; day 省略=今天) */
async function loadSales(day?: number) {
  const requested = day ? beijingDayStart(Number(day)) : Number(todayStart.value)
  if (requested > Number(todayStart.value)) {
    toast.warning('不能查看未来日期的营业记录')
    return
  }
  const requestId = ++salesRequestId
  salesLoading.value = true
  try {
    const res = await api.post('/api/activity/milk-tea/sales-record', requested ? { day: requested } : {})
    if (requestId !== salesRequestId) return
    const d = res.data?.data || {}
    if (apiError(res, d)) { sales.value = { ok: false, reason: `接口返回异常: ${JSON.stringify(res.data).slice(0, 120)}` }; return }
    if (!d || d.ok !== true) { sales.value = { ok: false, reason: d.reason || `接口返回体不含 ok 字段(可能后端未更新): ${JSON.stringify(res.data).slice(0, 120)}` }; return }
    sales.value = d
    salesDay.value = Number(d.day) || requested
  } catch (e: any) {
    if (requestId !== salesRequestId) return
    const st = e.response?.status ? `HTTP ${e.response.status}` : ''
    sales.value = { ok: false, reason: `营业记录请求失败：${st} ${e.response?.data?.error || e.message || '未知错误'}` }
  } finally {
    if (requestId === salesRequestId) salesLoading.value = false
  }
}
/** 前一天 / 后一天 */
function shiftSalesDay(delta: number) {
  const cur = Number(salesDay.value) || Number(todayStart.value)
  const target = cur + delta * DAY_SECONDS
  if (target > Number(todayStart.value)) {
    toast.warning('已经是最新营业日')
    return
  }
  return loadSales(target)
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

/** 日期戳 → MM/DD(北京时间) */
function fmtMonthDay(ts: number) {
  if (!ts) return ''
  const d = new Date((Number(ts) + BEIJING_OFFSET_SECONDS) * 1000)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}

const activityPeriodText = computed(() => {
  const startAt = Number(status.value?.startAt) || 0
  const settleAt = Number(status.value?.settleAt) || 0
  const businessEnd = settleAt > 0 ? settleAt - 1 : 0
  return startAt > 0 && businessEnd > 0
    ? `${fmtMonthDay(startAt)}–${fmtMonthDay(businessEnd)}`
    : '活动时间以游戏内为准'
})

const settlementPeriodText = computed(() => {
  const settleAt = Number(status.value?.settleAt) || 0
  const endAt = Number(status.value?.endAt) || 0
  if (settleAt > 0 && endAt > settleAt) return `${fmtMonthDay(settleAt)}–${fmtMonthDay(endAt - 1)}`
  if (settleAt > 0) return `${fmtMonthDay(settleAt)}起`
  return '结算时间以游戏内为准'
})

function salesHourLabel(hoursAgo: any) {
  const hours = Math.max(0, Math.floor(Number(hoursAgo) || 0))
  if (hours === 0) return isTodaySales.value ? '本小时' : '最近时段'
  return `${hours} 小时前`
}

function rankingNickname(entry: any) {
  return String(entry?.nickname || '').trim() || String(entry?.gid || '未知玩家')
}

function rankingKey(entry: any, index: number) {
  return `${entry?.rank ?? index}-${entry?.gid || rankingNickname(entry) || index}`
}

function rankingLevel(entry: any) {
  return Number(entry?.storeLevel ?? entry?.level) || 0
}

async function loadHireConfig() {
  const requestId = ++hireConfigRequestId
  try {
    const res = await api.get('/api/activity/milk-tea/hire-config')
    if (requestId !== hireConfigRequestId) return
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('读取雇佣设置', err); return }
    hireGids.value = (d.hireGids || []).map((g: any) => String(g))
    autoHire.value = !!d.autoHire
    autoInteract.value = !!d.autoInteract
    hireDuration.value = Number(d.hireDuration || d.duration) || 1
    if (d.interactType) interactType.value = Number(d.interactType) || 2
    if (d.storeName) storeName.value = String(d.storeName)
  } catch (e: any) {
    if (requestId !== hireConfigRequestId) return
    reportError('读取雇佣设置', apiError(null, null, e))
  }
}

async function loadFriends() {
  const requestId = ++friendsRequestId
  friendsBusy.value = true
  friendsError.value = ''
  try {
    const res = await api.get('/api/activity/milk-tea/friends')
    if (requestId !== friendsRequestId) return
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) {
      friends.value = []
      friendsError.value = err
      reportError('读取好友', err)
      return
    }
    friends.value = Array.isArray(d.friends) ? d.friends : []
  } catch (e: any) {
    if (requestId !== friendsRequestId) return
    friends.value = []
    friendsError.value = apiError(null, null, e)
    reportError('读取好友', friendsError.value)
  } finally {
    if (requestId === friendsRequestId) friendsBusy.value = false
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
  if (isSettling.value) {
    toast.warning('已进入结算期，不能领取收银台收益')
    return
  }
  if (!hasPending.value) {
    toast.warning('收银台暂无可领取收益')
    return
  }
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
    actionResult.value = d.usedUnits ? `已制作奶茶（投入 ${d.usedUnits} 个果实）` : '制作奶茶完成'
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
    if (d.skipped) {
      actionResult.value = d.reason || '当前不能领取工资'
      toast.warning(actionResult.value)
      await loadWorkStatus()
      return
    }
    if (d.ok === false) { reportError('领工资', d.reason || '领工资未成功'); return }
    actionResult.value = d.gained ? `已领工资 ${d.gained.count} 奶茶券` : '领工资完成'
    toast.success(actionResult.value)
    await loadStatus()
  } catch (e: any) {
    reportError('领工资', apiError(null, null, e))
  } finally {
    busy.value = ''
  }
}

/** 互动(我的工作, cmd=65): 目标只取当前雇主, 资格由服务端判定 */
async function interactNow() {
  if (!canInteract.value) {
    toast.warning(hasEmployer.value
      ? '本班已经互动过，不能重复互动'
      : '当前没有进行中的兼职（未被好友雇佣），不能互动')
    return
  }
  busy.value = 'interact'
  try {
    const res = await api.post('/api/activity/milk-tea/interact', { type: Number(interactType.value) || 2 })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('互动', err); return }
    if (d.skipped) {
      actionResult.value = d.reason || '当前不能互动'
      toast.warning(actionResult.value)
      await loadWorkStatus()
      return
    }
    if (d.ok === false) { reportError('互动', d.reason || '互动未成功'); return }
    const wage = formatWageChange(d.interact && d.interact.wage)
    actionResult.value = `已与好友 ${d.friendGid || '当前老板'} 互动${wage}`
    toast.success(actionResult.value)
    await loadWorkStatus()
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
    const res = await api.post('/api/activity/milk-tea/hire-all', {
      hireGids: hireGids.value,
      limit: 10,
      duration: Number(hireDuration.value) || 1,
    })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('批量雇佣', err); return }
    if (d.skipped) {
      actionResult.value = d.reason || `员工已满（${employeeCount.value}/${employeeCapacity.value}）`
      toast.warning(actionResult.value)
      await loadStatus()
      return
    }
    if (d.ok === false) {
      reportError('批量雇佣', d.reason || '批量雇佣未成功')
      return
    }
    actionResult.value = `批量雇佣完成：${d.hired}/${d.total} 成功`
    toast.success(actionResult.value)
    await loadStatus()
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
      interactType: Number(interactType.value) || 2,
      storeName: String(storeName.value || ''),
      hireDuration: Number(hireDuration.value) || 1,
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
    const res = await api.post('/api/activity/milk-tea/hire-auto', {
      hireGids: hireGids.value,
      duration: Number(hireDuration.value) || 1,
    })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('雇佣好友', err); return }
    if (d.skipped) {
      actionResult.value = d.reason || '当前没有可雇佣的好友'
      toast.warning(actionResult.value)
      return
    }
    const hiredGids = (Array.isArray(d.friendGids) && d.friendGids.length
      ? d.friendGids
      : (d.friendGid ? [d.friendGid] : []))
      .map((gid: any) => String(gid))
      .filter(Boolean)
    if (!hiredGids.length) {
      reportError('雇佣好友', d.reason || '接口未返回被雇佣好友')
      return
    }
    const staff = d.employeeCapacity
      ? `（员工 ${Number(d.finalEmployeeCount ?? d.employeeCount) || 0}/${Number(d.employeeCapacity)}）`
      : ''
    actionResult.value = `已自动补位 ${hiredGids.join('、')}${staff}`
    toast.success(actionResult.value)
    await loadStatus()
  } catch (e: any) {
    reportError('雇佣好友', apiError(null, null, e))
  } finally {
    busy.value = ''
  }
}

function toggleFriendsOpen() {
  friendsOpen.value = !friendsOpen.value
  if (friendsOpen.value && !friends.value.length && !friendsBusy.value) {
    void loadFriends()
  }
}

/** 串行 + 错开加载: 避免一次性并发多个游戏请求把队列打满(队列已满→心跳异常掉线) */
async function refreshAll() {
  if (refreshing.value) return
  refreshing.value = true
  todayStart.value = beijingDayStart(Math.floor(Date.now() / 1000))
  try {
    await loadStatus()
    await new Promise((r) => setTimeout(r, 300))
    await loadSales(selectedSalesDay.value)
    await new Promise((r) => setTimeout(r, 300))
    await loadUpgradeInfo()
    await new Promise((r) => setTimeout(r, 300))
    await loadShop()
    await new Promise((r) => setTimeout(r, 300))
    await loadTasks()
    await new Promise((r) => setTimeout(r, 300))
    await loadRankings(rankingCurrentPage.value)
    await new Promise((r) => setTimeout(r, 300))
    await loadHireConfig()
    // 好友列表首次会做重同步(约 6 个请求) → 只在展开"雇佣好友"时按需拉
    if (friendsOpen.value) await loadFriends()
  } finally {
    refreshing.value = false
  }
}

onMounted(() => {
  void refreshAll()
  nowTick.value = Math.floor(Date.now() / 1000)
  clockTimer = setInterval(() => {
    const tick = Math.floor(Date.now() / 1000)
    const previousToday = todayStart.value
    const nextToday = beijingDayStart(tick)
    const wasViewingToday = !salesDay.value || Number(salesDay.value) === Number(previousToday)
    nowTick.value = tick
    if (nextToday !== previousToday) {
      todayStart.value = nextToday
      if (wasViewingToday && !document.hidden && !salesLoading.value) void loadSales(nextToday)
    }
  }, 30_000)
  workRefreshTimer = setInterval(() => {
    if (document.hidden || statusBusy.value || busy.value || isSettling.value) return
    void loadWorkStatus()
  }, 60_000)
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
  clockTimer = null
  if (workRefreshTimer) clearInterval(workRefreshTimer)
  workRefreshTimer = null
})
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1500px] grid-cols-1 items-start gap-4 xl:grid-cols-2">
    <header class="col-span-full flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-xl text-gray-900 font-bold dark:text-gray-100">
          奶茶热销中
        </h2>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          营业 {{ activityPeriodText }} · 结算 {{ settlementPeriodText }}
        </p>
      </div>
      <BaseButton variant="secondary" size="sm" :loading="refreshing" @click="refreshAll">
        <i class="i-carbon-renew mr-1 text-base" />
        刷新页面
      </BaseButton>
    </header>

    <div
      v-if="isSettling"
      class="col-span-full rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
    >
      已进入结算期（{{ settlementPeriodText }}）：自动营业、宣传、雇佣、互动、购买专属种子都会停止；
      未领收益会通过邮件补发，请在结算期结束前完成兑换。
    </div>

    <!-- 经营状态 -->
    <section class="order-1 col-span-full rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">经营状态</h3>
        <span v-if="status" class="text-xs text-gray-400">更新于 {{ fmtTime(status.at) }}</span>
      </div>

      <template v-if="status">
        <div
          v-if="statusError"
          class="mb-3 min-w-0 break-words rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
        >
          状态刷新失败：{{ statusError }}。当前显示的是上次成功读取的数据。
        </div>
        <div class="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-5">
          <div class="min-w-0">
            <div class="text-xs text-gray-500 dark:text-gray-400">店铺</div>
            <div class="mt-0.5 truncate text-base text-gray-900 font-bold dark:text-gray-100">
              {{ status.storeName || '未开业' }}
              <span v-if="status.storeLevel" class="ml-1 text-xs text-gray-500 font-normal">Lv{{ status.storeLevel }}</span>
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-gray-500 dark:text-gray-400">待领取收益</div>
            <div
              class="mt-0.5 min-w-0 break-words text-base font-bold"
              :class="hasPending ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100'"
            >
              {{ pendingSummary }}
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-gray-500 dark:text-gray-400">奶茶券余额</div>
            <div class="mt-0.5 text-base text-gray-900 font-bold dark:text-gray-100">{{ milkCoupon.toLocaleString() }}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-gray-500 dark:text-gray-400">累计营业额</div>
            <div class="mt-0.5 text-base text-gray-900 font-bold dark:text-gray-100">
              {{ totalRevenue.toLocaleString() }}
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-gray-500 dark:text-gray-400">结算期开始</div>
            <div class="mt-0.5 text-sm text-gray-900 font-medium dark:text-gray-100">{{ fmtTime(status.settleAt) }}</div>
          </div>
        </div>

        <div class="mt-4 grid gap-4 border-t border-gray-100 pt-4 dark:border-gray-700 md:grid-cols-2">
          <div class="min-w-0">
            <div class="mb-1.5 flex flex-wrap items-center justify-between gap-1 text-xs">
              <span class="text-gray-500 dark:text-gray-400">
                店铺等级
                <span class="ml-1 font-medium text-gray-900 dark:text-gray-100">
                  Lv{{ upgradeInfo && upgradeInfo.ok ? upgradeInfo.level : (status.storeLevel || '—') }}
                </span>
                <template v-if="upgradeInfo && upgradeInfo.ok && upgradeInfo.required">
                  <span class="text-gray-400">→ Lv{{ Number(upgradeInfo.level) + 1 }}</span>
                </template>
              </span>
              <span v-if="upgradeInfo && upgradeInfo.ok && upgradeInfo.required" class="text-gray-500 dark:text-gray-400">
                {{ Number(upgradeInfo.revenue).toLocaleString() }} / {{ Number(upgradeInfo.required).toLocaleString() }}
                <span class="ml-1 font-medium" :class="upgradePercent() >= 100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-700 dark:text-gray-200'">
                  {{ upgradePercent() }}%
                </span>
              </span>
            </div>
            <div class="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
              <div
                class="h-full rounded transition-all"
                :class="upgradePercent() >= 100 ? 'bg-emerald-500' : 'bg-blue-500'"
                :style="{ width: upgradePercent() + '%' }"
              />
            </div>
            <div v-if="upgradeInfo && upgradeInfo.ok && upgradeInfo.canUpgrade" class="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
              营业额已达标，可升级
            </div>
            <div v-else-if="upgradeInfo && !upgradeInfo.ok" class="mt-1 text-[11px] text-gray-400">
              {{ upgradeInfo.reason || '升级进度暂不可用' }}
            </div>
          </div>

          <div class="min-w-0">
            <div class="text-xs text-gray-500 dark:text-gray-400">受雇状态</div>
            <div
              class="mt-0.5 text-sm font-medium"
              :class="hasEmployer
                ? 'text-emerald-600 dark:text-emerald-400'
                : (work.ok === false ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400')"
            >
              {{ workStateText }}
            </div>
            <div
              v-if="hasEmployer && work.employer"
              class="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400"
            >
              <span class="min-w-0 break-all">
                老板 {{ work.employer.name || work.employer.gid }}
                <span v-if="work.employer.name" class="text-gray-400">({{ work.employer.gid }})</span>
              </span>
              <span v-if="work.wage">工资 {{ Number(work.wage).toLocaleString() }}</span>
              <span v-if="work.titleName">特长 {{ work.titleName }}</span>
              <span v-if="work.lastInteraction">
                最近互动 {{ interactionName(work.lastInteraction.type) }}
                <template v-if="work.lastInteraction.count">×{{ work.lastInteraction.count }}</template>
                <template v-if="work.lastInteraction.at"> · {{ fmtTime(work.lastInteraction.at) }}</template>
              </span>
            </div>
          </div>
        </div>

        <div class="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-gray-500 dark:text-gray-400">当前员工</span>
            <span class="text-[10px] text-gray-400">
              {{ employeeCount }}/{{ employeeCapacity }} 位
              <template v-if="employeeCount"> · 在岗 {{ onDutyEmployeeCount }}</template>
            </span>
          </div>
          <div v-if="currentEmployees.length" class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <div
              v-for="e in currentEmployees"
              :key="e.shiftUid || `${e.gid}-${e.startAt}`"
              class="min-w-0 rounded border border-gray-100 px-2.5 py-2 dark:border-gray-700"
            >
              <div class="flex min-w-0 flex-wrap items-center gap-1 text-xs">
                <span class="min-w-0 break-words text-gray-900 font-medium dark:text-gray-100">
                  {{ e.name || `GID:${e.gid}` }}
                </span>
                <span v-if="e.gid" class="break-all text-[10px] text-gray-400">{{ e.gid }}</span>
                <span
                  class="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]"
                  :class="employeeOnDuty(e)
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                    : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'"
                >
                  {{ employeeOnDuty(e) ? '在岗' : '已下班' }}
                </span>
                <span
                  class="shrink-0 whitespace-nowrap rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300"
                >
                  {{ employeeTypeLabel(e) }}
                </span>
              </div>
              <div class="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                <span v-if="e.titleName">特长 {{ e.titleName }}</span>
                <span>班次 {{ fmtTime(e.startAt) }} 至 {{ fmtTime(e.endAt) }}</span>
                <span>{{ employeeOnDuty(e) ? `剩余 ${fmtDuration(employeeRemainSeconds(e))}` : '本班已结束' }}</span>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-gray-500 dark:text-gray-400">暂无员工</div>
        </div>

        <div v-if="hasPending" class="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <div class="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
            <span class="shrink-0 font-medium">待领取：</span>
            <span class="min-w-0 break-words">{{ pendingSummary }}</span>
          </div>
          <div class="mt-1">满载会暂停营业且不补发。</div>
        </div>
      </template>
      <div v-else class="text-xs text-gray-500 dark:text-gray-400">
        {{ statusBusy ? '读取中…' : (statusError || '暂无状态，账号需要在线') }}
      </div>
    </section>

    <!-- 员工与操作 -->
    <section class="order-2 col-span-full rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-700/60">
        <div>
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">员工与操作</h3>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            白名单 {{ hireGids.length }} 位{{ autoHire ? ' · 自动雇佣已开启' : '' }}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="!hireGids.length || employeesFull"
            :loading="busy === 'hire-all'"
            :title="employeesFull ? `员工已满（${employeeCount}/${employeeCapacity}）` : ''"
            @click="hireAllNow"
          >
            全部雇佣
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="employeesFull"
            :loading="busy === 'hire-auto'"
            :title="employeesFull ? `员工已满（${employeeCount}/${employeeCapacity}）` : ''"
            @click="hireNow"
          >
            自动补位
          </BaseButton>
        </div>
      </div>

      <div class="space-y-4 px-4 py-3">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          <BaseButton
            variant="secondary"
            size="sm"
            block
            :disabled="!hasPending || isSettling"
            :loading="busy === 'cashier'"
            :title="isSettling ? '结算期不能领取收银台收益' : (!hasPending ? '收银台暂无可领取收益' : '')"
            @click="claimCashierNow"
          >
            领收银台收益
          </BaseButton>
          <BaseButton variant="secondary" size="sm" block :loading="busy === 'craft'" @click="craftNow">
            制作全部果实
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            block
            :disabled="!hasEmployer"
            :loading="busy === 'wage'"
            :title="hasEmployer ? '' : '当前没有进行中的兼职'"
            @click="claimWageNow"
          >
            领工资
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            block
            :disabled="!canInteract"
            :loading="busy === 'interact'"
            :title="!hasEmployer ? '当前没有进行中的兼职' : (interactionCompleted ? '本班已互动' : '')"
            @click="interactNow"
          >
            {{ interactionCompleted ? '本班已互动' : '互动一次' }}
          </BaseButton>
          <BaseButton variant="secondary" size="sm" block :loading="busy === 'upgrade'" @click="upgradeNow">
            升级店铺
          </BaseButton>
        </div>

        <div v-if="actionResult" class="min-w-0 whitespace-pre-wrap break-words rounded bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:bg-gray-900/40 dark:text-gray-200">
          {{ actionResult }}
        </div>

        <div class="grid gap-3 rounded border border-gray-200 p-3 dark:border-gray-700 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="flex min-w-0 flex-col gap-1 text-xs text-gray-600 dark:text-gray-300">
              店名
              <input
                v-model="storeName"
                type="text"
                class="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
              >
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-xs text-gray-600 dark:text-gray-300">
              互动事项
              <select
                v-model.number="interactType"
                class="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
              >
                <option v-for="op in INTERACT_OPTIONS" :key="op.id" :value="op.id">
                  {{ op.name }}{{ op.recommended ? '（推荐）' : '' }}
                </option>
              </select>
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-xs text-gray-600 dark:text-gray-300">
              招聘班次
              <select
                v-model.number="hireDuration"
                class="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
              >
                <option :value="1">4 小时（已确认）</option>
              </select>
            </label>
            <div class="flex flex-wrap gap-x-4 gap-y-3 sm:col-span-2">
              <BaseSwitch v-model="autoHire" label="自动雇佣" />
              <BaseSwitch v-model="autoInteract" label="自动互动" />
            </div>
          </div>
          <BaseButton variant="primary" size="sm" :loading="hireSaving" @click="saveHireConfig">
            保存设置
          </BaseButton>
        </div>

        <div>
          <BaseButton variant="secondary" size="sm" @click="toggleFriendsOpen">
            {{ friendsOpen ? '收起好友列表' : '展开好友列表' }}
            <i :class="friendsOpen ? 'i-carbon-chevron-up' : 'i-carbon-chevron-down'" class="ml-1 text-base" />
          </BaseButton>

          <div v-if="friendsOpen" class="mt-2 rounded border border-gray-200 dark:border-gray-700">
            <div class="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-700">
              <BaseButton variant="secondary" size="sm" :loading="friendsBusy" @click="loadFriends">
                刷新好友
              </BaseButton>
              <BaseButton variant="secondary" size="sm" :disabled="!friends.length" @click="selectAllFriends">全选</BaseButton>
              <BaseButton variant="secondary" size="sm" :disabled="!hireGids.length" @click="clearAllFriends">清空</BaseButton>
              <BaseButton variant="secondary" size="sm" :disabled="!friends.length" @click="invertFriends">反选</BaseButton>
              <span class="text-xs text-gray-500 dark:text-gray-400">
                已勾选 {{ hireGids.length }} 位
              </span>
            </div>

            <div v-if="friendsBusy && !friends.length" class="px-3 py-4 text-xs text-gray-500 dark:text-gray-400">
              读取中…
            </div>
            <div v-else-if="!friends.length" class="px-3 py-4 text-xs text-gray-500 dark:text-gray-400">
              {{ friendsError || '未读到好友列表，账号在线后重试' }}
            </div>
            <div v-else class="grid grid-cols-1 gap-1 p-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              <label
                v-for="f in friends"
                :key="f.gid"
                class="flex min-w-0 cursor-pointer items-center gap-2 rounded border border-gray-200 px-2 py-1.5 text-xs dark:border-gray-700"
              >
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 shrink-0"
                  :checked="hireGids.includes(String(f.gid))"
                  @change="toggleGid(String(f.gid))"
                >
                <span class="truncate">{{ f.name || `好友 ${f.gid}` }}</span>
                <span class="ml-auto shrink-0 text-[10px] text-gray-400">Lv{{ f.level || '—' }}</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 营业记录 -->
    <section class="order-3 col-span-full rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 xl:col-span-1">
      <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">营业记录</h3>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {{ isTodaySales ? '今日售卖' : '当日售卖' }}
          </p>
        </div>
        <div class="flex items-center gap-1">
          <BaseButton variant="secondary" size="sm" title="前一天" aria-label="前一天" @click="shiftSalesDay(-1)">
            <i class="i-carbon-chevron-left text-base" />
          </BaseButton>
          <span class="min-w-[92px] px-1 text-center text-xs text-gray-600 dark:text-gray-300">
            {{ fmtDay(selectedSalesDay) }}
          </span>
          <BaseButton
            variant="secondary"
            size="sm"
            title="后一天"
            aria-label="后一天"
            :disabled="!canGoNextSalesDay"
            @click="shiftSalesDay(1)"
          >
            <i class="i-carbon-chevron-right text-base" />
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            title="刷新当前营业日"
            aria-label="刷新当前营业日"
            :loading="salesLoading"
            @click="loadSales(selectedSalesDay)"
          >
            <i class="i-carbon-renew text-base" />
          </BaseButton>
        </div>
      </div>

      <template v-if="sales && sales.ok">
        <div class="grid grid-cols-3 divide-x divide-gray-200 rounded bg-gray-50 py-2 text-center dark:divide-gray-700 dark:bg-gray-900/40">
          <div>
            <div class="text-[11px] text-gray-500 dark:text-gray-400">总杯数</div>
            <div class="mt-0.5 text-base text-gray-900 font-bold dark:text-gray-100">{{ Number(sales.cups || 0).toLocaleString() }}</div>
          </div>
          <div>
            <div class="text-[11px] text-gray-500 dark:text-gray-400">金币收益</div>
            <div class="mt-0.5 text-base text-amber-600 font-bold dark:text-amber-400">{{ Number(sales.gold || 0).toLocaleString() }}</div>
          </div>
          <div>
            <div class="text-[11px] text-gray-500 dark:text-gray-400">奶茶券收益</div>
            <div class="mt-0.5 text-base text-emerald-600 font-bold dark:text-emerald-400">{{ Number(sales.coupon || 0).toLocaleString() }}</div>
          </div>
        </div>

        <div class="mt-4">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-gray-500 dark:text-gray-400">分时销量</span>
            <span class="text-[10px] text-gray-400">相对查询时段</span>
          </div>
          <div
            v-if="sales.hourly && sales.hourly.length"
            class="grid grid-cols-2 gap-x-4 gap-y-1 rounded bg-gray-50 px-3 py-2 text-xs sm:grid-cols-3 dark:bg-gray-900/40"
          >
            <div
              v-for="h in sales.hourly"
              :key="h.hoursAgo"
              class="flex min-w-0 items-baseline justify-between gap-2"
            >
              <span class="min-w-0 break-words text-gray-500 dark:text-gray-400">{{ salesHourLabel(h.hoursAgo) }}</span>
              <span class="shrink-0 text-gray-900 font-medium dark:text-gray-100">{{ Number(h.cups || 0).toLocaleString() }} 杯</span>
            </div>
          </div>
          <div v-else class="text-xs text-gray-500 dark:text-gray-400">暂无分时数据</div>
        </div>

        <div class="mt-4">
          <div class="mb-2 text-xs text-gray-500 dark:text-gray-400">品类销售</div>
          <div v-if="sales.items && sales.items.length" class="flex flex-wrap gap-2">
            <span
              v-for="c in sales.items"
              :key="c.id"
              class="min-w-0 break-words rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
            >
              {{ c.name }} {{ Number(c.cups || 0).toLocaleString() }} 杯
            </span>
          </div>
          <div v-else class="text-xs text-gray-500 dark:text-gray-400">当日无售卖</div>
        </div>

        <div v-if="sales.rewards && sales.rewards.length" class="mt-4">
          <div class="mb-2 text-xs text-gray-500 dark:text-gray-400">额外收益</div>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="rw in sales.rewards"
              :key="rw.id"
              class="min-w-0 break-words rounded bg-rose-50 px-2 py-1 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-300"
            >
              {{ rw.name }}
            </span>
          </div>
        </div>

        <div class="mt-4">
          <div class="mb-2 text-xs text-gray-500 dark:text-gray-400">雇员记录</div>
          <div v-if="sales.records && sales.records.length" class="space-y-1.5">
            <div
              v-for="r in sales.records"
              :key="`${r.gid}-${r.startAt}`"
              class="rounded border border-gray-100 px-2.5 py-2 text-xs dark:border-gray-700"
            >
              <div class="flex items-center justify-between gap-2 text-[11px] text-gray-400">
                <span>{{ fmtClock(r.startAt) }}</span>
                <span class="shrink-0 whitespace-nowrap">{{ fmtDuration(r.workSeconds) }}</span>
              </div>
              <div class="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                <span class="min-w-0 break-words text-gray-900 font-medium dark:text-gray-100">{{ r.name }}</span>
                <span
                  v-if="r.titleName"
                  class="shrink-0 whitespace-nowrap rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
                >
                  {{ r.titleName }}
                </span>
              </div>
            </div>
          </div>
          <div v-else class="text-xs text-gray-500 dark:text-gray-400">暂无记录</div>
        </div>
      </template>
      <div v-else class="rounded border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {{ salesLoading ? '读取中…' : (sales && sales.reason ? sales.reason : '暂无营业记录') }}
      </div>
    </section>

    <!-- 活动种子商店 -->
    <section class="order-4 col-span-full rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 xl:col-span-1">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">活动种子商店</h3>
        <BaseButton variant="secondary" size="sm" :loading="shopBusy" @click="loadShop">
          <i class="i-carbon-renew mr-1 text-base" />
          刷新商品
        </BaseButton>
      </div>
      <div v-if="!shop.length" class="rounded border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {{ shopBusy ? '读取中…' : (shopError || '暂无商品，账号需要在线') }}
      </div>
      <div v-else class="space-y-4">
        <div v-for="grp in shopGroups" :key="grp.currencyId">
          <div class="mb-2 flex items-center gap-2">
            <span class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 font-medium dark:bg-gray-700 dark:text-gray-200">
              {{ grp.currencyName }}
            </span>
            <span class="text-xs text-gray-400">{{ grp.items.length }} 件</span>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            <div
              v-for="g in grp.items"
              :key="g.goodsId"
              class="flex min-w-0 flex-col rounded border p-3"
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
                <template v-if="g.limitCount">限购 {{ g.limitCount }}</template>
                <span v-if="isLocked(g)" class="text-amber-600 dark:text-amber-400">
                  · 需等级 ≥{{ g.requireLevel }}
                </span>
                <span v-else-if="isSoldOut(g)" class="text-red-500 dark:text-red-400"> · 已限购</span>
              </div>
              <div class="mt-2 flex items-end justify-between gap-2">
                <div class="flex min-w-0 flex-col gap-1">
                  <span class="truncate text-sm text-amber-600 dark:text-amber-400">
                    {{ Number(g.unitPrice).toLocaleString() }} {{ g.currencyName }}
                  </span>
                  <span class="text-[10px] text-gray-400">合计 {{ totalCost(g).toLocaleString() }}</span>
                </div>
                <div class="flex shrink-0 items-center gap-1.5">
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
    </section>

    <!-- 活动任务 -->
    <section class="order-5 col-span-full rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 xl:col-span-1">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">活动任务</h3>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            共 {{ tasks.length }} 项
          </p>
        </div>
        <BaseButton variant="secondary" size="sm" :loading="tasksLoading" @click="loadTasks">
          <i class="i-carbon-renew mr-1 text-base" />
          刷新任务
        </BaseButton>
      </div>

      <div v-if="tasksLoading && !tasks.length" class="rounded border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        读取中…
      </div>
      <div v-else-if="tasksError" class="min-w-0 break-words rounded border border-dashed border-amber-200 px-3 py-4 text-xs text-amber-700 dark:border-amber-800 dark:text-amber-300">
        {{ tasksError }}
      </div>
      <div v-else-if="!tasks.length" class="rounded border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        暂无任务
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="task in tasks"
          :key="task.id"
          class="min-w-0 rounded border border-gray-200 px-3 py-2.5 dark:border-gray-700"
        >
          <div class="flex min-w-0 items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="break-words text-sm text-gray-900 font-medium dark:text-gray-100">
                任务 #{{ task.id }}
              </div>
            </div>
            <span
              class="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]"
              :class="taskStatusClass(task)"
            >
              {{ taskStatusText(task) }}
            </span>
          </div>
          <div class="mt-2 flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 text-xs">
            <span class="shrink-0 text-gray-500 dark:text-gray-400">奖励</span>
            <span class="min-w-0 break-words text-gray-700 dark:text-gray-200">{{ taskRewardsText(task) }}</span>
          </div>
          <div v-if="Number(task.status) === 2" class="mt-2 flex justify-end">
            <BaseButton
              variant="secondary"
              size="sm"
              disabled
              title="任务领取协议尚未确认，暂不发送请求"
            >
              领取待确认
            </BaseButton>
          </div>
        </div>
      </div>
    </section>

    <!-- 店铺排行榜 -->
    <section class="order-6 col-span-full rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 xl:col-span-1">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">店铺排行榜</h3>
          <p class="mt-0.5 break-words text-xs text-gray-500 dark:text-gray-400">
            <span v-if="rankingMyRank">我的排名第 {{ rankingMyRank }} 名</span>
            <span v-else>我的排名暂未上榜</span>
            <span v-if="rankingServerTime"> · 服务器 {{ fmtTime(rankingServerTime) }}</span>
          </p>
        </div>
        <BaseButton variant="secondary" size="sm" :loading="rankingsLoading" @click="loadRankings(rankingCurrentPage)">
          <i class="i-carbon-renew mr-1 text-base" />
          刷新排行
        </BaseButton>
      </div>

      <div v-if="rankingsLoading && !rankings.length" class="rounded border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        读取中…
      </div>
      <div v-else-if="rankingsError" class="min-w-0 break-words rounded border border-dashed border-amber-200 px-3 py-4 text-xs text-amber-700 dark:border-amber-800 dark:text-amber-300">
        {{ rankingsError }}
      </div>
      <div v-else-if="!rankings.length" class="rounded border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        暂无排行数据
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="(entry, index) in rankings"
          :key="rankingKey(entry, index)"
          class="min-w-0 rounded border border-gray-200 px-3 py-2.5 dark:border-gray-700"
        >
          <div class="flex min-w-0 items-start gap-2">
            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs font-bold"
              :class="Number(entry.rank) <= 3
                ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'"
            >
              {{ entry.rank }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span class="min-w-0 break-words text-sm text-gray-900 font-medium dark:text-gray-100">
                  {{ entry.storeName || '未命名店铺' }}
                </span>
                <span class="shrink-0 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
                  Lv{{ rankingLevel(entry) || '—' }}
                </span>
                <span
                  v-if="entry.isSelf"
                  class="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                >
                  我的店铺
                </span>
                <span
                  v-else-if="entry.isFriend"
                  class="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                >
                  好友
                </span>
              </div>
              <div class="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                <span class="min-w-0 break-words">{{ rankingNickname(entry) }}</span>
                <span v-if="entry.playerLevel" class="shrink-0">玩家 Lv{{ entry.playerLevel }}</span>
                <span v-if="entry.gid" class="min-w-0 break-all text-gray-400">GID {{ entry.gid }}</span>
              </div>
            </div>
            <div class="max-w-[38%] shrink-0 text-right">
              <div class="break-words text-sm text-emerald-600 font-bold dark:text-emerald-400">
                {{ Number(entry.revenue || 0).toLocaleString() }}
              </div>
              <div class="text-[10px] text-gray-400">营业额</div>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3 dark:border-gray-700">
        <span class="text-xs text-gray-500 dark:text-gray-400">第 {{ rankingCurrentPage }} 页</span>
        <div class="flex items-center gap-1">
          <BaseButton
            variant="secondary"
            size="sm"
            title="上一页"
            aria-label="上一页"
            :disabled="rankingCurrentPage <= 1 || rankingsLoading"
            @click="shiftRankingPage(-1)"
          >
            <i class="i-carbon-chevron-left text-base" />
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            title="下一页"
            aria-label="下一页"
            :disabled="!rankingHasNext || rankingsLoading"
            @click="shiftRankingPage(1)"
          >
            <i class="i-carbon-chevron-right text-base" />
          </BaseButton>
        </div>
      </div>
    </section>
  </div>
</template>
