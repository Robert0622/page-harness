<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AgentBadge from '../components/AgentBadge.vue'
import Icon from '../components/Icon.vue'
import { brand } from '../lib/agents'
import { relTime, t } from '../lib/i18n'
import type { ChatStore } from './store'

const props = defineProps<{ store: ChatStore }>()
const s = props.store
const open = ref(false)
const renaming = ref(false)
const title = ref('')
const root = ref<HTMLElement>()
const input = ref<HTMLInputElement>()

function startRename() {
  title.value = s.chat.value?.title ?? ''
  renaming.value = true
  open.value = false
  nextTick(() => input.value?.select())
}
async function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  if (title.value.trim() && title.value !== s.chat.value?.title) await s.updateChat({ title: title.value })
}
const onDoc = (e: MouseEvent) => {
  if (open.value && root.value && !e.composedPath().includes(root.value)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDoc))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc))
</script>

<template>
  <div ref="root" class="switcher">
    <input v-if="renaming" ref="input" v-model="title" class="input rn" @keydown.enter="commitRename" @keydown.esc="renaming = false" @blur="commitRename" />
    <button v-else class="cur" data-testid="chat-switcher" @click="open = !open" @dblclick="startRename">
      <span class="tt">{{ s.chat.value?.title || t.newChat }}</span>
      <Icon name="chevron" />
    </button>
    <div v-if="open" class="menu card">
      <div class="acts">
        <button class="btn sm" data-testid="new-chat" @click="(open = false), s.newChat()"><Icon name="plus" />{{ t.newChat }}</button>
        <button class="btn sm" :disabled="!s.chat.value" @click="startRename"><Icon name="edit" />{{ t.rename }}</button>
        <a class="btn sm" href="/__ph/history" target="_blank" rel="noopener"><Icon name="history" />{{ t.history }}</a>
      </div>
      <div class="list">
        <button v-for="c in s.chats.value" :key="c.id" class="item" :class="{ on: c.id === s.chat.value?.id }" @click="(open = false), s.switchChat(c.id)">
          <span class="tt">{{ c.title || t.untitled }}</span>
          <span class="meta faint"><AgentBadge :id="c.agent" size="xs" /><span class="mt">{{ brand(c.agent).short }}{{ c.model ? ` · ${c.model}` : '' }} · {{ relTime(c.updatedAt) }}</span></span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.switcher { position: relative; min-width: 0; flex: 1; }
.cur { display: flex; align-items: center; gap: 4px; max-width: 100%; height: 28px; border: 0; background: none; padding: 0 8px; border-radius: var(--r); font-weight: 600; }
.cur:hover { background: var(--bg2); }
.cur svg { width: 14px; height: 14px; flex: none; color: var(--fg2); }
.tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn { width: 100%; height: 28px; }
.menu { position: absolute; left: 0; top: 36px; border-radius: var(--r-lg); z-index: 30; width: min(320px, calc(100vw - 16px)); box-shadow: var(--shadow); overflow: hidden; }
.acts { display: flex; gap: 4px; padding: 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.acts a { text-decoration: none; color: var(--fg); }
.list { max-height: 50vh; overflow: auto; padding: 4px; }
.item { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; border: 0; background: none; padding: 6px 10px; border-radius: var(--r-sm); text-align: left; }
.item:hover { background: var(--bg2); }
.item.on { background: var(--accent-soft); }
.item.on .tt { color: var(--accent-2); font-weight: 600; }
.item .tt { max-width: 100%; }
.meta { display: flex; align-items: center; gap: 4px; max-width: 100%; font-size: 11px; }
.mt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
