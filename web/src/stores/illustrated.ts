import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface IllustratedItem {
  seedId: number
  unlockStatus: number
  planted: boolean
  plantedCount: number
  harvestCount: number
  hasReward: boolean
  rewardClaimed?: boolean
  canClaim?: boolean
  reward?: { itemId: number, count: number } | null
  name?: string
  image?: string
}

export const useIllustratedStore = defineStore('illustrated', () => {
  const items = ref<IllustratedItem[]>([])
  const total = ref(0)
  const unlocked = ref(0)
  const claimable = ref(0)
  const loading = ref(false)

  const unlockedItems = computed(() => items.value.filter(i => i.planted))
  const lockedItems = computed(() => items.value.filter(i => !i.planted))
  const claimableItems = computed(() => items.value.filter(i => i.canClaim))

  function clear() {
    items.value = []
    total.value = 0
    unlocked.value = 0
    claimable.value = 0
  }

  async function fetchIllustrated(accountId: string) {
    if (!accountId)
      return
    const requestedId = accountId
    loading.value = true
    try {
      const res = await api.get('/api/illustrated', {
        headers: { 'x-account-id': accountId },
      })
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId !== requestedId)
        return
      if (res.data.ok && res.data.data) {
        const d = res.data.data
        items.value = Array.isArray(d.items) ? d.items : []
        total.value = Number(d.total) || items.value.length
        unlocked.value = Number(d.unlocked) || 0
        claimable.value = Number(d.claimable) || 0
      }
      else {
        clear()
      }
    }
    catch (e) {
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId === requestedId)
        clear()
      console.error('获取图鉴失败', e)
    }
    finally {
      loading.value = false
    }
  }

  async function claimRewards(accountId: string) {
    const res = await api.post('/api/illustrated/claim', {}, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }

  return {
    items,
    total,
    unlocked,
    claimable,
    loading,
    unlockedItems,
    lockedItems,
    claimableItems,
    fetchIllustrated,
    claimRewards,
    clear,
  }
})
