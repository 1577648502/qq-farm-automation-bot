<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps<{
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'outline' | 'text'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  disabled?: boolean
  block?: boolean
  to?: string
  href?: string
  type?: 'button' | 'submit' | 'reset'
}>()

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void
}>()

const componentTag = computed(() => {
  if (props.to) return RouterLink
  if (props.href) return 'a'
  return 'button'
})

const baseClasses = 'inline-flex items-center justify-center rounded-lg font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-55 select-none'

const variantClasses = computed(() => {
  switch (props.variant) {
    case 'primary':
      return 'text-white shadow-sm hover:shadow-md focus:ring-blue-500'
    case 'secondary':
      return 'bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-400 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
    case 'success':
      return 'bg-green-600 text-white hover:bg-green-500 focus:ring-green-500 shadow-sm'
    case 'danger':
      return 'bg-red-600 text-white hover:bg-red-500 focus:ring-red-500 shadow-sm'
    case 'ghost':
      return 'text-gray-600 hover:bg-gray-100 focus:ring-gray-400 dark:text-gray-400 dark:hover:bg-gray-800'
    case 'outline':
      return 'border border-gray-300 bg-transparent text-gray-700 hover:bg-gray-50 focus:ring-gray-500 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'
    case 'text':
      return 'hover:underline p-0 bg-transparent shadow-none hover:bg-transparent'
    default:
      return 'text-white shadow-sm hover:shadow-md focus:ring-blue-500'
  }
})

const sizeClasses = computed(() => {
  if (props.variant === 'text') return ''
  switch (props.size) {
    case 'sm': return 'px-3 py-1.5 text-sm gap-1.5'
    case 'lg': return 'px-6 py-3 text-lg gap-2'
    default: return 'px-4 py-2 text-sm gap-2'
  }
})

const widthClasses = computed(() => props.block ? 'w-full' : '')

const buttonStyle = computed(() => {
  if (props.variant === 'primary' || (!props.variant)) {
    return { backgroundColor: 'var(--theme-primary)' }
  }
  if (props.variant === 'text') {
    return { color: 'var(--theme-primary)' }
  }
  return {}
})
</script>

<template>
  <component
    :is="componentTag"
    :to="to"
    :href="href"
    :type="!to && !href ? (type || 'button') : undefined"
    :disabled="disabled || loading"
    :class="[baseClasses, variantClasses, sizeClasses, widthClasses]"
    :style="buttonStyle"
    v-bind="$attrs"
    @click="!disabled && !loading && emit('click', $event)"
  >
    <div v-if="loading" class="i-svg-spinners-ring-resize shrink-0 animate-spin" />
    <slot />
  </component>
</template>
