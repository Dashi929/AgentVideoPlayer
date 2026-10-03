// 历史记录功能验证：播放登记 → 列表显示 → 打开（走 showPlayer）→ 删除单条 → 清空
// 用法：AVP_E2E_DIR=<含多个视频的文件夹> npx electron scripts/test-history.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'avp-history-e2e-profile'));
// 与 e2e.js 相同：隐藏窗口里禁用后台媒体挂起/节流，否则 playing 事件不会到来
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-features', 'MediaSuspend,BackgroundVideoPauseOptimization,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const testDir = process.env.AVP_E2E_DIR;
if (!testDir || !fs.existsSync(testDir)) { console.error('请设置 AVP_E2E_DIR'); app.exit(1); }
process.env.AVP_SCAN = testDir;

const assocPath = require.resolve('../main/assoc.js');
require.cache[assocPath] = {
  id: assocPath, filename: assocPath, loaded: true,
  exports: { status: () => ({ supported: true, state: 'ok' }), register: () => {}, unregister: () => {}, touchMuiCache: () => {} },
};

// 窗口创建后再隐藏：创建时就 show:false 会让媒体管线挂起（playing 事件永远不来）
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
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('window missing');
    const wc = win.webContents;
    // 注意：窗口保持可见。隐藏窗口会让 Chromium 挂起媒体管线，playing 事件不再到来，
    // 播放登记也就无从验证（与 scripts/e2e.js 的行为一致）。
    await poll(wc, 'typeof window.__openVideo', 20000, v => v === 'function');
    await wc.executeJavaScript(`document.getElementById('videoEl').muted = true; true`);

    const lib = await wc.executeJavaScript(`window.api.listVideos().then(l => l.map(v => ({ id: v.id, name: v.name, path: v.path, folder: v.folder })))`);
    ok('片库扫描出视频', lib.length >= 2, `共 ${lib.length} 个视频`);
    const v1 = lib.find(v => /S02E03/i.test(v.name)) || lib[0];
    const v2 = lib.find(v => v.id !== v1.id);
    const ep = (name) => (name.match(/S0\dE\d+/i) || [name.slice(0, 12)])[0];

    // ---- 1. 侧栏入口存在，且位于 AI 助手与设置之间 ----
    const navOrder = await wc.executeJavaScript(`[...document.querySelectorAll('.nav-btn')].map(b => b.dataset.view)`);
    const iAgent = navOrder.indexOf('agent'), iHist = navOrder.indexOf('history'), iSet = navOrder.indexOf('settings');
    ok('侧栏「历史记录」位于 AI 助手与设置之间', iAgent >= 0 && iHist === iAgent + 1 && iSet === iHist + 1, navOrder.join(' > '));
    const navLabel = await wc.executeJavaScript(`document.querySelector('.nav-btn[data-view="history"] span').textContent`);
    ok('导航文案为「历史记录」', navLabel === '历史记录', navLabel);

    // ---- 2. 未播放时为空态 ----
    await wc.executeJavaScript(`document.querySelector('.nav-btn[data-view="history"]').click(); true`);
    const emptyState = await poll(wc,
      `({ empty: !document.getElementById('historyEmpty').classList.contains('hidden'), rows: document.querySelectorAll('.history-row').length })`,
      8000, s => s);
    ok('初始为空态', emptyState.empty && emptyState.rows === 0, JSON.stringify(emptyState));

    // ---- 3. 播放视频后自动出现记录 ----
    await wc.executeJavaScript(`(async () => {
      const l = await window.api.listVideos();
      window.__openVideo(l.find(v => v.id === ${JSON.stringify(v1.id)}));
      return true;
    })()`);
    await poll(wc, 'window.__playerDebug()', 30000, d => d.dur > 0);
    const hist = await poll(wc, 'window.api.getHistory()', 15000, h => h.length > 0);
    ok('播放后主进程登记历史', hist.length === 1 && hist[0].path === v1.path, `n=${hist.length}, name=${hist[0]?.name}`);
    ok('历史携带播放时间', hist[0]?.playedAt > Date.now() - 120000, `playedAt=${hist[0]?.playedAt}`);

    // 回到列表页看渲染结果
    await wc.executeJavaScript(`document.getElementById('backBtn').click(); true`);
    await sleep(400);
    await wc.executeJavaScript(`document.querySelector('.nav-btn[data-view="history"]').click(); true`);
    const listed = await poll(wc,
      `({ rows: document.querySelectorAll('.history-row').length, name: document.querySelector('.history-row .hr-name')?.textContent, actions: [...document.querySelectorAll('.history-row .hr-actions button span')].map(e => e.textContent) })`,
      10000, s => s.rows > 0);
    ok('历史页列出播放过的视频', listed.rows === 1, `rows=${listed.rows}`);
    ok('每行提供打开与删除操作', listed.actions.join(',') === '打开,删除记录', listed.actions.join(','));
    ok('行内显示文件名', String(listed.name).startsWith(v1.name.slice(0, 8)), listed.name);

    // ---- 4. 同路径重复播放不产生重复记录，只置顶 ----
    await wc.executeJavaScript(`(async () => {
      const l = await window.api.listVideos();
      window.__openVideo(l.find(v => v.id === ${JSON.stringify(v2.id)}));
      return true;
    })()`);
    await poll(wc, 'window.api.getHistory()', 30000, h => h.length === 2 && h[0].path === v2.path);
    await wc.executeJavaScript(`(async () => {
      const l = await window.api.listVideos();
      window.__openVideo(l.find(v => v.id === ${JSON.stringify(v1.id)}));
      return true;
    })()`);
    const hist2 = await poll(wc, 'window.api.getHistory()', 30000, h => h.length === 2 && h[0].path === v1.path);
    ok('重复播放同一条目只置顶不重复', hist2.length === 2 && hist2[0].path === v1.path && hist2[1].path === v2.path,
      hist2.map(h => ep(h.name)).join(' | '));

    // ---- 5. 打开记录走与资源管理器相同的链路（open-video-file → showPlayer → player 视图） ----
    await wc.executeJavaScript(`document.getElementById('backBtn').click(); true`);
    await sleep(400);
    await wc.executeJavaScript(`document.querySelector('.nav-btn[data-view="history"]').click(); true`);
    await poll(wc, `document.querySelectorAll('.history-row').length`, 10000, n => n === 2);
    // 找到 v2 那一行（列表顺序等于最近播放顺序，但按内容定位更稳）
    const v2Name = v2.name;
    await wc.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.history-row')].find(r => r.querySelector('.hr-name').textContent === ${JSON.stringify(v2Name)});
      row.querySelector('[data-act="open"]').click();
      return true;
    })()`);
    const opened = await poll(wc,
      `({ playerActive: document.getElementById('view-player').classList.contains('active'), title: document.getElementById('playerTitle').textContent, t: window.__playerDebug().t })`,
      30000, s => s.playerActive && s.t > 0);
    ok('打开记录进入播放器视图', opened.playerActive, `title=${opened.title}`);
    ok('打开的是该条记录对应视频', opened.title.includes(ep(v2.name)) || opened.title.includes(v2.name.slice(0, 10)), opened.title);

    // 播放器「后退」应回到历史页，而不是片库
    await wc.executeJavaScript(`document.getElementById('backBtn').click(); true`);
    const backTo = await poll(wc, `({ history: document.getElementById('view-history').classList.contains('active'), player: document.getElementById('view-player').classList.contains('active') })`,
      10000, s => !s.player);
    ok('播放器后退回到历史记录页', backTo.history && !backTo.player, JSON.stringify(backTo));

    // ---- 5.5 关键一致性：不在片库中的历史记录，打开时应自动登记进片库（与资源管理器双击同链路） ----
    await sleep(300);
    // 先确认 v2 在片库中，然后从片库移除它（只删记录，文件仍在）
    const inLibBefore = await wc.executeJavaScript(`window.api.listVideos().then(l => l.some(v => v.path === ${JSON.stringify(v2.path)}))`);
    await wc.executeJavaScript(`window.api.removeVideos([${JSON.stringify(v2.path)}])`);
    const inLibMid = await wc.executeJavaScript(`window.api.listVideos().then(l => l.some(v => v.path === ${JSON.stringify(v2.path)}))`);
    ok('准备：v2 已从片库移除', inLibBefore === true && inLibMid === false);
    await wc.executeJavaScript(`document.querySelector('.nav-btn[data-view="history"]').click(); true`);
    await poll(wc, `document.querySelectorAll('.history-row').length`, 10000, n => n === 2);
    await wc.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.history-row')].find(r => r.querySelector('.hr-name').textContent === ${JSON.stringify(v2Name)});
      row.querySelector('[data-act="open"]').click();
      return true;
    })()`);
    const reopened = await poll(wc, `({ active: document.getElementById('view-player').classList.contains('active'), title: document.getElementById('playerTitle').textContent })`,
      30000, s => s.active && s.title.includes(ep(v2.name)));
    const backInLib = await wc.executeJavaScript(`window.api.listVideos().then(l => l.find(v => v.path === ${JSON.stringify(v2.path)}) || null)`);
    ok('打开历史把不在片库的视频自动登记回片库', !!backInLib && backInLib.path === v2.path && reopened.active,
      `title=${reopened.title}, libId=${backInLib?.id}`);
    ok('重新登记后仍可记忆进度（片库记录字段齐全）', backInLib?.position === 0 && !!backInLib?.title && Array.isArray(backInLib?.tags),
      JSON.stringify({ position: backInLib?.position, title: backInLib?.title }));

    // ---- 6. 打开后该条置顶（与最近播放一致） ----
    const hist3 = await poll(wc, 'window.api.getHistory()', 15000, h => h[0].path === v2.path);
    ok('打开后对应记录置顶', hist3[0].path === v2.path);

    // ---- 7. 删除单条记录：只删记录，片库条目与磁盘文件保留 ----
    await wc.executeJavaScript(`document.getElementById('backBtn').click(); true`);
    await sleep(400);
    await wc.executeJavaScript(`document.querySelector('.nav-btn[data-view="history"]').click(); true`);
    await poll(wc, `document.querySelectorAll('.history-row').length`, 10000, n => n === 2);
    const idxV2 = await wc.executeJavaScript(`[...document.querySelectorAll('.history-row')].findIndex(r => r.querySelector('.hr-name').textContent === ${JSON.stringify(v2Name)})`);
    await wc.executeJavaScript(`document.querySelectorAll('.history-row')[${idxV2}].querySelector('[data-act="remove"]').click(); true`);
    const afterRemove = await poll(wc, 'window.api.getHistory()', 10000, h => h.length === 1);
    const libStill = await wc.executeJavaScript(`window.api.listVideos().then(l => l.length)`);
    const fileStill = await wc.executeJavaScript(`window.api.readVideo(${JSON.stringify(v2.path)}).then(() => true).catch(() => false)`);
    ok('删除按钮只删该条历史', afterRemove.length === 1 && afterRemove[0].path === v1.path, `剩余 ${afterRemove.length} 条`);
    ok('片库记录未受影响', libStill >= 2, `片库 ${libStill} 条`);
    ok('磁盘文件仍可读取', fileStill === true);
    const listNow = await poll(wc, `document.querySelectorAll('.history-row').length`, 8000, n => n === 1);
    ok('列表即时刷新为 1 条', listNow === 1, `rows=${listNow}`);

    // ---- 8. 清空历史（确认框） ----
    await wc.executeJavaScript(`document.getElementById('clearHistoryBtn').click(); true`);
    const dlg = await poll(wc, `!!document.querySelector('#chYes')`, 8000, b => b === true);
    ok('清空前弹出确认框', dlg);
    await wc.executeJavaScript(`document.querySelector('#chYes').click(); true`);
    const cleared = await poll(wc, 'window.api.getHistory()', 10000, h => h.length === 0);
    ok('清空后历史为空', cleared.length === 0);
    const emptyAgain = await poll(wc,
      `({ empty: !document.getElementById('historyEmpty').classList.contains('hidden'), rows: document.querySelectorAll('.history-row').length })`,
      8000, s => s.empty && s.rows === 0);
    ok('清空后回到空态', emptyAgain.empty && emptyAgain.rows === 0);

    // ---- 9. 不存在的文件：提示错误且不崩溃 ----
    const bad = await wc.executeJavaScript(`window.api.openHistory('Z:\\\\nope\\\\missing.mkv')`);
    ok('打开失效记录给出错误提示', bad && bad.ok === false && /不存在|无法访问/.test(bad.error || ''), JSON.stringify(bad));

    console.log('HISTORY-E2E-DONE ' + (results.every(r => r.pass) ? 'ALL-PASS' : 'HAS-FAIL'));
    app.exit(results.every(r => r.pass) ? 0 : 1);
  } catch (e) {
    console.error('HISTORY-E2E-ERROR:', e.message);
    app.exit(1);
  }
});
