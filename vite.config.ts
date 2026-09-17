import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // relative base so it works from any GitHub Pages subpath without config
  base: './',
  plugins: [react(), tailwindcss()],
})
