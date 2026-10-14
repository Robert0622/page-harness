<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ArtifactInfo } from '@shared/protocol'
import CodeView from '../components/CodeView.vue'
import Icon from '../components/Icon.vue'
import Markdown from '../components/Markdown.vue'
import { rawUrl } from '../lib/api'
import { exportPdf, exportPng } from '../lib/export'
import { t } from '../lib/i18n'
import JsonTree from './JsonTree.vue'

const props = defineProps<{ info: ArtifactInfo; version?: number }>()
const emit = defineEmits<{ version: [v: number | undefined] }>()

const v = computed(() => props.version ?? props.info.latest)
const old = computed(() => v.value !== props.info.latest)
const text = ref<string | null>(null)
const loadErr = ref(false)
const loading = ref(false)
const jsonMode = ref<'structured' | 'raw'>('structured')
const device = ref<'desktop' | 'mobile'>('desktop')
const zoomed = ref(false)
const copied = ref(false)
const imgKey = ref(0)
const body = ref<HTMLElement>()
const rendered = ref<HTMLElement>()
const frameBox = ref<HTMLElement>()
const scale = ref(1)

const isText = computed(() => !['image', 'file', 'html'].includes(props.info.kind))
const ext = computed(() => /\.([a-z0-9]+)$/i.exec(props.info.name)?.[1]?.toLowerCase() ?? 'text')
const parsed = computed(() => {
  if (props.info.kind !== 'json' || text.value === null) return undefined
  try {
    return { ok: true as const, value: JSON.parse(text.value) as unknown }
  } catch {
    return { ok: false as const }
  }
})
const structured = computed(() => props.info.kind === 'markdown' || (props.info.kind === 'json' && jsonMode.value === 'structured'))
const src = computed(() => {
  const base = rawUrl(props.info.name, old.value ? v.value : undefined)
  return `${base}${base.includes('?') ? '&' : '?'}t=${props.info.updatedAt}`
})

async function load() {
  loadErr.value = false
  if (!isText.value) {
    imgKey.value++
    return
  }
  loading.value = true
  try {
    const r = await fetch(rawUrl(props.info.name, v.value), { credentials: 'same-origin' })
    if (!r.ok) throw new Error(String(r.status))
    text.value = await r.text()
  } catch {
    loadErr.value = true
    text.value = null
  } finally {
    loading.value = false
  }
}
watch(() => [props.info.name, v.value, props.info.updatedAt], load, { immediate: true })

const DESKTOP_W = 1280
const MOBILE_W = 390
let ro: ResizeObserver | null = null
const fit = () => {
  const box = frameBox.value
  if (!box) return
  const w = device.value === 'desktop' ? DESKTOP_W : MOBILE_W
  scale.value = Math.min(1, (box.clientWidth - 16) / w)
}
onMounted(() => {
  ro = new ResizeObserver(fit)
  if (frameBox.value) ro.observe(frameBox.value)
})
watch(frameBox, (el) => el && ro?.observe(el))
watch(device, fit)
onBeforeUnmount(() => ro?.disconnect())

