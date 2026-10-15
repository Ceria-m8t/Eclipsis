import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'
import { startViewportTracking } from './viewport'

startViewportTracking()

createApp(App).use(router).mount('#app')
