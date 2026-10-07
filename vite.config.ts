import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://150.158.175.90:3457',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/v1')
      },
      '/ob': {
        target: 'http://150.158.175.90:18001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ob/, '/api'),
        headers: {
          'Cookie': 'ombre_session=_mw5-B_YQ8SWyh3nJ1H5UysOu5J_okvyX8eTrOGCuR0'
        }
      }
    }
  }
})
