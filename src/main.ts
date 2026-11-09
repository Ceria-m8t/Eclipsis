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
// 以前直连的 MCP（记忆库，带令牌）存在手机里；工具都搬到后端的工具箱了，这份不再用，清掉
try { localStorage.removeItem('eclipsis-mcp-servers') } catch {}
startViewportTracking()
startTheme()
startFont()
// 先和后端同步，再做一次性的功能说明升级（升级要在最新的那份上改）
void syncPromptsFromServer().finally(upgradeFeatures)

createApp(App).use(router).mount('#app')
startGlobalGlass()
