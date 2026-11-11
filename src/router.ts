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
        { path: 'hallway', component: () => import('./views/rooms/Hallway.vue') },
        { path: 'bedroom', component: () => import('./views/rooms/Bedroom.vue') },
        { path: 'kitchen', component: () => import('./views/rooms/Kitchen.vue') },
        { path: 'study', component: () => import('./views/rooms/Study.vue') },
        { path: 'study/shelf', component: () => import('./views/rooms/shelf/Bookshelf.vue') },
        { path: 'bathroom', component: () => import('./views/rooms/Bathroom.vue') },
        { path: 'greenhouse', component: () => import('./views/rooms/Greenhouse.vue') },
        { path: 'rooftop', component: () => import('./views/rooms/Rooftop.vue') },
        { path: 'basement', component: () => import('./views/rooms/Basement.vue') },
        { path: 'settings/prompt', component: () => import('./views/PromptEditor.vue') },
        // 设置是两层：/settings 目录，/settings/<哪一项>（同一个组件，切换时不重建，没保存的改动还在）
        { path: 'settings/:section?', component: () => import('./views/Settings.vue') },
        { path: 'chat', component: () => import('./views/Chat.vue') },
      ]
    }
  ]
})

export default router
