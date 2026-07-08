<script setup lang="ts">
defineProps<{
  label?: string
}>()
const model = defineModel<boolean>()
</script>

<template>
  <label class="inline-flex cursor-pointer items-center gap-3 select-none">
    <div class="relative inline-flex items-center">
      <input v-model="model" type="checkbox" class="peer sr-only">
      <div class="h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white dark:border-gray-500 dark:bg-gray-600 dark:after:border-gray-400 peer-checked:bg-[var(--theme-primary)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--theme-primary)]/20" />
    </div>
    <span v-if="label" class="text-sm text-gray-700 font-medium dark:text-gray-300">
      {{ label }}
    </span>
  </label>
</template>
