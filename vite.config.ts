import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // 开发时前端跑 5173，API 跑 8787；同源代理避免 CORS 与绝对路径问题
    proxy: { '/api': 'http://localhost:8787' },
  },
})
