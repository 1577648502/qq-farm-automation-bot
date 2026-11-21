import antfu from '@antfu/eslint-config'

export default antfu({
  vue: true,
  typescript: true,
  unocss: true,
  formatters: true,
  rules: {
    'no-alert': 'off',
    // 项目存量代码这两类写法极多(函数提升/单行双语句), 全改是无谓 churn, 降级为警告
    'style/max-statements-per-line': 'warn',
    'ts/no-use-before-define': 'warn',
  },
})
