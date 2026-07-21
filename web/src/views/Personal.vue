<script setup lang="ts">
import { ref } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import IllustratedPanel from '@/components/IllustratedPanel.vue'
import SeedShopPanel from '@/components/SeedShopPanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'

const currentTab = ref<'farm' | 'bag' | 'task' | 'illustrated' | 'seedShop'>('farm')
</script>

<template>
  <div class="h-full flex flex-col p-3 sm:p-4">
    <div class="mb-4 flex flex-wrap gap-2">
      <button
        class="min-h-[44px] rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'farm'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'farm' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'farm'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-sprout text-lg" />
          <span>我的农场</span>
        </div>
      </button>
      <button
        class="min-h-[44px] rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'bag'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'bag' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'bag'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-box text-lg" />
          <span>我的背包</span>
        </div>
      </button>
      <button
        class="min-h-[44px] rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'task'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'task' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'task'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-task text-lg" />
          <span>我的任务</span>
        </div>
      </button>
      <button
        class="min-h-[44px] rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'illustrated'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'illustrated' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'illustrated'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-catalog text-lg" />
          <span>我的图鉴</span>
        </div>
      </button>
      <button
        class="min-h-[44px] rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'seedShop'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'seedShop' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'seedShop'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-shopping-cart text-lg" />
          <span>种子商城</span>
        </div>
      </button>
    </div>

    <div class="flex-1 overflow-hidden overflow-y-auto">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="transform opacity-0 scale-95"
        enter-to-class="transform opacity-100 scale-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="transform opacity-100 scale-100"
        leave-to-class="transform opacity-0 scale-95"
      >
        <FarmPanel v-if="currentTab === 'farm'" />
        <BagPanel v-else-if="currentTab === 'bag'" />
        <TaskPanel v-else-if="currentTab === 'task'" />
        <IllustratedPanel v-else-if="currentTab === 'illustrated'" />
        <SeedShopPanel v-else-if="currentTab === 'seedShop'" />
      </Transition>
    </div>
  </div>
</template>
