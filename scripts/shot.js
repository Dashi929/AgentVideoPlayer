// 临时截图脚本：打开测试视频并暂停，抓取播放器控制条用于视觉检查
// 用法：AVP_E2E_DIR=<文件夹> npx electron scripts/shot.js [输出png路径]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'avp-e2e-profile'));
const testDir = process.env.AVP_E2E_DIR;
if (!testDir || !fs.existsSync(testDir)) { console.error('请设置 AVP_E2E_DIR'); app.exit(1); }
process.env.AVP_SCAN = testDir;

const assocPath = require.resolve('../main/assoc.js');
require.cache[assocPath] = {
  id: assocPath, filename: assocPath, loaded: true,
  exports: { status: () => ({ state: 'ok' }), register: () => {}, unregister: () => {}, touchMuiCache: () => {} },
};

try {
  const RealBW = BrowserWindow;
  class ShotBW extends RealBW {
    constructor(opts) { super({ ...opts, show: false }); }
  }
  Object.defineProperty(require('electron'), 'BrowserWindow', { value: ShotBW, configurable: true });
} catch (e) { console.log('[shot] patch skipped:', e.message); }

require('../main/main.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    win.show();
    const wc = win.webContents;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (await wc.executeJavaScript('typeof window.__openVideo').catch(() => null) === 'function') break;
      await sleep(150);
    }
    await wc.executeJavaScript(`(async () => {
      const el = document.getElementById('videoEl');
      el.muted = true;
      // 与 app.js showPlayer 一致：先切到播放器视图再打开视频
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-player'));
      const l = await window.api.listVideos();
      window.__openVideo(l.find(v => /S02E03/i.test(v.name)));
      return true;
    })()`);
    // 等起播 + 分辨率徽章出现，然后暂停让控制条常驻
    await sleep(6000);
    await wc.executeJavaScript(`(() => {
      document.getElementById('videoEl').pause();
      document.getElementById('videoEl').currentTime = 300;
      document.querySelectorAll('.overlay-bar, .overlay-rail, #playListPanel').forEach(() => {});
      return true;
    })()`);
    await sleep(800);
    const img = await wc.capturePage();
    const out = process.argv[2] || path.join(os.tmpdir(), 'avp-shot.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('saved', out, img.getSize().width + 'x' + img.getSize().height);
    app.exit(0);
  } catch (e) {
    console.error('shot error:', e.message);
    app.exit(1);
  }
});
