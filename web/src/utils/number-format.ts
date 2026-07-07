function trimZeros(value: string) {
  return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

export function formatCompactNumber(value: unknown) {
  const num = Math.max(0, Number(value) || 0)
  if (num >= 100000000)
    return `${trimZeros((num / 100000000).toFixed(2))}亿`
  if (num >= 10000)
    return `${trimZeros((num / 10000).toFixed(2))}万`
  return num.toLocaleString('zh-CN')
}

export function formatSignedCompactNumber(value: unknown) {
  const num = Number(value) || 0
  const sign = num > 0 ? '+' : ''
  return `${sign}${formatCompactNumber(Math.abs(num))}`
}
