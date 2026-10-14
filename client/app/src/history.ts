import { createApp } from 'vue'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { installTokens } from './lib/theme'
import HistoryApp from './history/HistoryApp.vue'
import { lang } from './lib/i18n'

installTokens()
document.documentElement.lang = lang.value
createApp(HistoryApp).mount('#app')
