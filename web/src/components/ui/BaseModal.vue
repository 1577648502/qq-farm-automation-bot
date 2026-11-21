<script setup lang="ts">
defineProps<{
  show: boolean
  title?: string
  /** 关闭时点击遮罩是否生效(默认关) */
  closeOnBackdrop?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <div
    v-if="show"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
    @click.self="closeOnBackdrop && emit('close')"
  >
    <div class="max-h-[85vh] w-full flex flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-800" @click.stop>
      <div class="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h3 class="text-lg text-gray-800 font-semibold dark:text-gray-100">
          {{ title || '' }}
        </h3>
        <button
          type="button"
          class="min-h-[32px] min-w-[32px] rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          aria-label="关闭"
          @click="emit('close')"
        >
          <div class="i-carbon-close text-lg" />
        </button>
      </div>
      <div class="flex-1 overflow-y-auto">
        <slot />
      </div>
      <div v-if="$slots.footer" class="shrink-0 border-t border-gray-100 px-4 py-3 dark:border-gray-700">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
