import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'
import { startViewportTracking } from './viewport'
import { installAuthGuard } from './auth-guard'

installAuthGuard()
startViewportTracking()

createApp(App).use(router).mount('#app')
