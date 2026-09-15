import { storeToRefs } from 'pinia'
import { onActivated, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAccountStore } from '@/stores/account'

/**
 * 页面数据自动刷新, 覆盖四种"用户期望看到新数据"的场景:
 * 1. 首次挂载 → onMounted 刷新
 * 2. 被 KeepAlive 缓存后再次进入 → onActivated 刷新
 * 3. 组件实例被复用、只有路由变化 → 监听 route.path 刷新
 * 4. **切换账号** → 监听 currentAccountId 刷新（页面上都是账号维度的数据）
 *
 * 首屏不会重复请求: 路由监听只在路径真正变化时触发, 账号监听只在 id 真正变化时触发。
 *
 * @param path 本页路由路径(可传数组, 用于路由变化时判断是否切回本页)
 * @param refresh 刷新函数(可 async)
 */
export function usePageRefresh(path: string | string[], refresh: () => void | Promise<void>) {
  const route = useRoute()
  const { currentAccountId } = storeToRefs(useAccountStore())
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
  watch(currentAccountId, (now, prev) => {
    // 切换账号: 页面数据都是账号维度的, 必须重新拉取
    if (String(now ?? '') !== String(prev ?? ''))
      void refresh()
  })
}
