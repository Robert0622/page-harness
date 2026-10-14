import { createApp } from 'vue'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { installTokens } from './lib/theme'
import ChatApp from './chat/ChatApp.vue'
import ArtifactsApp from './artifacts/ArtifactsApp.vue'
import { lang } from './lib/i18n'

installTokens()
document.documentElement.lang = lang.value
const role = location.hash === '#artifacts' ? 'artifacts' : 'chat'
createApp(role === 'artifacts' ? ArtifactsApp : ChatApp).mount('#app')
