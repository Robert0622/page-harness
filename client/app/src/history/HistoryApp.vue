<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChatMeta, ServerMsg, TurnView } from '@shared/protocol'
import { applyEvent } from '@shared/turns'
import AgentBadge from '../components/AgentBadge.vue'
import Icon from '../components/Icon.vue'
import TurnBlock from '../components/TurnBlock.vue'
import { brand } from '../lib/agents'
import { api } from '../lib/api'
import { fmt, lang, relTime, setLang, t } from '../lib/i18n'
import { theme } from '../lib/theme'
import { createSocket } from '../lib/ws'

interface Hit {
  chatId: string
  title: string
  turnId: string
  ts: number
  role: 'user' | 'agent'
  snippet: string
}

const chats = ref<ChatMeta[]>([])
const current = ref<ChatMeta | null>(null)
const turns = ref<TurnView[]>([])
const hasMore = ref(false)
const loading = ref(false)
const q = ref('')
const hits = ref<Hit[] | null>(null)
const searching = ref(false)
const hint = ref('')
const now = ref(Date.now())
const lightbox = ref<string | null>(null)
const main = ref<HTMLElement>()
const timer = setInterval(() => (now.value = Date.now()), 30_000)

const sock = createSocket(
  (m: ServerMsg) => {
    if (m.type === 'chats') chats.value = m.chats
    else if (m.type === 'snapshot' && m.snapshot.chat.id === current.value?.id) {
      current.value = m.snapshot.chat
      // Keep older pages already loaded; replace the tail with the fresh snapshot.
      const first = m.snapshot.turns[0]?.id
      const idx = first ? turns.value.findIndex((x) => x.id === first) : -1
      turns.value = idx >= 0 ? [...turns.value.slice(0, idx), ...m.snapshot.turns] : m.snapshot.turns
      if (idx < 0) hasMore.value = m.snapshot.hasMore
    } else if (m.type === 'event' && m.event.chatId === current.value?.id) {
      applyEvent(turns.value, m.event)
      turns.value = [...turns.value]
    } else if (m.type === 'state' && m.chatId === current.value?.id) current.value = m.chat
  },
  () => {
    sock.send({ type: 'subscribe', chat: current.value?.id ?? null, role: 'history' })
  },
)

async function refreshChats() {
  chats.value = await api.get<ChatMeta[]>('chats')
}

async function select(id: string, turnId?: string) {
  if (current.value?.id !== id) {
    loading.value = true
    try {
      const snap = await api.get<{ chat: ChatMeta; turns: TurnView[]; hasMore: boolean }>(`chats/${id}`)
      current.value = snap.chat
      turns.value = snap.turns
      hasMore.value = snap.hasMore
    } finally {
      loading.value = false
    }
    sock.send({ type: 'subscribe', chat: id, role: 'history' })
  }
  history.replaceState(null, '', `#chat=${id}${turnId ? `&turn=${turnId}` : ''}`)
  if (turnId) {
    for (let i = 0; i < 20 && !turns.value.some((x) => x.id === turnId) && hasMore.value; i++) await older(200)
    await nextTick()
    const el = main.value?.querySelector<HTMLElement>(`[data-turn="${turnId}"]`)
    el?.scrollIntoView({ block: 'start' })
    el?.classList.add('flash')
    setTimeout(() => el?.classList.remove('flash'), 1600)
  } else {
    await nextTick()
    main.value?.scrollTo({ top: main.value.scrollHeight })
  }
}

async function older(limit = 20) {
  if (!current.value || !hasMore.value || !turns.value.length) return
  const el = main.value
  const before = el ? el.scrollHeight - el.scrollTop : 0
  const r = await api.get<{ turns: TurnView[]; hasMore: boolean }>(`chats/${current.value.id}/turns?before=${turns.value[0].id}&limit=${limit}`)
  turns.value = [...r.turns, ...turns.value]
  hasMore.value = r.hasMore
  await nextTick()
  if (el) el.scrollTop = el.scrollHeight - before
}

