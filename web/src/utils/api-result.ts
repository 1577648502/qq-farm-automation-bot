/**
 * 统一解析接口返回里的错误信息
 *
 * 背景（踩过的坑）：后台/worker 的失败返回有多种形态，页面里只判断 `d.ok === false`
 * 会漏掉一部分，表现为"点了按钮什么也不提示"：
 *   ① HTTP 层失败   → axios 抛异常（e.response.data.error / e.message）
 *   ② 主进程 catch  → { ok: false, error: '...' }
 *   ③ worker 直接回 → { ok: true, data: { error: '...' } }   ← 没有 ok 字段, 最容易被漏掉
 *   ④ 业务性拒绝    → { ok: true, data: { ok: false, reason: '...' } }
 *
 * 用法：
 *   const err = apiError(res, res.data?.data, e)
 *   if (err) { toast.error(err); return }
 */
export function apiError(res: any, data: any, e?: any): string {
  const fromResp = e?.response?.data?.error || e?.response?.data?.message
  const fromAxios = e?.message
  const fromTop = res?.data?.error || res?.data?.message
  const fromData = data?.error || data?.message || data?.reason
  let msg = String(fromResp || fromTop || fromData || fromAxios || '')
  // ok:false 但没带文案时也要给一句, 否则调用方会当成"成功"继续往下走(静默失败)
  if (!msg && ((res?.data && res.data.ok === false) || (data && data.ok === false))) msg = '操作未成功'
  return msg
}

/** 成功/失败一行式处理：返回 true 表示成功；失败时回传原因（调用方负责 toast/展示） */
export function apiResult(res: any, data: any, e?: any): { ok: boolean, error: string } {
  const err = apiError(res, data, e)
  if (err) return { ok: false, error: err }
  if (!res?.data?.ok) return { ok: false, error: '请求失败（后台未就绪？）' }
  return { ok: true, error: '' }
}
