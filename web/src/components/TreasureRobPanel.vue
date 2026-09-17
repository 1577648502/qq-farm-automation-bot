<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

/**
 * 夺宝(抢宝) —— 手动夺宝
 * 流程: 刷新可夺宝藏(遍历好友) → 选挑战书 → 夺宝
 * 挑战书: 80103 高级 / 80102 中级 / 80101 初级 (优先高等级)
 */

interface Book {
  id: number
  name: string
  level: number
  count: number
}

interface BookSlot {
  bookItemId: number
  gold: number
}

interface Target {
  treasureId: string
  gid: number
  friendName: string
  stealableValue: number
  status: number
  maxValue: number
  bonusValue: number
  endTime: number
  bookSlots: BookSlot[]
  /** 该好友当前在运送的宝藏数量(列表只展示最好的一个) */
  treasureCount?: number
}

/** 一条抢夺记录(后端持久化, 含成功/失败/被拒 + 奖励) */
interface RobRecord {
  at: number
  outcome: 'win' | 'lose' | 'rejected' | 'unknown' | 'error'
  outcomeText: string
  ok: boolean
  reward: { id: number, count: number, name: string } | null
  rewardText: string
  message: string
  gid: number
  friendName: string
  bookName: string
  treasureShort?: string
  myCharm?: string
  theirCharm?: string
  myWinRate?: number
  theirWinRate?: number
  source?: 'manual' | 'auto'
}

const accountStore = useAccountStore()
const toast = useToastStore()
const currentAccountId = computed(() => String(accountStore.currentAccountId || ''))

const books = ref<Book[]>([])
const targets = ref<Target[]>([])
const loading = ref(false)
const robbing = ref<string>('')
const autoRunning = ref(false)
/** 每个宝藏选中的挑战书 id: treasureId -> bookItemId */
const picked = ref<Record<string, number>>({})
const logs = ref<string[]>([])
const records = ref<RobRecord[]>([])
const recordTotal = ref(0)
const recordSummary = ref<{ win: number, lose: number, rejected: number, error: number, rewardTotal: number } | null>(null)
const recordsLoading = ref(false)

