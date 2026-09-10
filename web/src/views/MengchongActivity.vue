<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useToastStore } from '@/stores/toast'

interface SigninItem {
  id: number
  count: number
  name: string
}

interface SigninDay {
  day: number
  unlocked: boolean
  claimed: boolean
  items: SigninItem[]
}

interface GroupInfo {
  id: number
  name: string
  type: number
  startTime: number
  endTime: number
  ruleTitle?: string
}

interface Handnote {
  id: number
  unlocked: boolean
  claimed: boolean
  photo: { photo?: string, say?: string } | null
}

interface PetState {
  growth: number
  petType: number
  baseValue?: number
  items: { id: number, count: number, name: string }[]
  handnotes: Handnote[]
}

interface MengchongOverview {
  updatedAt: number
  active: boolean
  main: GroupInfo | null
  signin: (GroupInfo & { currentDay?: number; totalDays?: number; days?: SigninDay[] }) | null
  seedGift: GroupInfo | null
  pet: PetState | null
  yuanqigao: number
}

const toast = useToastStore()
const loading = ref(false)
const busy = ref(false)
const overview = ref<MengchongOverview | null>(null)

// 高级操作
const opCmd = ref<number>(27)
const opGid = ref<string>('')
const opHex = ref<string>('')
const opResult = ref<string>('')
const opBusy = ref(false)

const active = computed(() => !!overview.value?.active)

