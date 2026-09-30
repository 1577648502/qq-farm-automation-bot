<script setup lang="ts">
/**
 * 自动化任务卡片（设置 → 自动控制 里统一用它）
 *
 * 结构固定四段，风格全站一致：
 *   ① 抬头: 标题 + 一句说明        右侧: 开关
 *   ② 参数行: `params` 插槽
 *   ③ 操作行: `actions` 插槽（按钮、结果文案）
 *   ④ 备注行: `note` 插槽（小字灰字）
 * 默认插槽放在参数/操作之间，用来放"子任务行"。
 */
defineProps<{
  title: string
  desc?: string
}>()
</script>

<template>
  <div class="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
    <!-- ① 抬头 -->
    <div class="flex items-start justify-between gap-3 px-3 py-2.5">
      <div class="min-w-0">
        <div class="text-sm text-gray-900 font-medium dark:text-gray-100">
          {{ title }}
        </div>
        <p v-if="desc" class="mt-0.5 text-xs leading-5 text-gray-500 dark:text-gray-400">
          {{ desc }}
        </p>
      </div>
      <div class="shrink-0 pt-0.5">
        <slot name="switch" />
      </div>
    </div>

    <!-- ②③ + 子任务 -->
    <div
      v-if="$slots.params || $slots.actions || $slots.default"
      class="space-y-2 border-t border-gray-100 px-3 py-2.5 dark:border-gray-700/60"
    >
      <div v-if="$slots.params" class="flex flex-wrap items-end gap-3">
        <slot name="params" />
      </div>
      <div v-if="$slots.actions" class="flex flex-wrap items-center gap-3">
        <slot name="actions" />
      </div>
      <slot />
    </div>

    <!-- ④ 备注 -->
    <div
      v-if="$slots.note"
      class="border-t border-gray-100 px-3 py-2 text-xs leading-5 text-gray-500 dark:border-gray-700/60 dark:text-gray-400"
    >
      <slot name="note" />
    </div>
  </div>
</template>
