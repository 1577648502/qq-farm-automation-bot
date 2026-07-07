export const QINGMEI_SEED_ID = 21221
export const QINGMEI_FRUIT_ID = 41221

interface QingniangCropLike {
  name?: string
  seedId?: number
  seedName?: string
  seedCount?: number
  fruitId?: number
  fruitName?: string
  fruitCount?: number
  fruitImage?: string
  image?: string
}

interface QingniangItemLike {
  id?: number
  name?: string
  count?: number
  image?: string
}

interface QingniangOverviewLike {
  crops?: QingniangCropLike[]
  items?: QingniangItemLike[]
}

function countOf(value: unknown) {
  return Math.max(0, Number(value) || 0)
}

export function findQingmeiCrop(overview?: QingniangOverviewLike | null) {
  return (overview?.crops || []).find(crop =>
    Number(crop?.seedId) === QINGMEI_SEED_ID
    || Number(crop?.fruitId) === QINGMEI_FRUIT_ID
    || crop?.name === '青梅'
    || crop?.fruitName === '青梅',
  ) || null
}

export function findQingmeiSeedItem(overview?: QingniangOverviewLike | null) {
  return (overview?.items || []).find(item =>
    Number(item?.id) === QINGMEI_SEED_ID
    || item?.name === '青梅种子',
  ) || null
}

export function findQingmeiFruitItem(overview?: QingniangOverviewLike | null) {
  return (overview?.items || []).find(item =>
    Number(item?.id) === QINGMEI_FRUIT_ID
    || item?.name === '青梅',
  ) || null
}

export function getQingmeiFruitCount(overview?: QingniangOverviewLike | null) {
  const item = findQingmeiFruitItem(overview)
  if (item)
    return countOf(item.count)

  return countOf(findQingmeiCrop(overview)?.fruitCount)
}

