import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'
import { startViewportTracking } from './viewport'
import { installAuthGuard } from './auth-guard'
import { startTheme } from './theme'
import { startFont } from './font'
import { upgradeFeatures } from './prompt-store'

installAuthGuard()
startViewportTracking()
startTheme()
startFont()
upgradeFeatures()

createApp(App).use(router).mount('#app')
