export type ApiFailureKind = 'transport' | 'business'

export interface ApiFailure {
  kind: ApiFailureKind | null
  error: string
}

function text(value: any): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 只解析 HTTP/接口层失败，不把业务返回里的 `reason` 当接口异常。
 */
export function apiResponseError(res: any, e?: any): string {
  const responseData = e?.response?.data
  const topData = res?.data
  const responseFailed = responseData?.ok === false
  const topFailed = topData?.ok === false
  const fromResp = text(responseData?.error)
    || (e ? text(responseData?.message) : '')
    || (responseFailed
      ? text(responseData?.message)
        || text(responseData?.reason)
        || text(responseData?.data?.reason)
      : '')
  const fromTop = text(topData?.error)
    || (topFailed
      ? text(topData?.message)
        || text(topData?.reason)
        || text(topData?.data?.reason)
      : '')
  const fromAxios = text(e?.message)
  let msg = fromResp || fromTop || fromAxios
  if (!msg && topFailed) {
    msg = '请求失败'
  }
  return msg
}

/**
 * 解析 worker 放在 data 里的业务失败；`reason` 只有明确失败时才作为错误。
 */
export function apiBusinessError(data: any): string {
  if (!data) {
    return ''
  }
  // 业务主动跳过是正常结果，页面会单独展示 skipped.reason，不应按失败上报。
  if (data.skipped === true) {
    return ''
  }
  const directError = text(data.error)
  if (directError) {
    return directError
  }
  if (data.ok !== false) {
    return ''
  }
  return text(data.message) || text(data.reason) || '操作未成功'
}

/**
 * 统一解析接口返回里的错误信息，并标明错误发生在哪一层。
 *
 * 背景（踩过的坑）：后台/worker 的失败返回有多种形态，页面里只判断 `d.ok === false`
 * 会漏掉一部分，表现为“点了按钮什么也不提示”：
 *   ① HTTP 层失败   → axios 抛异常（e.response.data.error / e.message）
 *   ② 主进程 catch  → { ok: false, error: '...' }
 *   ③ worker 直接回 → { ok: true, data: { error: '...' } }
 *   ④ 业务性拒绝    → { ok: true, data: { ok: false, reason: '...' } }
 */
export function apiFailure(res: any, data: any, e?: any): ApiFailure {
  const transportError = apiResponseError(res, e)
  if (transportError) {
    return { kind: 'transport', error: transportError }
  }
  const businessError = apiBusinessError(data)
  if (businessError) {
    return { kind: 'business', error: businessError }
  }
  return { kind: null, error: '' }
}

export function apiError(res: any, data: any, e?: any): string {
  return apiFailure(res, data, e).error
}

/** 成功/失败一行式处理：返回 true 表示成功；失败时回传原因（调用方负责 toast/展示） */
export function apiResult(res: any, data: any, e?: any): {
  ok: boolean
  error: string
  kind: ApiFailureKind | 'invalid' | null
} {
  const failure = apiFailure(res, data, e)
  if (failure.error) {
    return { ok: false, error: failure.error, kind: failure.kind }
  }
  if (!res?.data?.ok) {
    return { ok: false, error: '请求失败（后台未就绪？）', kind: 'invalid' }
  }
  return { ok: true, error: '', kind: null }
}
