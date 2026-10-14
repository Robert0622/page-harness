<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ModelInfo } from '@shared/protocol'
import AgentBadge from '../components/AgentBadge.vue'
import Icon from '../components/Icon.vue'
import { brand, orderAgents } from '../lib/agents'
import EffortSlider from './EffortSlider.vue'
import { fmt, t } from '../lib/i18n'
import type { ChatStore } from './store'

type Row = { kind: 'default' } | { kind: 'model'; m: ModelInfo } | { kind: 'custom'; id: string }

const props = defineProps<{ store: ChatStore }>()
const s = props.store
const open = ref(false)
const q = ref('')
const active = ref(0)
const root = ref<HTMLElement>()
const search = ref<HTMLInputElement>()
const listEl = ref<HTMLElement>()
const maxH = ref(360)

const agentId = computed(() => s.chat.value?.agent ?? '')
const agent = computed(() => s.agents.value.find((a) => a.id === agentId.value))
const agentList = computed(() => orderAgents(s.agents.value))
/** The not-installed agent whose install hint is showing. */
const hintFor = ref<string | null>(null)
const hintAgent = computed(() => s.agents.value.find((a) => a.id === hintFor.value))
const current = computed(() => s.chat.value?.model ?? null)
const all = computed(() => s.models.value[agentId.value])
const loading = computed(() => all.value === undefined)
const defaultModel = computed(() => all.value?.find((m) => m.isDefault))
const choices = computed(() => (all.value ?? []).filter((m) => !m.isDefault))

const match = (m: ModelInfo, needle: string) => !needle || m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle)
const filtered = computed(() => choices.value.filter((m) => match(m, q.value.trim().toLowerCase())))

const FAMILIES: Array<[string, RegExp]> = [
  ['Claude', /^claude|^(sonnet|opus|haiku)$/i],
  ['GPT', /^(gpt|o\d|codex)/i],
  ['Gemini', /^gemini/i],
  ['Grok', /grok/i],
  ['Composer', /^composer/i],
  ['Hunyuan', /^(hy\d|hunyuan)/i],
  ['DeepSeek', /^deepseek/i],
  ['GLM', /^glm/i],
  ['Kimi', /^kimi/i],
  ['Qwen', /^qwen/i],
]
// OpenCode ids carry the provider in front (`anthropic/claude-sonnet-4`); group by the model name.
const family = (id: string) => {
  const name = id.replace(/^[\w.@-]+\//, '')
  return FAMILIES.find(([, re]) => re.test(name))?.[0] ?? ''
}
const groups = computed(() => {
  const map = new Map<string, ModelInfo[]>()
  for (const m of filtered.value) {
    const f = family(m.id)
    map.set(f, [...(map.get(f) ?? []), m])
  }
  const order = [...FAMILIES.map(([n]) => n), '']
  return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([name, items]) => ({ name: name || t.value.groupOther, items }))
})
const showGroupNames = computed(() => groups.value.length > 1)
const customId = computed(() => {
  const v = q.value.trim()
  return v && !/\s/.test(v) && !choices.value.some((m) => m.id === v) ? v : ''
})
const rows = computed<Row[]>(() => [
  ...(q.value.trim() ? [] : [{ kind: 'default' } as Row]),
  ...groups.value.flatMap((g) => g.items.map((m): Row => ({ kind: 'model', m }))),
  ...(customId.value ? [{ kind: 'custom', id: customId.value } as Row] : []),
])
const rowIndex = (m: ModelInfo) => rows.value.findIndex((r) => r.kind === 'model' && r.m.id === m.id)

const effort = computed(() => s.chat.value?.effort ?? null)
const pillName = computed(() => (!current.value ? defaultModel.value?.label ?? t.value.defaultModel : all.value?.find((m) => m.id === current.value)?.label ?? current.value))
const pillModel = computed(() => (effort.value ? `${pillName.value} · ${t.value.effortNames[effort.value] ?? effort.value}` : pillName.value))
const activeModel = computed(() => (current.value ? all.value?.find((m) => m.id === current.value) : defaultModel.value))
const efforts = computed(() => activeModel.value?.efforts ?? [])
const fast = computed(() => !!s.chat.value?.fast && !!activeModel.value?.fastTier)
async function pickEffort(e: string | null) {
  if (e !== effort.value) await s.updateChat({ effort: e })
}

function parts(label: string) {
  const needle = q.value.trim().toLowerCase()
  const i = needle ? label.toLowerCase().indexOf(needle) : -1
  if (i < 0) return [{ text: label, hit: false }]
  return [
    { text: label.slice(0, i), hit: false },
    { text: label.slice(i, i + needle.length), hit: true },
    { text: label.slice(i + needle.length), hit: false },
  ].filter((p) => p.text)
}

