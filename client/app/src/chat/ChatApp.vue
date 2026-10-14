<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AgentBadge from '../components/AgentBadge.vue'
import Icon from '../components/Icon.vue'
import TurnBlock from '../components/TurnBlock.vue'
import { fmt, t } from '../lib/i18n'
import ChatSwitcher from './ChatSwitcher.vue'
import Composer from './Composer.vue'
import QueueList from './QueueList.vue'
import ReviewerPanel from './ReviewerPanel.vue'
import SettingsMenu from './SettingsMenu.vue'
import { createChatStore } from './store'

const s = createChatStore()
const list = ref<HTMLElement>()
const sentinel = ref<HTMLElement>()
const atBottom = ref(true)
const unread = ref(false)
const lightbox = ref<string | null>(null)
const now = ref(Date.now())
const timer = setInterval(() => (now.value = Date.now()), 30_000)

const openLive = computed(() => s.liveSessions.value.filter((x) => x.status !== 'accepted' && x.status !== 'discarded'))
const discardableLive = computed(() => openLive.value.filter((x) => x.status !== 'accepting' && x.status !== 'discarding'))
const failedLive = computed(() => openLive.value.filter((x) => x.status === 'failed'))
/** Newest request turn of each Live session. */
const latestLive = computed(() => {
  const m = new Map<string, string>()
  for (const turn of s.turns.value) if (turn.user.live?.sid) m.set(turn.user.live.sid, turn.id)
  return m
})
const agent = computed(() => s.agents.value.find((a) => a.id === s.chat.value?.agent))
const unreadFrom = ref(0)
const newCount = computed(() => Math.max(1, s.turns.value.length - unreadFrom.value))
watch(
  () => s.chat.value?.agent,
  (a) => a && s.loadModels(a),
  { immediate: true },
)

const scrollToBottom = (smooth = false) => {
  const el = list.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  unread.value = false
}
let lastTop = 0
const onScroll = () => {
  const el = list.value
  if (!el) return
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  // Content can grow between a programmatic scroll and its event; only an upward scroll unpins.
  if (near) atBottom.value = true
  else if (el.scrollTop < lastTop - 1) atBottom.value = false
  lastTop = el.scrollTop
  if (atBottom.value) unread.value = false
}

// Follow new output only when the user is already at the bottom.
watch(
  () => {
    const last = s.turns.value[s.turns.value.length - 1]
    return [s.turns.value.length, last?.lastSeq, last?.items.length]
  },
  () => {
    const follow = atBottom.value
    nextTick(() => {
      if (follow) scrollToBottom()
      else if (!unread.value) {
        unread.value = true
        unreadFrom.value = s.turns.value.length - 1
      }
    })
  },
)
watch(
  () => s.chat.value?.id,
  () => nextTick(() => scrollToBottom()),
)

// Keep the scroll position when older turns are prepended.
async function loadOlder() {
  const el = list.value
  if (!el || s.loadingOlder.value || !s.hasMore.value) return
  const before = el.scrollHeight - el.scrollTop
  await s.loadOlder()
  await nextTick()
  el.scrollTop = el.scrollHeight - before
}
let io: IntersectionObserver | null = null
// The list shrinks when the queue or a taller composer appears; stay pinned to the bottom.
const ro = new ResizeObserver(() => atBottom.value && scrollToBottom())
onMounted(() => {
  io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadOlder(), { root: list.value, rootMargin: '120px' })
  if (sentinel.value) io.observe(sentinel.value)
  if (list.value) ro.observe(list.value)
})
onBeforeUnmount(() => {
  io?.disconnect()
  ro.disconnect()
  clearInterval(timer)
})

function discardAll() {
  const xs = discardableLive.value
  // Failed sets have nothing worth keeping; anything else may be work the user still wants.
  if (xs.some((x) => x.status !== 'failed') && !confirm(fmt(t.value.confirmDiscardAll, { n: xs.length }))) return
  for (const x of xs) s.live({ op: 'discard', sid: x.sid })
}
function clearFailed() {
  for (const x of failedLive.value) s.live({ op: 'discard', sid: x.sid })
}
</script>

