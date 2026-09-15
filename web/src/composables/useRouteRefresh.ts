import { onActivated, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 进入本页时自动刷新数据, 解决"左侧菜单切换过来时页面数据不刷新"的问题:
 * - 组件首次挂载 → onMounted 触发一次
 * - 组件被 KeepAlive 缓存后再次进入 → onActivated 触发
 * - 组件实例被复用(只有路由变化, 没有重新挂载) → 监听路由变化触发
 *
 * 三种情况都会刷新, 且首屏不会重复请求(监听只在 path 真正变化时触发)。
 *
 * @param path 本页的路由路径(可传数组)
 * @param refresh 刷新函数(可 async)
 */
export function useRouteRefresh(path: string | string[], refresh: () => void | Promise<void>) {
  const route = useRoute()
  const paths = Array.isArray(path) ? path : [path]

  onMounted(() => { void refresh() })
  onActivated(() => { void refresh() })
  watch(
    () => route.path,
    (now, prev) => {
      if (now !== prev && paths.includes(now))
        void refresh()
    },
  )
}
