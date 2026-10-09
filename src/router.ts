import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/living'
    },
    {
      path: '/living',
      component: () => import('./views/LivingRoom.vue')
    },
    {
      path: '/living/chat',
      component: () => import('./views/LivingChat.vue')
    },
    {
      path: '/living/calendar',
      component: () => import('./views/Calendar.vue')
    },
    {
      path: '/study',
      component: () => import('./views/Study.vue')
    },
    {
      path: '/settings',
      component: () => import('./views/Settings.vue')
    }
  ]
})

export default router
