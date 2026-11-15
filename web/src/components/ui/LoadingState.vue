<script setup lang="ts">
/**
 * 统一的"加载中"占位块。
 *
 * 原来这个两行结构(居中容器 + 转圈图标)在 8 个文件里各抄了一遍,
 * 尺寸还分 text-4xl / text-2xl / text-lg 三档。抽成一个组件后,
 * 想调整转圈大小/间距只改这里。
 *
 * 按钮内部的小转圈(inline、跟随文字)不属于这个场景, 仍各自写。
 */
withDefaults(defineProps<{
  /** 尺寸档位, 与原来的写法一一对应 */
  size?: 'sm' | 'md' | 'lg'
  /** 上下留白, 与原来 py-12 一致 */
  padded?: boolean
  /** 附带的文字说明(可选) */
  text?: string
}>(), {
  size: 'lg',
  padded: true,
  text: '',
})

const SIZE_CLASS = {
  sm: 'text-lg',
  md: 'text-2xl',
  lg: 'text-4xl',
} as const
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-2" :class="padded ? 'py-12' : ''">
    <div class="i-svg-spinners-90-ring-with-bg text-blue-500" :class="SIZE_CLASS[size]" />
    <div v-if="text" class="text-sm text-gray-400">
      {{ text }}
    </div>
  </div>
</template>
