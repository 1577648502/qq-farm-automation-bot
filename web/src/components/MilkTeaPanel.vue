<script setup lang="ts">
/**
 * 奶茶热销中（2026-10-15 新活动）专属面板
 *
 * 结构：
 *   ① 经营状态（店名 / 营业额 / 下次结算）+ 刷新
 *   ② 自动经营开关（总开关 / 领收银台收益 / 工坊加工 / 宣传喇叭）+ 店名 + 保存
 *   ③ 手动操作（领收益 / 加工 / 喇叭 / 互动 / 雇佣好友）
 *   ④ 种子商店（含**兑换数量**，实时算总价）
 *   ⑤ 任务列表（只读）
 *
 * 协议见 core/src/services/milk-tea.js
 */
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

const props = defineProps<{
  accountId: string
  settings: any
  saving?: boolean
}>()
const emit = defineEmits<{ (e: 'save'): void }>()

const status = ref<any>(null)
const statusBusy = ref(false)
const actionBusy = ref('')
const actionResult = ref('')

const shop = ref<any[]>([])
const shopBusy = ref(false)
const shopQty = ref<Record<number, number>>({})
const shopResult = ref('')

const tasks = ref<any[]>([])
const tasksBusy = ref(false)

const hireGid = ref('')

function headers() {
  return { headers: { 'x-account-id': props.accountId } }
}

async function loadStatus() {
  if (!props.accountId) return
  statusBusy.value = true
  try {
    const res = await api.get('/api/activity/milk-tea/status', headers())
    status.value = res.data?.data || null
    if (res.data?.ok === false) status.value = { ok: false, reason: res.data.error }
  } catch (e: any) {
    status.value = { ok: false, reason: e?.response?.data?.error || e.message }
  } finally {
    statusBusy.value = false
  }
}

async function loadShop() {
  if (!props.accountId) return
  shopBusy.value = true
  try {
    const res = await api.get('/api/activity/milk-tea/shop', headers())
    shop.value = Array.isArray(res.data?.data?.goods) ? res.data.data.goods : []
    for (const g of shop.value) if (!shopQty.value[g.goodsId]) shopQty.value[g.goodsId] = 1
  } catch (e: any) {
    shopResult.value = e?.response?.data?.error || e.message
  } finally {
    shopBusy.value = false
  }
}

async function loadTasks() {
  if (!props.accountId) return
  tasksBusy.value = true
  try {
    const res = await api.get('/api/activity/milk-tea/tasks', headers())
    tasks.value = Array.isArray(res.data?.data?.tasks) ? res.data.data.tasks : []
  } catch { /* 忽略 */ } finally {
    tasksBusy.value = false
  }
}

async function runAction(kind: string, body: any = {}) {
  if (!props.accountId) { actionResult.value = '请先选择账号'; return }
  actionBusy.value = kind
  actionResult.value = ''
  try {
    const res = await api.post(`/api/activity/milk-tea/${kind}`, body, headers())
    const d = res.data?.data || {}
    if (!res.data?.ok || d.ok === false) {
      actionResult.value = res.data?.error || d.reason || '执行失败'
      return
    }
    const label: Record<string, string> = {
      cashier: '已领取收银台收益',
      craft: '已提交工坊加工',
      speaker: '已使用宣传喇叭',
      open: `已开业（店名「${d.storeName || ''}」）`,
      hire: `已雇佣好友 ${d.friendGid || ''}`,
      interact: '已完成一次互动',
    }
    actionResult.value = label[kind] || '完成'
    await loadStatus()
  } catch (e: any) {
    actionResult.value = e?.response?.data?.error || e.message || '请求失败（账号未运行？）'
  } finally {
    actionBusy.value = ''
  }
}

async function buy(goods: any) {
  const count = clampQty(goods)
  if (!props.accountId) { shopResult.value = '请先选择账号'; return }
  actionBusy.value = `buy-${goods.goodsId}`
  shopResult.value = ''
  try {
    const res = await api.post('/api/activity/milk-tea/buy', { goodsId: goods.goodsId, count }, headers())
    const d = res.data?.data || {}
    if (!res.data?.ok || d.ok === false) { shopResult.value = res.data?.error || d.reason || '兑换失败'; return }
    const got = d.got ? `${d.got.count} 个` : `${count} 个`
    const cost = d.cost ? `，花费 ${Number(d.cost.amount).toLocaleString()} ${goods.currencyName}` : ''
    shopResult.value = `已兑换「${goods.name}」${got}${cost}`
  } catch (e: any) {
    shopResult.value = e?.response?.data?.error || e.message || '请求失败（账号未运行？）'
  } finally {
    actionBusy.value = ''
  }
}

