<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { fmt, lang, setLang, t } from '../lib/i18n'
import type { ChatStore } from './store'

const props = defineProps<{ store: ChatStore }>()
const s = props.store
const name = ref(s.me.value?.name ?? '')
watch(
  () => s.me.value?.name,
  (n) => n && (name.value = n),
)
const named = computed(() => !!s.me.value?.name)
const editing = ref(false)
const open = computed(() => s.review.value.items.filter((i) => i.status === 'open').length)
const mine = computed(() => s.review.value.items.filter((i) => i.author.id === s.me.value?.id).length)

function save() {
  if (!name.value.trim()) return
  s.setName(name.value.trim())
  editing.value = false
}
</script>

<template>
  <div class="rp" data-testid="reviewer-panel">
    <header>
      <Icon name="pen" />
      <b>{{ t.reviewerTitle }}</b>
      <span class="spacer" />
      <div class="seg">
        <button class="btn sm" :class="{ on: lang === 'zh-CN' }" @click="setLang('zh-CN')">中</button>
        <button class="btn sm" :class="{ on: lang === 'en' }" @click="setLang('en')">EN</button>
      </div>
    </header>
    <div v-if="s.conn.value !== 'ready'" class="conn">{{ s.conn.value === 'connecting' ? t.connecting : t.netError }}</div>
    <main>
      <form v-if="!named || editing" class="name" @submit.prevent="save">
        <label for="rp-name">{{ t.reviewerNameLabel }}</label>
        <input id="rp-name" v-model="name" class="input" maxlength="40" :placeholder="t.reviewerNamePh" data-testid="reviewer-name" autofocus />
        <button class="btn primary" type="submit" :disabled="!name.trim()" data-testid="reviewer-save">{{ t.reviewerJoin }}</button>
      </form>
      <div v-else class="me">
        <div class="av">{{ s.me.value!.name.slice(0, 1).toUpperCase() }}</div>
        <div class="who">
          <b data-testid="reviewer-me">{{ s.me.value!.name }}</b>
          <span class="muted">{{ t.reviewerRole }}</span>
        </div>
        <button class="btn ghost sm" @click="editing = true">{{ t.rename }}</button>
      </div>
      <div class="stats">
        <span>{{ fmt(t.reviewerStats, { open, mine }) }}</span>
      </div>
      <ul class="how">
        <li>{{ t.reviewerHowComment }}</li>
        <li v-if="s.mode.value === 'review'">{{ t.reviewerHowEdit }}</li>
        <li>{{ t.reviewerHowThread }}</li>
        <li>{{ t.reviewerHowApprove }}</li>
      </ul>
      <p class="muted small">{{ t.reviewerLimits }}</p>
    </main>
  </div>
</template>

<style scoped>
.rp { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
header { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 10px; border-bottom: 1px solid var(--line); }
header svg { width: 15px; height: 15px; color: var(--accent); }
.conn { padding: 6px 12px; font-size: var(--fs-sm); background: var(--bg2); border-bottom: 1px solid var(--line); }
main { padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
.name { display: flex; flex-direction: column; gap: 8px; }
.name label { font-weight: 600; }
.me { display: flex; align-items: center; gap: 10px; }
.av { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: var(--accent-fg); font-weight: 700; }
.who { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.stats { font-size: var(--fs-sm); color: var(--fg2); }
.how { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); line-height: 1.5; }
.small { font-size: var(--fs-xs); margin: 0; line-height: 1.5; }
</style>
