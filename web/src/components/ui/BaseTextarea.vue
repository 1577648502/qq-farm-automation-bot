<script setup lang="ts">
defineProps<{
  placeholder?: string
  label?: string
  disabled?: boolean
  rows?: number
}>()
const model = defineModel<string>()
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label v-if="label" class="text-sm text-gray-700 font-medium dark:text-gray-300">
      {{ label }}
    </label>
    <textarea
      v-model="model"
      :rows="rows || 3"
      :placeholder="placeholder"
      :disabled="disabled"
      class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition-all duration-200 placeholder:text-gray-400 focus:border-[var(--theme-primary)] focus:ring-2 focus:ring-[var(--theme-primary)]/15 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-[var(--theme-primary)] dark:focus:ring-[var(--theme-primary)]/20 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 dark:disabled:bg-gray-800/50"
    />
  </div>
</template>
