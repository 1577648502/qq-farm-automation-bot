<script setup lang="ts">
import type { Theme } from '@/stores/app'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

function selectTheme(theme: Theme) {
  appStore.applyTheme(theme)
  appStore.toggleThemePanel()
}
</script>

<template>
  <div class="relative">
    <button
      class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-all hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
      title="主题设置"
      @click="appStore.toggleThemePanel()"
    >
      <div class="i-carbon-color-palette text-xl" />
    </button>

    <teleport to="body">
      <div
        v-if="appStore.showThemePanel"
        class="fixed inset-0 z-[99] bg-black/30 backdrop-blur-sm"
        @click="appStore.toggleThemePanel()"
      />

      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="scale-95 opacity-0"
        enter-to-class="scale-100 opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="scale-100 opacity-100"
        leave-to-class="scale-95 opacity-0"
      >
        <div
          v-if="appStore.showThemePanel"
          class="fixed z-[100] w-80 rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800"
          :style="{
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
          }"
        >
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-sm text-gray-800 font-semibold dark:text-gray-200">
              选择主题
            </h3>
            <button
              class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
              @click="appStore.toggleThemePanel()"
            >
              <div class="i-carbon-close text-lg" />
            </button>
          </div>

          <div class="grid grid-cols-2 gap-2.5">
            <button
              v-for="(t, theme) in appStore.themes"
              :key="theme"
              class="relative flex flex-col items-center justify-center gap-2 rounded-lg p-3 transition-all hover:scale-[1.04] active:scale-95"
              :class="{
                'ring-2 ring-offset-2': appStore.currentTheme === theme,
                'dark:ring-offset-gray-800': t.isDark,
              }"
              :style="{
                background: t.gradient,
                '--tw-ring-color': t.primary,
                '--tw-ring-offset-color': t.isDark ? '#1f2937' : '#ffffff',
              }"
              :title="t.name"
              @click="selectTheme(theme as Theme)"
            >
              <div :class="t.icon" class="text-xl text-white/90" />
              <span class="text-xs text-white font-medium drop-shadow-sm">{{ t.name }}</span>
              <div
                v-if="appStore.currentTheme === theme"
                class="i-carbon-checkmark absolute right-1.5 top-1.5 text-sm text-white drop-shadow"
              />
            </button>
          </div>
        </div>
      </Transition>
    </teleport>
  </div>
</template>
