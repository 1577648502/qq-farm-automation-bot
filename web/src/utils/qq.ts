const QQ_UIN_RE = /^\d{8,12}$/

export function getQQUin(value: unknown) {
  const text = String(value ?? '').trim()
  return QQ_UIN_RE.test(text) ? text : ''
}

export function getAccountQQUin(account: any) {
  if (!account)
    return ''

  return getQQUin(account.name) || getQQUin(account.uin) || getQQUin(account.qq)
}

export function getQQAvatarUrl(account: any, size = 100) {
  const uin = getAccountQQUin(account)
  if (!uin)
    return ''

  const cacheKey = String(account?.updatedAt || account?.createdAt || account?.id || uin)
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=${size}&t=${encodeURIComponent(cacheKey)}`
}
