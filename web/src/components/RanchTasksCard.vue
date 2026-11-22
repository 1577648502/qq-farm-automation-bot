<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

// 牧场任务卡片 —— 2026-11-22 从 Ranch.vue 的「牧场任务」页签抽出来,
// 合并到「我的」页面的任务页签(与农场任务面板并列展示)。
// 牧场任务与农场任务完全独立(服务端按 scene_id=2 拉取)。
// 日常自动流程已包含领取, 这里是手动补领入口。

const accountStore = useAccountStore()
const toast = useToastStore()
const { currentAccountId } = storeToRefs(accountStore)

const loading = ref(false)
const error = ref('')
const tasks = ref<any[]>([])
const claiming = ref(false)

async function reload() {
  const id = currentAccountId.value
  if (!id)
    return
  loading.value = true
  error.value = ''
  try {
    const res = await api.get('/api/ranch/tasks', { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '获取牧场任务失败')
    tasks.value = d.data?.tasks || []
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '获取牧场任务失败'
  }
  finally {
    loading.value = false
  }
}

async function claimAll() {
  const id = currentAccountId.value
  if (!id || claiming.value)
    return
  claiming.value = true
  try {
    const res = await api.post('/api/ranch/tasks/claim', {}, { headers: { 'x-account-id': id } })
    const d = res.data
    if (!d?.ok)
      throw new Error(d?.error || '领取失败')
    const r = d.data || {}
    if (r.claimed > 0)
      toast.success(`已领取 ${r.claimed} 个牧场任务`)
    else
      toast.info(r.claimable > 0 ? '可领任务正在处理，请稍后刷新' : '当前没有可领取的牧场任务')
    await reload()
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || e?.message || '领取失败')
  }
  finally {
    claiming.value = false
  }
}

const claimableCount = computed(() => tasks.value.filter(t => t.canClaim).length)

onMounted(reload)
</script>

<template>
  <div class="rounded-lg bg-white shadow dark:bg-gray-800">
    <div class="border-b border-gray-100 p-3 dark:border-gray-700 sm:p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="flex items-center gap-2 text-lg font-bold">
          <div class="i-carbon-task text-xl text-sky-500" />
          牧场任务
          <span v-if="tasks.length" class="text-xs text-gray-400 font-normal">
            可领 {{ claimableCount }} / 共 {{ tasks.length }}
          </span>
        </h3>
        <div class="flex gap-2">
          <BaseButton variant="secondary" size="sm" :loading="loading" @click="reload">
            <span class="i-carbon-renew mr-1" />刷新
          </BaseButton>
          <BaseButton size="sm" :disabled="claiming || claimableCount === 0" @click="claimAll">
            <span class="i-carbon-gift mr-1" />
            {{ claiming ? '领取中…' : '一键领取' }}
          </BaseButton>
        </div>
      </div>
      <p class="mt-1 text-xs text-gray-400">
        牧场任务与农场任务完全独立（服务端按 scene_id=2 拉取）。日常自动流程已包含领取，这里是手动补领。
      </p>
    </div>
    <div class="p-3 sm:p-4">
      <LoadingState v-if="loading && !tasks.length" />
      <div v-else-if="error" class="border border-red-200 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20">
        {{ error }}
      </div>
      <div v-else-if="!tasks.length" class="py-10 text-center text-sm text-gray-400">
        暂无牧场任务（可能等级不足，或服务端未下发）
      </div>
      <div v-else class="space-y-1.5">
        <div
          v-for="t in tasks"
          :key="t.id"
          class="flex flex-wrap items-center gap-2 border rounded px-2.5 py-2 text-xs"
          :class="t.canClaim
            ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20'
            : 'border-gray-100 dark:border-gray-700'"
        >
          <span class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
            {{ t.typeLabel }}
          </span>
          <span class="min-w-0 flex-1 text-gray-700 dark:text-gray-200">{{ t.desc }}</span>
          <span class="text-gray-400">{{ t.progress }}/{{ t.totalProgress }}</span>
          <span v-if="t.rewardText" class="text-emerald-600 dark:text-emerald-400">{{ t.rewardText }}</span>
          <span
            class="shrink-0"
            :class="t.isClaimed
              ? 'text-green-600 dark:text-green-400'
              : (t.canClaim ? 'text-amber-600 font-medium dark:text-amber-400' : 'text-gray-400')"
          >
            {{ t.isClaimed ? '已领取' : (t.canClaim ? '可领取' : '进行中') }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