function fmtTime(sec: number) {
  if (!sec) return '-'
  const d = new Date(sec * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtRange(begin: number, end: number) {
  return `${fmtTime(begin)} ~ ${fmtTime(end)}`
}

function fmtNum(n: number) {
  return (Number(n) || 0).toLocaleString('zh-CN')
}

function extractError(e: any): string {
  return e?.response?.data?.error || e?.message || ''
}

async function loadOverview() {
  loading.value = true
  try {
    const { data } = await api.get('/api/mengchong/overview')
    if (data?.ok) {
      overview.value = data.data
    } else {
      toast.error(data?.error || '加载失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '加载失败')
  } finally {
    loading.value = false
  }
}

async function handleClaimGift() {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/claim-free-gift')
    if (data?.ok) {
      toast.success('免费稀有种子礼包领取成功')
      await loadOverview()
    } else {
      toast.error(data?.error || '领取失败(可能今日已领)')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '领取失败')
  } finally {
    busy.value = false
  }
}

async function handleFeed() {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/feed')
    if (data?.ok) {
      const r = data.data || {}
      const gains = (r.items || []).map((i: any) => `${i.name}×${i.count}`).join('、')
      toast.success(`投喂成功${gains ? ` → ${gains}` : ''}`)
      await loadOverview()
    } else {
      toast.error(data?.error || '投喂失败(可能元气糕不足)')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '投喂失败')
  } finally {
    busy.value = false
  }
}

async function handleClaimHandnote(h: Handnote) {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/claim-handnote', { handnoteId: h.id })
    if (data?.ok) {
      const awards = (data.data?.awards || []).map((i: any) => `${i.name}×${i.count}`).join('、')
      toast.success(`已领取手记 ${h.id} 奖励${awards ? ` → ${awards}` : ''}`)
      await loadOverview()
    } else {
      toast.error(data?.error || '领取失败(可能已领取)')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '领取失败')
  } finally {
    busy.value = false
  }
}

async function handleRunNow() {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/run-now')
    if (data?.ok) {
      const r = data.data || {}
      if (r.skipped) {
        toast.info('自动化开关未开启, 请先到设置中开启"萌宠游记每日任务"')
      } else {
        toast.success(`已执行: 免费礼包 ${r.giftClaimed ? '是' : '否'}, 手记奖励 ${r.handnoteClaims || 0} 个`)
      }
      await loadOverview()
    } else {
      toast.error(data?.error || '执行失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '执行失败')
  } finally {
    busy.value = false
  }
}

async function handleOperate() {
  opBusy.value = true
  opResult.value = ''
  try {
    const payload: any = { cmd: opCmd.value }
    if (opHex.value.trim()) {
      payload.payloadHex = opHex.value.trim()
    } else if ((opCmd.value === 47 || opCmd.value === 32) && opGid.value) {
      payload.payloadVarints = [Number(opGid.value)]
    }
    const { data } = await api.post('/api/mengchong/operate', payload)
    if (data?.ok) {
      opResult.value = JSON.stringify(data.data?.result || {}, null, 1)
      toast.success('操作已发送 (err=0)')
      await loadOverview()
    } else {
      opResult.value = data?.error || '操作失败'
      toast.error(opResult.value)
    }
  } catch (e: any) {
    opResult.value = extractError(e) || '操作失败'
    toast.error(opResult.value)
  } finally {
    opBusy.value = false
  }
}

onMounted(async () => {
  await loadOverview()
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-4 p-4">
    <!-- 标题 -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl text-gray-900 font-bold dark:text-white">
          萌宠游记
        </h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          S3 比熊萌宠 · 养成寻宝 · 比熊赠礼 · 每日免费种子礼包
        </p>
      </div>
      <div class="flex gap-2">
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="loadOverview">
          刷新
        </BaseButton>
        <BaseButton variant="primary" size="sm" :loading="busy" @click="handleRunNow">
          执行每日任务
        </BaseButton>
      </div>
    </div>

    <!-- 未开启提示 -->
    <div v-if="!active && !loading" class="rounded border border-yellow-300 bg-yellow-50 p-4 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200">
      活动未开启或已结束。
    </div>

    <template v-if="active && overview">
      <!-- 活动信息 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-2 text-sm text-gray-900 font-medium dark:text-white">
          活动信息
        </h3>
        <div class="space-y-1 text-sm text-gray-600 dark:text-gray-300">
          <div v-if="overview.main">
            <span class="font-medium">{{ overview.main.name }}</span>
            <span class="ml-2 text-gray-500">{{ fmtRange(overview.main.startTime, overview.main.endTime) }}</span>
          </div>
          <div v-if="overview.seedGift">
            免费种子礼包: <span class="font-medium">{{ overview.seedGift.name }}</span>
            <span class="ml-2 text-gray-500">{{ fmtRange(overview.seedGift.startTime, overview.seedGift.endTime) }}</span>
          </div>
          <div v-if="overview.signin">
            比熊赠礼: <span class="font-medium">{{ overview.signin.name }}</span>
            <span class="ml-2 text-gray-500">{{ fmtRange(overview.signin.startTime, overview.signin.endTime) }}</span>
          </div>
        </div>
      </div>

      <!-- 每日免费礼包 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">
          每日免费稀有种子礼包
        </h3>
        <p class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
          每日 0 点刷新一份免费稀有种子礼包, 未领取可累计保留。开启"萌宠游记每日任务"后自动领取。
        </p>
        <BaseButton
          class="mt-3"
          variant="primary"
          size="sm"
          :disabled="busy"
          :loading="busy"
          @click="handleClaimGift"
        >
          领取礼包
        </BaseButton>
      </div>

      <!-- 比熊宠物 + 投喂 -->
      <div v-if="overview.pet" class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-2 text-sm text-gray-900 font-medium dark:text-white">
          比熊萌宠
        </h3>
        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div class="rounded border border-gray-200 p-3 dark:border-gray-700">
            <div class="text-xs text-gray-500 dark:text-gray-400">成长值</div>
            <div class="mt-1 text-xl font-bold">{{ fmtNum(overview.pet.growth) }}</div>
          </div>
          <div class="rounded border border-gray-200 p-3 dark:border-gray-700">
            <div class="text-xs text-gray-500 dark:text-gray-400">元气糕(背包)</div>
            <div class="mt-1 text-xl font-bold">{{ fmtNum(overview.yuanqigao) }}</div>
          </div>
          <div
            v-for="it in overview.pet.items"
            :key="it.id"
            class="rounded border border-gray-200 p-3 dark:border-gray-700"
          >
            <div class="text-xs text-gray-500 dark:text-gray-400">{{ it.name }}</div>
            <div class="mt-1 text-xl font-bold">{{ fmtNum(it.count) }}</div>
          </div>
        </div>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          投喂消耗背包中的萌宠元气糕, 比熊成长至成年后解锁寻宝/夺宝。
        </p>
        <BaseButton
          class="mt-3"
          variant="primary"
          size="sm"
          :disabled="busy || !overview.yuanqigao"
          :loading="busy"
          @click="handleFeed"
        >
          {{ overview.yuanqigao ? '投喂比熊' : '元气糕不足' }}
        </BaseButton>
      </div>

      <!-- 爪印手记 -->
      <div v-if="overview.pet && overview.pet.handnotes && overview.pet.handnotes.length" class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          爪印手记
        </h3>
        <div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <div
            v-for="h in overview.pet.handnotes"
            :key="h.id"
            class="flex flex-col rounded border p-3 text-sm dark:border-gray-700"
            :class="h.claimed
              ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20'
              : h.unlocked
                ? 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-900/20'
                : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40'"
          >
            <span class="font-medium">手记 {{ h.id }}</span>
            <span class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
              <template v-if="h.claimed">
                已领取
              </template>
              <template v-else-if="h.unlocked">
                可领取
              </template>
              <template v-else>
                未解锁
              </template>
            </span>
            <BaseButton
              v-if="h.unlocked && !h.claimed"
              class="mt-2"
              variant="primary"
              size="sm"
              :disabled="busy"
              :loading="busy"
              @click="handleClaimHandnote(h)"
            >
              领取
            </BaseButton>
          </div>
        </div>
      </div>

      <!-- 比熊赠礼 -->
      <div v-if="overview.signin && overview.signin.days && overview.signin.days.length" class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          比熊赠礼 (31 天累计奖励)
          <span v-if="overview.signin.currentDay" class="ml-2 text-xs text-gray-500">当前第 {{ overview.signin.currentDay }} 天</span>
        </h3>
        <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">
          领取走"千星游记"通用通道, 可在设置中开启"千星游记自动点亮领取"自动领取。
        </p>
        <div class="grid grid-cols-4 gap-2 md:grid-cols-8 lg:grid-cols-10">
          <div
            v-for="d in overview.signin.days"
            :key="d.day"
            class="rounded border p-2 text-center text-xs dark:border-gray-700"
            :class="d.claimed
              ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20'
              : d.unlocked
                ? 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-900/20'
                : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40'"
          >
            <div class="font-medium">
              第{{ d.day }}天
            </div>
            <div class="mt-1 text-gray-500 dark:text-gray-400">
              {{ d.items.map(i => `${i.name}×${i.count}`).join(' ') || '-' }}
            </div>
            <div class="mt-1">
              <span v-if="d.claimed" class="text-green-600 dark:text-green-400">已领</span>
              <span v-else-if="d.unlocked" class="text-rose-600 dark:text-rose-400">可领</span>
              <span v-else class="text-gray-400">未开放</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 萌宠操作 (待确认语义) -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">
          萌宠操作
        </h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          投喂/领取手记已有专用按钮; 这里保留原始命令入口(按抓包推断): 27 打开/刷新, 31 寻宝, 47 好友操作(填 gid), 49 翻看手记。
        </p>
        <div class="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label class="mb-1 block text-xs text-gray-500">命令</label>
            <select v-model.number="opCmd" class="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900">
              <option :value="27">
                27 · 打开/刷新
              </option>
              <option :value="29">
                29 · 投喂
              </option>
              <option :value="31">
                31 · 寻宝(推测)
              </option>
              <option :value="32">
                32 · 领手记奖励
              </option>
              <option :value="47">
                47 · 好友操作(推测)
              </option>
              <option :value="49">
                49 · 翻看手记
              </option>
            </select>
          </div>
          <div v-if="opCmd === 47">
            <label class="mb-1 block text-xs text-gray-500">好友 gid</label>
            <BaseInput v-model="opGid" placeholder="好友 gid" class="w-48" />
          </div>
          <div v-if="opCmd === 32">
            <label class="mb-1 block text-xs text-gray-500">手记 id</label>
            <BaseInput v-model="opGid" placeholder="手记 id" class="w-32" />
          </div>
          <div>
            <label class="mb-1 block text-xs text-gray-500">payload(hex, 可选)</label>
            <BaseInput v-model="opHex" placeholder="如 0a0101" class="w-40" />
          </div>
          <BaseButton variant="primary" size="sm" :loading="opBusy" @click="handleOperate">
            发送
          </BaseButton>
        </div>
        <pre v-if="opResult" class="mt-3 max-h-48 overflow-auto rounded bg-gray-100 p-2 text-xs dark:bg-gray-900">{{ opResult }}</pre>
      </div>
    </template>
  </div>
</template>
