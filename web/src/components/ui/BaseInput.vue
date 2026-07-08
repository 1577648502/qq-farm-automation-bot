<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  type?: string
  placeholder?: string
  label?: string
  disabled?: boolean
  clearable?: boolean
}>()
const emit = defineEmits<{
  (e: 'clear'): void
}>()
const model = defineModel<string | number>()
const showPassword = ref(false)
const inputType = computed(() => {
  if (props.type === 'password' && showPassword.value) {
    return 'text'
  }
  return props.type || 'text'
})
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label v-if="label" class="text-sm text-gray-700 font-medium dark:text-gray-300">
      {{ label }}
    </label>
    <div class="relative">
      <input
        v-model="model"
        :type="inputType"
        :placeholder="placeholder"
        :disabled="disabled"
        class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition-all duration-200 placeholder:text-gray-400 focus:border-[var(--theme-primary)] focus:ring-2 focus:ring-[var(--theme-primary)]/15 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-[var(--theme-primary)] dark:focus:ring-[var(--theme-primary)]/20 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 dark:disabled:bg-gray-800/50"
        :class="{ 'pr-10': type === 'password' || (clearable && model) }"
      >
      <button
        v-if="type === 'password'"
        type="button"
        class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
        tabindex="-1"
        @click="showPassword = !showPassword"
      >
        <div v-if="showPassword" class="i-carbon-view-off text-lg" />
        <div v-else class="i-carbon-view text-lg" />
      </button>
      <button
        v-else-if="clearable && model"
        type="button"
        class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
        tabindex="-1"
        @click="model = ''; emit('clear')"
      >
        <div class="i-carbon-close text-lg" />
      </button>
    </div>
  </div>
</template>

<style scoped>
input::-ms-reveal,
input::-ms-clear {
  display: none;
}
</style>
