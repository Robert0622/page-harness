<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { ArtifactInfo, ArtifactKind, ServerMsg } from '@shared/protocol'
import Icon from '../components/Icon.vue'
import { connectPage } from '../lib/bridge'
import { relTime, t } from '../lib/i18n'
import { theme } from '../lib/theme'
import { createSocket } from '../lib/ws'
import ArtifactPreview from './ArtifactPreview.vue'

const artifacts = ref<ArtifactInfo[]>([])
const loaded = ref(false)
const store = <T,>(s: Storage, k: string, d: T): T => {
  try {
    const v = s.getItem(k)
    return v ? (JSON.parse(v) as T) : d
  } catch {
    return d
  }
}
const put = (s: Storage, k: string, v: unknown) => {
  try {
    s.setItem(k, JSON.stringify(v))
  } catch {}
}
const tabsState = reactive(store<{ tabs: string[]; active: string | null; versions: Record<string, number> }>(sessionStorage, 'ph:art-tabs', { tabs: [], active: null, versions: {} }))
const seen = reactive(store<Record<string, number>>(localStorage, 'ph:art-seen', {}))
watch(tabsState, () => put(sessionStorage, 'ph:art-tabs', tabsState), { deep: true })
watch(seen, () => put(localStorage, 'ph:art-seen', seen), { deep: true })

const byName = computed(() => new Map(artifacts.value.map((a) => [a.name, a])))
const active = computed(() => (tabsState.active ? byName.value.get(tabsState.active) : undefined))
const now = ref(Date.now())
const timer = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(timer))

function open(name: string, version?: number) {
  if (!tabsState.tabs.includes(name)) tabsState.tabs.push(name)
  tabsState.active = name
  if (version && byName.value.get(name)?.latest !== version) tabsState.versions[name] = version
  else delete tabsState.versions[name]
}
function close(name: string) {
  const i = tabsState.tabs.indexOf(name)
  if (i >= 0) tabsState.tabs.splice(i, 1)
  if (tabsState.active === name) tabsState.active = tabsState.tabs[i] ?? tabsState.tabs[i - 1] ?? null
  delete tabsState.versions[name]
}
watch(
  () => [active.value?.name, active.value?.latest],
  () => {
    if (active.value) seen[active.value.name] = active.value.latest
  },
)
const mark = (a: ArtifactInfo) => (seen[a.name] === undefined ? 'new' : seen[a.name] < a.latest ? 'updated' : '')

let pinnedApplied = false
const sock = createSocket(
  (m: ServerMsg) => {
    if (m.type !== 'artifacts') return
    artifacts.value = m.artifacts
    // Tabs for artifacts that no longer exist are dropped.
    for (const name of [...tabsState.tabs]) if (!m.artifacts.some((a) => a.name === name)) close(name)
    if (!loaded.value) {
      loaded.value = true
      consumePending()
    }
    if (m.open) open(m.open)
    else if (m.pinned && !pinnedApplied && !tabsState.active) open(m.pinned)
    pinnedApplied = true
  },
  () => {},
)
onBeforeUnmount(() => sock.close())

function consumePending() {
  const p = store<{ name: string; version?: number; ts: number } | null>(localStorage, 'ph:art-open', null)
  if (p && Date.now() - p.ts < 30_000 && byName.value.has(p.name)) open(p.name, p.version)
  localStorage.removeItem('ph:art-open')
}
const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ph-panel') : null
if (bc)
  bc.onmessage = (e) => {
    const d = e.data as { type: string; name: string; version?: number }
    if (d?.type === 'open-artifact') {
      open(d.name, d.version)
      localStorage.removeItem('ph:art-open')
    }
  }

const bridge = connectPage('artifacts', (m) => {
  if (m.type === 'ph:attach' || m.type === 'ph:theme') theme.value = m.theme
})
void bridge

