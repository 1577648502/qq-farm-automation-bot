/**
 * 农场操作的中文名 / 图标 / 按钮配色 —— 单一来源。
 *
 * 同一批操作在三个地方出现:
 *   · FarmPanel  整田操作(一键收获 / 一键种植 …)
 *   · LandBoard  单地块操作(点开一块地后弹的按钮)
 *   · Dashboard  操作记录里的图标与名称
 * 之前各写一份, 新增一个操作要改三处, 很容易漏。这里统一后按需取。
 */
export interface LandOpMeta {
  label: string
  icon: string
  /** LandBoard 里操作按钮的边框/底色/文字色 */
  tone: string
  /** Dashboard 操作记录用的纯文字色 */
  color: string
}

/** 可对单块地执行的操作(键与后端 operateSingleLand 的 op 一致) */
export const LAND_OP_META: Record<string, LandOpMeta> = {
  water: {
    label: '浇水',
    icon: 'i-carbon-rain-drop',
    tone: 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    color: 'text-blue-400',
  },
  weed: {
    label: '除草',
    icon: 'i-carbon-clean',
    tone: 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    color: 'text-yellow-500',
  },
  bug: {
    label: '除虫',
    icon: 'i-carbon-warning-alt',
    tone: 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    color: 'text-red-400',
  },
  harvest: {
    label: '收获',
    icon: 'i-carbon-wheat',
    tone: 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    color: 'text-green-500',
  },
  fertilize: {
    label: '施肥',
    icon: 'i-carbon-chemistry',
    tone: 'border-cyan-300 bg-cyan-50 text-cyan-700 hover:bg-cyan-100 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
    color: 'text-emerald-500',
  },
  plant: {
    label: '种植',
    icon: 'i-carbon-sprout',
    tone: 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300',
    color: 'text-lime-500',
  },
  clear: {
    label: '铲除',
    icon: 'i-carbon-trash-can',
    tone: 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300',
    color: 'text-red-500',
  },
  upgrade: {
    label: '升级土地',
    icon: 'i-carbon-upgrade',
    tone: 'border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
    color: 'text-violet-500',
  },
  unlock: {
    label: '解锁土地',
    icon: 'i-carbon-unlocked',
    tone: 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    color: 'text-blue-500',
  },
}

/** 有机肥按钮单独用一套配色(与普通肥区分) */
export const ORGANIC_FERTILIZER_TONE = 'border-lime-300 bg-lime-50 text-lime-700 hover:bg-lime-100 dark:border-lime-700 dark:bg-lime-900/30 dark:text-lime-300'

export function getLandOpMeta(op: string): LandOpMeta {
  return LAND_OP_META[String(op)] || { label: String(op), icon: 'i-carbon-circle-dash', tone: 'border-gray-300 bg-gray-50 text-gray-700 dark:border-gray-600 dark:bg-gray-900/30 dark:text-gray-300', color: 'text-gray-400' }
}

/**
 * 操作记录条目元数据(Dashboard"今日操作"统计用)。
 * 与 LAND_OP_META 的区别: 记录里会出现好友互助/商店/牧场专属条目, 且部分 icon
 * 特意选了偏"记录展示"的形态(如收获记录用 crop-growth 而按钮用 wheat)。
 * 单一来源: 后端 OPERATION_KEYS(runtime-engine.js) 里每个键都应在这里有条目。
 */
export const STATUS_OP_META: Record<string, { label: string, icon: string, color: string }> = {
  // ---- 农场(与 LAND_OP_META 同键, label/color 复用, icon 用记录展示形态) ----
  harvest: { label: '收获', icon: 'i-carbon-crop-growth', color: 'text-green-500' },
  water: { label: '浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-400' },
  weed: { label: '除草', icon: 'i-carbon-cut-out', color: 'text-yellow-500' },
  bug: { label: '除虫', icon: 'i-carbon-warning-alt', color: 'text-red-400' },
  fertilize: { label: '施肥', icon: 'i-carbon-chemistry', color: 'text-emerald-500' },
  plant: { label: '种植', icon: 'i-carbon-tree', color: 'text-lime-500' },
  steal: { label: '偷菜', icon: 'i-carbon-run', color: 'text-orange-500' },
  helpWater: { label: '帮浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-300' },
  helpWeed: { label: '帮除草', icon: 'i-carbon-cut-out', color: 'text-yellow-400' },
  helpBug: { label: '帮除虫', icon: 'i-carbon-warning-alt', color: 'text-red-300' },
  taskClaim: { label: '任务', icon: 'i-carbon-task-complete', color: 'text-indigo-500' },
  sell: { label: '出售', icon: 'i-carbon-shopping-cart', color: 'text-pink-500' },
  // ---- 牧场(与农场同构, 全部功能都有条目; 图标只用已安装的 carbon/fa-solid 包) ----
  ranchHarvest: { label: '牧场收', icon: 'i-fas-egg', color: 'text-amber-500' },
  ranchProduce: { label: '催产', icon: 'i-carbon-flash', color: 'text-lime-500' },
  ranchFeed: { label: '牧场喂', icon: 'i-carbon-restaurant', color: 'text-orange-400' },
  ranchSell: { label: '卖产物', icon: 'i-carbon-shopping-cart-plus', color: 'text-pink-400' },
  ranchBuyCubs: { label: '买幼崽', icon: 'i-fas-coins', color: 'text-amber-400' },
  ranchPlace: { label: '幼崽入栏', icon: 'i-fas-chess-pawn', color: 'text-yellow-500' },
  ranchClean: { label: '清牧场', icon: 'i-carbon-clean', color: 'text-teal-500' },
  ranchSteal: { label: '偷牧场', icon: 'i-carbon-arrow-down-left', color: 'text-rose-500' },
  ranchStroke: { label: '照顾', icon: 'i-fas-hand-holding-heart', color: 'text-emerald-500' },
  ranchHazard: { label: '使坏', icon: 'i-fas-bug', color: 'text-red-400' },
  ranchRotation: { label: '游商', icon: 'i-carbon-store', color: 'text-violet-500' },
  ranchTask: { label: '牧场任务', icon: 'i-carbon-task', color: 'text-sky-500' },
  ranchIllustrated: { label: '图鉴', icon: 'i-carbon-gift', color: 'text-fuchsia-500' },
  ranchBuilding: { label: '建筑', icon: 'i-carbon-building', color: 'text-indigo-400' },
  ranchRegion: { label: '地块', icon: 'i-carbon-map', color: 'text-cyan-500' },
  ranchGrass: { label: '牧草机', icon: 'i-fas-seedling', color: 'text-green-400' },
}

/** 操作记录条目查询(缺省给中性占位) */
export function getStatusOpMeta(op: string): { label: string, icon: string, color: string } {
  return STATUS_OP_META[String(op)] || { label: String(op), icon: 'i-carbon-circle-dash', color: 'text-gray-400' }
}
