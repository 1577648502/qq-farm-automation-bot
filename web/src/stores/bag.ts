import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export const useBagStore = defineStore('bag', () => {
  const allItems = ref<any[]>([])
  const originalItems = ref<any[]>([])
  const loading = ref(false)

  function clearBag() {
    allItems.value = []
    originalItems.value = []
  }

  const items = computed(() => {
    const hiddenIds = new Set([1, 1001, 1002, 1101, 1011, 1012, 3001, 3002])
    const hiddenTypes = new Set([18])
    return allItems.value.filter((it: any) =>
      !hiddenIds.has(Number(it.id || 0))
      && !hiddenTypes.has(Number(it.itemType || 0)),
    )
  })

  const dashboardItems = computed(() => {
    const targetIds = new Set([1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => targetIds.has(Number(it.id || 0)))
  })

  /**
   * 牧场罐头桶(7003 普通 / 7004 有机)。
   * ⚠ 它们只出现在**牧场背包**(GetBag{scene:2}), 农场背包(/api/bag)里没有,
   *   所以要单独拉 /api/ranch/bag。count 就是桶里剩余秒数。
   */
  const ranchBucketItems = ref<any[]>([])
  const ranchBucketLoading = ref(false)

  async function fetchRanchBuckets(accountId: string) {
    if (!accountId)
      return
    ranchBucketLoading.value = true
    try {
      const res = await api.get('/api/ranch/bag', { headers: { 'x-account-id': accountId } })
      const items = Array.isArray(res.data?.data?.items) ? res.data.data.items : []
      ranchBucketItems.value = items.filter((it: any) => [7003, 7004].includes(Number(it.id || 0)))
    }
    catch {
      ranchBucketItems.value = []
    }
    finally {
      ranchBucketLoading.value = false
    }
  }

  async function fetchBag(accountId: string) {
    if (!accountId)
      return
    const requestedId = accountId
    loading.value = true
    try {
      const res = await api.get('/api/bag', {
        headers: { 'x-account-id': accountId },
      })
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId !== requestedId)
        return
      if (res.data.ok && res.data.data) {
        allItems.value = Array.isArray(res.data.data.items) ? res.data.data.items : []
        originalItems.value = Array.isArray(res.data.data.originalItems) ? res.data.data.originalItems : []
      }
      else if (res.data && res.data.ok === false && res.data.error) {
        allItems.value = []
        originalItems.value = []
      }
    }
    catch (e) {
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId === requestedId) {
        allItems.value = []
        originalItems.value = []
      }
      console.error(e)
    }
    finally {
      loading.value = false
    }
  }

  async function useItem(accountId: string, itemId: number, count = 1) {
    const res = await api.post('/api/bag/use', { itemId, count }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }

  async function sellItems(accountId: string, items: Array<{ id: number, count: number, uid?: number }>) {
    const res = await api.post('/api/bag/sell', { items }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }

  return {
    items,
    allItems,
    originalItems,
    dashboardItems,
    ranchBucketItems,
    ranchBucketLoading,
    loading,
    fetchBag,
    fetchRanchBuckets,
    clearBag,
    useItem,
    sellItems,
  }
})