let searchTimer = 0
watch(q, (v) => {
  clearTimeout(searchTimer)
  if (!v.trim()) {
    hits.value = null
    return
  }
  searchTimer = window.setTimeout(async () => {
    searching.value = true
    try {
      hits.value = await api.get<Hit[]>(`search?q=${encodeURIComponent(v.trim())}`)
    } finally {
      searching.value = false
    }
  }, 200)
})

function highlight(s: string): string {
  const esc = s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const needle = q.value.trim()
  if (!needle) return esc
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!), 'gi')
  return esc.replace(re, (m) => `<mark>${m}</mark>`)
}

// Keep the channel alive. A channel created only for one postMessage can be collected before the
// other page receives it, so "Continue in panel" would show the hint and leave the open chat unchanged.
const panelChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ph-panel') : null

function continueInPanel() {
  if (!current.value) return
  const id = current.value.id
  try {
    localStorage.setItem('ph:chat', id)
    localStorage.setItem('ph:chat-switch', JSON.stringify({ id, ts: Date.now() }))
  } catch {}
  panelChannel?.postMessage({ type: 'switch-chat', id })
  sock.send({ type: 'focus_chat', id })
  hint.value = t.value.continueHint
  setTimeout(() => (hint.value = ''), 4000)
}
async function remove() {
  if (!current.value || !confirm(t.value.confirmDelete)) return
  await api.del(`chats/${current.value.id}`)
  current.value = null
  turns.value = []
  history.replaceState(null, '', '#')
  await refreshChats()
}

const totals = computed(() => {
  let ms = 0
  let tok = 0
  for (const x of turns.value) {
    ms += x.durationMs ?? 0
    tok += (x.usage?.inputTokens ?? 0) + (x.usage?.outputTokens ?? 0)
  }
  return { ms, tok }
})

onMounted(async () => {
  await refreshChats()
  const m = /chat=([\w-]+)(?:&turn=([\w-]+))?/.exec(location.hash)
  if (m) await select(m[1], m[2])
})
onBeforeUnmount(() => {
  clearInterval(timer)
  panelChannel?.close()
  sock.close()
})
</script>

<template>
  <div class="hist">
    <aside>
      <div class="brand"><i />Page Harness <span class="faint">· {{ t.history }}</span></div>
      <div class="search">
        <Icon name="search" />
        <input v-model="q" class="input" :placeholder="t.search" data-testid="history-search" />
      </div>
      <div v-if="hits" class="list">
        <div class="cnt faint">{{ searching ? '…' : hits.length ? fmt(t.results, { n: hits.length }) : t.noResults }}</div>
        <button v-for="(h, i) in hits" :key="i" class="item hit" @click="select(h.chatId, h.turnId || undefined)">
          <span class="tt">{{ h.title || t.untitled }}</span>
          <span class="snip" v-html="highlight(h.snippet)" />
          <span class="meta faint">{{ h.role === 'user' ? t.you : 'Agent' }} · {{ relTime(h.ts, now) }}</span>
        </button>
      </div>
      <div v-else class="list">
        <div v-if="!chats.length" class="cnt faint">{{ t.noChats }}</div>
        <button v-for="c in chats" :key="c.id" class="item" :class="{ on: c.id === current?.id }" :data-chat="c.id" @click="select(c.id)">
          <span class="tt">{{ c.title || t.untitled }}</span>
          <span v-if="c.preview" class="snip">{{ c.preview }}</span>
          <span class="meta faint"><AgentBadge :id="c.agent" size="xs" /><span class="mt">{{ brand(c.agent).short }} · {{ fmt(t.turns, { n: c.turns }) }} · {{ relTime(c.updatedAt, now) }}</span></span>
        </button>
      </div>
      <div class="foot">
        <button class="btn ghost sm" @click="setLang(lang === 'en' ? 'zh-CN' : 'en')">{{ lang === 'en' ? '中文' : 'English' }}</button>
        <button class="btn ghost icon sm" @click="theme = theme === 'dark' ? 'light' : 'dark'"><Icon :name="theme === 'dark' ? 'sun' : 'moon'" /></button>
      </div>
    </aside>
    <section>
      <template v-if="current">
        <header>
          <div class="ttl">
            <h1>{{ current.title || t.untitled }}</h1>
            <div class="faint sub">
              {{ brand(current.agent).short }}{{ current.model ? ` · ${current.model}` : '' }} · {{ fmt(t.turns, { n: current.turns }) }} · {{ new Date(current.createdAt).toLocaleString() }}
              <template v-if="totals.tok"> · {{ totals.tok.toLocaleString() }} {{ t.tokens }}</template>
            </div>
          </div>
          <button class="btn sm" data-testid="continue" @click="continueInPanel"><Icon name="external" />{{ t.continueInPanel }}</button>
          <a class="btn sm" :href="`/__ph/api/chats/${current.id}/export.md`" data-testid="export"><Icon name="download" />{{ t.exportMd }}</a>
          <button class="btn sm danger icon" :title="t.delete" @click="remove"><Icon name="trash" /></button>
        </header>
        <div v-if="hint" class="hint">{{ hint }}</div>
        <main ref="main">
          <div class="older">
            <button v-if="hasMore" class="btn ghost sm" @click="older()">{{ t.loadOlder }}</button>
          </div>
          <div v-if="loading" class="center"><span class="spin" /></div>
          <TurnBlock v-for="turn in turns" :key="turn.id" :turn="turn" :interactive="false" :now="now" @image="lightbox = $event" />
        </main>
      </template>
      <div v-else class="center muted">{{ t.selectChat }}</div>
    </section>
    <div v-if="lightbox" class="lightbox" @click="lightbox = null"><img :src="lightbox" alt="" /></div>
  </div>