function toggle() {
  if (open.value) return close()
  hintFor.value = null
  agOpen.value = false
  if (agentId.value) void s.loadModels(agentId.value)
  const composer = root.value?.closest('.composer') as HTMLElement | null
  maxH.value = Math.max(180, Math.min(440, (composer?.getBoundingClientRect().top ?? 400) - 12))
  q.value = ''
  active.value = 0
  open.value = true
  nextTick(() => search.value?.focus())
}
function close() {
  open.value = false
}
async function pick(r: Row) {
  const model = r.kind === 'default' ? null : r.kind === 'model' ? r.m.id : r.id
  close()
  if (model !== current.value) await s.updateChat({ model })
}
async function setAgent(id: string) {
  const a = s.agents.value.find((x) => x.id === id)
  if (a && !a.available) {
    hintFor.value = hintFor.value === id ? null : id
    return
  }
  hintFor.value = null
  if (id === agentId.value) return
  await s.updateChat({ agent: id })
  void s.loadModels(id)
  active.value = 0
}
/** The agent dropdown at the top of the picker: a listbox in a fixed order, driven like a native select. */
const agOpen = ref(false)
const agActive = ref(0)
const agTrigger = ref<HTMLButtonElement>()
const agListEl = ref<HTMLElement>()
function openAgents() {
  agActive.value = Math.max(0, agentList.value.findIndex((a) => a.id === agentId.value))
  agOpen.value = true
  nextTick(() => agListEl.value?.focus())
}
function closeAgents(refocus = true) {
  agOpen.value = false
  if (refocus) nextTick(() => agTrigger.value?.focus())
}
function toggleAgents() {
  if (agOpen.value) closeAgents()
  else openAgents()
}
/** A missing agent only shows how to install it; the chat keeps its agent. */
async function chooseAgent(id: string) {
  closeAgents()
  await setAgent(id)
}
const agSel = ref<HTMLElement>()
/**
 * A click anywhere else in the picker collapses the agent list. On click rather than pointerdown, so the
 * layout only shifts after the click has landed (a model row below still gets picked); focus stays where
 * the click put it.
 */
