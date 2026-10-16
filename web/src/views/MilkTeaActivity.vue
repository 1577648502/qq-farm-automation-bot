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
const hireOpen = ref(false)
const hireSaving = ref(false)
const newGid = ref('')
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

function addGid() {
  const v = String(newGid.value || '').trim()
  if (!/^\d{5,}$/.test(v)) { toast.warning('请输入正确的好友 GID（纯数字）'); return }
  if (!hireGids.value.includes(v)) hireGids.value.push(v)
  newGid.value = ''
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
  if (hireOpen.value) await loadFriends()
}

/** 展开雇佣好友时才去拉好友(重请求) */
async function toggleHire() {
  hireOpen.value = !hireOpen.value
  if (hireOpen.value && !friends.value.length) {
    await new Promise((r) => setTimeout(r, 300))
    await loadFriends()
  }
}

onMounted(() => {
  loadStatus()
  setTimeout(() => loadHireConfig(), 500)
  setTimeout(() => loadShop(), 1000)
})
</script>

<template>
  <div class="space-y-4">
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
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
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

    <!-- ①b 操作(手动按钮 + 参数) —— 设置页只留开关, 操作都在这 -->
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">
          操作
          <span class="ml-2 text-xs text-gray-500">自动化开关在 设置 → 自动控制</span>
        </h3>
        <span v-if="actionResult" class="text-xs text-gray-600 dark:text-gray-300">{{ actionResult }}</span>
      </div>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <BaseButton variant="secondary" size="sm" :loading="busy === 'cashier'" @click="claimCashierNow">领收银台收益</BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="busy === 'craft'" @click="craftNow">制作奶茶（全部果实）</BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="busy === 'wage'" @click="claimWageNow">领工资</BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="busy === 'interact'" @click="interactNow">互动一次</BaseButton>
      </div>
      <div class="flex flex-wrap items-center gap-2 rounded border border-gray-200 px-2.5 py-2 dark:border-gray-700">
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
        <label class="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          雇主 GID
          <input v-model="interactGid" type="text" :placeholder="status && status.employer ? String(status.employer.gid) : '可留空自动探测'" class="w-36 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900">
        </label>
        <BaseButton variant="primary" size="sm" :loading="hireSaving" @click="saveHireConfig">保存参数</BaseButton>
      </div>
    </div>

    <!-- ② 活动种子商店 -->
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
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
                  限购 {{ g.limitCount }}<span v-if="g.boughtCount"> · 已兑 {{ g.boughtCount }}</span>
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
    <div class="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <button
        class="flex w-full items-center justify-between px-4 py-3 text-left"
        @click="toggleHire"
      >
        <span class="text-sm text-gray-900 font-medium dark:text-white">
          雇佣好友
          <span class="ml-2 text-xs text-gray-500 font-normal">
            已勾选 {{ hireGids.length }} 位{{ autoHire ? ' · 自动雇佣已开' : '' }}
          </span>
        </span>
        <span class="text-xs text-gray-400">{{ hireOpen ? '收起 ▲' : '展开 ▼' }}</span>
      </button>
      <div v-show="hireOpen" class="border-t border-gray-100 px-4 py-3 dark:border-gray-700/60">
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
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <input
            v-model="newGid"
            type="text"
            placeholder="手动添加好友 GID"
            class="w-48 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900"
          >
          <BaseButton variant="secondary" size="sm" @click="addGid">添加</BaseButton>
          <span class="text-xs text-gray-400">GID 可在「好友」页面查看</span>
        </div>
        <div v-if="friends.length" class="mb-2 flex flex-wrap items-center gap-2">
          <BaseButton variant="secondary" size="sm" @click="selectAllFriends">全选</BaseButton>
          <BaseButton variant="secondary" size="sm" @click="clearAllFriends">清空</BaseButton>
          <BaseButton variant="secondary" size="sm" @click="invertFriends">反选</BaseButton>
          <span class="text-xs text-gray-500 dark:text-gray-400">
            共 {{ friends.length }} 位好友，已勾选 {{ hireGids.length }} 位（改完记得点「保存设置」）
          </span>
        </div>
        <div v-if="!friends.length" class="text-xs text-gray-500 dark:text-gray-400">
          {{ friendsBusy ? '读取中…' : '未读到好友列表（账号需在线；QQ 端可用上面的输入框手动添加 GID）' }}
        </div>
        <div v-else class="grid grid-cols-2 gap-1 md:grid-cols-3 xl:grid-cols-4">
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
        <div v-if="hireGids.length" class="mt-2 flex flex-wrap gap-1">
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
