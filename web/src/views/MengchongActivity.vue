<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
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
  opened: boolean        // 已点亮
  claimed: boolean       // 已领取奖励
  unlocked?: boolean     // 兼容字段 = opened
  photo: { photo?: string, say?: string } | null
}

interface PetState {
  growth: number
  petType: number
  stage: number
  adult?: boolean
  feedCount: number
  luckyStar?: number
  baseValue?: number
  items: { id: number, count: number, name: string }[]
  handnotes: Handnote[]
}

interface MengchongOverview {
  updatedAt: number
  active: boolean
  main: GroupInfo | null
  seedGift: (GroupInfo & { currentDay?: number, totalDays?: number, days?: SigninDay[] }) | null
  pet: PetState | null
  yuanqigao: number
  luckyStar: number
}

interface ShopItem {
  id: number
  name: string
  item: { id: number, count: number, name: string } | null
  cost: { id: number, amount: number, name: string } | null
  limit: number
  bought: number
  remaining: number | null
  order: number
  quality: number
  icon: string
}

const toast = useToastStore()
const loading = ref(false)
const busy = ref(false)
const overview = ref<MengchongOverview | null>(null)
const shopItems = ref<ShopItem[]>([])
const shopLuckyStar = ref(0)
const shopLoading = ref(false)
const rules = ref<{ uid: string, sections: { key: string, title: string, lines: string[] }[] } | null>(null)
const rulesOpen = ref(false)
const rulesLoading = ref(false)
// 说明里的关键数值 (摘自活动说明) — 便于对照操作
const CHALLENGE_TIERS = [
  { name: '初级挑战书', value: 50, win: 60, lose: 40 },
  { name: '中级挑战书', value: 150, win: 225, lose: 75 },
  { name: '高级挑战书', value: 300, win: 510, lose: 90 },
]

const active = computed(() => !!overview.value?.active)

// 状态里除元气糕/幸运星之外的额外道具 (避免与背包卡片重复)
const DUP_ITEM_IDS = [1028, 1029]
const otherPetItems = computed(() =>
  (overview.value?.pet?.items || []).filter((it: any) => !DUP_ITEM_IDS.includes(Number(it.id))),
)

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

async function loadOverview(): Promise<MengchongOverview | null> {
  loading.value = true
  try {
    const { data } = await api.get('/api/mengchong/overview')
    if (data?.ok) {
      overview.value = data.data
      return overview.value
    }
    toast.error(data?.error || '加载失败')
  } catch (e: any) {
    toast.error(extractError(e) || '加载失败')
  } finally {
    loading.value = false
  }
  return null
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

async function handleAutoFeed() {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/auto-feed')
    if (data?.ok) {
      const r = data.data || {}
      if (!r.feeds) {
        toast.info(`未投喂${r.stopped ? ` (${r.stopped})` : ''}`)
      } else {
        toast.success(`自动投喂 ${r.feeds} 次 (成长值 ${r.growth}, 幸运星 ${r.luckyStar}${r.petUnlocked ? `, 已解锁${r.petName || '比熊犬'}` : ''})`)
      }
      await loadOverview()
    } else {
      toast.error(data?.error || '自动投喂失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '自动投喂失败')
  } finally {
    busy.value = false
  }
}

async function handleClaimPet() {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/claim-pet')
    if (data?.ok) {
      toast.success(`已解锁 ${data.data?.name || '比熊犬'}`)
      await loadOverview()
    } else {
      toast.error(data?.error || '领取失败(可能尚未成年)')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '领取失败')
  } finally {
    busy.value = false
  }
}

async function handleUnlockHandnote(h: Handnote) {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/unlock-handnote', { handnoteId: h.id })
    const apiReason = data?.error || data?.data?.reason || ''
    // 不信任接口自述: 刷新后复核该手记是否真的点亮
    const fresh = await loadOverview()
    const after = fresh?.pet?.handnotes?.find(x => x.id === h.id)
    const reallyOpened = !!(after && (after.opened || after.unlocked))
    if (data?.ok && reallyOpened) {
      toast.success(`已点亮手记 ${h.id}`)
    } else {
      toast.warning(`手记 ${h.id} 尚不可点亮${apiReason ? ` (${apiReason})` : ''}`)
    }
  } catch (e: any) {
    toast.error(extractError(e) || '点亮失败')
  } finally {
    busy.value = false
  }
}

