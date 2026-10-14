<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { t } from '../lib/i18n'
import ModelPicker from './ModelPicker.vue'
import type { ChatStore } from './store'

const props = defineProps<{ store: ChatStore }>()
const s = props.store
const ta = ref<HTMLTextAreaElement>()
const fileInput = ref<HTMLInputElement>()
const dragging = ref(false)

const resize = () => {
  const el = ta.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 128)}px`
}
watch(() => s.draft.text, () => nextTick(resize))

function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    send()
  }
}
function send() {
  if (s.sendPrompt()) nextTick(() => ta.value?.focus())
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) {
    e.preventDefault()
    void s.addFiles(files)
  }
}
function onPickFiles() {
  const files = fileInput.value?.files
  if (files?.length) void s.addFiles([...files])
  if (fileInput.value) fileInput.value.value = ''
}
function onDrop(e: DragEvent) {
  dragging.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) void s.addFiles(files)
}
defineExpose({ focus: () => ta.value?.focus() })
</script>

<template>
  <div class="composer" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
    <div class="box">
      <div v-if="s.draft.picks.length || s.draft.marks.length || s.draft.attachments.length" class="drafts">
        <span v-for="(p, i) in s.draft.picks" :key="p.id" class="chip draft" :title="p.selector">
          <Icon name="target" /><span class="lbl">&lt;{{ p.tagName.toLowerCase() }}&gt; {{ p.text || p.selector }}</span>
          <button :title="t.removeDraft" :aria-label="t.removeDraft" data-testid="remove-draft" @click="s.draft.picks.splice(i, 1)"><Icon name="x" /></button>
        </span>
        <span v-for="(m, i) in s.draft.marks" :key="'m' + m.n" class="chip draft" :title="m.note || undefined">
          <Icon name="pen" /><span class="lbl">{{ t.marks }} {{ m.n }}{{ m.note ? ` · ${m.note}` : '' }}</span>
          <button :title="t.removeDraft" :aria-label="t.removeDraft" data-testid="remove-draft" @click="s.draft.marks.splice(i, 1)"><Icon name="x" /></button>
        </span>
        <span v-for="(a, i) in s.draft.attachments" :key="'a' + i" class="att" :class="{ err: a.error }" :title="a.error || a.name">
          <img v-if="a.preview" :src="a.preview" alt="" />
          <span v-else class="fname"><Icon name="file" />{{ a.name }}</span>
          <span v-if="a.uploading" class="spin" />
          <button :title="t.removeDraft" @click="s.draft.attachments.splice(i, 1)"><Icon name="x" /></button>
        </span>
      </div>
      <textarea
        ref="ta"
        v-model="s.draft.text"
        rows="1"
        :placeholder="s.running.value ? t.placeholderBusy : t.placeholder"
        @keydown="onKey"
        @paste="onPaste"
      />
      <div class="bar">
        <button class="btn icon attach" :title="t.attach" @click="fileInput?.click()"><Icon name="clip" /></button>
        <input ref="fileInput" type="file" multiple hidden @change="onPickFiles" />
        <ModelPicker :store="s" />
        <span class="spacer" />
        <button v-if="s.running.value" class="btn sm danger stop" @click="s.send({ type: 'cancel' })"><Icon name="stop" />{{ t.stop }}</button>
        <button class="btn primary icon send" :title="t.send" :aria-label="t.send" :disabled="!s.canSend.value || s.conn.value !== 'ready'" data-testid="send" @click="send"><Icon name="send" /></button>
      </div>
    </div>
    <div class="hint">{{ t.enterHint }}</div>
  </div>
</template>

<style scoped>
.composer { position: relative; padding: 8px 12px 6px; border-top: 1px solid var(--line); background: var(--bg); }
.box { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r); background: var(--base); transition: border-color var(--dur), box-shadow var(--dur); }
.box:focus-within { border-color: var(--accent); box-shadow: var(--focus); }
.dragging .box { border-style: dashed; border-color: var(--accent); }
.drafts { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 8px 0; }
.chip.draft { background: var(--accent-soft); color: var(--fg); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); max-width: 100%; padding-right: 2px; }
.chip.draft svg { width: 12px; height: 12px; flex: none; }
.chip.draft .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.draft button { flex: none; }
.chip.draft button, .att button { border: 0; background: none; padding: 0 2px; display: inline-grid; place-items: center; color: var(--fg2); }
.chip.draft button svg, .att button svg { width: 12px; height: 12px; }
.att { position: relative; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 2px; background: var(--bg); }
.att.err { border-color: var(--err); }
.att img { width: 52px; height: 52px; object-fit: cover; border-radius: 4px; }
.att .fname { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); padding: 0 6px; height: 28px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att .fname svg { width: 13px; height: 13px; }
.att > button { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; border-radius: 50%; background: var(--err); color: #fff; }
textarea { display: block; width: 100%; resize: none; border: 0; padding: 9px 10px 4px; background: transparent; outline: none; min-height: 40px; max-height: 128px; line-height: 1.5; font-size: var(--fs-lg); }
.bar { display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 8px; }
.attach { width: 32px; height: 32px; color: var(--fg2); background: var(--bg); }
.attach svg { width: 16px; height: 16px; }
.send { width: 30px; height: 30px; }
.send svg { width: 14px; height: 14px; }
.stop { height: 28px; }
.hint { padding: 4px 2px 0; font-size: var(--fs-xs); color: var(--fg3); }
</style>
