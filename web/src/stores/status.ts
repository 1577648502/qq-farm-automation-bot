import type { Socket } from 'socket.io-client'
import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { ref } from 'vue'
import api from '@/api'

// Define interfaces for better type checking
interface DailyGift {
  key: string
  label: string
  enabled?: boolean
  doneToday: boolean
  lastAt?: number
  completedCount?: number
  totalCount?: number
  tasks?: any[]
}

interface DailyGiftsResponse {
  date: string
  growth: DailyGift
  gifts: DailyGift[]
}

export const useStatusStore = defineStore('status', () => {
  const status = ref<any>(null)
  const logs = ref<any[]>([])
  const accountLogs = ref<any[]>([])
  const dailyGifts = ref<DailyGiftsResponse | null>(null)
  const loading = ref(false)
  const error = ref('')
  const logsLoading = ref(false)
  const logsError = ref('')
  const realtimeConnected = ref(false)
  const realtimeLogsEnabled = ref(true)
  const currentRealtimeAccountId = ref('')
  const tokenRef = useStorage('admin_token', '')

  let socket: Socket | null = null
  let latestLogsRequest = 0
  let latestStatusRequest = 0
  let latestDailyGiftsRequest = 0
  let latestAccountLogsRequest = 0

  function normalizeAccountId(accountId: any) {
    return String(accountId || '').trim()
  }

  function payloadMatchesCurrentAccount(payload: any) {
    const current = normalizeAccountId(currentRealtimeAccountId.value)
    if (!current)
      return true
    const actual = normalizeAccountId(payload && payload.accountId)
    return actual === current
  }

  function filterLogsForAccount(list: any[], accountId: string) {
    const current = normalizeAccountId(accountId)
    if (!current || current === 'all')
      return list
    return list.filter(entry => normalizeAccountId(entry?.accountId) === current)
  }

  function responseMatchesTarget(response: any, targetAccountId: string) {
    const target = normalizeAccountId(targetAccountId)
    if (!target || target === 'all')
      return true
    const actual = normalizeAccountId(
      response && (response.accountId || response.data?.accountId),
    )
    return !actual || actual === target
  }

  function requestMatchesCurrentAccount(requestId: number, latestRequest: number, targetAccountId: string) {
    if (requestId !== latestRequest)
      return false
    const current = normalizeAccountId(currentRealtimeAccountId.value)
    const target = normalizeAccountId(targetAccountId)
    return !current || target === 'all' || current === target
  }

  function normalizeStatusPayload(input: any) {
    return (input && typeof input === 'object') ? { ...input } : {}
  }

  function normalizeLogEntry(input: any) {
    const entry = (input && typeof input === 'object') ? { ...input } : {}
    const ts = Number(entry.ts) || Date.parse(String(entry.time || '')) || Date.now()
    return {
      ...entry,
      ts,
      time: entry.time || new Date(ts).toISOString().replace('T', ' ').slice(0, 19),
    }
  }

  function pushRealtimeLog(entry: any) {
    const next = normalizeLogEntry(entry)
    logs.value.push(next)
    if (logs.value.length > 1000)
      logs.value = logs.value.slice(-1000)
  }

  function pushRealtimeAccountLog(entry: any) {
    const next = (entry && typeof entry === 'object') ? entry : {}
    accountLogs.value.push(next)
    if (accountLogs.value.length > 300)
      accountLogs.value = accountLogs.value.slice(-300)
  }

  function handleRealtimeStatus(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = normalizeAccountId(body.accountId)
    const current = normalizeAccountId(currentRealtimeAccountId.value)
    if (current && accountId !== current)
      return
    if (body.status && typeof body.status === 'object') {
      status.value = normalizeStatusPayload(body.status)
      error.value = ''
    }
  }

  function handleRealtimeLog(payload: any) {
    if (!realtimeLogsEnabled.value || !payloadMatchesCurrentAccount(payload))
      return
    pushRealtimeLog(payload)
  }

  function handleRealtimeAccountLog(payload: any) {
    if (!payloadMatchesCurrentAccount(payload))
      return
    pushRealtimeAccountLog(payload)
  }

  function handleRealtimeLogsSnapshot(payload: any) {
    if (!realtimeLogsEnabled.value)
      return
    const body = (payload && typeof payload === 'object') ? payload : {}
    if (!payloadMatchesCurrentAccount(body))
      return
    const list = Array.isArray(body.logs) ? body.logs : []
    logs.value = filterLogsForAccount(list, currentRealtimeAccountId.value)
      .map((item: any) => normalizeLogEntry(item))
    logsError.value = ''
  }

  function handleRealtimeAccountLogsSnapshot(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const list = Array.isArray(body.logs) ? body.logs : []
    const current = normalizeAccountId(currentRealtimeAccountId.value)
    const snapshotAccountId = normalizeAccountId(body.accountId)
    if (current && snapshotAccountId && snapshotAccountId !== current)
      return

    const next = filterLogsForAccount(list, current)
    // 兼容不带 accountId 的旧版快照: 空结果可能来自上一个账号, 不覆盖已加载的新账号日志。
    if (current && !snapshotAccountId && next.length === 0 && accountLogs.value.length > 0)
      return
    accountLogs.value = next
  }

  function ensureRealtimeSocket() {
    if (socket)
      return socket

    socket = io('/', {
      path: '/socket.io',
      autoConnect: false,
      transports: ['websocket'],
      auth: {
        token: tokenRef.value,
      },
    })

    socket.on('connect', () => {
      realtimeConnected.value = true
      if (currentRealtimeAccountId.value) {
        socket?.emit('subscribe', { accountId: currentRealtimeAccountId.value })
      }
      else {
        socket?.emit('subscribe', { accountId: 'all' })
      }
    })

    socket.on('disconnect', () => {
      realtimeConnected.value = false
    })

    socket.on('connect_error', (err) => {
      realtimeConnected.value = false
      console.error('[realtime] 连接失败:', err.message)
    })

    socket.on('status:update', handleRealtimeStatus)
    socket.on('log:new', handleRealtimeLog)
    socket.on('account-log:new', handleRealtimeAccountLog)
    socket.on('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.on('account-logs:snapshot', handleRealtimeAccountLogsSnapshot)
    return socket
  }

  function connectRealtime(accountId: string) {
    const normalizedAccountId = normalizeAccountId(accountId)
    if (currentRealtimeAccountId.value !== normalizedAccountId) {
      latestStatusRequest += 1
      latestLogsRequest += 1
      latestDailyGiftsRequest += 1
      latestAccountLogsRequest += 1
      status.value = null
      logs.value = []
      accountLogs.value = []
      dailyGifts.value = null
      error.value = ''
      loading.value = false
      logsError.value = ''
      logsLoading.value = false
    }
    currentRealtimeAccountId.value = normalizedAccountId
    if (!tokenRef.value)
      return

    const client = ensureRealtimeSocket()
    client.auth = {
      token: tokenRef.value,
      accountId: currentRealtimeAccountId.value || 'all',
    }

    if (client.connected) {
      client.emit('subscribe', { accountId: currentRealtimeAccountId.value || 'all' })
      return
    }
    client.connect()
  }

  function disconnectRealtime() {
    if (!socket)
      return
    socket.off('connect')
    socket.off('disconnect')
    socket.off('connect_error')
    socket.off('status:update', handleRealtimeStatus)
    socket.off('log:new', handleRealtimeLog)
    socket.off('account-log:new', handleRealtimeAccountLog)
    socket.off('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.off('account-logs:snapshot', handleRealtimeAccountLogsSnapshot)
    socket.disconnect()
    socket = null
    realtimeConnected.value = false
  }

  async function fetchStatus(accountId: string) {
    const normalizedAccountId = normalizeAccountId(accountId)
    if (!normalizedAccountId)
      return
    const requestId = ++latestStatusRequest
    const isCurrentRequest = () => requestMatchesCurrentAccount(
      requestId,
      latestStatusRequest,
      normalizedAccountId,
    )
    loading.value = true
    try {
      const { data } = await api.get('/api/status', {
        headers: { 'x-account-id': normalizedAccountId },
      })
      if (!isCurrentRequest() || !responseMatchesTarget(data, normalizedAccountId))
        return
      if (data.ok) {
        status.value = normalizeStatusPayload(data.data)
        error.value = ''
      }
      else {
        error.value = data.error
      }
    }
    catch (e: any) {
      if (isCurrentRequest())
        error.value = e.message
    }
    finally {
      if (requestId === latestStatusRequest)
        loading.value = false
    }
  }

  async function fetchLogs(accountId: string, options: any = {}) {
    const targetAccountId = normalizeAccountId(accountId) || normalizeAccountId(options.accountId) || 'all'
    if (!accountId && targetAccountId !== 'all')
      return
    const requestId = ++latestLogsRequest
    const params: any = { limit: 100, ...options }
    const headers: any = {}
    if (targetAccountId !== 'all') {
      headers['x-account-id'] = targetAccountId
    }
    else {
      params.accountId = 'all'
    }

    logsLoading.value = true
    logsError.value = ''
    try {
      const { data } = await api.get('/api/logs', { headers, params })
      if (!requestMatchesCurrentAccount(requestId, latestLogsRequest, targetAccountId)
        || !responseMatchesTarget(data, targetAccountId)) {
        return
      }
      if (data.ok) {
        logs.value = filterLogsForAccount(Array.isArray(data.data) ? data.data : [], targetAccountId)
        logsError.value = ''
      }
      else {
        logsError.value = data?.error || '日志加载失败'
      }
    }
    catch (e: any) {
      if (requestMatchesCurrentAccount(requestId, latestLogsRequest, targetAccountId)) {
        logsError.value = e?.response?.data?.error || e?.message || '日志加载失败'
      }
    }
    finally {
      if (requestId === latestLogsRequest)
        logsLoading.value = false
    }
  }

  async function fetchDailyGifts(accountId: string) {
    const normalizedAccountId = normalizeAccountId(accountId)
    if (!normalizedAccountId)
      return
    const requestId = ++latestDailyGiftsRequest
    const isCurrentRequest = () => requestMatchesCurrentAccount(
      requestId,
      latestDailyGiftsRequest,
      normalizedAccountId,
    )
    try {
      const { data } = await api.get('/api/daily-gifts', {
        headers: { 'x-account-id': normalizedAccountId },
      })
      if (!isCurrentRequest() || !responseMatchesTarget(data, normalizedAccountId))
        return
      if (data.ok) {
        dailyGifts.value = data.data
      }
    }
    catch (e) {
      if (isCurrentRequest())
        console.error('获取每日奖励失败', e)
    }
  }

  async function fetchAccountLogs(limit = 100) {
    const targetAccountId = normalizeAccountId(currentRealtimeAccountId.value)
    const requestId = ++latestAccountLogsRequest
    if (!targetAccountId) {
      accountLogs.value = []
      return
    }
    const isCurrentRequest = () => requestId === latestAccountLogsRequest
      && normalizeAccountId(currentRealtimeAccountId.value) === targetAccountId
    try {
      const res = await api.get(`/api/account-logs?limit=${Math.max(1, Number(limit) || 100)}`, {
        headers: { 'x-account-id': targetAccountId },
      })
      if (!isCurrentRequest())
        return
      if (Array.isArray(res.data)) {
        accountLogs.value = filterLogsForAccount(res.data, targetAccountId)
      }
    }
    catch (e) {
      if (isCurrentRequest())
        console.error(e)
    }
  }

  function setRealtimeLogsEnabled(enabled: boolean) {
    realtimeLogsEnabled.value = !!enabled
  }

  return {
    status,
    logs,
    accountLogs,
    dailyGifts,
    loading,
    error,
    logsLoading,
    logsError,
    realtimeConnected,
    realtimeLogsEnabled,
    fetchStatus,
    fetchLogs,
    fetchAccountLogs,
    fetchDailyGifts,
    setRealtimeLogsEnabled,
    connectRealtime,
    disconnectRealtime,
  }
})
