<script setup lang="ts">
/**
 * 协议观察 —— 游戏更新了没有, 这里直接看
 *
 * 背景: 以前每次活动更新都要手动 mitmproxy 抓包 + 解码 + 人工比对, 一次半小时。
 * 现在机器人跑着就在采集每个 service.method 的字段结构, 这个页面把结论摊开:
 *   · 活动结构: 有哪些活动组/子活动, 谁是新的, 谁的 body 字段在 proto 里没定义;
 *   · 新接口: 基线之后第一次出现的接口;
 *   · 新字段: 老接口上多出来的字段号。
 *
 * 「以此为准」= 把当前状态冻结成基线。冻结之前的差异全部归零,
 * 之后只报真正的新变化 —— 所以处理完一次更新就点一下它。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import api from '@/api'
import { useToastStore } from '@/stores/toast'
import LoadingState from '@/components/ui/LoadingState.vue'

interface BodyField {
  no: number
  name: string
  defined: boolean
}

interface ChildActivity {
  id: number
  name: string
  type: number
  status: number
  startTime: number
  endTime: number
  isNew: boolean
  bodyFields: BodyField[]
  undefinedBodyFields: number[]
}

interface ActivityGroup {
  id: number
  name: string
  startTime: number
  endTime: number
  isNew: boolean
  children: ChildActivity[]
}

interface InterfaceRow {
  key: string
  count: number
  errors: number
  lastSeenAt: number
  isNew: boolean
  newFields: string[]
  accounts: string[]
}

const accountStore = useAccountStore()
const toast = useToastStore()
const currentAccountId = computed(() => accountStore.currentAccountId)

const loading = ref(false)
const freezing = ref(false)
const error = ref('')
const data = ref<any>(null)
const filter = ref('')
const activeTab = ref<'activity' | 'interfaces'>('activity')

const overview = computed(() => data.value || {})
const groups = computed<ActivityGroup[]>(() => overview.value.activityChange?.groups || [])
const rows = computed<InterfaceRow[]>(() => {
  const list = (overview.value.interfaces || []) as InterfaceRow[]
  const kw = filter.value.trim().toLowerCase()
  if (!kw) return list
  return list.filter(r => r.key.toLowerCase().includes(kw))
})
const newInterfaces = computed<string[]>(() => overview.value.newInterfaces || [])
const newFieldCount = computed(() => (overview.value.interfacesWithNewFields || []).length)
const undefinedFields = computed(() => overview.value.activityChange?.undefinedBodyFields || [])

const hasUpdate = computed(() => newInterfaces.value.length > 0
  || newFieldCount.value > 0
  || undefinedFields.value.length > 0
  || groups.value.some(g => g.isNew || g.children.some(c => c.isNew)))

function fmtTime(ms: number) {
  if (!ms) return '-'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

async function refresh() {
  if (!currentAccountId.value) return
  loading.value = true
  error.value = ''
  try {
    const res = await api.get('/api/protocol/overview', { headers: { 'x-account-id': currentAccountId.value } })
    const d = res.data
    if (!d?.ok) throw new Error(d?.error || '获取失败')
    data.value = d.data
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取失败'
  } finally {
    loading.value = false
  }
}

async function freeze() {
  if (!currentAccountId.value) return
  freezing.value = true
  try {
    const res = await api.post('/api/protocol/baseline', {}, { headers: { 'x-account-id': currentAccountId.value } })
    const d = res.data
    if (!d?.ok) throw new Error(d?.error || '操作失败')
    toast.success(`已冻结基线：${d.data.interfaceCount} 个接口`)
    await refresh()
  } catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '操作失败')
  } finally {
    freezing.value = false
  }
}

// ============ 接口字段树查看(对应 /api/protocol/inspect) ============
// 采集到的样本是原始 hex, 面板按裸 wire 现场解析 —— 新玩法没写 .proto 时也能看结构。
const inspectKey = ref('')
const inspectMode = ref<'tree' | 'strings'>('tree')
const inspectLoading = ref(false)
const inspectError = ref('')
const inspectResult = ref<any>(null)

async function inspect(key?: string, mode?: 'tree' | 'strings') {
  const target = String(key || inspectKey.value || '').trim()
  if (!target)
    return
  if (key)
    inspectKey.value = key
  if (mode)
    inspectMode.value = mode
  inspectLoading.value = true
  inspectError.value = ''
  inspectResult.value = null
  try {
    const res = await api.get('/api/protocol/inspect', {
      params: { key: target, mode: inspectMode.value, depth: 5 },
      headers: { 'x-account-id': currentAccountId.value },
    })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '获取失败')
    inspectResult.value = d.data
  }
  catch (e: any) {
    inspectError.value = e?.response?.data?.error || e?.message || '获取失败'
  }
  finally {
    inspectLoading.value = false
  }
}

function closeInspect() {
  inspectResult.value = null
  inspectError.value = ''
}

onMounted(refresh)
watch(currentAccountId, () => refresh())
</script>

<template>
  <div class="p-3 sm:p-4">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="i-carbon-catalog text-xl text-sky-600" />
        <h2 class="text-lg font-bold">协议观察</h2>
        <span v-if="data" class="text-xs" :class="hasUpdate ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'">
          {{ hasUpdate ? '发现更新' : '无变化' }}
        </span>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
          :disabled="loading"
          @click="refresh"
        >
          <div class="i-carbon-renew" :class="{ 'animate-spin': loading }" />
          刷新
        </button>
        <button
          type="button"
          class="min-h-[40px] inline-flex items-center gap-1.5 border border-sky-500 rounded-lg bg-sky-600 px-3 py-2 text-sm text-white font-medium transition hover:bg-sky-700 disabled:opacity-50"
          :disabled="freezing || !data"
          @click="freeze"
        >
          <div class="i-carbon-checkmark" />
          {{ freezing ? '处理中…' : '以此为准' }}
        </button>
      </div>
    </div>

    <div v-if="!currentAccountId" class="py-12 text-center text-sm text-gray-400">
      请先选择账号
    </div>
    <LoadingState v-else-if="loading && !data" text="加载中…" />
    <div v-else-if="error" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
      {{ error }}
    </div>

    <div v-else-if="data" class="space-y-4">
      <!-- 概览 -->
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">采集账号</div>
          <div class="mt-1 text-xl font-semibold">{{ overview.sources?.length || 0 }}</div>
        </div>
        <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">接口总数</div>
          <div class="mt-1 text-xl font-semibold">{{ overview.interfaceCount || 0 }}</div>
        </div>
        <div class="rounded-lg border px-3 py-2" :class="newInterfaces.length ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20' : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'">
          <div class="text-xs text-gray-500">新接口</div>
          <div class="mt-1 text-xl font-semibold">{{ newInterfaces.length }}</div>
        </div>
        <div class="rounded-lg border px-3 py-2" :class="undefinedFields.length ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20' : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'">
          <div class="text-xs text-gray-500">未定义 body 字段</div>
          <div class="mt-1 text-xl font-semibold">{{ undefinedFields.length }}</div>
        </div>
      </div>

      <!-- 基线状态提示 -->
      <div
        v-if="!overview.hasBaseline"
        class="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-700 dark:border-sky-800 dark:bg-sky-900/20 dark:text-sky-300"
      >
        还没有基线 —— 当前所有接口都会被算作"新"。确认现在的游戏版本是正常的之后, 点右上角「以此为准」，
        之后就能只看真正的更新。
      </div>
      <div v-else class="text-xs text-gray-400">
        基线时间：{{ fmtTime(overview.baselineAt) }} · 基线接口 {{ overview.baselineInterfaces || 0 }} 个
      </div>

      <!-- 未定义字段告警 -->
      <section
        v-if="undefinedFields.length"
        class="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20"
      >
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold text-red-700 dark:text-red-300">
          <div class="i-carbon-warning" />
          这些子活动的数据体在 proto 里没有定义（新玩法，需要补 .proto）
        </h3>
        <div class="space-y-1">
          <div v-for="item in undefinedFields" :key="item.id" class="text-xs text-red-600 dark:text-red-300">
            <span class="font-mono">[{{ item.id }}]</span> {{ item.name }} → 字段
            <span class="font-mono">#{{ item.fields.join(', #') }}</span>
          </div>
        </div>
      </section>

      <!-- 新接口 -->
      <section
        v-if="newInterfaces.length"
        class="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20"
      >
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-300">
          <div class="i-carbon-add-alt" />
          基线之后新出现的接口
        </h3>
        <div class="space-y-1">
          <div v-for="key in newInterfaces" :key="key" class="font-mono text-xs text-amber-700 dark:text-amber-300">
            {{ key }}
          </div>
        </div>
      </section>

      <!-- Tab -->
      <div class="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          class="px-3 py-2 text-sm"
          :class="activeTab === 'activity' ? 'border-b-2 border-sky-500 font-medium text-sky-600' : 'text-gray-500'"
          @click="activeTab = 'activity'"
        >
          活动结构
        </button>
        <button
          type="button"
          class="px-3 py-2 text-sm"
          :class="activeTab === 'interfaces' ? 'border-b-2 border-sky-500 font-medium text-sky-600' : 'text-gray-500'"
          @click="activeTab = 'interfaces'"
        >
          接口清单 ({{ overview.interfaceCount || 0 }})
        </button>
      </div>

      <!-- 活动结构 -->
      <div v-if="activeTab === 'activity'" class="space-y-3">
        <div v-if="!groups.length" class="py-8 text-center text-sm text-gray-400">
          还没采到活动列表。账号登录后会自动拉一次 ActivityService.List。
        </div>
        <section
          v-for="g in groups"
          :key="g.id"
          class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
        >
          <h3 class="mb-2 flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            <div class="i-carbon-events text-sky-600" />
            {{ g.name }}
            <span class="font-mono text-xs text-gray-400 font-normal">{{ g.id }}</span>
            <span v-if="g.isNew" class="rounded bg-amber-100 px-1.5 text-xs font-normal text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">新</span>
            <span class="ml-auto text-xs text-gray-400 font-normal">
              {{ fmtTime(g.startTime * 1000) }} → {{ fmtTime(g.endTime * 1000) }}
            </span>
          </h3>
          <div class="space-y-1.5">
            <div
              v-for="c in g.children"
              :key="c.id"
              class="rounded border border-gray-100 px-2 py-1.5 text-xs dark:border-gray-700"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-gray-400">{{ c.id }}</span>
                <span class="text-gray-600 dark:text-gray-300">{{ c.name }}</span>
                <span class="text-gray-400">type={{ c.type }}</span>
                <span v-if="c.isNew" class="rounded bg-amber-100 px-1.5 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">新子活动</span>
              </div>
              <div class="mt-1 flex flex-wrap gap-1">
                <span
                  v-for="f in c.bodyFields"
                  :key="f.no"
                  class="rounded px-1.5 py-0.5 font-mono"
                  :class="f.defined
                    ? 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'"
                >
                  #{{ f.no }}{{ f.defined ? `=${f.name}` : ' 未定义' }}
                </span>
                <span v-if="!c.bodyFields.length" class="text-gray-400">无数据体</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <!-- 接口清单 -->
      <div v-else class="space-y-2">
        <input
          v-model="filter"
          type="text"
          placeholder="按接口名过滤，如 ActivityService / Notify"
          class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
        >
        <div class="max-h-[60vh] overflow-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table class="w-full text-left text-xs">
            <thead class="sticky top-0 bg-gray-50 dark:bg-gray-700">
              <tr>
                <th class="px-2 py-1.5 font-medium">
                  接口
                </th>
                <th class="px-2 py-1.5 text-right font-medium">
                  次数
                </th>
                <th class="px-2 py-1.5 font-medium">
                  新增字段
                </th>
                <th class="px-2 py-1.5 font-medium">
                  最后出现
                </th>
                <th class="px-2 py-1.5 font-medium">
                  字段树
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in rows"
                :key="r.key"
                class="border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40"
              >
                <td class="px-2 py-1.5 font-mono">
                  <span v-if="r.isNew" class="mr-1 rounded bg-amber-100 px-1 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">新</span>
                  {{ r.key }}
                </td>
                <td class="px-2 py-1.5 text-right text-gray-500">
                  {{ r.count }}
                  <span v-if="r.errors" class="ml-1 text-red-500">err{{ r.errors }}</span>
                </td>
                <td class="px-2 py-1.5 font-mono text-amber-600 dark:text-amber-400">
                  {{ r.newFields?.length ? `+${r.newFields.join(', +')}` : '' }}
                </td>
                <td class="px-2 py-1.5 whitespace-nowrap text-gray-400">
                  {{ fmtTime(r.lastSeenAt) }}
                </td>
                <td class="px-2 py-1.5">
                  <button
                    type="button"
                    class="rounded border border-sky-300 px-1.5 py-0.5 text-sky-600 transition hover:bg-sky-50 dark:border-sky-700 dark:text-sky-300 dark:hover:bg-sky-900/30"
                    @click="inspect(r.key)"
                  >
                    查看
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 字段树弹层: 用采集到的原始 hex 按裸 wire 现场解, 不依赖 .proto -->
      <div
        v-if="inspectResult || inspectError || inspectLoading"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
        @click="closeInspect"
      >
        <div class="max-h-[85vh] max-w-4xl w-full flex flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-800" @click.stop>
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 p-3 dark:border-gray-700">
            <h3 class="text-sm font-bold">
              字段树 · <span class="font-mono text-sky-600 dark:text-sky-300">{{ inspectKey }}</span>
            </h3>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded border px-2 py-1 text-xs"
                :class="inspectMode === 'tree' ? 'border-sky-400 bg-sky-50 text-sky-700 dark:bg-sky-900/30' : 'border-gray-300 text-gray-500'"
                @click="inspect(inspectKey, 'tree')"
              >
                结构
              </button>
              <button
                type="button"
                class="rounded border px-2 py-1 text-xs"
                :class="inspectMode === 'strings' ? 'border-sky-400 bg-sky-50 text-sky-700 dark:bg-sky-900/30' : 'border-gray-300 text-gray-500'"
                @click="inspect(inspectKey, 'strings')"
              >
                文案
              </button>
              <button type="button" class="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600" @click="closeInspect">
                关闭
              </button>
            </div>
          </div>
          <div class="flex-1 overflow-auto p-3">
            <div v-if="inspectLoading" class="py-10 text-center text-sm text-gray-400">
              解析中…
            </div>
            <div v-else-if="inspectError" class="py-10 text-center text-sm text-red-500">
              {{ inspectError }}
            </div>
            <div v-else-if="inspectResult" class="space-y-3">
              <div v-if="!inspectResult.decoded?.length" class="py-8 text-center text-sm text-gray-400">
                没有可用样本（该接口可能是空请求且未收到响应）
              </div>
              <div v-for="(d, i) in inspectResult.decoded" :key="d.key" class="space-y-1">
                <div class="text-xs text-gray-500">
                  {{ d.key }} · 采集 {{ d.count }} 次 · 样本 {{ d.sampleCount }} 条
                </div>
                <div
                  v-for="(s, j) in d.samples"
                  :key="j"
                  class="rounded border border-gray-200 p-2 dark:border-gray-700"
                >
                  <div class="mb-1 text-[11px] text-gray-400">
                    样本 {{ j + 1 }} · {{ s.accountId }} · {{ s.dir }} · {{ s.bytes }}B{{ s.truncated ? ' (截断)' : '' }}
                  </div>
                  <pre class="whitespace-pre-wrap break-all text-[11px] text-gray-700 leading-relaxed dark:text-gray-300">{{ (s.lines || []).join('\n') }}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
