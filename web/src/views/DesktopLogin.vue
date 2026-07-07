<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useDesktopLoginStore, type DesktopSession } from '@/stores/desktop-login'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

const store = useDesktopLoginStore()
const accountStore = useAccountStore()
const toast = useToastStore()

const autoLogin = ref(false)
const qqPath = ref('')
const activeTab = ref<'login' | 'sessions'>('login')
const pollTimer = ref<any>(null)
const openingFarmUin = ref('')
const bindingUin = ref('')
const pollIntervalMs = 2000

// 头像
function avatarUrl(uin: string) {
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : ''
}

// 时间格式化
function fmtTime(ts: number) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN')
}

// 状态标签
function statusBadge(s: DesktopSession) {
  if (s.status === 'online') return { text: '已登录', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' }
  if (s.status === 'login_failed') return { text: '登录失败', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' }
  if (s.pid) return { text: '进程存在', cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' }
  return { text: '离线', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' }
}

// ========== QR 扫码流程 ==========
async function startQR() {
  store.resetQrState()
  const ok = await store.fetchQR()
  if (ok) {
    startPolling()
  } else {
    toast.error(store.qrMessage)
  }
}

function startPolling() {
  stopPolling()
  pollTimer.value = setInterval(async () => {
    const result = await store.pollQrStatus()
    if (result?.done) {
      stopPolling()
      if (result.uin) {
        toast.success('扫码成功: ' + (result.nickname || result.uin))
      }
    }
  }, pollIntervalMs)
}

function stopPolling() {
  if (pollTimer.value) {
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }
}

async function doLaunch() {
  if (!store.loggedUin) {
    toast.warning('请先扫码')
    return
  }
  const ok = await store.launchQQ(store.loggedUin, store.loggedCookies, store.loggedNickname, autoLogin.value, qqPath.value)
  if (ok) {
    toast.success('QQ 已启动')
    activeTab.value = 'sessions'
  } else {
    toast.error(store.launchResult || '启动失败')
  }
}

// ========== Session 管理 ==========
async function handleStop(uin: string) {
  await store.stopQQ(uin)
  toast.info('已停止 QQ (uin: ' + uin + ')')
}

async function handleLaunchFromSession(s: DesktopSession) {
  const ok = await store.launchQQ(s.uin, '', s.nickname, s.autoLogin, s.qqPath || '')
  if (ok) {
    toast.success('QQ 已启动')
  } else {
    toast.error(store.launchResult || '启动失败')
  }
}

async function handleOpenFarm(uin: string) {
  if (openingFarmUin.value) return
  openingFarmUin.value = uin
  toast.info('正在获取新 Code...')
  try {
    const result = await store.openFarm(uin)
    if (result?.code) {
      if (result.codeRefresh?.ok) {
        toast.success('已更新code：' + String(result.code).slice(0, 8) + '...')
      } else if (result.codeRefresh && !result.codeRefresh.ok) {
        toast.warning('已抓到 Code，但实例未刷新：' + (result.codeRefresh.reason || '刷新失败'))
      } else {
        toast.success('已抓到农场 Code: ' + String(result.code).slice(0, 8) + '...')
      }
    } else if (result?.manualRequired) {
      toast.warning('抓包已启动，请手动打开 QQ 农场')
    } else if (result) {
      toast.warning('农场已打开，但暂未抓到 Code')
    } else {
      toast.error('打开农场失败')
    }
  } finally {
    openingFarmUin.value = ''
  }
}

async function handleBindCodeTarget(uin: string, accountId: string) {
  if (bindingUin.value) return
  bindingUin.value = uin
  try {
    const res = await store.bindCodeTarget(uin, accountId)
    if (res.ok) {
      const acc = accountStore.accounts.find(a => String(a.id) === String(accountId))
      if (!accountId) {
        toast.success('已取消绑定实例')
      } else if (acc?.running) {
        toast.success('已绑定运行中实例，后续每3分钟自动刷新 Code')
      } else {
        toast.success('已绑定未运行实例，请先手动获取 Code 启动实例')
      }
    } else {
      toast.error(res.error || '绑定失败')
      await store.fetchSessions()
    }
  } catch (e: any) {
    toast.error(e.response?.data?.error || e.message || '绑定失败')
    await store.fetchSessions()
  } finally {
    bindingUin.value = ''
  }
}

async function copyCode(code: string) {
  if (!code) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = code
      textarea.setAttribute('readonly', 'readonly')
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.top = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      textarea.setSelectionRange(0, code.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      if (!ok) throw new Error('copy failed')
    }
    toast.success('Code 已复制')
  } catch (e) {
    toast.warning('复制失败，请长按 Code 手动复制')
  }
}

async function handleDelete(uin: string) {
  await store.deleteSession(uin)
  toast.info('已删除记录')
}

// ========== 初始化 ==========
onMounted(() => {
  store.fetchSessions()
  accountStore.fetchAccounts()
})

onBeforeUnmount(() => {
  stopPolling()
})

useIntervalFn(() => {
  store.fetchSessions()
}, 5000)

const sessionsList = computed(() => store.sessions)
const bindableAccounts = computed(() => accountStore.accounts)
</script>
<template>
  <div class="mx-auto max-w-5xl p-4 sm:p-6">
    <div class="mb-6">
      <h1 class="flex items-center gap-2 text-2xl font-bold text-gray-800 dark:text-gray-100">
        <span class="i-carbon-qr-code text-2xl" style="color: var(--theme-primary)" />
        桌面登录
      </h1>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        扫码登录 QQ 桌面版，管理 QQ 进程与登录 Session
      </p>
    </div>

    <div class="mb-6 flex gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
      <button
        class="flex-1 rounded-lg px-4 py-2 text-sm font-medium transition"
        :class="activeTab === 'login'
          ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
          : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
        @click="activeTab = 'login'; store.resetQrState()"
      >
        <span class="i-carbon-qr-code mr-1 inline-block align-text-bottom" />
        扫码登录
      </button>
      <button
        class="flex-1 rounded-lg px-4 py-2 text-sm font-medium transition"
        :class="activeTab === 'sessions'
          ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
          : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
        @click="activeTab = 'sessions'"
      >
        <span class="i-carbon-list-boxes mr-1 inline-block align-text-bottom" />
        登录记录
        <span v-if="sessionsList.length" class="ml-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">{{ sessionsList.length }}</span>
      </button>
    </div>

    <div v-if="activeTab === 'login'">
      <div class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div v-if="store.qrStatus === 'idle'" class="flex flex-col items-center py-8">
          <div class="mb-4 text-6xl text-gray-300 dark:text-gray-600">
            <span class="i-carbon-qr-code" />
          </div>
          <p class="mb-4 text-sm text-gray-500 dark:text-gray-400">
            点击下方按钮生成 QQ 桌面版登录二维码
          </p>
          <BaseButton
            :style="{ backgroundColor: 'var(--theme-primary)', borderColor: 'var(--theme-primary)' }"
            class="text-white"
            @click="startQR"
          >
            <span class="i-carbon-qr-code mr-1" />
            生成二维码
          </BaseButton>
        </div>

        <div v-else-if="store.qrStatus === 'loading'" class="flex flex-col items-center py-8">
          <div class="mb-4 h-16 w-16 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
          <p class="text-sm text-gray-500 dark:text-gray-400">{{ store.qrMessage }}</p>
        </div>

        <div v-else class="flex flex-col items-center py-4">
          <div v-if="store.qrcode" class="mb-4 overflow-hidden rounded-xl border-2 border-gray-200 shadow-lg dark:border-gray-600">
            <img :src="store.qrcode" alt="QR Code" class="h-52 w-52 sm:h-60 sm:w-60">
          </div>

          <div class="mb-4 text-center">
            <div
              class="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm"
              :class="{
                'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400': store.qrStatus === 'ready',
                'bg-yellow-50 text-yellow-600 dark:bg-yellow-900/20 dark:text-yellow-400': store.qrStatus === 'waiting',
                'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400': store.qrStatus === 'success' || !!store.loggedUin,
                'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400': store.qrStatus === 'error',
              }"
            >
              <span
                class="h-2 w-2 rounded-full"
                :class="{
                  'bg-blue-500': store.qrStatus === 'ready',
                  'bg-yellow-500 animate-pulse': store.qrStatus === 'waiting',
                  'bg-green-500': store.qrStatus === 'success' || !!store.loggedUin,
                  'bg-red-500': store.qrStatus === 'error',
                }"
              />
              {{ store.qrMessage || '等待操作...' }}
            </div>
          </div>

          <div v-if="store.loggedUin" class="mb-4 w-full max-w-sm rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/10">
            <div class="flex items-center gap-3">
              <img
                :src="avatarUrl(store.loggedUin)"
                class="h-12 w-12 rounded-full border-2 border-white shadow"
                @error="($event.target as HTMLImageElement).src = ''"
              >
              <div>
                <p class="font-medium text-gray-900 dark:text-gray-100">{{ store.loggedNickname || '未知用户' }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">QQ: {{ store.loggedUin }}</p>
              </div>
            </div>
            <div class="mt-3">
              <BaseButton
                :style="{ backgroundColor: 'var(--theme-primary)', borderColor: 'var(--theme-primary)' }"
                class="w-full text-white"
                :loading="store.launching"
                @click="doLaunch"
              >
                <span class="i-carbon-play mr-1" />
                {{ store.launching ? '正在启动...' : '启动 QQ.exe 并自动登录' }}
              </BaseButton>
            </div>
            <p v-if="store.launchResult" class="mt-2 text-center text-xs text-gray-500">{{ store.launchResult }}</p>

          <!-- 自动登录选项 -->
          <div class="mt-3 flex items-center justify-center gap-2">
            <input
              id="autoLoginCheck"
              v-model="autoLogin"
              type="checkbox"
              class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            >
            <label for="autoLoginCheck" class="text-xs text-gray-500 dark:text-gray-400 select-none cursor-pointer">
              保存此登录记录（Bot 启动时不会自动拉起 QQ）
            </label>
          </div>
          </div>
          <!-- QQ 路径配置 -->
          <div class="mt-3">
            <label class="text-xs text-gray-400 block mb-1">QQ 路径（Windows 必填，macOS 无需填写）</label>
            <input
              v-model="qqPath"
              type="text"
              placeholder="Windows 必填，例如: D:\Program Files (x86)\QQ\QQ.exe"
              class="w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            >
          </div>

          <div class="flex gap-2">
            <button
              v-if="store.qrStatus !== 'success'"
              class="rounded-lg border border-gray-200 px-4 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
              @click="stopPolling(); store.resetQrState()"
            >
              取消
            </button>
            <button
              v-if="store.qrStatus === 'error'"
              class="rounded-lg px-4 py-1.5 text-sm text-white transition"
              :style="{ backgroundColor: 'var(--theme-primary)' }"
              @click="startQR"
            >
              重新生成
            </button>
          </div>
        </div>
      </div>

      <div class="mt-4 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        <p class="mb-1 font-medium text-gray-700 dark:text-gray-300">使用说明：</p>
        <ol class="ml-4 list-decimal space-y-1">
          <li>扫码登录用于通过桌面 QQ 抓取农场 Code，目前仅支持 1 个账号进行 Code 抓取。</li>
          <li>使用前请先到「设置」页面，为对应账号打开「踢下线后等待 Code」开关。</li>
          <li>点击「生成二维码」后扫码登录，登录过程中会拉起 QQ。</li>
          <li>QQ 拉起后，需要手动勾选 QQ 上的「自动登录」，并手动完成登录。</li>
          <li>登录成功后，系统会在「登录记录」中记录对应 QQ 进程。</li>
          <li>点击「登录记录」页面中的「运行农场」后，系统会自动抓取 Code 并完成农场登录。</li>
          <li>登录后会每 3 分钟自动刷新一次 Code；刷新时会重新拉起一次农场，并占用剪贴板。</li>
          <li>建议在服务器或不常用的电脑上运行挂机，避免影响日常使用。</li>
        </ol>
      </div>
    </div>

    <div v-if="activeTab === 'sessions'">
      <div v-if="!store.loadingSessions && sessionsList.length === 0" class="flex flex-col items-center rounded-xl border border-dashed border-gray-300 bg-white py-12 dark:border-gray-600 dark:bg-gray-800">
        <span class="mb-3 text-4xl text-gray-300 dark:text-gray-600 i-carbon-qr-code" />
        <p class="text-sm text-gray-400 dark:text-gray-500">暂无登录记录</p>
        <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">请先在「扫码登录」中完成登录</p>
      </div>

      <div v-else class="space-y-3">
        <div
          v-for="s in sessionsList"
          :key="s.uin"
          class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition dark:border-gray-700 dark:bg-gray-800 hover:shadow-md"
        >
          <div class="flex items-start justify-between">
            <div class="flex items-center gap-3">
              <img
                :src="avatarUrl(s.uin)"
                class="h-12 w-12 rounded-full border-2 border-white shadow"
                @error="($event.target as HTMLImageElement).src = ''"
              >
              <div>
                <div class="flex items-center gap-2">
                  <span class="font-medium text-gray-900 dark:text-gray-100">{{ s.nickname || '未知用户' }}</span>
                  <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="statusBadge(s).cls">{{ statusBadge(s).text }}</span>
                </div>
                <div class="mt-1 space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
                  <p>QQ: {{ s.uin }}</p>
                  <p class="flex items-center gap-1">
                    <input
                      type="checkbox"
                      :checked="s.autoLogin"
                      class="h-3 w-3 rounded border-gray-300 text-blue-600"
                      @change="store.toggleAutoLogin(s.uin, ($event.target as HTMLInputElement).checked)"
                    >
                    <span class="text-gray-400">自动登录</span>
                  </p>
                  <p v-if="s.pid">PID: {{ s.pid }}</p>
                  <p v-if="s.farmPids?.length">农场PID: {{ s.farmPids.join(', ') }}</p>
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-gray-400">刷新到实例:</span>
                    <select
                      class="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                      :value="s.boundAccountId || ''"
                      :disabled="bindingUin === s.uin"
                      @change="handleBindCodeTarget(s.uin, ($event.target as HTMLSelectElement).value)"
                    >
                      <option value="">不绑定</option>
                      <option
                        v-for="acc in bindableAccounts"
                        :key="acc.id"
                        :value="acc.id"
                      >
                        {{ acc.nick || acc.name || acc.id }}（{{ acc.running ? '运行中' : '未运行' }}）
                      </option>
                    </select>
                    <span v-if="s.boundAccountName" class="text-green-500">
                      每3分钟自动刷新
                    </span>
                  </div>
                  <p v-if="s.lastCodeRefreshAt" :class="s.lastCodeRefreshOk ? 'text-green-500' : 'text-red-400'">
                    实例Code刷新: {{ s.lastCodeRefreshOk ? '成功' : (s.lastCodeRefreshError || '失败') }} · {{ fmtTime(s.lastCodeRefreshAt) }}
                  </p>
                  <p>登录时间: {{ fmtTime(s.createdAt) }}</p>
                  <p class="text-xs">
                    <span v-if="s.farmCode" class="text-green-600 dark:text-green-400">
                      Code:
                      <span class="font-mono break-all select-all">{{ s.farmCode }}</span>
                      <button
                        class="ml-2 rounded border border-green-200 px-1.5 py-0.5 text-[11px] text-green-600 hover:bg-green-50 dark:border-green-800 dark:hover:bg-green-900/20"
                        @click="copyCode(s.farmCode || '')"
                      >
                        复制
                      </button>
                      <span v-if="s.lastCapturedAt" class="text-gray-400 ml-1">{{ fmtTime(s.lastCapturedAt) }}</span>
                    </span>
                    <span v-else class="text-red-400">Code: 未捕获到</span>
                  </p>
                  <p>最后活跃: {{ fmtTime(s.lastActiveAt) }}</p>
                </div>
              </div>
            </div>

            <div class="flex gap-2">
              <button
                v-if="!s.pid"
                class="rounded-lg border border-green-200 px-3 py-1 text-xs text-green-500 transition dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-900/20"
                @click="handleLaunchFromSession(s)"
              >
                启动
              </button>
              <button
                v-if="s.pid"
                class="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-500 transition dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
                @click="handleStop(s.uin)"
              >
                停止
              </button>
              <button
                v-if="s.pid && s.status === 'online'"
                class="rounded-lg border border-green-200 px-3 py-1 text-xs text-green-600 transition disabled:cursor-not-allowed disabled:opacity-60 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-900/20"
                :disabled="!!openingFarmUin"
                @click="handleOpenFarm(s.uin)"
              >
                {{ openingFarmUin === s.uin ? '运行中...' : '运行农场' }}
              </button>
              <button
                v-if="!s.pid || s.status === 'offline'"
                class="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-500 transition dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                @click="handleDelete(s.uin)"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
