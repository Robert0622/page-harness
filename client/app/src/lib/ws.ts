// Reconnecting WebSocket to /__ph/ws.
import { ref } from 'vue'
import type { ClientMsg, ServerMsg } from '@shared/protocol'

export type ConnState = 'connecting' | 'ready' | 'error'

export function createSocket(onMessage: (m: ServerMsg) => void, onOpen: () => void) {
  const state = ref<ConnState>('connecting')
  const failures = ref(0)
  let ws: WebSocket | null = null
  let timer = 0
  let ping = 0
  let closed = false

  const connect = () => {
    if (closed) return
    if (failures.value > 0) state.value = failures.value > 2 ? 'error' : 'connecting'
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/__ph/ws`)
    ws.onopen = () => {
      failures.value = 0
      state.value = 'ready'
      onOpen()
      clearInterval(ping)
      ping = window.setInterval(() => send({ type: 'ping' }), 25_000)
    }
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data as string) as ServerMsg)
      } catch (err) {
        console.error('[page-harness] bad message', err)
      }
    }
    ws.onclose = () => {
      clearInterval(ping)
      if (closed) return
      failures.value++
      state.value = failures.value > 2 ? 'error' : 'connecting'
      clearTimeout(timer)
      timer = window.setTimeout(connect, Math.min(8000, 400 * 2 ** Math.min(failures.value, 5)))
    }
  }

  const send = (m: ClientMsg) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(m))
      return true
    }
    return false
  }

  connect()
  return {
    state,
    failures,
    send,
    reconnect() {
      failures.value = 0
      ws?.close()
      clearTimeout(timer)
      connect()
    },
    close() {
      closed = true
      ws?.close()
    },
  }
}