function pushLog(msg: string) {
  logs.value.unshift(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`)
  if (logs.value.length > 200) logs.value.length = 200
}

/** 只展示"运送中且未结束"的宝藏(后端已过滤, 这里再兜一层) */
const visibleTargets = computed(() => (targets.value || []).filter((t) => {
  if (Number(t.status) !== 2)
    return false
  if (t.endTime) {
    const endMs = t.endTime > 1e12 ? t.endTime : t.endTime * 1000
    if (endMs <= Date.now())
      return false
  }
  return true
}))

const availableBooks = computed(() => books.value.filter(b => Number(b.count) > 0))
/** 优先高等级可用的挑战书 */
const bestBook = computed(() => {
  const list = [...books.value].sort((a, b) => b.level - a.level)
  return list.find(b => Number(b.count) > 0) || null
})

async function fetchBooks() {
  if (!currentAccountId.value) return
  try {
    const res = await api.get('/api/treasure/books', { headers: { 'x-account-id': currentAccountId.value } })
    if (res.data?.ok) {
      books.value = (res.data.data?.books || []).sort((a: Book, b: Book) => b.level - a.level)
    } else {
      toast.error(res.data?.error || '读取挑战书失败')
    }
  } catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '读取挑战书失败')
  }
}

async function fetchTargets() {
  if (!currentAccountId.value) return
  loading.value = true
  try {
    const res = await api.get('/api/treasure/targets', {
      headers: { 'x-account-id': currentAccountId.value },
      timeout: 120000,
    })
    if (res.data?.ok) {
      const list: Target[] = res.data.data?.targets || []
      targets.value = list
      picked.value = {}
      for (const t of list) {
        if (bestBook.value) picked.value[t.treasureId] = bestBook.value.id
      }
      const skipped = Number(res.data.data?.skippedEnded) || 0
      if (!list.length) {
        pushLog(`没有可夺的宝藏（已查 ${res.data.data?.friendCount || 0} 位好友${skipped ? `，已忽略 ${skipped} 个已结束/非运送中的宝藏` : ''}）`)
      } else {
        pushLog(`刷新到 ${list.length} 位好友的可夺宝藏（已查 ${res.data.data?.friendCount || 0} 位好友${skipped ? `，已忽略 ${skipped} 个已结束/非运送中的宝藏` : ''}）`)
      }
    } else {
      toast.error(res.data?.error || '刷新失败')
    }
  } catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '刷新失败（好友多时较慢，请耐心等待）')
  } finally {
    loading.value = false
  }
}

async function fetchRecords() {
  if (!currentAccountId.value) return
  recordsLoading.value = true
  try {
    const res = await api.get('/api/treasure/records', {
      headers: { 'x-account-id': currentAccountId.value },
      params: { limit: 100 },
    })
    if (res.data?.ok) {
      records.value = res.data.data?.records || []
      recordTotal.value = Number(res.data.data?.total) || 0
      recordSummary.value = res.data.data?.summary || null
    }
  } catch (e: any) {
    // 记录拉取失败不打断主流程
  } finally {
    recordsLoading.value = false
  }
}

async function clearRecords() {
  if (!currentAccountId.value) return
  try {
    const res = await api.delete('/api/treasure/records', { headers: { 'x-account-id': currentAccountId.value } })
    if (res.data?.ok) {
      records.value = []
      recordTotal.value = 0
      recordSummary.value = null
      toast.success('抢夺记录已清空')
    } else {
      toast.error(res.data?.error || '清空失败')
    }
  } catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '清空失败')
  }
}

function fmtTime(ms: number) {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 结果徽标配色: 成功=绿(夺到) / 失败=红 / 未发起=灰 */
function outcomeClass(o: string) {
  if (o === 'win')
    return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
  if (o === 'lose')
    return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  if (o === 'error')
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
}

function refreshAll() {
  return Promise.all([fetchBooks(), fetchTargets(), fetchRecords()])
}

async function robOne(t: Target) {
  const bookItemId = picked.value[t.treasureId] || (bestBook.value ? bestBook.value.id : 0)
  if (!bookItemId) {
    toast.warning('没有可用的挑战书')
    return
  }
  const book = books.value.find(b => b.id === bookItemId)
  robbing.value = t.treasureId
  try {
    const res = await api.post('/api/treasure/rob', {
      gid: t.gid,
      treasureId: t.treasureId,
      bookItemId,
      friendName: t.friendName || '',
    }, { headers: { 'x-account-id': currentAccountId.value }, timeout: 60000 })
    if (res.data?.ok) {
      const d = res.data.data || {}
      const who = t.friendName || t.gid
      // 以后端战报为准: 成功/失败/未发起 三态, 并带上奖励
      if (d.outcome === 'win') {
        pushLog(`✅ ${who} 用【${book?.name || bookItemId}】夺得 ${d.rewardText || '奖励'}`)
        toast.success(d.rewardText ? `夺得 ${d.rewardText}` : '夺宝成功')
      } else if (d.outcome === 'lose') {
        pushLog(`❌ ${who} 用【${book?.name || bookItemId}】落败, 返还 ${d.rewardText || '奖励'}`)
        toast.warning(`夺宝落败, 返还 ${d.rewardText || '奖励'}`)
      } else if (d.outcome === 'rejected') {
        pushLog(`⛔ ${who} 用【${book?.name || bookItemId}】未发起: ${d.message || '被服务端拒绝'}`)
        toast.warning(d.message || '服务端拒绝了这次夺宝')
      } else if (d.ok) {
        pushLog(`✅ ${who} 夺宝成功（${book?.name || bookItemId}）`)
        toast.success('夺宝成功')
      } else {
        pushLog(`⚠️ ${who} 用了【${book?.name || bookItemId}】但未生效（可夺价值 ${d.before} → ${d.after}），可能该宝藏已被夺到上限`)
        toast.warning('这次没有生效，换个宝藏试试')
      }
      await fetchBooks()
      await fetchTargets()
      await fetchRecords()
    } else {
      toast.error(res.data?.error || '夺宝失败')
      pushLog(`❌ ${t.friendName || t.gid} 夺宝失败：${res.data?.error || '未知错误'}`)
    }
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '夺宝失败'
    toast.error(msg)
    pushLog(`❌ ${t.friendName || t.gid} 夺宝异常：${msg}`)
  } finally {
    robbing.value = ''
  }
}

async function runAutoNow() {
  autoRunning.value = true
  try {
    const res = await api.post('/api/treasure/run-auto', {}, {
      headers: { 'x-account-id': currentAccountId.value },
      timeout: 180000,
    })
    if (res.data?.ok) {
      const d = res.data.data || {}
      if (d.skipped) {
        toast.warning('自动夺宝开关未开启（可在 设置 → 自动化 里打开）')
      } else {
        pushLog(`🤖 自动夺宝: 尝试 ${d.attempted} 次，成功 ${d.win ?? d.success}，失败 ${d.lose ?? 0}，被拒 ${d.rejected ?? 0}，未生效 ${d.noEffect}，异常 ${d.failed}`)
        for (const it of (d.details || [])) {
          const tail = it.rewardText ? ` → ${it.rewardText}` : (it.message || it.error || '')
          pushLog(`   · ${it.friendName || it.gid} ${it.book} → ${it.outcomeText || (it.ok ? '成功' : '未生效')}${tail ? ' ' + tail : ''}`)
        }
        toast.success('自动夺宝执行完成')
      }
      await refreshAll()
    } else {
      toast.error(res.data?.error || '执行失败')
    }
  } catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '执行失败')
  } finally {
    autoRunning.value = false
  }
}

function fmtRemain(sec: number) {
  if (!sec) return '-'
  const left = Math.max(0, Math.round(sec - Date.now() / 1000))
  if (left <= 0) return '已结束'
  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  return h > 0 ? `${h}小时${m}分` : `${m}分`
}

function slotGold(t: Target, bookItemId: number) {
  const s = (t.bookSlots || []).find(x => Number(x.bookItemId) === Number(bookItemId))
  return s ? s.gold : 0
}

onMounted(() => {
  void refreshAll()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          找到正在运送宝藏的好友，用挑战书抢夺。挑战书优先使用高等级（高级 → 中级 → 初级）。
        </p>
      </div>
      <div class="flex gap-2">
        <BaseButton variant="secondary" size="sm" :loading="autoRunning" @click="runAutoNow">
          立即自动夺宝一次
        </BaseButton>
        <BaseButton variant="primary" size="sm" :loading="loading" @click="refreshAll">
          刷新可夺宝藏
        </BaseButton>
      </div>
    </div>

    <!-- 我的挑战书 -->
    <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">
        我的挑战书
      </div>
      <div class="flex flex-wrap gap-3">
        <div
          v-for="b in books"
          :key="b.id"
          class="rounded border px-3 py-2 text-sm"
          :class="b.count > 0
            ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/40 dark:bg-green-900/20 dark:text-green-300'
            : 'border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-500'"
        >
          {{ b.name }} × {{ b.count }}
        </div>
        <div v-if="!books.length" class="text-sm text-gray-400">
          读取中…
        </div>
      </div>
      <div v-if="bestBook" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        将优先使用：<span class="font-medium text-gray-700 dark:text-gray-200">{{ bestBook.name }}</span>
      </div>
      <div v-else class="mt-2 text-xs text-amber-600 dark:text-amber-400">
        当前没有可用挑战书，无法夺宝
      </div>
    </div>

    <!-- 可夺宝藏 -->
    <div class="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div class="flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-700">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-200">
          可夺宝藏（{{ visibleTargets.length }}）
        </span>
        <span class="text-xs text-gray-400">只显示正在运送的宝藏 · 遍历好友查询，好友多时较慢</span>
      </div>

      <div v-if="loading" class="px-3 py-6 text-center text-sm text-gray-400">
        正在遍历好友查询宝藏…
      </div>
      <div v-else-if="!visibleTargets.length" class="px-3 py-6 text-center text-sm text-gray-400">
        暂无可夺宝藏（好友里暂时没人正在运送宝藏）
      </div>
      <div v-else class="divide-y divide-gray-100 dark:divide-gray-700">
        <div
          v-for="t in visibleTargets"
          :key="t.gid"
          class="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
        >
          <div class="min-w-[140px]">
            <div class="font-medium text-gray-800 dark:text-gray-100">
              {{ t.friendName || `gid:${t.gid}` }}
              <span v-if="Number(t.treasureCount) > 1" class="ml-1 text-xs text-gray-400 font-normal">
                (在运送 {{ t.treasureCount }} 个)
              </span>
            </div>
            <div class="text-xs text-gray-400">
              {{ t.treasureId.slice(-8) }}
            </div>
          </div>

          <div class="min-w-[110px]">
            <div class="text-xs text-gray-400">
              可夺价值
            </div>
            <div class="font-medium text-amber-600 dark:text-amber-400">
              {{ t.stealableValue }}
            </div>
          </div>

          <div class="min-w-[80px]">
            <div class="text-xs text-gray-400">
              状态
            </div>
            <div class="text-green-600 dark:text-green-400">
              运送中
            </div>
          </div>

          <div class="min-w-[100px]">
            <div class="text-xs text-gray-400">
              剩余时间
            </div>
            <div class="text-gray-600 dark:text-gray-300">
              {{ fmtRemain(t.endTime) }}
            </div>
          </div>

          <div class="min-w-[100px]">
            <div class="text-xs text-gray-400">
              这一刀可夺
            </div>
            <div class="text-gray-600 dark:text-gray-300">
              {{ slotGold(t, Number(picked[t.treasureId]) || 0) }}
            </div>
          </div>

          <div class="flex items-center gap-2">
            <BaseSelect
              v-model="picked[t.treasureId]"
              :options="availableBooks.map(b => ({ label: `${b.name}(×${b.count})`, value: b.id }))"
              class="w-44"
            />
            <BaseButton
              variant="primary"
              size="sm"
              :loading="robbing === t.treasureId"
              :disabled="!picked[t.treasureId]"
              @click="robOne(t)"
            >
              夺宝
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 抢夺记录(持久化: 成功/失败 + 获得的奖励) -->
    <div class="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-700">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-gray-700 dark:text-gray-200">
            抢夺记录（{{ recordTotal }} 条）
          </span>
          <span v-if="recordSummary" class="text-xs text-gray-500 dark:text-gray-400">
            成功
            <span class="font-medium text-green-600 dark:text-green-400">{{ recordSummary.win }}</span>
            · 失败 {{ recordSummary.lose }} · 未发起 {{ recordSummary.rejected }}
            <span v-if="recordSummary.error">· 异常 {{ recordSummary.error }}</span>
            <span class="ml-1 text-gray-500 dark:text-gray-400">累计夺得 {{ recordSummary.rewardTotal }} 幸运星</span>
          </span>
        </div>
        <div class="flex items-center gap-3">
          <button class="text-xs text-gray-400 hover:text-gray-600" :disabled="recordsLoading" @click="fetchRecords">
            刷新
          </button>
          <button
            class="text-xs text-gray-400 hover:text-red-500 disabled:opacity-50"
            :disabled="!records.length"
            @click="clearRecords"
          >
            清空
          </button>
        </div>
      </div>

      <div v-if="!records.length" class="px-3 py-6 text-center text-xs text-gray-400">
        暂无抢夺记录（每次夺宝后都会在这里留下成功/失败与获得的奖励）
      </div>
      <div v-else class="max-h-80 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-700">
        <div v-for="(r, i) in records" :key="`${r.at}-${i}`" class="px-3 py-2">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span class="text-xs text-gray-400">{{ fmtTime(r.at) }}</span>
            <span class="min-w-[110px] font-medium text-gray-800 dark:text-gray-100">
              {{ r.friendName || `gid:${r.gid}` }}
            </span>
            <span class="text-xs text-gray-500 dark:text-gray-400">{{ r.bookName || '-' }}</span>
            <span class="rounded px-1.5 py-0.5 text-xs" :class="outcomeClass(r.outcome)">
              {{ r.outcomeText }}
            </span>
            <span
              v-if="r.rewardText"
              class="text-xs font-medium"
              :class="r.outcome === 'win'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-gray-500 dark:text-gray-400'"
            >
              {{ r.outcome === 'win' ? '夺得' : '返还' }} {{ r.rewardText }}
            </span>
            <span
              v-if="r.source === 'auto'"
              class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-400 dark:bg-gray-700 dark:text-gray-300"
            >
              自动
            </span>
          </div>
          <div v-if="r.message || r.theirCharm || r.myCharm" class="mt-0.5 text-xs text-gray-400">
            <span v-if="r.message">{{ r.message }}</span>
            <span v-if="r.theirCharm" class="ml-2">对方锦囊: {{ r.theirCharm }}</span>
            <span v-if="r.myCharm" class="ml-2">我方锦囊: {{ r.myCharm }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 操作日志 -->
    <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-200">操作记录</span>
        <button class="text-xs text-gray-400 hover:text-gray-600" @click="logs = []">
          清空
        </button>
      </div>
      <div v-if="!logs.length" class="text-xs text-gray-400">
        暂无记录
      </div>
      <div v-else class="max-h-64 space-y-1 overflow-y-auto text-xs text-gray-600 dark:text-gray-300">
        <div v-for="(l, i) in logs" :key="i" class="whitespace-pre-wrap">
          {{ l }}
        </div>
      </div>
    </div>
  </div>
</template>
