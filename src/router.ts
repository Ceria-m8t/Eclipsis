import { createRouter, createWebHistory } from 'vue-router'
import Entrance from './views/Entrance.vue'
import LivingRoom from './views/LivingRoom.vue'
import Study from './views/Study.vue'
import Bedroom from './views/Bedroom.vue'
import Kitchen from './views/Kitchen.vue'
import Settings from './views/Settings.vue'

const routes = [
  { path: '/', component: Entrance },
  { path: '/living', component: LivingRoom },
  { path: '/study', component: Study },
  { path: '/bedroom', component: Bedroom },
  { path: '/kitchen', component: Kitchen },
  { path: '/settings', component: Settings }
]

export const router = createRouter({
  history: createWebHistory(),
  routes
})
