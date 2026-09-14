<script setup lang="ts">
defineProps<{
  label?: string
  disabled?: boolean
}>()
const model = defineModel<boolean>()
</script>

<template>
  <label
    class="inline-flex items-center gap-3"
    :class="disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'"
  >
    <div class="relative inline-flex items-center">
      <input v-model="model" type="checkbox" class="peer sr-only" :disabled="disabled">
      <div
        class="h-6 w-11 rounded-full after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:border after:border-gray-300 dark:border-gray-600 after:rounded-full after:bg-white dark:bg-gray-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-green-500/20 after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white"
        :class="disabled ? 'bg-gray-100 dark:bg-gray-800' : 'bg-gray-200 peer-checked:bg-green-500'"
      />
    </div>
    <span
      v-if="label"
      class="select-none text-sm font-medium"
      :class="disabled ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300'"
    >
      {{ label }}
    </span>
  </label>
</template>
