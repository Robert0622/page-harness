<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '../components/Icon.vue'
import { fmt, t } from '../lib/i18n'

const props = defineProps<{ efforts: string[]; value: string | null; defaultEffort?: string; model: string; fast: boolean; fastTier?: { id: string; description?: string } }>()
const emit = defineEmits<{ change: [effort: string | null]; model: []; fast: [on: boolean] }>()

const fastTip = computed(() => {
  const d = props.fastTier?.description ?? ''
  const speed = /([\d.]+)\s*x\s*speed/i.exec(d)?.[1]
  return {
    title: speed ? fmt(t.value.fastSpeed, { n: speed }) : t.value.fastMode,
    sub: /increased usage/i.test(d) ? t.value.fastUsage : speed ? '' : d,
  }
})

const track = ref<HTMLElement>()
const drag = ref<number | null>(null)

const name = (e?: string) => (e ? t.value.effortNames[e] ?? e : '')
const baseIndex = computed(() => {
  const i = props.efforts.indexOf(props.value ?? props.defaultEffort ?? '')
  return i < 0 ? 0 : i
})
const index = computed(() => drag.value ?? baseIndex.value)
const last = computed(() => Math.max(1, props.efforts.length - 1))
const pct = computed(() => (index.value / last.value) * 100)
const shown = computed(() => props.efforts[index.value])
/** No effort chosen and the CLI doesn't say which one it uses (CodeBuddy, OpenCode): show "Default", not the first stop. */
const unset = computed(() => drag.value === null && !props.value && !props.defaultEffort)

function commit(i: number) {
  const e = props.efforts[i]
  if (e === undefined) return
  const next = !props.value && e === props.defaultEffort ? null : e
  if (next !== props.value) emit('change', next)
}
function at(clientX: number): number {
  const r = track.value!.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  return Math.round(x * last.value)
}
function down(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag.value = at(e.clientX)
}
function move(e: PointerEvent) {
  if (drag.value !== null) drag.value = at(e.clientX)
}
function up() {
  if (drag.value === null) return
  const i = drag.value
  drag.value = null
  commit(i)
}
function key(e: KeyboardEvent) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
  if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    commit(e.key === 'Home' ? 0 : props.efforts.length - 1)
  } else if (step) {
    e.preventDefault()
    e.stopPropagation()
    commit(Math.min(props.efforts.length - 1, Math.max(0, index.value + step)))
  }
}
</script>

<template>
  <div class="es" data-testid="effort-picker">
    <div class="head">
      <button
        v-if="fastTier"
        class="side fast"
        :class="{ on: fast }"
        type="button"
        :aria-pressed="fast"
        :aria-label="fastTip.title"
        data-testid="fast-toggle"
        @click="emit('fast', !fast)"
      >
        <Icon name="zap" />
        <span class="tip" role="tooltip">
          <b>{{ fastTip.title }}</b>
          <span v-if="fastTip.sub">{{ fastTip.sub }}</span>
        </span>
      </button>
      <span v-else class="side off"><Icon name="zap" /></span>
      <div class="mid">
        <div class="val" data-testid="effort-value">{{ unset ? t.effortDefault : name(shown) }}</div>
        <button class="mdl" type="button" @click="emit('model')">{{ model }}<Icon name="right" /></button>
      </div>
      <button
        class="side rs"
        type="button"
        :disabled="!value"
        :title="fmt(t.effortReset, { v: name(defaultEffort) || t.effortDefault })"
        data-testid="effort-reset"
        @click="emit('change', null)"
      >
        <Icon name="reset" />
      </button>
    </div>
    <div
      ref="track"
      class="track"
      :class="{ unset }"
      role="slider"
      tabindex="0"
      :aria-label="t.effort"
      :aria-valuemin="0"
      :aria-valuemax="efforts.length - 1"
      :aria-valuenow="index"
      :aria-valuetext="unset ? t.effortDefault : name(shown)"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="drag = null"
      @keydown="key"
    >
      <div class="fill" :style="{ width: `calc(12px + (100% - 24px) * ${pct / 100})` }" />
      <span
        v-for="(e, i) in efforts"
        :key="e"
        class="dot"
        :class="{ lit: i <= index }"
        :style="{ left: `calc(12px + (100% - 24px) * ${i / last})` }"
        :data-effort="e"
        data-testid="effort-option"
        :title="name(e)"
      />
      <span class="knob" :style="{ left: `calc(12px + (100% - 24px) * ${index / last})` }" />
    </div>
  </div>
</template>

<style scoped>
.es { margin: 4px 8px 8px; padding: 8px 10px 10px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--bg); box-shadow: var(--shadow-sm); }
.head { display: flex; align-items: center; gap: 8px; }
.side { flex: none; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg3); }
.head :deep(svg) { width: 14px; height: 14px; }
.side.off { opacity: .35; }
.fast { position: relative; padding: 0; border: 0; border-radius: var(--r-sm); background: none; cursor: pointer; }
.fast:hover { background: var(--bg2); color: var(--fg); }
.fast.on { color: var(--accent); background: var(--accent-soft); }
.fast.on :deep(svg) { fill: currentColor; }
.tip { position: absolute; left: -4px; bottom: calc(100% + 8px); z-index: 2; display: none; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 10px; border-radius: var(--r); background: #1f1f23; color: #fff; font-size: var(--fs-xs); line-height: 1.35; white-space: nowrap; text-align: left; box-shadow: var(--shadow); pointer-events: none; }
.tip b { font-weight: 600; font-size: var(--fs-sm); }
.tip span { color: rgba(255, 255, 255, .65); }
.fast:hover .tip { display: flex; }
.side:focus-visible { outline: none; box-shadow: var(--focus); }
.rs { padding: 0; border: 0; border-radius: var(--r-sm); background: none; cursor: pointer; }
.rs:hover:not(:disabled) { background: var(--bg2); color: var(--fg); }
.rs:disabled { opacity: .35; cursor: default; }
.mid { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; }
.val { font-size: var(--fs-sm); font-weight: 600; color: var(--accent); line-height: 1.3; }
.mdl { display: inline-flex; align-items: center; gap: 1px; max-width: 100%; padding: 0 2px; border: 0; background: none; font-size: var(--fs-xs); color: var(--fg3); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mdl:hover { color: var(--fg); }
.mdl :deep(svg) { width: 11px; height: 11px; flex: none; }
.track { position: relative; height: 24px; margin-top: 8px; border-radius: 999px; background: var(--bg2); cursor: pointer; touch-action: none; outline: none; }
.track:focus-visible { box-shadow: var(--focus); }
.fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--accent); transition: width .12s var(--ease); }
.dot { position: absolute; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-radius: 50%; background: var(--fg3); opacity: .5; pointer-events: none; }
.dot.lit { background: var(--accent-fg); opacity: .8; }
.unset .fill { opacity: 0; }
.unset .dot { background: var(--fg3); }
.unset .knob { opacity: .55; }
.knob { position: absolute; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25), 0 0 0 1px rgba(0, 0, 0, .04); pointer-events: none; transition: left .12s var(--ease); }
</style>
