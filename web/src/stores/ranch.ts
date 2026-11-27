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
  /** 服务端内部值(与小程序显示无关) */
  level: number
  /** 小程序显示档位(2026-11-23 buildingTier 定案); 表外建筑为 null */
  tier?: number | null
  status: number
  /** coop=窝 pen=棚 feed=喂食机 */
  kind: string
}

export interface RanchAnimal {
  slot: number
  animalId: number
  name: string
  /** 所属栏舍实例 ID(窝=10001, 棚=10003 …) */
  ranchInstId?: number
  /** 1=窝 2=棚(服务端 husbandry_type) */
  husbandryType?: number
  /** 阶段 1=幼崽 2=成长 3=生产 4=成熟 */
  stage: number
  stageText: string
  /** 兼容字段: 等于 stage(旧前端按 feedState 分支出倒计时) */
  feedState: number
  /** 可收获(服务端 can_harvest, 权威) */
  harvestable?: boolean
  canHarvest?: boolean
  /** 生产期(constructing) */
  producing?: boolean
  /** 可交付(催产) */
  canDeliver?: boolean
  canProduce?: boolean
  /** 饥饿(牧草断了) */
  hungry?: boolean
  grassBlocked?: boolean
  canFeed?: boolean
  canDonate?: boolean
  limitedCanUsed?: boolean
  produceCount?: number
  /** 各阶段就绪倒计时(秒; null=服务端没给该字段, 负数=已过) */
  infantInSec?: number | null
  growInSec?: number | null
  produceInSec?: number | null
  matureInSec?: number | null
  deliveringInSec?: number | null
  /** 距"可收获"秒数; 0=现在就能收 */
  harvestInSec?: number | null
  deliverInSec?: number | null
  /** 当前阶段剩余秒数 */
  stageEndInSec?: number | null
  /** 当前倒计时的阶段名(幼崽期/成长期/生产期/成熟期/交付中) */
  countdownKind?: string
  produceUnknownReason?: string
  expectedHarvestExp?: number
  expectedProduceExp?: number
  /** 预计收获所得 */
  sellCost: { itemId: number, amount: number } | null
  mutant: boolean
}

/** 服务端返回的单个栏舍(窝/棚各一条) */
export interface RanchGroup {
  ranchInstId: number
  husbandryType: number
  capacity: number
  animalCount: number
  animals: RanchAnimal[]
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
  /** 小程序显示档位(来自 buildingTier); 缺省=表外建筑 */
  tier?: number | null
  stored: number
  capacity: number
}

export interface RanchOverview {
  hostGid: number
  coopCount: number
  penCount: number
  /** 服务端原值: 窝/棚各自的容量(不是"规划格数") */
  coops?: RanchGroup[]
  pens?: RanchGroup[]
  coopAnimals?: number
  penAnimals?: number
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
    return data.data as { open: boolean, refreshAt: number, groups?: Array<{ id: number, name: string, limit?: number }>, goods: RotationShopGoods[] }
  }

  async function operate(accountId: string, opts: { op: string, slot?: number, feedType?: number, count?: number, maxSpend?: number, batch?: string, goodsId?: number, cubItemId?: number, gid?: number, instId?: number, complete?: boolean, price?: number, uid?: number, animalInstId?: number, hostGid?: number, place?: boolean, x?: number, y?: number, probe?: boolean }) {
    const { data } = await api.post('/api/ranch/operate', opts, {
      headers: { 'x-account-id': accountId },
    })
    if (!data?.ok)
      throw new Error(data?.error || '操作失败')
    return data.data
  }

  return { overview, loading, operating, fetchOverview, fetchCubShop, fetchRotationShop, fetchWeightScore, care, operate }
})