<template>
  <ReviewerPanel v-if="s.me.value?.access === 'reviewer'" :store="s" />
  <div v-else class="chat-app">
    <header>
      <ChatSwitcher :store="s" />
      <button class="btn ghost icon" :title="t.newChat" @click="s.newChat()"><Icon name="plus" /></button>
      <SettingsMenu :store="s" />
    </header>
    <div v-if="openLive.length" class="livebar">
      <Icon name="sparkle" />
      <span>{{ fmt(t.liveActive, { n: openLive.length }) }}</span>
      <span class="spacer" />
      <button v-if="failedLive.length" class="btn sm" :title="t.clearFailedHint" data-testid="live-clear-failed" @click="clearFailed">{{ fmt(t.clearFailed, { n: failedLive.length }) }}</button>
      <button v-if="discardableLive.length" class="btn sm" :title="t.discardAllHint" data-testid="live-discard-all" @click="discardAll">{{ fmt(t.discardAll, { n: discardableLive.length }) }}</button>
    </div>

    <div v-if="s.conn.value !== 'ready'" class="conn" :class="s.conn.value" data-testid="conn">
      <span v-if="s.conn.value === 'connecting'" class="spin" />
      <span>{{ s.conn.value === 'connecting' ? t.connecting : t.netError }}</span>
      <button v-if="s.conn.value === 'error'" class="btn sm" @click="s.reconnect()">{{ t.retryNow }}</button>
    </div>

    <main ref="list" class="list" @scroll="onScroll">
      <div ref="sentinel" class="sentinel">
        <span v-if="s.loadingOlder.value" class="spin" />
        <button v-else-if="s.hasMore.value" class="btn ghost sm" @click="loadOlder">{{ t.loadOlder }}</button>
      </div>
      <div v-if="s.turns.value.length" class="headline" data-testid="headline"><AgentBadge v-if="s.chat.value?.agent" :id="s.chat.value.agent" size="xs" /><span class="hl">{{ fmt(t.headerLine, { agent: agent?.label ?? s.chat.value?.agent ?? '', n: s.turns.value.length }) }}</span></div>
      <div v-else-if="s.conn.value === 'ready'" class="empty">
        <div class="empty-av"><Icon name="robot" /></div>
        <div class="empty-title">{{ s.mode.value === 'review' ? t.reviewEmptyTitle : t.emptyTitle }}</div>
        <div class="empty-hint">{{ s.mode.value === 'review' ? t.reviewEmptyHint : t.emptyHint }}</div>
      </div>
      <TurnBlock
        v-for="turn in s.turns.value"
        :key="turn.id"
        :turn="turn"
        :interactive="true"
        :pending-asks="s.pendingAsks.value"
        :live-sessions="s.liveSessions.value"
        :live-views="s.liveViews"
        :live-latest="!!turn.user.live?.sid && latestLive.get(turn.user.live.sid) === turn.id"
        :now="now"
        @answer="s.answer"
        @retry="(id) => s.send({ type: 'retry', turnId: id })"
        @live="s.live"
        @nav="s.liveNav"
        @image="lightbox = $event"
        @artifact="s.openArtifact"
      />
    </main>
    <button v-if="unread && !atBottom" class="unread" data-testid="unread" @click="scrollToBottom(true)"><Icon name="chevrons" />{{ fmt(t.newCount, { n: newCount }) }}</button>

    <div v-if="s.error.value" class="toast err">{{ s.error.value }}</div>
    <QueueList :store="s" />
    <Composer :store="s" />
    <div v-if="lightbox" class="lightbox" @click="lightbox = null"><img :src="lightbox" alt="" /></div>
  </div>
</template>

<style scoped>
.chat-app { height: 100%; display: flex; flex-direction: column; position: relative; background: var(--bg); container: chat / inline-size; }
header { display: flex; align-items: center; gap: 2px; height: 40px; padding: 0 8px; border-bottom: 1px solid var(--line); }
.livebar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--accent-soft); border-bottom: 1px solid var(--line); font-size: var(--fs-sm); }
.livebar svg { width: 14px; height: 14px; color: var(--accent-2); }
.conn { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: var(--fs-sm); background: var(--bg2); border-bottom: 1px solid var(--line); }
.conn.error { background: var(--err-bg); color: var(--err); }
.list { flex: 1; overflow: auto; overscroll-behavior: contain; padding-bottom: 12px; }
.sentinel { display: flex; justify-content: center; padding: 4px; min-height: 4px; }
.headline { display: flex; align-items: center; gap: 6px; padding: 2px 14px 4px; font-size: var(--fs-xs); color: var(--fg3); }
.headline .hl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 28px 24px; text-align: center; }
.empty-av { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--agent-soft); color: var(--agent); }
.empty-av svg { width: 22px; height: 22px; }
.empty-title { font-size: var(--fs-lg); font-weight: 600; }
.empty-hint { font-size: var(--fs-sm); color: var(--fg2); line-height: 1.6; max-width: 280px; }
.unread { position: absolute; left: 50%; transform: translateX(-50%); bottom: 140px; z-index: 5; display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--info); font-size: var(--fs-sm); font-weight: 600; box-shadow: var(--shadow-pop); animation: un-in var(--dur) var(--ease); }
.unread svg { width: 15px; height: 15px; }
@keyframes un-in { from { opacity: 0; transform: translate(-50%, 6px); } }
.toast { position: absolute; left: 12px; right: 12px; bottom: 140px; padding: 8px 12px; border-radius: var(--r); font-size: var(--fs-sm); z-index: 6; box-shadow: var(--shadow); }
.toast.err { background: var(--err-bg); color: var(--err); border: 1px solid color-mix(in srgb, var(--err) 30%, transparent); }
</style>
