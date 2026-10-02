// 临时 e2e 验证脚本：隐藏窗口跑完整应用，验证 字幕/续播/播放列表 三项改动。
// 用法：npx electron scripts/e2e.js
// 测试文件夹默认取 AVP_E2E_DIR 环境变量（需为含内嵌字幕的多集文件夹）。
// 使用独立临时 userData（不碰真实片库数据），结果打 PASS/FAIL 日志。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 独立临时档案，避免污染用户真实片库/设置
app.setPath('userData', path.join(os.tmpdir(), 'avp-e2e-profile'));
// 测试视频文件夹（如：E:\迅雷云盘\[NEST] Wistoria Wand and Sword S02 [CR WEB-DL 1080p AVC AAC][JPSC]）
const testDir = process.env.AVP_E2E_DIR;
if (!testDir || !fs.existsSync(testDir)) {
  console.error('请设置 AVP_E2E_DIR 指向含内嵌字幕的多集视频文件夹');
  app.exit(1);
}
process.env.AVP_SCAN = testDir;

// 打桩 assoc：e2e 不写注册表
const assocPath = require.resolve('../main/assoc.js');
require.cache[assocPath] = {
  id: assocPath, filename: assocPath, loaded: true,
  exports: { status: () => ({ state: 'ok' }), register: () => {}, unregister: () => {}, touchMuiCache: () => {} },
};

// 窗口尽量不显示（失败则退回由 ready 后 hide 兜底）
try {
  const RealBW = BrowserWindow;
  class HiddenBW extends RealBW {
    constructor(opts) { super({ ...opts, show: false }); }
  }
  Object.defineProperty(require('electron'), 'BrowserWindow', { value: HiddenBW, configurable: true });
} catch (e) { console.log('[e2e] BrowserWindow patch skipped:', e.message); }

require('../main/main.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function poll(wc, expr, timeout, check) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try { last = await wc.executeJavaScript(expr, true); } catch { /* 页面未就绪 */ }
    if (last != null && check(last)) return last;
    await sleep(150);
  }
  throw new Error(`poll timeout (${timeout}ms), last=${JSON.stringify(last)}`);
}

