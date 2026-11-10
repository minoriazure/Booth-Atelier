const { app, net } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const root = process.env.BOOTH_TEST_DIR
process.env.PORTABLE_EXECUTABLE_DIR = join(root, 'portable')
process.env.BOOTH_NO_STARTUP = '1'
process.env.BOOTH_SMOKE = '1'
mkdirSync(join(root, 'portable', 'data', 'items', '1'), { recursive: true })
writeFileSync(join(root, 'portable', 'booth_cookies.txt'), '# Netscape HTTP Cookie File\n')
const media = join(root, 'portable', 'data', 'items', '1', 'test.webm')
const outside = join(root, 'outside.webm')
writeFileSync(media, 'abcdef'); writeFileSync(outside, 'secret')
app.on('session-created', (session) => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
})
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const settings = await window.boothAPI.settings.get();
        if (!settings.downloadRoot) throw new Error('trusted IPC failed');
        let rejected = false;
        try { await window.boothAPI.settings.set({downloadRootMissing:false}) } catch { rejected = true }
        if (!rejected) throw new Error('internal settings were writable');
        return {passed:['application startup','trusted IPC','settings boundary']};
      })()`)
      console.log(JSON.stringify(result))
      const response = await net.fetch(`image-cache://local/${encodeURIComponent(media)}`, { headers: { Range: 'bytes=-3' } })
      if (response.status !== 206 || await response.text() !== 'def') throw new Error('media range failed')
      const denied = await net.fetch(`image-cache://local/${encodeURIComponent(outside)}`)
      if (denied.status < 400) throw new Error('outside media was readable')
      await denied.body?.cancel()
      console.log('Media range and root boundaries verified')
      await win.loadURL('about:blank')
      const rejected = await win.webContents.executeJavaScript('(async()=>{try{await window.boothAPI.settings.get();return false}catch{return true}})()')
      if (!rejected) throw new Error('IPC allowed untrusted navigation')
      console.log('Untrusted navigation IPC rejected')
      app.quit()
    } catch (error) { console.error(error); app.exit(1) }
  })
})
require(resolve('out/main/index.js'))
