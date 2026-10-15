/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // 本地开发：转发到服务器上的 Dylan 网关。key 不写在这里，开发时在设置页填。
      '/api': {
        target: 'http://150.158.175.90:3457',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/v1')
      }
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
})