function onPopClick(e: MouseEvent) {
  if (agOpen.value && agSel.value && !e.composedPath().includes(agSel.value)) closeAgents(false)
}
function onTriggerKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    openAgents()
  }
}
function onAgentListKey(e: KeyboardEvent) {
  if (e.isComposing) return
  const n = agentList.value.length
  const move: Record<string, () => number> = {
    ArrowDown: () => Math.min(n - 1, agActive.value + 1),
    ArrowUp: () => Math.max(0, agActive.value - 1),
    Home: () => 0,
    End: () => n - 1,
  }
  if (e.key in move) agActive.value = move[e.key]()
  else if (e.key === 'Enter' || e.key === ' ') {
    const a = agentList.value[agActive.value]
    if (a) void chooseAgent(a.id)
  } else if (e.key === 'Escape') closeAgents()
  else if (e.key === 'Tab') return closeAgents(false)
  else return
  e.preventDefault()
  e.stopPropagation()
  nextTick(() => agListEl.value?.querySelector('.ag-opt.active')?.scrollIntoView({ block: 'nearest' }))
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const n = rows.value.length
    if (n) active.value = (active.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    nextTick(() => listEl.value?.querySelector('.opt.active')?.scrollIntoView({ block: 'nearest' }))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const r = rows.value[active.value]
    if (r) void pick(r)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
watch(q, () => (active.value = 0))

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !e.composedPath().includes(root.value)) close()
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div ref="root" class="mp">
    <button class="pill" :class="{ on: open }" :disabled="!s.chat.value" data-testid="model-pill" :title="[agent?.label ?? agentId, current ?? pillName, fast ? t.fastShort : ''].filter(Boolean).join(' · ')" @click="toggle">
      <AgentBadge v-if="agentId" :id="agentId" size="xs" data-testid="pill-agent" />
      <span class="ag">{{ agent ? brand(agent.id).short : agentId }}</span>
      <span class="sep">·</span>
      <span class="ml">{{ pillModel }}</span>
      <Icon v-if="fast" name="zap" class="fz" data-testid="pill-fast" />
      <Icon name="chevron" class="chev" />
    </button>
    <div v-if="open" class="pop" data-testid="model-picker" :style="{ maxHeight: `${maxH}px` }" @keydown="onKey" @click="onPopClick">
      <div ref="agSel" class="agsel">
        <button
          ref="agTrigger"
          class="ag-trig"
          :class="{ on: agOpen }"
          aria-haspopup="listbox"
          :aria-expanded="agOpen"
          :aria-label="`${t.agent}: ${agent?.label ?? agentId}`"
          data-testid="agent-trigger"
          @click="toggleAgents"
          @keydown="onTriggerKey"
        >
          <AgentBadge v-if="agentId" :id="agentId" size="sm" />
          <span class="nm">{{ agent ? brand(agent.id).short : agentId }}</span>
          <Icon name="chevron" class="chev" />
        </button>
        <div
          v-if="agOpen"
          ref="agListEl"
          class="ag-list"
          role="listbox"
          tabindex="-1"
          :aria-label="t.agent"
          :aria-activedescendant="agentList[agActive] ? `ph-agent-${agentList[agActive].id}` : undefined"
          data-testid="agent-list"
          @keydown="onAgentListKey"
        >
          <div
            v-for="(a, i) in agentList"
            :id="`ph-agent-${a.id}`"
            :key="a.id"
            class="ag-opt"
            role="option"
            :aria-selected="a.id === agentId"
            :class="{ active: i === agActive, on: a.id === agentId, off: !a.available }"
            :title="a.available ? [a.label, a.version, a.path].filter(Boolean).join(' · ') : `${a.label} · ${t.notInstalled}`"
            :data-agent="a.id"
            data-testid="agent-option"
            @mousemove="agActive = i"
            @mousedown.prevent
            @click="chooseAgent(a.id)"
          >
            <AgentBadge :id="a.id" size="sm" :off="!a.available" />
            <span class="nm">{{ brand(a.id).short }}</span>
            <span v-if="!a.available" class="tag"><Icon name="download" />{{ t.notInstalled }}</span>
            <Icon v-else-if="a.id === agentId" name="check" class="ck" />
          </div>
        </div>
      </div>
      <div v-if="hintAgent" class="ni" data-testid="agent-hint">
        <template v-if="brand(hintAgent.id).install">
          {{ fmt(t.agentMissing, { agent: hintAgent.label }) }}
          <code class="mono">{{ brand(hintAgent.id).install }}</code>
        </template>
        <template v-else>{{ fmt(t.agentMissingNoCmd, { agent: hintAgent.label }) }}</template>
        {{ fmt(t.agentPathHint, { flag: `--${hintAgent.id}-path` }) }}
      </div>
      <div class="sbox">
        <Icon name="search" />
        <input ref="search" v-model="q" :placeholder="t.searchModels" data-testid="model-search" />
      </div>
      <div ref="listEl" class="list">
        <div v-if="loading" class="state"><span class="spin" />{{ t.loadingModels }}</div>
        <template v-else>
          <button v-if="!q.trim()" class="opt" :class="{ active: active === 0, cur: !current }" data-testid="model-default" @mouseenter="active = 0" @click="pick({ kind: 'default' })">
            <span class="lb">{{ t.defaultAuto }}</span>
            <span v-if="defaultModel" class="id mono">{{ defaultModel.label }}</span>
            <Icon v-if="!current" name="check" class="ck" />
          </button>
          <div v-if="all === null" class="state">{{ t.modelsFailed }}</div>
          <template v-for="g in groups" :key="g.name">
            <div v-if="showGroupNames" class="gname">{{ g.name }}</div>
            <button
              v-for="m in g.items"
              :key="m.id"
              class="opt"
              :class="{ active: active === rowIndex(m), cur: current === m.id }"
              :data-model="m.id"
              data-testid="model-option"
              @mouseenter="active = rowIndex(m)"
              @click="pick({ kind: 'model', m })"
            >
              <span class="lb"><template v-for="(p, i) in parts(m.label)" :key="i"><mark v-if="p.hit">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></span>
              <span v-if="m.label !== m.id" class="id mono">{{ m.id }}</span>
              <Icon v-if="current === m.id" name="check" class="ck" />
            </button>
          </template>
          <button v-if="customId" class="opt" :class="{ active: active === rows.length - 1 }" data-testid="model-custom" @mouseenter="active = rows.length - 1" @click="pick({ kind: 'custom', id: customId })">
            <Icon name="plus" class="pl" /><span class="lb">{{ fmt(t.useCustom, { id: customId }) }}</span>
          </button>
          <div v-if="all && !filtered.length && !customId && q.trim()" class="state">{{ t.noModels }}</div>
        </template>
      </div>
      <EffortSlider
        v-if="efforts.length > 1"
        :efforts="efforts"
        :value="effort"
        :default-effort="activeModel?.defaultEffort"
        :model="activeModel?.label ?? pillName"
        :fast="fast"
        :fast-tier="activeModel?.fastTier"
        @change="pickEffort"
        @fast="(on) => s.updateChat({ fast: on })"
        @model="search?.focus()"
      />
      <div v-if="agent?.version" class="foot faint"><AgentBadge :id="agent.id" size="xs" />{{ agent.label }} · {{ fmt(t.agentVersion, { v: agent.version }) }}</div>
    </div>
  </div>
</template>

<style scoped>
.mp { min-width: 0; display: flex; }
.pill { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; height: 28px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--r); background: transparent; color: var(--fg2); font-size: var(--fs-sm); }
.pill:hover:not(:disabled), .pill.on { background: var(--bg2); border-color: var(--line); color: var(--fg); }
.pill svg { width: 13px; height: 13px; flex: none; }
.ag { flex: none; font-weight: 500; }
.sep { color: var(--fg3); }
.ml { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chev { color: var(--fg3); }
.pill .fz { width: 11px; height: 11px; color: var(--accent); fill: currentColor; }
.pop { position: absolute; left: 8px; right: 8px; bottom: calc(100% + 6px); z-index: 30; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--bg); box-shadow: var(--shadow); overflow: hidden; animation: mp-in var(--dur) var(--ease); }
@keyframes mp-in { from { opacity: 0; transform: translateY(4px); } }
.pill .ab { width: 16px; height: 16px; }
.agsel { margin: 8px 8px 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ag-trig { display: flex; align-items: center; gap: 8px; min-width: 0; height: 32px; padding: 0 8px 0 7px; border: 1px solid var(--line); border-radius: var(--r); background: var(--base); color: var(--fg); font-size: var(--fs-sm); font-weight: 500; text-align: left; }
.ag-trig:hover, .ag-trig.on { background: var(--bg2); }
.ag-trig:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--focus); }
.ag-trig .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-trig .chev { width: 13px; height: 13px; flex: none; color: var(--fg3); transition: transform var(--dur) var(--ease); }
.ag-trig.on .chev { transform: rotate(180deg); }
.ag-list { display: flex; flex-direction: column; padding: 3px; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg); outline: none; animation: mp-in var(--dur) var(--ease); }
.ag-list:focus-visible { box-shadow: var(--focus); }
.ag-opt { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 30px; padding: 4px 6px; border-radius: var(--r-sm); color: var(--fg); font-size: var(--fs-sm); cursor: pointer; }
.ag-opt.active { background: var(--bg2); }
.ag-opt.on .nm { font-weight: 600; color: var(--accent-2); }
.ag-opt.off { color: var(--fg3); }
.ag-opt .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-opt .tag { flex: none; display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px 1px 4px; border-radius: 999px; background: var(--bg3); color: var(--fg3); font-size: var(--fs-xs); white-space: nowrap; }
.ag-opt .tag svg { width: 11px; height: 11px; }
.ag-opt.off.active .tag { color: var(--accent-2); background: var(--accent-soft); }
.ag-opt .ck { width: 13px; height: 13px; flex: none; color: var(--accent-2); }
.ni { margin: 6px 8px 0; padding: 6px 8px; border-radius: var(--r-sm); background: var(--bg2); font-size: var(--fs-xs); line-height: 1.6; color: var(--fg2); overflow-wrap: anywhere; }
.ni code { display: block; width: fit-content; max-width: 100%; margin: 3px 0; padding: 1px 5px; border-radius: 3px; background: var(--code-bg, var(--bg3)); color: var(--fg); font-size: 10.5px; user-select: all; }
.sbox { display: flex; align-items: center; gap: 6px; margin: 8px; padding: 0 8px; height: 30px; border: 1px solid var(--line); border-radius: var(--r); background: var(--base); }
.sbox:focus-within { border-color: var(--accent); box-shadow: var(--focus); }
.sbox svg { width: 13px; height: 13px; color: var(--fg3); flex: none; }
.sbox input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font-size: var(--fs-sm); }
.list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 4px 4px; border-top: 1px solid var(--line2); padding-top: 4px; }
.gname { padding: 8px 8px 2px; font-size: var(--fs-xs); font-weight: 600; color: var(--fg3); text-transform: uppercase; letter-spacing: .04em; }
.opt { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 4px 8px; border: 0; border-radius: var(--r-sm); background: none; text-align: left; font-size: var(--fs-sm); color: var(--fg); }
.opt.active { background: var(--bg2); }
.opt.cur .lb { font-weight: 600; color: var(--accent-2); }
.lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb mark { background: var(--accent-soft); color: var(--accent-2); border-radius: 2px; }
.id { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--fg3); }
.ck { width: 13px; height: 13px; flex: none; color: var(--accent-2); }
.pl { width: 13px; height: 13px; flex: none; color: var(--fg3); }
.state { display: flex; align-items: center; gap: 8px; padding: 10px 8px; font-size: var(--fs-sm); color: var(--fg3); }
.foot { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-top: 1px solid var(--line2); font-size: var(--fs-xs); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The chat window can be dragged down to 320px: keep the model readable and let the badge name the agent. */
@container chat (max-width: 380px) {
  .pill .ag, .pill .sep { display: none; }
}
</style>