</template>

<style scoped>
.hist { height: 100%; display: grid; grid-template-columns: 320px 1fr; }
aside { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; background: var(--bg2); }
.brand { display: flex; align-items: center; gap: 8px; padding: 14px 14px 8px; font-weight: 700; font-size: 14px; }
.brand i { width: 10px; height: 10px; border-radius: 3px; background: var(--accent); transform: rotate(45deg); }
.search { position: relative; padding: 4px 12px 8px; }
.search svg { position: absolute; left: 22px; top: 12px; width: 14px; height: 14px; color: var(--fg3); }
.search .input { width: 100%; padding-left: 30px; }
.list { flex: 1; overflow: auto; padding: 4px 8px; display: flex; flex-direction: column; gap: 2px; }
.cnt { padding: 4px 6px; font-size: 12px; }
.item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; border: 0; background: none; padding: 8px; border-radius: 8px; }
.item:hover { background: var(--bg3); }
.item.on { background: var(--accent-soft); }
.tt { font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.snip { font-size: 12px; color: var(--fg2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.snip :deep(mark) { background: color-mix(in srgb, var(--accent) 30%, transparent); color: inherit; border-radius: 2px; }
.meta { display: flex; align-items: center; gap: 4px; max-width: 100%; font-size: 11px; }
.mt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot { display: flex; justify-content: space-between; padding: 8px 12px; border-top: 1px solid var(--line); }
section { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
header { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
header a { color: var(--fg); text-decoration: none; }
.ttl { flex: 1; min-width: 0; }
h1 { margin: 0; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 12px; }
.hint { padding: 6px 20px; background: var(--accent-soft); font-size: 12px; }
main { flex: 1; overflow: auto; padding: 0 8px 40px; }
main :deep(.turn) { max-width: 860px; margin: 0 auto; border-bottom: 1px solid var(--line); }
main :deep(.turn.flash) { animation: flash 1.6s; }
@keyframes flash { 0%, 40% { background: var(--accent-soft); } 100% { background: transparent; } }
.older { display: flex; justify-content: center; padding: 8px; }
.center { display: flex; align-items: center; justify-content: center; height: 100%; padding: 24px; }
@media (max-width: 720px) { .hist { grid-template-columns: 1fr; } aside { max-height: 40vh; } }
</style>
