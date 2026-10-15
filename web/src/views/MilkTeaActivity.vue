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
const autoTask = ref(false)
const hireOpen = ref(false)
const hireSaving = ref(false)
const newGid = ref('')

const tasks = ref<any[]>([])
const tasksBusy = ref(false)
const taskClaiming = ref<number>(0)

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

const claimableTasks = computed(() => tasks.value.filter((t: any) => t.status === 2))

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
    autoTask.value = !!d.autoTask
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

async function loadTasks() {
  tasksBusy.value = true
  try {
    const res = await api.get('/api/activity/milk-tea/tasks')
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('读取任务', err); tasks.value = []; return }
    tasks.value = Array.isArray(d.tasks) ? d.tasks : []
  } catch (e: any) {
    reportError('读取任务', apiError(null, null, e))
  } finally {
    tasksBusy.value = false
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
      autoTask: autoTask.value,
    })
    const err = apiError(res, res.data?.data)
    if (err) { reportError('保存设置', err); return }
    toast.success(`已保存：好友 ${hireGids.value.length} 位${autoHire.value ? '，自动雇佣开' : ''}${autoTask.value ? '，自动领任务开' : ''}`)
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

async function claimTask(t: any) {
  taskClaiming.value = Number(t.id) || 0
  try {
    const res = await api.post('/api/activity/milk-tea/claim-task', { taskId: t.id })
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError(`领取任务#${t.id}`, err); return }
    actionResult.value = `任务#${t.id} 已领取`
    toast.success(actionResult.value)
    await loadTasks()
  } catch (e: any) {
    reportError(`领取任务#${t.id}`, apiError(null, null, e))
  } finally {
    taskClaiming.value = 0
  }
}

async function claimAllTasks() {
  taskClaiming.value = -1
  try {
    const res = await api.post('/api/activity/milk-tea/claim-task', {})
    const d = res.data?.data || {}
    const err = apiError(res, d)
    if (err) { reportError('一键领取任务', err); return }
    if (d.skipped) { actionResult.value = d.reason || '没有可领任务'; toast.warning(actionResult.value); return }
    const okCount = (d.claimed || []).filter((x: any) => x.ok).length
    actionResult.value = `已领取 ${okCount}/${(d.claimed || []).length} 个任务`
    toast.success(actionResult.value)
    await loadTasks()
  } catch (e: any) {
    reportError('一键领取任务', apiError(null, null, e))
  } finally {
    taskClaiming.value = 0
  }
}

function refreshAll() {
  loadStatus()
  loadShop()
  loadHireConfig()
  loadFriends()
  loadTasks()
}

onMounted(refreshAll)
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
      </div>
      <div v-else class="text-xs text-gray-500 dark:text-gray-400">
        {{ statusBusy ? '读取中…' : (status?.reason || '暂无状态（账号需在线）') }}
      </div>
      <div v-if="status && pending > 0" class="mt-2 text-xs text-amber-600 dark:text-amber-400">
        收银台还有 {{ pending.toLocaleString() }} 待领取 —— 满载会暂停营业且不补发，建议在「设置 → 自动控制」开启自动领取。
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
        @click="hireOpen = !hireOpen"
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
          <BaseButton variant="secondary" size="sm" :loading="busy === 'hire-auto'" @click="hireNow">
            立即雇佣一个
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

    <!-- ④ 任务（卡片式 + 领取） -->
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">
          任务
          <span class="ml-2 text-xs text-gray-500">
            可领 {{ claimableTasks.length }} 个
            <template v-if="!claimableTasks.length">；状态：1 未完成 · 2 可领 · 3 已领</template>
          </span>
        </h3>
        <div class="flex flex-wrap items-center gap-2">
          <BaseSwitch v-model="autoTask" label="自动领取" />
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="!claimableTasks.length"
            :loading="taskClaiming === -1"
            @click="claimAllTasks"
          >
            一键领取
          </BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="tasksBusy" @click="loadTasks">
            刷新任务
          </BaseButton>
        </div>
      </div>
      <div v-if="!tasks.length" class="text-xs text-gray-500 dark:text-gray-400">
        {{ tasksBusy ? '读取中…' : '暂无任务' }}
      </div>
      <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="t in tasks"
          :key="t.id"
          class="flex flex-col rounded border p-3"
          :class="t.status === 2
            ? 'border-emerald-300 dark:border-emerald-800'
            : 'border-gray-200 dark:border-gray-700'"
        >
          <div class="flex items-start justify-between gap-2">
            <span class="text-sm text-gray-900 font-medium dark:text-white">任务 #{{ t.id }}</span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              :class="t.status === 2
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : t.status === 3
                  ? 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'"
            >
              {{ t.status === 2 ? '可领' : t.status === 3 ? '已领' : '未完成' }}
            </span>
          </div>
          <div class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
            <div v-for="(r, i) in (t.rewards || [])" :key="i">{{ r.name }}</div>
            <div v-if="!(t.rewards || []).length">（无奖励信息）</div>
          </div>
          <div class="mt-2 flex justify-end">
            <BaseButton
              variant="primary"
              size="sm"
              :disabled="t.status !== 2"
              :loading="taskClaiming === Number(t.id)"
              @click="claimTask(t)"
            >
              {{ t.status === 2 ? '领取' : (t.status === 3 ? '已领取' : '未完成') }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <div v-if="actionResult" class="text-xs text-gray-600 dark:text-gray-300">{{ actionResult }}</div>
  </div>
</template>
