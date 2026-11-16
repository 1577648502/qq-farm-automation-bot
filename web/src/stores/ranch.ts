import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface RanchAnimal {
  slot: number
  animalId: number
  name: string
  stage: number
  stageText: string
  feedState: number
  produceInSec: number
  sellCost: { itemId: number, amount: number } | null
  mutant: boolean
}

export interface RanchOverview {
  hostGid: number
  coopCount: number
  penCount: number
  grassCount: number
  ranchExp: number
  animals: RanchAnimal[]
  opLimits?: Array<{ opId: number, used: number, limit: number }>
}

export const useRanchStore = defineStore('ranch', () => {
  const overview = ref<RanchOverview | null>(null)
  const loading = ref(false)
  const operating = ref(false)

  async function fetchOverview(accountId: string) {
    if (!accountId)
      return
    loading.value = true
    try {
      const { data } = await api.get('/api/ranch/overview', {
        headers: { 'x-account-id': accountId },
      })
      if (data?.ok)
        overview.value = data.data
      else if (data?.error)
        throw new Error(data.error)
    }
    finally {
      loading.value = false
    }
  }

  async function care(accountId: string, opts: Record<string, any> = {}) {
    const { data } = await api.post('/api/ranch/care', opts, {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '巡牧场失败')
    return data.data
  }

  async function operate(accountId: string, opts: { op: string, slot?: number, feedType?: number, count?: number }) {
    const { data } = await api.post('/api/ranch/operate', opts, {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '操作失败')
    return data.data
  }

  return { overview, loading, operating, fetchOverview, care, operate }
})