const ICON: Record<ArtifactKind, string> = { html: 'monitor', json: 'file', markdown: 'file', yaml: 'file', image: 'image', text: 'file', file: 'file' }
const KIND_LABEL: Record<ArtifactKind, string> = { html: 'HTML', json: 'JSON', markdown: 'Markdown', yaml: 'YAML', image: 'Image', text: 'Text', file: 'File' }
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
</script>

<template>
  <div class="art-app">
    <nav class="tabs">
      <button class="tab" :class="{ on: !tabsState.active }" data-testid="tab-all" @click="tabsState.active = null">{{ t.allArtifacts }} <span class="faint">{{ artifacts.length }}</span></button>
      <div v-for="name in tabsState.tabs" :key="name" class="tab" :class="{ on: tabsState.active === name }" @click="tabsState.active = name">
        <span class="nm">{{ name }}</span>
        <span v-if="byName.get(name) && mark(byName.get(name)!) === 'updated' && tabsState.active !== name" class="dot" />
        <button class="x" :title="t.close" @click.stop="close(name)"><Icon name="x" /></button>
      </div>
    </nav>
    <div v-if="sock.state.value !== 'ready'" class="conn muted"><span class="spin" />{{ sock.state.value === 'error' ? t.netError : t.connecting }}</div>
    <main>
      <ArtifactPreview
        v-if="active"
        :key="active.name"
        :info="active"
        :version="tabsState.versions[active.name]"
        @version="(v) => (v ? (tabsState.versions[active!.name] = v) : delete tabsState.versions[active!.name])"
      />
      <div v-else-if="loaded && !artifacts.length" class="empty muted"><Icon name="sparkle" />{{ t.noArtifacts }}</div>
      <div v-else class="grid">
        <button v-for="a in artifacts" :key="a.name" class="tile card" :data-artifact="a.name" @click="open(a.name)">
          <div class="ic"><Icon :name="ICON[a.kind]" /></div>
          <div class="nm">{{ a.name }}</div>
          <div class="meta faint">{{ KIND_LABEL[a.kind] }} · {{ size(a.size) }} · v{{ a.latest }}</div>
          <div class="meta faint">{{ relTime(a.updatedAt, now) }}</div>
          <span v-if="mark(a) === 'new'" class="flag new">{{ t.new }}</span>
          <span v-else-if="mark(a) === 'updated'" class="flag upd">{{ t.updated }}</span>
        </button>
      </div>
    </main>
  </div>
</template>

<style scoped>
.art-app { height: 100%; display: flex; flex-direction: column; }
.tabs { display: flex; gap: 2px; padding: 4px 6px 0; border-bottom: 1px solid var(--line); overflow-x: auto; flex: none; background: var(--bg2); }
.tab { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid transparent; border-bottom: 0; border-radius: 8px 8px 0 0; background: none; cursor: pointer; white-space: nowrap; max-width: 220px; }
.tab.on { background: var(--bg); border-color: var(--line); margin-bottom: -1px; }
.tab .nm { overflow: hidden; text-overflow: ellipsis; }
.tab .x { border: 0; background: none; padding: 0; display: inline-grid; color: var(--fg3); }
.tab .x svg { width: 12px; height: 12px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.conn { display: flex; gap: 8px; align-items: center; padding: 6px 10px; font-size: 12px; }
main { flex: 1; min-height: 0; overflow: auto; }
.empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center; }
.empty svg { width: 28px; height: 28px; color: var(--accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; padding: 12px; }
.tile { position: relative; text-align: left; padding: 12px; display: flex; flex-direction: column; gap: 4px; cursor: pointer; }
.tile:hover { border-color: var(--accent); }
.tile .ic { width: 32px; height: 32px; border-radius: 8px; background: var(--accent-soft); display: grid; place-items: center; color: var(--accent); }
.tile .ic svg { width: 18px; height: 18px; }
.tile .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 11px; }
.flag { position: absolute; top: 8px; right: 8px; font-size: 10px; padding: 1px 6px; border-radius: 999px; font-weight: 700; }
.flag.new { background: var(--accent); color: var(--accent-fg); }
.flag.upd { background: var(--warn-bg); color: var(--warn); }
</style>