function maxQty(goods: any) {
  const lim = Math.floor(Number(goods.limitCount) || 0)
  return lim > 0 ? lim : 9999
}

function clampQty(goods: any) {
  const n = Math.floor(Number(shopQty.value[goods.goodsId]) || 1)
  return Math.min(Math.max(1, n), maxQty(goods))
}

function totalCost(goods: any) {
  return Number(goods.unitPrice || 0) * clampQty(goods)
}

/** 按货币分组: 金币 / 奶茶券 / 钻石 … */
const shopGroups = computed(() => {
  const map = new Map<number, any>()
  for (const g of shop.value) {
    const k = Number(g.currencyId) || 0
    if (!map.has(k)) map.set(k, { currencyId: k, currencyName: g.currencyName || `货币#${k}`, items: [] as any[] })
    map.get(k).items.push(g)
  }
  return Array.from(map.values())
})

const KIND_LABEL: Record<string, string> = { seed: '种子', exchange: '装扮兑换' }
function kindLabel(g: any) {
  return KIND_LABEL[g.kind] || '道具'
}

function fmtTime(sec: number) {
  if (!sec) return '-'
  const d = new Date(sec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

onMounted(() => {
  loadStatus()
  loadShop()
  loadTasks()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
        奶茶热销中
        <span class="ml-2 text-xs text-gray-500 font-normal dark:text-gray-400">
          营业 10/15–11/14 · 结算 11/15–11/16
        </span>
      </h3>
      <div class="flex items-center gap-2">
        <BaseButton variant="secondary" size="sm" :loading="statusBusy" @click="loadStatus">
          刷新状态
        </BaseButton>
      </div>
    </div>

    <!-- ① 经营状态 -->
    <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div v-if="status && status.ok" class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">店铺</div>
          <div class="text-gray-900 font-medium dark:text-gray-100">
            {{ status.storeName || '未开业' }}
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">累计营业额</div>
          <div class="text-gray-900 font-medium dark:text-gray-100">
            {{ Number(status.value || 0).toLocaleString() }}
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">下次结算</div>
          <div class="text-gray-900 font-medium dark:text-gray-100">{{ fmtTime(status.nextAt) }}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">最近更新</div>
          <div class="text-gray-900 font-medium dark:text-gray-100">{{ fmtTime(status.at) }}</div>
        </div>
      </div>
      <div v-else class="text-sm text-gray-500 dark:text-gray-400">
        {{ statusBusy ? '读取中…' : (status?.reason || '暂无状态（账号需在线）') }}
      </div>
    </div>

    <!-- ② 自动经营 -->
    <div class="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div class="border-b border-gray-100 px-3 py-2.5 dark:border-gray-700/60">
        <div class="text-sm text-gray-900 font-medium dark:text-gray-100">自动经营</div>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          收银台满载会暂停营业且不补发收益，因此「自动领收银台收益」建议常开；每 15 分钟自查一次。
        </p>
      </div>
      <div class="space-y-2 px-3 py-2.5">
        <div class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          <BaseSwitch v-model="settings.milkTeaEnabled" label="启用自动经营" />
          <BaseSwitch v-model="settings.milkTeaCashier" label="自动领收银台收益" />
          <BaseSwitch v-model="settings.milkTeaCraft" label="自动工坊加工" />
          <BaseSwitch v-model="settings.milkTeaSpeaker" label="自动使用宣传喇叭" />
        </div>
        <div class="flex flex-wrap items-end gap-3 pt-1">
          <BaseInput v-model="settings.milkTeaStoreName" label="店名（首次开业用）" type="text" class="w-44" />
          <BaseButton variant="primary" size="sm" :loading="!!saving" @click="emit('save')">
            保存设置
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- ③ 手动操作 -->
    <div class="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div class="border-b border-gray-100 px-3 py-2.5 dark:border-gray-700/60">
        <div class="text-sm text-gray-900 font-medium dark:text-gray-100">立即执行一次</div>
      </div>
      <div class="space-y-2 px-3 py-2.5">
        <div class="flex flex-wrap items-center gap-2">
          <BaseButton variant="secondary" size="sm" :loading="actionBusy === 'cashier'" @click="runAction('cashier')">
            领收银台收益
          </BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="actionBusy === 'craft'" @click="runAction('craft')">
            工坊加工
          </BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="actionBusy === 'speaker'" @click="runAction('speaker')">
            用宣传喇叭
          </BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="actionBusy === 'interact'" @click="runAction('interact')">
            我的工作互动
          </BaseButton>
          <BaseButton v-if="status && !status.storeName" variant="primary" size="sm" :loading="actionBusy === 'open'" @click="runAction('open')">
            开业（{{ settings.milkTeaStoreName || '奶茶小铺' }}）
          </BaseButton>
        </div>
        <div class="flex flex-wrap items-end gap-2">
          <BaseInput v-model="hireGid" label="雇佣好友 GID" type="text" class="w-44" />
          <BaseButton variant="secondary" size="sm" :loading="actionBusy === 'hire'" @click="runAction('hire', { friendGid: hireGid })">
            雇佣
          </BaseButton>
        </div>
        <div v-if="actionResult" class="text-xs text-gray-600 dark:text-gray-300">{{ actionResult }}</div>
      </div>
    </div>

    <!-- ④ 种子商店（兑换数量） -->
    <div class="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div class="flex items-center justify-between border-b border-gray-100 px-3 py-2.5 dark:border-gray-700/60">
        <div>
          <div class="text-sm text-gray-900 font-medium dark:text-gray-100">活动种子商店</div>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            分货币计价（金币 / 奶茶券 / 钻石）；填数量后点「兑换」，超出限购会自动夹到上限，合计实时计算。
          </p>
        </div>
        <BaseButton variant="secondary" size="sm" :loading="shopBusy" @click="loadShop">
          刷新商品
        </BaseButton>
      </div>
      <div class="px-3 py-2.5">
        <div v-if="!shop.length" class="text-sm text-gray-500 dark:text-gray-400">
          {{ shopBusy ? '读取中…' : '暂无商品（账号需在线）' }}
        </div>
        <div v-else class="space-y-4">
          <div v-for="grp in shopGroups" :key="grp.currencyId">
            <div class="mb-1.5 flex items-center gap-2">
              <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 font-medium dark:bg-gray-700 dark:text-gray-200">
                {{ grp.currencyName }}
              </span>
              <span class="text-xs text-gray-400">{{ grp.items.length }} 件</span>
            </div>
            <div class="space-y-2">
              <div
                v-for="g in grp.items"
                :key="g.goodsId"
                class="flex flex-wrap items-center gap-3 rounded border border-gray-200 px-2.5 py-2 dark:border-gray-700"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-sm text-gray-900 font-medium dark:text-gray-100">{{ g.name }}</span>
                    <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                      {{ kindLabel(g) }}
                    </span>
                  </div>
                  <div class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    <template v-if="g.itemNameKnown">内容：{{ g.itemName }} · </template>
                    单价：{{ Number(g.unitPrice).toLocaleString() }} {{ g.currencyName }}
                    <template v-if="g.limitCount"> · 限购 {{ g.limitCount }}</template>
                    <template v-if="g.unlockText"> · 需 {{ g.unlockText }}</template>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <BaseInput
                    v-model.number="shopQty[g.goodsId]"
                    label="兑换数量"
                    type="number"
                    min="1"
                    :max="maxQty(g)"
                    class="w-28"
                  />
                  <span class="text-xs text-gray-500 dark:text-gray-400">
                    合计 {{ totalCost(g).toLocaleString() }}
                  </span>
                  <BaseButton
                    variant="secondary"
                    size="sm"
                    :loading="actionBusy === `buy-${g.goodsId}`"
                    @click="buy(g)"
                  >
                    兑换
                  </BaseButton>
                </div>
              </div>
            </div>
          </div>
          <div v-if="shopResult" class="text-xs text-gray-600 dark:text-gray-300">{{ shopResult }}</div>
        </div>
      </div>
    </div>

    <!-- ⑤ 任务列表 -->
    <div class="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div class="flex items-center justify-between border-b border-gray-100 px-3 py-2.5 dark:border-gray-700/60">
        <div>
          <div class="text-sm text-gray-900 font-medium dark:text-gray-100">任务</div>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            状态：1 未完成 · 2 可领 · 3 已领（领取命令尚未抓到，暂只展示）
          </p>
        </div>
        <BaseButton variant="secondary" size="sm" :loading="tasksBusy" @click="loadTasks">
          刷新任务
        </BaseButton>
      </div>
      <div class="px-3 py-2.5">
        <div v-if="!tasks.length" class="text-sm text-gray-500 dark:text-gray-400">
          {{ tasksBusy ? '读取中…' : '暂无任务' }}
        </div>
        <div v-else class="space-y-1">
          <div v-for="t in tasks" :key="t.id" class="flex flex-wrap items-center gap-2 text-xs">
            <span class="text-gray-500 dark:text-gray-400">#{{ t.id }}</span>
            <span class="text-gray-700 dark:text-gray-200">
              {{ (t.rewards || []).map((r: any) => r.name).join('、') || '（无奖励信息）' }}
            </span>
            <span
              class="rounded px-1.5 py-0.5"
              :class="t.status === 2
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : t.status === 3
                  ? 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'"
            >
              {{ t.status === 2 ? '可领' : t.status === 3 ? '已领' : '未完成' }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