async function copy() {
  try {
    if (isText.value && text.value !== null) await navigator.clipboard.writeText(text.value)
    else if (props.info.kind === 'html') await navigator.clipboard.writeText(await (await fetch(rawUrl(props.info.name, v.value))).text())
    else if (props.info.kind === 'image') {
      const blob = await (await fetch(rawUrl(props.info.name, v.value))).blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    }
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {}
}
const exporting = ref(false)
async function doExport(kind: 'png' | 'pdf') {
  const el = rendered.value
  if (!el) return
  exporting.value = true
  try {
    await (kind === 'png' ? exportPng(el, props.info.name) : exportPdf(el, props.info.name))
  } finally {
    exporting.value = false
  }
}
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (zoomed.value = false)
onMounted(() => addEventListener('keydown', onKey))
onBeforeUnmount(() => removeEventListener('keydown', onKey))
</script>

<template>
  <div class="pv" :class="{ zoomed }">
    <div class="tb">
      <select v-if="info.versions.length > 1" class="input sel" :value="v" data-testid="version-select" @change="emit('version', Number(($event.target as HTMLSelectElement).value) === info.latest ? undefined : Number(($event.target as HTMLSelectElement).value))">
        <option v-for="x in [...info.versions].reverse()" :key="x.v" :value="x.v">v{{ x.v }} · {{ new Date(x.ts).toLocaleString() }}</option>
      </select>
      <span v-if="old" class="chip ro">{{ t.readOnly }}</span>
      <template v-if="info.kind === 'html'">
        <div class="seg">
          <button class="btn sm" :class="{ on: device === 'desktop' }" @click="device = 'desktop'"><Icon name="monitor" />{{ t.desktop }}</button>
          <button class="btn sm" :class="{ on: device === 'mobile' }" @click="device = 'mobile'"><Icon name="phone" />{{ t.mobile }}</button>
        </div>
      </template>
      <div v-if="info.kind === 'json' && parsed?.ok" class="seg">
        <button class="btn sm" :class="{ on: jsonMode === 'structured' }" @click="jsonMode = 'structured'">{{ t.structured }}</button>
        <button class="btn sm" :class="{ on: jsonMode === 'raw' }" @click="jsonMode = 'raw'">{{ t.raw }}</button>
      </div>
      <span class="spacer" />
      <button class="btn ghost icon sm" :title="t.zoom" @click="zoomed = !zoomed"><Icon :name="zoomed ? 'x' : 'zoom'" /></button>
      <button v-if="info.kind !== 'file'" class="btn ghost icon sm" :title="copied ? t.copied : t.copy" @click="copy"><Icon :name="copied ? 'check' : 'copy'" /></button>
      <a class="btn ghost icon sm" :title="t.download" :href="rawUrl(info.name, v, true)"><Icon name="download" /></a>
      <template v-if="structured && text !== null">
        <button class="btn sm" :disabled="exporting" @click="doExport('png')">PNG</button>
        <button class="btn sm" :disabled="exporting" @click="doExport('pdf')">PDF</button>
      </template>
    </div>
    <div ref="body" class="body">
      <div v-if="loading" class="center"><span class="spin" /></div>
      <div v-else-if="loadErr" class="center col">
        <span class="muted">{{ t.loadFailed }}</span>
        <button class="btn sm" @click="load"><Icon name="refresh" />{{ t.retry }}</button>
      </div>
      <template v-else>
        <div v-if="info.kind === 'html'" ref="frameBox" class="frame-box">
          <div class="frame-wrap" :style="{ width: (device === 'desktop' ? 1280 : 390) * scale + 'px', height: '100%' }">
            <iframe
              :key="src + device"
              :src="src"
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              referrerpolicy="no-referrer"
              :title="info.name"
              :style="{ width: (device === 'desktop' ? 1280 : 390) + 'px', height: 100 / scale + '%', transform: `scale(${scale})` }"
            />
          </div>
        </div>
        <div v-else-if="info.kind === 'image'" class="center col">
          <img :key="imgKey" :src="`${src}&r=${imgKey}`" :alt="info.name" class="img" @error="loadErr = true" />
        </div>
        <div v-else-if="info.kind === 'file'" class="center col">
          <Icon name="file" class="big" />
          <div>{{ info.name }}</div>
          <div class="muted">{{ t.binary }} · {{ (info.size / 1024).toFixed(1) }} KB</div>
          <a class="btn primary" :href="rawUrl(info.name, v, true)"><Icon name="download" />{{ t.download }}</a>
        </div>
        <div v-else-if="info.kind === 'markdown' && text !== null" ref="rendered" class="doc" @dblclick="zoomed = !zoomed">
          <Markdown :source="text" />
        </div>
        <div v-else-if="info.kind === 'json' && text !== null && jsonMode === 'structured' && parsed?.ok" ref="rendered" class="doc">
          <JsonTree :value="parsed.value" />
        </div>
        <CodeView v-else-if="text !== null" :code="text" :lang="info.kind === 'json' ? 'json' : info.kind === 'yaml' ? 'yaml' : ext" class="code" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.pv { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
.pv.zoomed { position: fixed; inset: 0; z-index: 50; }
.tb { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tb a { color: var(--fg); }
.sel { height: 26px; font-size: 12px; max-width: 220px; }
.ro { background: var(--warn-bg); color: var(--warn); }
.body { flex: 1; min-height: 0; overflow: auto; position: relative; }
.center { display: flex; align-items: center; justify-content: center; height: 100%; padding: 24px; gap: 8px; }
.center.col { flex-direction: column; }
.big { width: 40px; height: 40px; color: var(--fg3); }
.img { max-width: 100%; max-height: 100%; object-fit: contain; background: repeating-conic-gradient(var(--bg2) 0 25%, var(--bg) 0 50%) 0 0 / 16px 16px; }
.doc { padding: 16px 20px; max-width: 920px; margin: 0 auto; }
.code { min-height: 100%; }
.frame-box { height: 100%; display: flex; justify-content: center; padding: 8px; background: var(--bg2); overflow: hidden; }
.frame-wrap { overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: #fff; flex: none; }
.frame-wrap iframe { border: 0; transform-origin: 0 0; display: block; background: #fff; }
</style>
