import { onMounted, ref } from 'vue'

/**
 * 土地等级 → 名称、以及施肥范围里的土地类型名。
 *
 * 为什么从接口取:
 *   这套映射原本在后端 farm.js、前端 LandCard.vue、前端 Settings.vue 各有一份。
 *   2026-11 新增"蓝晶土地(6级)"时三处都要改, 漏一处就会出现
 *   "设置里能勾蓝晶、地块卡片却显示空白"。现在唯一来源是后端
 *   core/src/config/land-types.js, 前端只消费 /api/game-version 的结果。
 *
 * 下面的兜底表保证接口没返回时界面也不会空白。
 */

const FALLBACK_LEVEL_NAMES: Record<number, string> = {
  0: '普通',
  1: '黄土地',
  2: '红土地',
  3: '黑土地',
  4: '金土地',
  5: '紫晶土地',
  6: '蓝晶土地',
}

const FALLBACK_LAND_TYPES = [
  { label: '蓝晶土地', value: 'blue' },
  { label: '紫晶土地', value: 'amethyst' },
  { label: '金土地', value: 'gold' },
  { label: '黑土地', value: 'black' },
  { label: '红土地', value: 'red' },
  { label: '普通土地', value: 'normal' },
]

// 模块级缓存: 多个组件共用, 只请求一次
const levelNames = ref<Record<number, string>>({ ...FALLBACK_LEVEL_NAMES })
const landTypeOptions = ref(FALLBACK_LAND_TYPES.slice())
let loaded = false
let inflight: Promise<void> | null = null

export function useLandTypes() {
  function load() {
    if (loaded || inflight)
      return inflight || Promise.resolve()
    inflight = (async () => {
      try {
        const { default: api } = await import('@/api')
        const { data } = await api.get('/api/game-version')
        const levels = data?.landLevels
        if (Array.isArray(levels) && levels.length) {
          levelNames.value = Object.fromEntries(
            levels.map((it: any) => [Number(it.level), String(it.name)]),
          )
        }
        const types = data?.landTypes
        if (Array.isArray(types) && types.length) {
          landTypeOptions.value = types.map((it: any) => ({ label: String(it.label), value: String(it.value) }))
        }
        loaded = true
      }
      catch {
        // 接口失败就用兜底表, 不影响渲染
      }
      finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** 土地等级 → 中文名(短名, 用于地块卡片) */
  function getLandLevelName(level: any) {
    const lv = Math.min(Math.max(Number(level) || 0, 0), 6)
    return levelNames.value[lv] || FALLBACK_LEVEL_NAMES[lv] || ''
  }

  // 组件一挂载就用兜底表渲染, 同时异步拉真实表; 拉到后自动更新
  onMounted(load)

  return { levelNames, landTypeOptions, load, getLandLevelName }
}
