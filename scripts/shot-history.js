// 历史记录页截图：填充几条记录后抓取页面，用于视觉检查
// 用法：AVP_E2E_DIR=<文件夹> npx electron scripts/shot-history.js [输出png]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'avp-history-shot-profile'));
app.commandLine.appendSwitch('disable-background-media-suspend');
const testDir = process.env.AVP_E2E_DIR;
if (!testDir || !fs.existsSync(testDir)) { console.error('请设置 AVP_E2E_DIR'); app.exit(1); }
process.env.AVP_SCAN = testDir;

const assocPath = require.resolve('../main/assoc.js');
require.cache[assocPath] = {
  id: assocPath, filename: assocPath, loaded: true,
  exports: { status: () => ({ supported: true, state: 'registered' }), register: () => {}, unregister: () => {}, touchMuiCache: () => {} },
};

require('../main/main.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const wc = win.webContents;
    for (let i = 0; i < 140; i++) {
      if (await wc.executeJavaScript('typeof window.__openVideo').catch(() => null) === 'function') break;
      await sleep(150);
    }
    await wc.executeJavaScript(`document.getElementById('videoEl').muted = true; true`);
    // 造 4 条历史（含进度），模拟真实使用后的样子
    await wc.executeJavaScript(`(async () => {
      const l = await window.api.listVideos();
      const picked = [l[2], l[0], l[5], l[8]].filter(Boolean);
      for (let i = 0; i < picked.length; i++) {
        await window.api.touchHistory({ path: picked[i].path, name: picked[i].name, folder: picked[i].folder });
        await new Promise(r => setTimeout(r, 120));
      }
      await window.api.updateVideo({ id: 4, position: 0, duration: 1 });
      await window.api.updateVideo({ id: picked[1].id, position: 620, duration: 1426 });
      await window.api.updateVideo({ id: picked[2].id, position: 40, duration: 1426 });
      return picked.length;
    })()`);
    await wc.executeJavaScript(`document.querySelector('.nav-btn[data-view="history"]').click(); true`);
    await sleep(900);
    const img = await wc.capturePage();
    const out = process.argv[2] || path.join(os.tmpdir(), 'avp-history.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('saved', out, img.getSize().width + 'x' + img.getSize().height);
    app.exit(0);
  } catch (e) {
    console.error('shot error:', e.message);
    app.exit(1);
  }
});
