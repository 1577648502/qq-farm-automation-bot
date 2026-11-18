<script setup lang="ts">
import { computed, ref } from 'vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'

const props = defineProps<{
  dailyGifts: any
  /** 当前账号, 手动领取时带上(不传则用全局 x-account-id) */
  accountId?: string
}>()

const toast = useToastStore()
const claimingKey = ref('')

/**
 * 只有"支持手动补领"的礼包才显示按钮。
 * 其余(邮箱/分享/会员/月卡)走各自的游戏侧流程, 强行提供按钮只会发出必然失败的请求。
 */
const MANUAL_CLAIMABLE = new Set(['red_packet_daily'])

function canManualClaim(gift: any) {
  return !!gift && MANUAL_CLAIMABLE.has(gift.key) && !gift.doneToday
}

async function manualClaim(gift: any) {
  if (!gift || claimingKey.value)
    return
  claimingKey.value = gift.key
  try {
    const headers: Record<string, string> = {}
    const id = String(props.accountId || '').trim()
    if (id)
      headers['x-account-id'] = id
    const res = await api.post('/api/red-packet/claim', {}, { headers })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '领取失败')
    if (d.data?.claimed)
      toast.success('红包领取成功')
    else
      toast.info('当前没有可领取的红包')
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '领取失败')
  }
  finally {
    claimingKey.value = ''
  }
}

const GIFT_ICONS: Record<string, string> = {
  task_claim: 'i-carbon-task-complete',
  email_rewards: 'i-carbon-email',
  mall_free_gifts: 'i-carbon-shopping-bag',
  daily_share: 'i-carbon-share',
  vip_daily_gift: 'i-carbon-star',
  month_card_gift: 'i-carbon-calendar',
  red_packet_daily: 'i-carbon-piggy-bank',
}

function getGiftIcon(key: string) {
  return GIFT_ICONS[key] || 'i-carbon-gift'
}

const hasDailyData = computed(() => !!props.dailyGifts)
const gifts = computed(() => props.dailyGifts?.gifts || [])

function formatTime(timestamp: number) {
  if (!timestamp)
    return '未领取'
  const d = new Date(timestamp)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function getGiftStatusText(gift: any) {
  if (!gift)
    return '未知'
  if (gift.key === 'vip_daily_gift' && gift.hasGift === false)
    return '未开通'
  if (gift.key === 'month_card_gift' && gift.hasCard === false)
    return '未开通'
  if (gift.doneToday)
    return '今日已完成'
  if (gift.enabled)
    return '等待执行'
  return '未开启'
}

function formatGiftSubText(gift: any) {
  if (!gift)
    return ''
  if (gift.key === 'vip_daily_gift' && gift.hasGift === false)
    return '未开通QQ会员或无每日礼包'
  if (gift.key === 'month_card_gift' && gift.hasCard === false)
    return '未购买月卡或已过期'
  // 红包特有: 上次检测到几个可领, 让用户知道"现在点有没有用"
  if (gift.key === 'red_packet_daily' && !gift.doneToday && Number(gift.claimableCount) > 0)
    return `${gift.claimableCount} 个待领取`
  const ts = Number(gift.lastAt || 0)
  if (!ts)
    return ''
  if (gift.doneToday)
    return `完成时间 ${formatTime(ts)}`
  if (gift.enabled)
    return `上次执行 ${formatTime(ts)}`
  return `上次检测 ${formatTime(ts)}`
}

function formatGiftProgress(gift: any) {
  if (!gift)
    return ''
  const total = Number(gift.totalCount || 0)
  const current = Number(gift.completedCount || 0)
  if (!total)
    return ''
  return `进度：${current}/${total}`
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Daily Gifts Grid -->
    <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
      <h3 class="mb-3 flex items-center gap-2 font-medium">
        <div class="i-carbon-gift text-pink-500" />
        <span>每日礼包 & 任务</span>
      </h3>

      <div
        v-if="!hasDailyData"
        class="rounded-lg bg-gray-50 p-6 text-center text-sm text-gray-500 dark:bg-gray-900/40 dark:text-gray-400"
      >
        请登录账号后查看
      </div>
      <div
        v-else-if="!gifts.length"
        class="rounded-lg bg-gray-50 p-6 text-center text-sm text-gray-500 dark:bg-gray-900/40 dark:text-gray-400"
      >
        暂无每日礼包与任务数据
      </div>
      <div v-else class="grid grid-cols-2 gap-3 2xl:grid-cols-3 sm:grid-cols-3 2xl:gap-4">
        <div
          v-for="gift in gifts"
          :key="gift.key"
          class="flex flex-col justify-between border border-gray-100 rounded-lg p-3 dark:border-gray-700 2xl:p-4"
        >
          <div class="mb-2 flex items-center gap-2">
            <div
              class="h-7 w-7 flex flex-shrink-0 items-center justify-center rounded-md 2xl:h-8 2xl:w-8"
              :class="gift.doneToday ? 'bg-green-100 dark:bg-green-900/30' : (gift.enabled ? 'bg-blue-100 dark:bg-blue-900/30' : 'bg-gray-100 dark:bg-gray-700')"
            >
              <div
                class="text-base 2xl:text-lg"
                :class="[getGiftIcon(gift.key), gift.doneToday ? 'text-green-500' : (gift.enabled ? 'text-blue-500' : 'text-gray-400')]"
              />
            </div>
            <span class="text-sm text-gray-700 font-medium leading-tight 2xl:text-base dark:text-gray-300">
              {{ gift.label }}
            </span>
          </div>

          <div class="flex items-end justify-between">
            <span
              class="text-xs 2xl:text-sm"
              :class="gift.doneToday ? 'text-green-500' : (gift.enabled ? 'text-blue-500' : 'text-gray-400')"
            >
              {{ getGiftStatusText(gift) }}
            </span>

            <div class="flex flex-col items-end">
              <span v-if="formatGiftProgress(gift)" class="text-xs text-gray-500 font-bold 2xl:text-sm">
                {{ formatGiftProgress(gift) }}
              </span>
              <span
                v-if="formatGiftSubText(gift)"
                class="mt-0.5 text-[10px] text-gray-400 2xl:text-xs"
              >
                {{ formatGiftSubText(gift) }}
              </span>
            </div>
          </div>

          <!-- 手动补领: 只有红包支持(自动任务里已默认领, 这里给个即时入口) -->
          <button
            v-if="canManualClaim(gift)"
            type="button"
            class="mt-2 w-full border border-rose-200 rounded-md bg-rose-50 py-1 text-[11px] text-rose-600 font-medium transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300"
            :disabled="!!claimingKey"
            @click="manualClaim(gift)"
          >
            {{ claimingKey === gift.key ? '领取中…' : '立即领取' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
