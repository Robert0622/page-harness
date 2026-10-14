<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { lang, setLang, t } from '../lib/i18n'
import type { ChatStore } from './store'

const props = defineProps<{ store: ChatStore }>()
const s = props.store
const open = ref(false)
const myName = ref('')
const copied = ref(false)
watch(
  () => s.me.value?.name,
  (n) => (myName.value = n ?? ''),
  { immediate: true },
)
function saveName() {
  if (myName.value.trim() && myName.value.trim() !== s.me.value?.name) s.setName(myName.value.trim())
}
async function copyShare() {
  if (!s.share.value) return
  try {
    await navigator.clipboard.writeText(s.share.value)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = s.share.value
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
const root = ref<HTMLElement>()
const statusKey = computed(() => {
  if (!s.controlOn.value) return 'disabled'
  if (s.controlOutdated.value || (s.page.attached && s.page.caps.pageControl === null && s.pageStatus.value === 'unsupported')) return 'unsupported'
  return s.pageStatus.value === 'disabled' ? 'offline' : s.pageStatus.value
})
const statusText = computed(() => (t.value as unknown as Record<string, string>)[`status_${statusKey.value}`])

const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !e.composedPath().includes(root.value)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div ref="root" class="settings">
    <button class="btn ghost icon" :title="t.settings" data-testid="settings" @click="open = !open">
      <Icon name="gear" />
      <span v-if="s.controlOn.value" class="dot" />
    </button>
    <div v-if="open" class="menu card">
      <div class="h">{{ t.settings }}</div>
      <label class="tog">
        <span>{{ t.allowControl }}</span>
        <input v-model="s.controlOn.value" class="switch" type="checkbox" data-testid="toggle-control" />
      </label>
      <p class="desc">{{ t.controlPrivacy }}</p>
      <div v-if="s.controlOn.value" class="status" :class="statusKey" data-testid="control-status"><i />{{ statusText }}</div>
      <hr />
      <label class="tog">
        <span>{{ t.liveToggle }}</span>
        <input v-model="s.liveOn.value" class="switch" type="checkbox" data-testid="toggle-live" />
      </label>
      <p class="desc">{{ s.mode.value === 'review' ? t.liveReviewDesc : t.liveDesc }}</p>
      <hr />
      <div class="h">{{ t.teamTitle }}</div>
      <label class="field">
        <span class="muted">{{ t.myName }}</span>
        <input v-model="myName" class="input" maxlength="40" data-testid="owner-name" @change="saveName" @keydown.enter="saveName" />
      </label>
      <template v-if="s.share.value">
        <p class="desc">{{ t.teamShareDesc }}</p>
        <div class="share">
          <input class="input" readonly :value="s.share.value" data-testid="share-link" @focus="($event.target as HTMLInputElement).select()" />
          <button class="btn sm" @click="copyShare">{{ copied ? t.copied : t.copyLink }}</button>
        </div>
      </template>
      <p v-else class="desc">{{ t.teamNoShare }}</p>
      <hr />
      <div class="row">
        <span class="muted">{{ t.language }}</span>
        <span class="spacer" />
        <div class="seg">
          <button class="btn sm" :class="{ on: lang === 'zh-CN' }" @click="setLang('zh-CN')">中文</button>
          <button class="btn sm" :class="{ on: lang === 'en' }" @click="setLang('en')">English</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings { position: relative; }
.dot { position: absolute; top: 4px; right: 4px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg); }
.menu { position: absolute; right: 0; top: 36px; border-radius: var(--r-lg); z-index: 30; width: 300px; padding: 12px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 8px; }
.h { font-weight: 600; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); }
.share { display: flex; gap: 6px; }
.share .input { flex: 1; min-width: 0; font: var(--fs-xs)/1 var(--mono); }
.tog { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-weight: 600; cursor: pointer; }
.desc { margin: 0; color: var(--fg2); font-size: var(--fs-sm); line-height: 1.5; }
.status { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); }
.status i { width: 8px; height: 8px; border-radius: 50%; background: var(--fg3); }
.status.online i { background: var(--ok); }
.status.paused i, .status.transferred i { background: var(--warn); }
.status.unsupported { color: var(--err); }
.status.unsupported i { background: var(--err); }
hr { border: 0; border-top: 1px solid var(--line2); margin: 2px 0; width: 100%; }
</style>
