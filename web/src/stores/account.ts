import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export interface Account {
  id: string
  name: string
  nick?: string
  uin?: number
  platform?: string
  running?: boolean
  keepRunningOnKickout?: boolean
  // Add other fields as discovered
}

export interface AccountLog {
  time: string
  action: string
  msg: string
  reason?: string
}

export function getPlatformLabel(p?: string) {
  if (p === 'qq')
    return 'QQ'
  if (p === 'wx')
    return '微信'
  return ''
}

export function getPlatformClass(p?: string) {
  if (p === 'qq')
    return 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
  if (p === 'wx')
    return 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
  return ''
}

export const useAccountStore = defineStore('account', () => {
  const accounts = ref<Account[]>([])
  const currentAccountId = useStorage('current_account_id', '')
  const loading = ref(false)
  const logs = ref<AccountLog[]>([])
  let latestAccountsRequest = 0

  const currentAccount = computed(() =>
    accounts.value.find(a => String(a.id) === currentAccountId.value),
  )

  async function fetchAccounts() {
    const requestId = ++latestAccountsRequest
    loading.value = true
    try {
      // api interceptor adds x-admin-token
      const res = await api.get('/api/accounts')
      if (requestId !== latestAccountsRequest)
        return
      const nextAccounts = res.data?.ok && Array.isArray(res.data.data?.accounts)
        ? res.data.data.accounts
        : null
      if (nextAccounts) {
        accounts.value = nextAccounts

        // Auto-select first account if none selected or selected not found
        if (accounts.value.length > 0) {
          const found = accounts.value.find(a => String(a.id) === currentAccountId.value)
          if (!found && accounts.value[0]) {
            currentAccountId.value = String(accounts.value[0].id)
          }
        }
        else {
          // 如果账号列表为空，清空当前选中的账号ID
          currentAccountId.value = ''
        }
      }
    }
    catch (e) {
      console.error('获取账号失败', e)
      // 临时网络错误不能清空最后一次成功快照，否则所有依赖账号的页面都会失去上下文。
    }
    finally {
      if (requestId === latestAccountsRequest)
        loading.value = false
    }
  }

  function selectAccount(id: string) {
    currentAccountId.value = id
  }

  function setCurrentAccount(acc: Account) {
    selectAccount(acc.id)
  }

  async function startAccount(id: string) {
    await api.post(`/api/accounts/${id}/start`)
    await fetchAccounts()
  }

  async function stopAccount(id: string) {
    await api.post(`/api/accounts/${id}/stop`)
    await fetchAccounts()
  }

  async function deleteAccount(id: string) {
    await api.delete(`/api/accounts/${id}`)
    if (currentAccountId.value === id) {
      currentAccountId.value = ''
    }
    await fetchAccounts()
  }

  async function fetchLogs() {
    try {
      const res = await api.get('/api/account-logs?limit=100')
      if (Array.isArray(res.data)) {
        logs.value = res.data
      }
    }
    catch (e) {
      console.error('获取账号日志失败', e)
    }
  }

  async function addAccount(payload: any) {
    try {
      await api.post('/api/accounts', payload)
      await fetchAccounts()
    }
    catch (e) {
      console.error('添加账号失败', e)
      throw e
    }
  }

  async function updateAccount(id: string, payload: any) {
    try {
      // core uses POST /api/accounts for both add and update (if id is present)
      await api.post('/api/accounts', { ...payload, id })
      await fetchAccounts()
    }
    catch (e) {
      console.error('更新账号失败', e)
      throw e
    }
  }

  async function setKickoutCodeRefresh(id: string, enabled: boolean) {
    try {
      await api.post(`/api/accounts/${id}/kickout-code-refresh`, { enabled })
      await fetchAccounts()
    }
    catch (e) {
      console.error('保存踢下线刷新开关失败', e)
      throw e
    }
  }

  return {
    accounts,
    currentAccountId,
    currentAccount,
    loading,
    logs,
    fetchAccounts,
    selectAccount,
    startAccount,
    stopAccount,
    deleteAccount,
    fetchLogs,
    addAccount,
    updateAccount,
    setKickoutCodeRefresh,
    setCurrentAccount,
  }
})
