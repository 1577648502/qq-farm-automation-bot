/**
 * 1 档已由实际抓包确认；2/3 档按游戏招聘界面的档位顺序补齐。
 */
export interface MilkTeaHireDurationOption {
  value: number
  label: string
}

export const MILK_TEA_HIRE_DURATION_OPTIONS: MilkTeaHireDurationOption[] = [
  { value: 1, label: '4 小时（40）' },
  { value: 2, label: '12 小时（130）' },
  { value: 3, label: '24 小时（270）' },
]

export function normalizeMilkTeaHireDuration(value: unknown): number {
  const duration = Number(value)
  return MILK_TEA_HIRE_DURATION_OPTIONS.some(option => option.value === duration)
    ? duration
    : 1
}
