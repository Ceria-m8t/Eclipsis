import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'
import { startViewportTracking } from './viewport'
import { installAuthGuard } from './auth-guard'
import { startTheme } from './theme'
import { startFont } from './font'
import { upgradeFeatures, syncPromptsFromServer } from './prompt-store'
import { startGlobalGlass } from './liquid/global'

installAuthGuard()
startViewportTracking()
startTheme()
startFont()
// 先和后端同步，再做一次性的功能说明升级（升级要在最新的那份上改）
void syncPromptsFromServer().finally(upgradeFeatures)

createApp(App).use(router).mount('#app')
startGlobalGlass()
