import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(appDir, '..')

const VIRTUAL_DEV_TAILWIND = '\0virtual:dev-tailwind-styles'
const TAILWIND_DEV_PATH = '/__tailwind.css'

/**
 * In dev, Vite normally injects CSS via JS (`updateStyle`), which strict CSP in embedded
 * browsers (Freedom / miniapp WebViews) blocks. Serve the compiled Tailwind file as a real
 * stylesheet and drop the CSS import from the module graph during `vite` only.
 */
function tailwindLinkedStylesheetDev(): Plugin {
  return {
    name: 'tailwind-linked-stylesheet-dev',
    apply: 'serve',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './index.css' || !importer || !/[\\/]main\.tsx$/.test(importer)) return null
      return VIRTUAL_DEV_TAILWIND
    },
    load(id) {
      if (id !== VIRTUAL_DEV_TAILWIND) return null
      return '// Styles loaded via <link> in dev (CSP-safe)\nexport {}\n'
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (url !== TAILWIND_DEV_PATH) return next()
        try {
          const cssPath = path.join(appDir, 'src', 'index.css')
          const input = fs.readFileSync(cssPath, 'utf8')
          const postcss = (await import('postcss')).default
          const { default: postcssrc } = await import('postcss-load-config')
          const { plugins, options } = await postcssrc({ cwd: appDir })
          const result = await postcss(plugins).process(input, { ...options, from: cssPath })
          res.setHeader('Content-Type', 'text/css; charset=utf-8')
          res.end(result.css)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(`/* Failed to compile Tailwind for dev */\n/* ${message} */\n`)
        }
      })
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (html.includes(TAILWIND_DEV_PATH)) return html
        return html.replace(
          '</head>',
          `  <link rel="stylesheet" href="${TAILWIND_DEV_PATH}" />\n</head>`,
        )
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [tailwindLinkedStylesheetDev(), react()],
  resolve: {
    alias: {
      // Local workspace package: avoids broken symlinks and missing `dist/` during dev.
      'swarm-kv': path.resolve(repoRoot, 'swarm-kv/src/index.ts'),
    },
  },
  server: {
    fs: {
      allow: [appDir, repoRoot],
    },
  },
  optimizeDeps: {
    include: ['@ethersphere/bee-js'],
  },
})
