import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('./views/Home.vue'),
      children: [
        { path: '', redirect: '/living-room' },
        { path: 'living-room', component: () => import('./views/rooms/LivingRoom.vue') },
        { path: 'bedroom', component: () => import('./views/rooms/Bedroom.vue') },
        { path: 'kitchen', component: () => import('./views/rooms/Kitchen.vue') },
        { path: 'study', component: () => import('./views/rooms/Study.vue') },
        { path: 'bathroom', component: () => import('./views/rooms/Bathroom.vue') },
        { path: 'rooftop', component: () => import('./views/rooms/Rooftop.vue') },
        { path: 'basement', component: () => import('./views/rooms/Basement.vue') },
        { path: 'chat', component: () => import('./views/Chat.vue') },
        { path: 'settings', component: () => import('./views/Settings.vue') },
      ]
    }
  ]
})

export default router
