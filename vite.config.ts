import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The build stamp at the foot of the Wallet page (src/components/BuildStamp.tsx):
 * the commit and the UK time of the build, e.g. "4f1c2a9 · 23 Oct 2026 18:40".
 * A commit with uncommitted changes on top is marked "+".
 */
function buildId(): string {
  const git = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
      return ''
    }
  }
  const sha = git('git rev-parse --short HEAD') || 'unknown'
  const dirty = git('git status --porcelain --untracked-files=no') ? '+' : ''
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date())
  return `${sha}${dirty} · ${when.replace(',', '')}`
}

// https://vite.dev/config/
export default defineConfig({
  // relative base so it works from any GitHub Pages subpath without config
  base: './',
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  plugins: [react(), tailwindcss()],
})
