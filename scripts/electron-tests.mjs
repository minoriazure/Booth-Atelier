import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'booth-electron-tests-'))
try {
  await build({ entryPoints: ['scripts/renderer-smoke.tsx'], bundle: true, outfile: join(dir, 'renderer.js'), platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  const env = { ...process.env, BOOTH_TEST_DIR: dir, BOOTH_TEST_CSS: resolve('src/renderer/src/styles.css') }
  delete env.ELECTRON_RUN_AS_NODE
  for (const host of ['scripts/electron-test-host.cjs', 'scripts/app-smoke-host.cjs']) {
  const code = await new Promise((done, reject) => {
    const child = spawn(require('electron'), [resolve(host)], { env, stdio: 'inherit', windowsHide: true })
    child.on('error', reject); child.on('exit', done)
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Electron regression timed out')) }, 60000)
    child.on('exit', () => clearTimeout(timeout))
  })
  if (code !== 0) throw new Error(`Electron regression failed: ${code}`)
  }
} finally { rmSync(dir, { recursive: true, force: true }) }
