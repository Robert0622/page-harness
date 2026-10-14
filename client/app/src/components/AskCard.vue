<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { AskAnswer, AskSpec } from '@shared/protocol'
import { t } from '../lib/i18n'

const props = defineProps<{ askId: string; spec: AskSpec; answer?: AskAnswer; pending: boolean; turnRunning: boolean }>()
const emit = defineEmits<{ answer: [askId: string, answer: AskAnswer] }>()

const step = ref(0)
const sel = reactive<Record<string, string[]>>({})
const other = reactive<Record<string, string>>({})
const values = reactive<Record<string, string>>({})
if (props.spec.kind === 'form') for (const f of props.spec.fields) values[f.name] = f.default ?? ''

const active = computed(() => !props.answer && props.pending)
const questions = computed(() => (props.spec.kind === 'question' ? props.spec.questions : []))
const q = computed(() => questions.value[step.value])

function toggle(qid: string, oid: string, multiple?: boolean) {
  const cur = sel[qid] ?? []
  sel[qid] = multiple ? (cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid]) : [oid]
}
const answered = (qid: string) => (sel[qid]?.length ?? 0) > 0 || !!other[qid]?.trim()

function submitQuestions() {
  const answers: Record<string, { selected: string[]; other?: string }> = {}
  for (const x of questions.value) answers[x.id] = { selected: sel[x.id] ?? [], other: other[x.id]?.trim() || undefined }
  emit('answer', props.askId, { answers })
}
const formValid = computed(() => props.spec.kind !== 'form' || props.spec.fields.every((f) => !f.required || values[f.name]?.trim()))
function submitForm() {
  if (!formValid.value) return
  emit('answer', props.askId, { values: { ...values } })
}
const skip = () => emit('answer', props.askId, { skipped: true })

const summary = computed(() => {
  const a = props.answer
  if (!a) return props.turnRunning ? '' : t.value.answerCancelled
  if ('skipped' in a) return t.value.skipped
  if ('timeout' in a) return t.value.answerTimeout
  if ('cancelled' in a) return t.value.answerCancelled
  return ''
})
const label = (qid: string, oid: string) => questions.value.find((x) => x.id === qid)?.options.find((o) => o.id === oid)?.label ?? oid
</script>

<template>
  <div class="ask card">
    <div v-if="spec.title" class="title">{{ spec.title }}</div>

    <!-- answered / closed -->
    <template v-if="!active">
      <div v-if="answer && 'answers' in answer" class="sum">
        <div v-for="x in questions" :key="x.id" class="qa">
          <div class="qp">{{ x.prompt }}</div>
          <div class="qv">
            {{ [...(answer.answers[x.id]?.selected ?? []).map((o) => label(x.id, o)), answer.answers[x.id]?.other ? `${t.other}: ${answer.answers[x.id]?.other}` : ''].filter(Boolean).join('、') || '—' }}
          </div>
        </div>
      </div>
      <div v-else-if="answer && 'values' in answer && spec.kind === 'form'" class="sum">
        <div v-for="f in spec.fields" :key="f.name" class="qa">
          <div class="qp">{{ f.label }}</div>
          <div class="qv">{{ answer.values[f.name] || '—' }}</div>
        </div>
      </div>
      <div v-if="summary" class="faint">{{ summary }}</div>
    </template>

    <!-- question -->
    <template v-else-if="spec.kind === 'question' && q">
      <div v-if="questions.length > 1" class="dots">
        <span v-for="(x, i) in questions" :key="x.id" :class="{ cur: i === step, done: answered(x.id) }" @click="step = i" />
      </div>
      <div class="prompt">{{ q.prompt }}</div>
      <div class="opts">
        <label v-for="o in q.options" :key="o.id" class="opt" :class="{ on: sel[q.id]?.includes(o.id) }">
          <input :type="q.multiple ? 'checkbox' : 'radio'" :name="askId + q.id" :checked="sel[q.id]?.includes(o.id)" @change="toggle(q.id, o.id, q.multiple)" />
          <span class="ol">
            <span>{{ o.label }}</span>
            <span v-if="o.recommended" class="rec">{{ t.recommended }}</span>
            <span v-if="o.description" class="od">{{ o.description }}</span>
          </span>
        </label>
        <label v-if="q.allowOther !== false" class="opt other">
          <span class="ol">{{ t.other }}</span>
          <input v-model="other[q.id]" class="input" :placeholder="t.otherPlaceholder" @keydown.stop />
        </label>
      </div>
      <div class="foot">
        <button class="btn ghost sm" @click="skip">{{ t.skip }}</button>
        <span class="spacer" />
        <button v-if="step > 0" class="btn sm" @click="step--">{{ t.prev }}</button>
        <button v-if="step < questions.length - 1" class="btn sm primary" :disabled="!answered(q.id)" @click="step++">{{ t.next }}</button>
        <button v-else class="btn sm primary" :disabled="!questions.every((x) => answered(x.id))" @click="submitQuestions">{{ t.submit }}</button>
      </div>
    </template>

    <!-- form -->
    <template v-else-if="spec.kind === 'form'">
      <div v-if="spec.description" class="muted">{{ spec.description }}</div>
      <label v-for="f in spec.fields" :key="f.name" class="field">
        <span>{{ f.label }}<em v-if="f.required"> *</em></span>
        <textarea v-if="f.type === 'textarea'" v-model="values[f.name]" class="input ta" :placeholder="f.placeholder" rows="3" @keydown.stop />
        <input v-else v-model="values[f.name]" class="input" :type="f.type === 'url' ? 'url' : 'text'" :placeholder="f.placeholder" @keydown.stop @keydown.enter="submitForm" />
      </label>
      <div class="foot">
        <button class="btn ghost sm" @click="skip">{{ t.skip }}</button>
        <span class="spacer" />
        <button class="btn sm primary" :disabled="!formValid" @click="submitForm">{{ t.submit }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ask { padding: 12px; display: flex; flex-direction: column; gap: 10px; border-radius: var(--r-xl); border-color: color-mix(in srgb, var(--agent) 25%, var(--line)); background: color-mix(in srgb, var(--agent) 5%, var(--bg)); }
.title { font-weight: 600; }
.dots { display: flex; gap: 4px; }
.dots span { height: 4px; flex: 1; max-width: 28px; border-radius: 999px; background: var(--line); cursor: pointer; transition: background var(--dur); }
.dots span.done { background: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.dots span.cur { background: var(--accent); }
.prompt { font-weight: 600; }
.opts { display: flex; flex-direction: column; gap: 6px; }
.opt { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--bg); cursor: pointer; transition: border-color var(--dur), background var(--dur); }
.opt:hover { border-color: var(--line-strong); }
.opt.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent-soft) 60%, var(--bg)); }
.opt input[type='radio'], .opt input[type='checkbox'] { width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--accent); flex: none; }
.ol { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; flex: 1; }
.rec { font-size: var(--fs-xs); padding: 0 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent-2); font-weight: 500; }
.od { width: 100%; color: var(--fg2); font-size: var(--fs-sm); }
.opt.other { align-items: center; cursor: default; }
.opt.other .ol { flex: none; }
.opt.other .input { flex: 1; height: 26px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field em { color: var(--err); font-style: normal; }
.ta { height: auto; padding: 6px 8px; resize: vertical; }
.foot { display: flex; gap: 6px; align-items: center; }
.sum { display: flex; flex-direction: column; gap: 6px; }
.qa { padding: 6px 10px; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg); }
.qp { color: var(--fg3); font-size: var(--fs-xs); }
.qv { font-weight: 600; }
</style>