async function handleClaimHandnote(h: Handnote) {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/claim-handnote', { handnoteId: h.id })
    const apiReason = data?.error || data?.data?.reason || ''
    const awards = (data.data?.awards || []).map((i: any) => `${i.name}×${i.count}`).join('、')
    const fresh = await loadOverview()
    const after = fresh?.pet?.handnotes?.find(x => x.id === h.id)
    if (data?.ok && after?.claimed) {
      toast.success(`已领取手记 ${h.id} 奖励${awards ? ` → ${awards}` : ''}`)
    } else {
      toast.warning(`手记 ${h.id} 领取未生效${apiReason ? ` (${apiReason})` : ''}`)
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
      if (r.skipped === true) {
        toast.info('自动化开关未开启, 请先到设置中开启"萌宠游记每日任务"')
      } else {
        const parts = [`免费礼包 ${r.giftClaimed ? '已领' : '未领'}`, `手记奖励 ${r.handnoteClaims || 0} 个`]
        const skipList = Array.isArray(r.skipped) ? r.skipped : []
        toast.success(`已执行: ${parts.join(', ')}${skipList.length ? ` (跳过: ${skipList.join('、')})` : ''}`)
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

async function refreshAll() {
  await Promise.all([loadOverview(), fetchShop()])
}

async function fetchRules() {
  rulesLoading.value = true
  try {
    const { data } = await api.get('/api/mengchong/rules')
    if (data?.ok) rules.value = data.data
  } catch (e) { /* 说明加载失败不阻断 */ } finally {
    rulesLoading.value = false
  }
}

async function fetchShop() {
  shopLoading.value = true
  try {
    const { data } = await api.get('/api/mengchong/shop')
    if (data?.ok) {
      shopItems.value = Array.isArray(data.data?.items) ? data.data.items : []
      shopLuckyStar.value = Number(data.data?.luckyStar) || 0
    } else {
      toast.error(data?.error || '获取拾物小铺失败')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '获取拾物小铺失败')
  } finally {
    shopLoading.value = false
  }
}

async function handleExchange(g: ShopItem) {
  if (g.remaining !== null && g.remaining <= 0) {
    toast.warning(`${g.name} 已达兑换上限`)
    return
  }
  if (g.cost && shopLuckyStar.value > 0 && shopLuckyStar.value < g.cost.amount) {
    toast.warning(`幸运星不足 (需要 ${g.cost.amount}, 现有 ${shopLuckyStar.value})`)
    return
  }
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/shop-exchange', { goodsId: g.id, count: 1 })
    const reason = data?.error || data?.data?.reason || ''
    await fetchShop()
    if (data?.ok && data.data?.verified !== false && data.data?.ok !== false) {
      toast.success(`已兑换 ${g.name}${g.item ? ` → ${g.item.name}×${g.item.count}` : ''}`)
    } else {
      toast.warning(`兑换未生效${reason ? ` (${reason})` : ''}`)
    }
  } catch (e: any) {
    toast.error(extractError(e) || '兑换失败')
  } finally {
    busy.value = false
  }
}

async function handleTreasure() {
  busy.value = true
  try {
    const { data } = await api.post('/api/mengchong/treasure-hunt')
    const r = data?.data || {}
    if (data?.ok && r.verified !== false && r.ok !== false) {
      toast.success(`寻宝成功: 消耗元气糕 ${r.spentYuanqigao || 0}, 幸运星 +${r.gainedLuckyStar || 0} (已自动开始护送)`)
      await loadOverview()
      await fetchShop()
    } else {
      toast.warning(r.reason || data?.error || '寻宝未生效(命令待抓包确认)')
    }
  } catch (e: any) {
    toast.error(extractError(e) || '寻宝失败')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await loadOverview()
  await fetchShop()
  await fetchRules()
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
        <BaseButton variant="secondary" size="sm" :loading="loading || shopLoading" @click="refreshAll">
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
            每日免费稀有种子礼包:
            <span class="ml-2 text-gray-500">{{ fmtRange(overview.seedGift.startTime, overview.seedGift.endTime) }}</span>
          </div>
        </div>
      </div>

      <!-- 每日免费礼包 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">
          每日免费稀有种子礼包
          <span v-if="overview.seedGift?.currentDay" class="ml-2 text-xs text-gray-500">当前第 {{ overview.seedGift.currentDay }} 天</span>
        </h3>
        <p class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
          每日 0 点刷新一份免费稀有种子礼包(泡泡棉花糖种子/狗尾草种子等), 未领取可累计。开启"萌宠游记每日任务"后自动领取;
          与设置里的"千星游记自动点亮领取"是同一接口。
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
          <span class="ml-2 rounded px-1.5 py-0.5 text-xs" :class="overview.pet.adult ? 'bg-rose-50 text-rose-600 dark:bg-rose-900/30 dark:text-rose-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'">
            {{ overview.pet.adult ? '已成年' : '幼年' }}
          </span>
          <span v-if="overview.pet.feedCount" class="ml-2 text-xs text-gray-500">已投喂 {{ overview.pet.feedCount }} 次</span>
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
          <div class="rounded border border-gray-200 p-3 dark:border-gray-700">
            <div class="text-xs text-gray-500 dark:text-gray-400">幸运星(背包)</div>
            <div class="mt-1 text-xl font-bold">{{ fmtNum(overview.luckyStar) }}</div>
          </div>
          <div
            v-for="it in otherPetItems"
            :key="it.id"
            class="rounded border border-gray-200 p-3 dark:border-gray-700"
          >
            <div class="text-xs text-gray-500 dark:text-gray-400">{{ it.name }}</div>
            <div class="mt-1 text-xl font-bold">{{ fmtNum(it.count) }}</div>
          </div>
        </div>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          每次投喂消耗 700 萌宠元气糕 → 成长值 +700、幸运星 +100; 成长至成年后可解锁寻宝/夺宝并领取比熊犬。
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="busy || !overview.yuanqigao"
            :loading="busy"
            @click="handleFeed"
          >
            投喂一次
          </BaseButton>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="busy || !overview.yuanqigao"
            :loading="busy"
            @click="handleAutoFeed"
          >
            自动投喂(用完为止)
          </BaseButton>
          <BaseButton
            v-if="overview.pet.adult"
            variant="primary"
            size="sm"
            :disabled="busy"
            :loading="busy"
            @click="handleClaimPet"
          >
            领取比熊犬
          </BaseButton>
        </div>
      </div>

      <!-- 爪印手记 -->
      <div v-if="overview.pet && overview.pet.handnotes && overview.pet.handnotes.length" class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          爪印手记
          <span class="ml-2 text-xs text-gray-500">按进度依次开放; 开启"萌宠游记每日任务"后自动点亮+领取</span>
        </h3>
        <div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <div
            v-for="h in overview.pet.handnotes"
            :key="h.id"
            class="flex flex-col rounded border p-3 text-sm dark:border-gray-700"
            :class="h.claimed
              ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20'
              : (h.opened || h.unlocked)
                ? 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-900/20'
                : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40'"
          >
            <span class="font-medium">手记 {{ h.id }}</span>
            <span class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
              <template v-if="h.claimed">
                已领取
              </template>
              <template v-else-if="h.opened || h.unlocked">
                已点亮 · 可领取
              </template>
              <template v-else>
                未点亮
              </template>
            </span>
            <BaseButton
              v-if="(h.opened || h.unlocked) && !h.claimed"
              class="mt-2"
              variant="primary"
              size="sm"
              :disabled="busy"
              :loading="busy"
              @click="handleClaimHandnote(h)"
            >
              领取
            </BaseButton>
            <BaseButton
              v-else-if="!(h.opened || h.unlocked)"
              class="mt-2"
              variant="secondary"
              size="sm"
              :disabled="busy"
              :loading="busy"
              @click="handleUnlockHandnote(h)"
            >
              点亮
            </BaseButton>
          </div>
        </div>
      </div>

      <!-- 31 天种子礼包 -->
      <div v-if="overview.seedGift && overview.seedGift.days && overview.seedGift.days.length" class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="mb-3 text-sm text-gray-900 font-medium dark:text-white">
          种子礼包 31 天进度
          <span v-if="overview.seedGift.currentDay" class="ml-2 text-xs text-gray-500">当前第 {{ overview.seedGift.currentDay }} 天</span>
        </h3>
        <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">
          每日领取一份稀有种子, 未领取可累计保留。
        </p>
        <div class="grid grid-cols-4 gap-2 md:grid-cols-8 lg:grid-cols-10">
          <div
            v-for="d in overview.seedGift.days"
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

      <!-- 拾物小铺 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm text-gray-900 font-medium dark:text-white">
            拾物小铺
            <span class="ml-2 text-xs text-gray-500">消耗幸运星兑换</span>
          </h3>
          <div class="text-sm text-gray-600 dark:text-gray-300">
            幸运星: <span class="font-bold text-amber-600 dark:text-amber-400">{{ fmtNum(shopLuckyStar) }}</span>
          </div>
        </div>
        <div v-if="!shopItems.length && !shopLoading" class="text-xs text-gray-500 dark:text-gray-400">
          暂无可兑换商品
        </div>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div
            v-for="g in shopItems"
            :key="g.id"
            class="flex flex-col rounded border p-3 dark:border-gray-700"
            :class="(g.remaining !== null && g.remaining <= 0)
              ? 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40'
              : 'border-gray-200 dark:border-gray-700'"
          >
            <div class="flex items-start justify-between gap-2">
              <span class="text-sm font-medium">{{ g.name }}</span>
              <span v-if="g.remaining !== null" class="shrink-0 text-xs text-gray-500">
                {{ g.remaining > 0 ? `可兑 ${g.remaining}` : '已兑完' }}
              </span>
            </div>
            <div class="mt-1 flex-1 text-xs text-gray-500 dark:text-gray-400">
              {{ g.item ? `${g.item.name} ×${g.item.count}` : '' }}
            </div>
            <div class="mt-2 flex items-center justify-between gap-2">
              <span class="text-sm text-amber-600 dark:text-amber-400">
                {{ g.cost ? `${fmtNum(g.cost.amount)} ${g.cost.name}` : '免费' }}
              </span>
              <BaseButton
                variant="primary"
                size="sm"
                :disabled="busy || (g.remaining !== null && g.remaining <= 0)"
                :loading="busy"
                @click="handleExchange(g)"
              >
                {{ (g.remaining !== null && g.remaining <= 0) ? '已兑完' : '兑换' }}
              </BaseButton>
            </div>
          </div>
        </div>
      </div>

      <!-- 寻宝 -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">
          比熊寻宝
        </h3>
        <div class="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400">
          <div>· 前置条件: 比熊<b>成年</b>, 每次消耗萌宠元气糕 (每日寻宝次数有限)</div>
          <div>· 必定获得: 幸运星 + 待护送宝藏 + 挑战书</div>
          <div>· 获得宝藏后<b>自动开启护送</b> (无需手动激活), 单次护送 4 小时</div>
          <div>· 宝藏初始价值 350 幸运星 = 50 保底(不可掠夺) + 300 博弈资金; 博弈资金达 500 触发爆仓满载结算</div>
        </div>
        <BaseButton
          class="mt-3"
          variant="primary"
          size="sm"
          :disabled="busy || !overview.yuanqigao || !(overview.pet && overview.pet.adult)"
          :loading="busy"
          @click="handleTreasure"
        >
          {{ !(overview.pet && overview.pet.adult) ? '比熊未成年' : (overview.yuanqigao ? '寻宝一次' : '元气糕不足') }}
        </BaseButton>
      </div>

      <!-- 夺宝参考 (来自活动说明) -->
      <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 class="text-sm text-gray-900 font-medium dark:text-white">
          夺宝参考
          <span class="ml-2 text-xs text-gray-500">消耗 1 张挑战书向好友护送中的宝藏发起夺宝, 每日最多 20 次</span>
        </h3>
        <div class="mt-3 overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-left text-gray-500 dark:text-gray-400">
                <th class="py-1 pr-4 font-normal">
                  挑战书
                </th>
                <th class="py-1 pr-4 font-normal">
                  价值
                </th>
                <th class="py-1 pr-4 font-normal">
                  胜利可得
                </th>
                <th class="py-1 font-normal">
                  失败可得
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in CHALLENGE_TIERS" :key="t.name" class="border-t border-gray-100 dark:border-gray-700">
                <td class="py-1 pr-4">
                  {{ t.name }}
                </td>
                <td class="py-1 pr-4">
                  {{ t.value }} 幸运星
                </td>
                <td class="py-1 pr-4 text-rose-600 dark:text-rose-400">
                  {{ t.win }}
                </td>
                <td class="py-1 text-gray-500">
                  {{ t.lose }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          需满足: 好友宝藏护送中、其博弈资金高于所选挑战书价值、其遭夺宝次数 &lt; 3 次; 连续 3 次失败会触发「夺宝安慰礼」返还幸运星。
        </p>
      </div>
      <!-- 玩法说明 (摘自活动内说明) -->
      <div v-if="rules && rules.sections.length" class="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <button
          class="flex w-full items-center justify-between p-4 text-left"
          @click="rulesOpen = !rulesOpen"
        >
          <span class="text-sm text-gray-900 font-medium dark:text-white">
            玩法说明
            <span class="ml-2 text-xs text-gray-500 font-normal">活动内原文 (寻宝 / 护送 / 夺宝 / 锦囊)</span>
          </span>
          <span class="text-xs text-gray-500">{{ rulesOpen ? '收起' : '展开' }}</span>
        </button>
        <div v-if="rulesOpen" class="space-y-4 border-t border-gray-100 px-4 pb-4 pt-3 dark:border-gray-700">
          <div v-for="sec in rules.sections" :key="sec.key">
            <h4 class="mb-1 text-xs text-gray-900 font-bold dark:text-white">
              {{ sec.title }}
            </h4>
            <div class="space-y-0.5 text-xs leading-5 text-gray-600 dark:text-gray-300">
              <div v-for="(line, i) in sec.lines" :key="i" class="whitespace-pre-wrap">
                {{ line }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