app.whenReady().then(async () => {
  const results = [];
  const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  };
  try {
    for (const w of BrowserWindow.getAllWindows()) { try { w.hide(); } catch { /* 已关 */ } }
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('window missing');
    const wc = win.webContents;

    // 等渲染层就绪
    await poll(wc, 'typeof window.__openVideo', 20000, v => v === 'function');
    // 静音 + 装媒体事件日志（断言事件顺序用）
    await wc.executeJavaScript(`(() => {
      const el = document.getElementById('videoEl');
      el.muted = true;
      window.__evlog = [];
      for (const ev of ['play', 'pause', 'seeking', 'seeked', 'loadedmetadata', 'ended']) {
        el.addEventListener(ev, () => window.__evlog.push({ ev, t: Math.round(el.currentTime), at: Math.round(performance.now()) }), true);
      }
      return true;
    })()`);

    const lib = await wc.executeJavaScript(`window.api.listVideos().then(l => l.map(v => ({ id: v.id, name: v.name, folder: v.folder })))`);
    ok('片库扫描', lib.length >= 10, `共 ${lib.length} 个视频`);
    const folder = lib[0]?.folder;
    const expected = lib.filter(v => v.folder === folder).length;

    // ---- 1. 播放列表 = 同文件夹视频，自然排序 ----
    await wc.executeJavaScript(`(async () => {
      const l = await window.api.listVideos();
      window.__openVideo(l.find(v => /S02E03/i.test(v.name)));
      return true;
    })()`);
    const dbg3 = await poll(wc, 'window.__playerDebug()', 25000, d => d.playlist.count > 0 && d.dur > 0);
    ok('播放列表=同文件夹', dbg3.playlist.count === expected, `列表 ${dbg3.playlist.count}/${expected}`);
    ok('E03 排在第 3 位', dbg3.playlist.idx === 2, `idx=${dbg3.playlist.idx}`);

    // ---- 2. 内嵌字幕自动加载（默认 ASS 轨） ----
    const dbgSub = await poll(wc, 'window.__playerDebug()', 40000, d => d.subs.on);
    const sub = await wc.executeJavaScript(`(() => {
      const tt = [...document.getElementById('videoEl').textTracks].find(t => t.mode === 'showing');
      return { label: tt?.label, cues: tt?.cues ? tt.cues.length : 0 };
    })()`);
    ok('内嵌字幕自动加载', dbgSub.subs.on && sub.cues > 50, `label=${dbgSub.subs.label}, cues=${sub.cues}`);

    // ---- 3. 下一集 = 列表下一条 ----
    await wc.executeJavaScript(`document.getElementById('nextBtn').click(); true`);
    const dbg4 = await poll(wc, 'window.__playerDebug()', 25000, d => d.playlist.idx === 3 && d.dur > 0);
    ok('下一集切到 E04', dbg4.playlist.idx === 3, `idx=${dbg4.playlist.idx}`);

    // ---- 3.5 播放列表侧栏：展开 → 点第 6 项 → 收起 ----
    await wc.executeJavaScript(`document.getElementById('listBtn').click(); true`);
    const panel = await poll(wc,
      `({ open: !document.getElementById('playListPanel').classList.contains('hidden'), n: document.querySelectorAll('.plp-item').length })`,
      10000, s => s.open && s.n > 0);
    ok('侧栏面板展开并列出列表', panel.n === expected, `items=${panel.n}`);
    await wc.executeJavaScript(`document.querySelectorAll('.plp-item')[5].click(); true`);
    const dbg6 = await poll(wc, 'window.__playerDebug()', 25000, d => d.playlist.idx === 5 && d.dur > 0);
    ok('点面板第 6 项切到 E06', dbg6.playlist.idx === 5, `idx=${dbg6.playlist.idx}`);
    await wc.executeJavaScript(`document.getElementById('listBtn').click(); true`);
    const closed = await wc.executeJavaScript(`document.getElementById('playListPanel').classList.contains('hidden')`);
    ok('面板可收起', closed);

    // ---- 4. 续播：先暂停定位到记录点再播放 ----
    await wc.executeJavaScript(`(async () => {
      window.__evlog = [];
      const l = await window.api.listVideos();
      const v = l.find(x => /S02E05/i.test(x.name));
      await window.api.updateVideo({ id: v.id, position: 600 });
      window.__openVideo(v);
      return true;
    })()`);
    await poll(wc, 'window.__evlog', 25000,
      log => log.some(e => e.ev === 'play' && e.t > 550));
    const seq = await wc.executeJavaScript(`window.__evlog.map(e => e.ev + '@' + e.t).join(' ')`);
    const metaIdx = seq.indexOf('loadedmetadata');
    const seekIdx = seq.indexOf('seeking@600') >= 0 ? seq.indexOf('seeking@600') : seq.indexOf('seeking@59'); // 关键帧对齐可能落到 59x
    const playIdx = seq.indexOf('play@');
    ok('打开后先暂停定位到记录点（seeking 先于 play）',
      metaIdx >= 0 && seekIdx > metaIdx && playIdx > seekIdx && /seeked/.test(seq.slice(seekIdx, playIdx)),
      seq);
    const dbg5 = await poll(wc, '(() => { const d = window.__playerDebug(); const el = document.getElementById("videoEl"); return { t: d.t, paused: el.paused, seeking: el.seeking }; })()',
      25000, s => !s.paused && !s.seeking && s.t > 590 && s.t < 660);
    ok('从记录点继续播放', dbg5.t > 590 && dbg5.t < 660, `t=${Math.round(dbg5.t)}`);

    console.log('E2E-DONE ' + (results.every(r => r.pass) ? 'ALL-PASS' : 'HAS-FAIL'));
    app.exit(results.every(r => r.pass) ? 0 : 1);
  } catch (e) {
    console.error('E2E-ERROR:', e.message);
    app.exit(1);
  }
});
