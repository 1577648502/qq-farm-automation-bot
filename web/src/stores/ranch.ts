import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface RanchFacility {
  slot: number
  kind?: string
  name: string
  level: number
  stored: number
  capacity: number
  instanceId?: number
  /** 建筑升级中(来自 AllCells) */
  upgrading?: boolean
  /** 建筑等级(来自 AllCells, 与 level 互为补充) */
  upgradeLevel?: number
  buildingId?: number
  buildingKind?: string
}

export interface RanchBuilding {
  instId: number
  buildingId: number
  level: number
  status: number
  /** coop=窝 pen=棚 feed=喂食机 */
  kind: string
}

export interface RanchAnimal {
  slot: number
  animalId: number
  name: string
  stage: number
  stageText: string
  feedState: number
  /** 是否成年(后端按 grown_flag 判定) */
  grown?: boolean
  /** 副产物就绪, 可收获(后端权威字段) */
  harvestable?: boolean
  /** 距下次产出秒数; null = 还没进入产出周期 */
  harvestInSec?: number | null
  /** 兼容字段, 语义同 harvestInSec */
  produceInSec: number | null
  /** 催产就绪(后端权威字段) */
  canProduce?: boolean
  /** 饥饿 */
  hungry?: boolean
  sellCost: { itemId: number, amount: number } | null
  mutant: boolean
}

export interface CubShopItem {
  goodsId: number
  animalId: number
  name: string
  price: number
  limit: number
  bought: number
  /** 剩余可买; null = 不限购 */
  remaining?: number | null
  unlocked: boolean
  currencyId: number
  valueRatio: number
}

export interface RotationShopGoods {
  group: number
  seq: number
  itemId: number
  currencyId: number
  price: number
  discountPrice?: number
  limit: number
  uid: number
}

export interface RanchFacility {
  slot: number
  name: string
  level: number
  stored: number
  capacity: number
}

export interface RanchOverview {
  hostGid: number
  coopCount: number
  penCount: number
  grassCount: number
  ranchExp: number
  /** 牧场等级(独立于农场等级) */
  ranchLevel?: number
  /** 当前等级内经验 */
  ranchLevelExp?: number
  /** 当前等级所需经验 */
  ranchLevelNeeded?: number
  animals: RanchAnimal[]
  facilities?: RanchFacility[]
  /** AllCells 的真实建筑清单 */
  buildings?: RanchBuilding[]
  coopBuildings?: RanchBuilding[]
  penBuildings?: RanchBuilding[]
  feedBuildings?: RanchBuilding[]
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

  async function fetchCubShop(accountId: string) {
    const { data } = await api.get('/api/ranch/cub-shop', {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '获取幼崽商店失败')
    return data.data as {
      shop: CubShopItem[]
      best: CubShopItem | null
      /** 金券余额; null = 读不到, 前端不做余额拦截 */
      voucher: number | null
    }
  }

  async function fetchWeightScore(accountId: string) {
    const { data } = await api.get('/api/ranch/weight-score', {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '获取饲养档位失败')
    return data.data as { tiers: Array<{ level: number, requiredWeight: number, rewards: Array<{ itemId: number, count: number }> }> }
  }

  async function fetchRotationShop(accountId: string) {
    const { data } = await api.get('/api/ranch/rotation-shop', {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '获取游商失败')
    return data.data as { open: boolean, refreshAt: number, goods: RotationShopGoods[] }
  }

  async function operate(accountId: string, opts: { op: string, slot?: number, feedType?: number, count?: number, maxSpend?: number, batch?: string, goodsId?: number, cubItemId?: number, gid?: number, instId?: number, complete?: boolean, price?: number }) {
    const { data } = await api.post('/api/ranch/operate', opts, {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '操作失败')
    return data.data
  }

  return { overview, loading, operating, fetchOverview, fetchCubShop, fetchRotationShop, fetchWeightScore, care, operate }
})
