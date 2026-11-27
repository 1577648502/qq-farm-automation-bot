import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export const useBagStore = defineStore('bag', () => {
  const allItems = ref<any[]>([])
  const originalItems = ref<any[]>([])
  // 后端从 items 里排除的牧场货币(1007 金券/1008 松果币等), 单独带回 ——
  // Dashboard 牧场货币卡靠它(2026-11-28 回归修复)
  const bagCurrencies = ref<any[]>([])
  const loading = ref(false)

  function clearBag() {
    allItems.value = []
    originalItems.value = []
    bagCurrencies.value = []
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
    // 1011/1012 化肥桶, 3001/3002 收藏点,
    // 1007 金券 / 1008 松果币(牧场货币),
    // 7003/7004 罐头桶(普通/有机) —— 全部都在**农场背包**(ItemService.Bag)里。
    // ⚠ 2026-11-20 抓包核对(20261119-091627_罐头):
    //   Bag 回包 89 项里明确带 {7003: 507411, 7004: 345665}(秒) = 140.9h / 96.0h;
    //   而牧场背包(GetBag{scene:2}, 只有 9 项)里**没有** 7003/7004。
    //   之前接到 /api/ranch/bag 上, 所以首页一直显示 0.0h。
    // ⚠ 2026-11-28: 后端把 1007/1008 从 items 排除(11-22"其他分类不显牧场货币"),
    //   这些货币改从 data.currencies 单独带回, 这里合成回同一形状。
    const targetIds = new Set([1011, 1012, 3001, 3002, 1007, 1008, 7003, 7004])
    return allItems.value.filter((it: any) => targetIds.has(Number(it.id || 0)))
      .concat(bagCurrencies.value.filter((c: any) => targetIds.has(Number(c.id || 0))))
  })

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
        bagCurrencies.value = Array.isArray(res.data.data.currencies) ? res.data.data.currencies : []
      }
      else if (res.data && res.data.ok === false && res.data.error) {
        allItems.value = []
        originalItems.value = []
        bagCurrencies.value = []
      }
    }
    catch (e) {
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId === requestedId) {
        allItems.value = []
        originalItems.value = []
        bagCurrencies.value = []
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
    loading,
    fetchBag,
    clearBag,
    useItem,
    sellItems,
  }
})
