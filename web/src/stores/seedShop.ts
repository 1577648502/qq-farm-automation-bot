import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface SeedGoods {
  seedId: number
  goodsId: number
  name?: string
  price: number | null
  requiredLevel: number | null
  locked: boolean
  soldOut: boolean
  unknownMeta?: boolean
  image?: string
}

export const useSeedShopStore = defineStore('seedShop', () => {
  const items = ref<SeedGoods[]>([])
  const loading = ref(false)

  const availableItems = computed(() => items.value.filter(i => !i.locked && !i.soldOut))
  const lockedItems = computed(() => items.value.filter(i => i.locked))
  const soldOutItems = computed(() => items.value.filter(i => i.soldOut))

  function clear() {
    items.value = []
  }

  async function fetchSeeds(accountId: string) {
    if (!accountId)
      return
    const requestedId = accountId
    loading.value = true
    try {
      const res = await api.get('/api/seeds', {
        headers: { 'x-account-id': accountId },
      })
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId !== requestedId)
        return
      if (res.data.ok && Array.isArray(res.data.data))
        items.value = res.data.data
      else
        clear()
    }
    catch (e) {
      const acc = useAccountStore()
      const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (curId === requestedId)
        clear()
      console.error('获取种子商城失败', e)
    }
    finally {
      loading.value = false
    }
  }

  async function buySeed(accountId: string, goodsId: number, num: number, price: number | null) {
    const res = await api.post('/api/seeds/buy', { goodsId, num, price }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }

  return {
    items,
    loading,
    availableItems,
    lockedItems,
    soldOutItems,
    fetchSeeds,
    buySeed,
    clear,
  }
})
