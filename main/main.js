const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const scanner = require('./scanner');
const media = require('./media');
const files = require('./files');
const agent = require('./agent');
const assoc = require('./assoc');

let win = null;

// ---- 外部打开（文件关联 /「打开方式」/ 命令行带视频路径）----
let rendererReady = false;
let pendingOpenFiles = [];

const samePath = (x, y) => {
  const a = path.resolve(x), b = path.resolve(y);
  return a === b || (process.platform === 'win32' && a.toLowerCase() === b.toLowerCase());
};

/** 外部打开的文件自动登记进片库，之后走正常播放流程（进度记忆/标签/连播都可用） */
function importVideoFile(p) {
  const existed = db.allVideos().find(v => v.path === p);
  if (existed) return existed;
  let stat;
  try { stat = fs.statSync(p); } catch { return null; }
  return db.upsertVideo({
    id: scanner.videoId(p),
    path: p,
    name: path.basename(p),
    folder: path.dirname(p),
    size: stat.size,
    mtime: stat.mtimeMs,
    tags: [],
    title: path.basename(p, path.extname(p)),
    cover: null,
    position: 0,
    duration: null,
    lastPlayed: 0,
  });
}

/** 从启动参数中挑出视频文件（过滤掉 electron 自身、应用目录、flag 类参数） */
function extractVideoPaths(argv) {
  const appDir = app.getAppPath();
  const out = [];
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    if (a === '.' || a === './' || samePath(a, appDir)) continue;
    try {
      if (fs.existsSync(a) && fs.statSync(a).isFile() &&
          scanner.VIDEO_EXT.has(path.extname(a).toLowerCase())) {
        out.push(path.resolve(a));
      }
    } catch { /* 参数不可访问时忽略 */ }
  }
  return out;
}

function flushOpenFiles() {
  if (!rendererReady || !win || win.isDestroyed() || !pendingOpenFiles.length) return;
  const list = pendingOpenFiles;
  pendingOpenFiles = [];
  win.webContents.send('open-video-file', list);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function deliverOpenFiles(paths) {
  if (!paths || !paths.length) return;
  const videos = paths.map(importVideoFile).filter(Boolean);
  if (!videos.length) return;
  pendingOpenFiles.push(...videos);
  flushOpenFiles();
}

function assocCfg() {
  // 开发模式下 exe 是 electron.exe，打开命令需附加应用目录参数
  return { exePath: process.execPath, appDir: app.isPackaged ? null : app.getAppPath() };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#14161a',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.setMenuBarVisibility(false);

  // 关闭确认：有 AI 任务排队/执行时提示用户
  let forceQuit = false;
  win.on('close', async (e) => {
    if (forceQuit) return;
    const queue = require('./queue');
    if (!queue.hasActive()) return;
    e.preventDefault();
    const n = queue.activeCount();
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'AI 任务进行中',
      message: `还有 ${n} 个 AI 任务在排队或执行中，现在退出将中断这些任务。\n（已完成的视频不受影响，未处理的不会继续）`,
      buttons: ['继续退出', '取消'],
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response === 0) {
      forceQuit = true;
      win.close();
    }
  });
}

// ---- 渲染层截帧请求桥（无 ffmpeg 回退）----
function askRendererCapture(videoPath, times) {
  return new Promise((resolve, reject) => {
    const wc = win?.webContents;
    if (!wc) return reject(new Error('窗口不可用'));
    const timeout = setTimeout(() => reject(new Error('截帧超时')), 45000);
    const handler = (_e, payload) => {
      clearTimeout(timeout);
      ipcMain.removeListener('capture-frames-result', handler);
      resolve(payload);
    };
    ipcMain.on('capture-frames-result', handler);
    wc.send('capture-frames', { videoPath, times });
  });
}

let scanRoots = db.getSettings().scanRoots || [];
const lower = (p) => String(p).toLowerCase();

/** 本地/UNC 路径 → file:// URL（支持 \\server\share 形式；逐段编码，#/% 等特殊字符不破坏 URL） */
function toFileUrl(p) {
  const s = p.split('\\').join('/');
  return (s.startsWith('//') ? 'file://' : 'file:///') +
    s.split('/').map(seg => seg ? encodeURIComponent(seg) : '').join('/');
}

/** 求一组目录的公共祖先（大小写不敏感，按 \ 分段） */
function commonAncestor(dirs) {
  if (!dirs.length) return null;
  let segs = dirs[0].toLowerCase().split('\\');
  for (const d of dirs) {
    const parts = d.toLowerCase().split('\\');
    let i = 0;
    while (i < segs.length && i < parts.length && segs[i] === parts[i]) i++;
    segs = segs.slice(0, i);
  }
  // UNC 最少保留 \\server\share 四段（前两段为空）
  const min = dirs[0].startsWith('\\\\') ? 4 : 1;
  if (segs.length < min) return null;
  // 用原始大小写还原
  const orig = dirs[0].split('\\').slice(0, segs.length);
  return orig.join('\\');
}

function doRescan() {
  const results = { added: 0, removed: 0, total: 0 };
  for (const root of scanRoots) {
    const r = scanner.scanFolder(root);
    results.added += r.added; results.removed += r.removed;
  }
  results.total = db.allVideos().length;
  return results;
}

function registerIpc() {
  ipcMain.handle('settings:get', () => ({
    ...db.getSettings(),
    hasFfmpeg: null, // 异步填充
  }));
  ipcMain.handle('settings:update', (_e, patch) => db.updateSettings(patch));
  ipcMain.handle('media:check-ffmpeg', () => media.checkFfmpeg());

  ipcMain.handle('library:scan', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择要加入片库的文件夹',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return null;
    const folder = filePaths[0];
    if (!scanRoots.includes(folder)) {
      scanRoots.push(folder);
      db.updateSettings({ scanRoots });
    }
    const result = doRescan();
    return { folder, ...result };
  });
  ipcMain.handle('library:roots', () => {
    let stored = db.getSettings().scanRoots || [];
    if (stored.length === 0 && db.allVideos().length > 0) {
      // 兼容旧数据：从现有视频推导公共根目录
      const lcp = commonAncestor(db.allVideos().map(v => v.folder));
      if (lcp) {
        stored = [lcp];
        db.updateSettings({ scanRoots: stored });
      }
    }
    return stored;
  });
  ipcMain.handle('library:list', () => db.allVideos());
  ipcMain.handle('library:folders', () => db.allFolders());
  ipcMain.handle('library:update', (_e, patch) => db.upsertVideo(patch));

  ipcMain.handle('video:read', async (_e, filePath) => {
    // 校验是库内视频，返回可直接喂给 <video> 的 URL
    const v = db.allVideos().find(v => v.path === filePath);
    if (!v) throw new Error('不在片库中');
    return { url: toFileUrl(filePath), video: v };
  });

  // 内置播放器解不了的（10-bit/HEVC 等）交给系统播放器
  ipcMain.handle('video:open-external', (_e, filePath) => shell.openPath(filePath));

  // 渲染层初始化完成后通知主进程，补发启动时/运行中收到的外部打开请求
  ipcMain.on('renderer-ready', () => { rendererReady = true; flushOpenFiles(); });

  // 文件关联注册（Windows，HKCU 无需管理员）
  ipcMain.handle('assoc:status', () => assoc.status(assocCfg(), scanner.VIDEO_EXT));
  ipcMain.handle('assoc:register', () => assoc.register(assocCfg(), scanner.VIDEO_EXT));
  ipcMain.handle('assoc:unregister', () => assoc.unregister(assocCfg(), scanner.VIDEO_EXT));

  ipcMain.handle('agent:run', async (_e, { message, history }) => {
    try {
      const res = await agent.runAgent(message, history || [], (ch, payload) => {
        // 截帧结果通过事件回传，这里直接走 askRendererCapture 的机制
        if (ch === 'capture-frames') return askRendererCapture(payload.videoPath, payload.times);
        return null;
      }, doRescan);
      return res;
    } catch (e) {
      return { finalText: '出错了: ' + e.message, steps: [] };
    }
  });

  ipcMain.handle('ai:test', async () => {
    try {
      const ai = require('./ai');
      const resp = await ai.chat([{ role: 'user', content: '回复"连接成功"四个字' }], { temperature: 0 });
      return { ok: true, reply: ai.assistantMessage(resp)?.content };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- 沉浸式播放器新增 ----
  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('window:maximize', () => {
    if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
  });
  ipcMain.on('window:close', () => win?.close());

  // 同目录字幕：找 srt 转 vtt（浏览器只认 vtt）
  ipcMain.handle('subtitle:find', (_e, videoPath) => {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const list = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.srt')) continue;
        const full = path.join(dir, f);
        list.push({
          file: full,
          name: path.basename(f, '.srt'),
          match: path.basename(f, '.srt').toLowerCase().startsWith(base.toLowerCase()) ||
                 f.toLowerCase().startsWith(base.toLowerCase()) ? 1 : 0,
        });
      }
    } catch { /* 目录不可读 */ }
    list.sort((a, b) => b.match - a.match);
    return list.slice(0, 20);
  });
  ipcMain.handle('subtitle:read', (_e, srtPath) => {
    const srt = fs.readFileSync(srtPath, 'utf8').replace(/^\uFEFF/, '');
    const vtt = 'WEBVTT\n\n' + srt
      .replace(/\r/g, '')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return vtt;
  });

  // 截图保存到本地 appdata
  ipcMain.handle('screenshot:save', (_e, { videoName, base64 }) => {
    const dir = path.join(app.getPath('userData'), 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `${path.basename(videoName, path.extname(videoName))}_${stamp}.jpg`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return file;
  });

  // DLNA 投屏
  const dlna = require('./dlna');
  const server = require('./server');
  ipcMain.handle('cast:search', () => dlna.searchRenderers());
  ipcMain.handle('cast:play', (_e, { location, videoId, title }) => {
    const url = server.streamUrl(videoId);
    return dlna.cast({ location }, url, title);
  });

  // ---- 批量操作（多选 + 右键菜单）----

  // 从片库移除记录（不动磁盘文件）；paths 为前缀时匹配整个文件夹
  ipcMain.handle('library:remove', (_e, paths) => {
    const d = db.load();
    const list = paths.map(p => p.toLowerCase());
    let removed = 0;
    for (const [id, v] of Object.entries(d.videos)) {
      if (list.some(p => v.path.toLowerCase() === p || v.path.toLowerCase().startsWith(p.endsWith('\\') ? p : p + '\\'))) {
        delete d.videos[id];
        removed++;
      }
    }
    db.save();
    return removed;
  });

  // 物理删除文件（危险操作，前端需二次确认）
  ipcMain.handle('library:deleteFiles', (_e, ids) => {
    const results = [];
    for (const id of ids) {
      const v = db.getVideo(id);
      if (!v) continue;
      try {
        fs.rmSync(v.path, { force: true });
        db.removeVideo(id);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    db.deleteVideosMissing();
    return results;
  });

  // 收藏分类（收藏夹 = 分类集合）
  ipcMain.handle('collections:get', () => db.getCollections());
  ipcMain.handle('collections:create', (_e, { name, ids = [], dirs = [] }) => {
    const list = db.getCollections();
    const cols = db.allVideos();
    let finalName = (name || '').trim();
    if (!finalName) {
      // 自动命名：新建收藏N
      let i = 1;
      const names = new Set(list.map(c => c.name));
      while (names.has(`新建收藏${i}`)) i++;
      finalName = `新建收藏${i}`;
    } else {
      const names = new Set(list.map(c => c.name));
      if (names.has(finalName)) {
        let i = 2;
        while (names.has(`${finalName} ${i}`)) i++;
        finalName = `${finalName} ${i}`;
      }
    }
    // 文件夹收藏：以文件夹名默认命名
    if (!name && dirs.length === 1 && ids.length === 0) {
      const base = dirs[0].split('\\').filter(Boolean).pop();
      if (base && !list.some(c => c.name === base)) finalName = base;
    }
    const count = new Set([
      ...ids.filter(id => cols.some(v => v.id === id)),
      ...cols.filter(v => dirs.some(d => lower(v.folder).startsWith(lower(d.endsWith('\\') ? d : d + '\\')))).map(v => v.id),
    ]).size;
    const col = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: finalName, ids, dirs, createdAt: Date.now(), _count: count };
    list.push(col);
    db.saveCollections(list);
    return col;
  });
  ipcMain.handle('collections:rename', (_e, { id, name }) => {
    const list = db.getCollections();
    const col = list.find(c => c.id === id);
    if (col && name?.trim()) col.name = name.trim();
    db.saveCollections(list);
    return col;
  });
  ipcMain.handle('collections:copy', (_e, { id }) => {
    const list = db.getCollections();
    const src = list.find(c => c.id === id);
    if (!src) return null;
    let name = src.name + ' 副本';
    let i = 2;
    while (list.some(c => c.name === name)) name = `${src.name} 副本${i++}`;
    const col = { ...src, id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, createdAt: Date.now() };
    list.push(col);
    db.saveCollections(list);
    return col;
  });
  ipcMain.handle('collections:delete', (_e, { id }) => {
    db.saveCollections(db.getCollections().filter(c => c.id !== id));
    return true;
  });

  // ---- AI 任务队列（串行处理，可删除/撤销）----
  const queue = require('./queue');
  const agentMod = agent;
  const media = require('./aiMedia');
  const capture = (videoPath, times) =>
    agentMod.captureFrames(videoPath, times, (ch, payload) =>
      ch === 'capture-frames' ? askRendererCapture(payload.videoPath, payload.times) : null);
  queue.init({
    sendToRenderer: (ch, payload) => win?.webContents.send(ch, payload),
    webTag: (v, onStep) => media.webTag(v, onStep),
    runAgent: (msg) => agentMod.runAgent(msg, [], (ch, payload) =>
      ch === 'capture-frames' ? askRendererCapture(payload.videoPath, payload.times) : null),
    coverFor: (v, onStep) => media.coverFor(v, capture, onStep || (() => {})),
    subtitleFor: (v, onStep) => media.subtitleFor(v, onStep || (() => {})),
    seriesTagFor: (dir, onStep) => media.seriesTagFor(dir, onStep || (() => {})),
    seriesCoverFor: (dir, onStep) => media.seriesCoverFor(dir, capture, onStep || (() => {})),
  });
  ipcMain.handle('queue:add', (_e, { op, ids, dirs }) => queue.addJob(op, ids || [], dirs || []));
  ipcMain.handle('queue:remove', (_e, id) => queue.removeJob(id));

  // 收藏批量切换
  ipcMain.handle('library:setFav', (_e, { ids, fav }) => {
    for (const id of ids) db.upsertVideo({ id, fav });
    return ids.length;
  });

  // 收藏整个文件夹下的视频
  ipcMain.handle('library:setFavFolder', (_e, { dirs, fav }) => {
    const list = dirs.map(d => d.toLowerCase());
    let n = 0;
    for (const v of db.allVideos()) {
      if (list.some(p => v.path.toLowerCase().startsWith(p.endsWith('\\') ? p : p + '\\'))) {
        db.upsertVideo({ id: v.id, fav });
        n++;
      }
    }
    return n;
  });
}

// 单实例：再次双击视频文件时转发给已运行的窗口播放，而不是另开进程
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    deliverOpenFiles(extractVideoPaths(argv));
  });
  // macOS：Finder 双击文件
  app.on('open-file', (_e, p) => deliverOpenFiles([p]));

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    // 一次性迁移：旧的"星标标签收藏"转为收藏分类
    const oldTags = db.getSettings().favTags || [];
    if (oldTags.length && db.getCollections().length === 0) {
      for (const t of oldTags) {
        const ids = db.allVideos().filter(v => (v.tags || []).includes(t)).map(v => v.id);
        if (ids.length) db.getCollections().push({ id: 'c_mig_' + t, name: t, ids, dirs: [], createdAt: Date.now() });
      }
      db.saveCollections(db.getCollections());
      db.updateSettings({ favTags: [] });
    }
    // 测试钩子：AVP_SCAN=<文件夹> 启动时自动扫描
    if (process.env.AVP_SCAN) {
      const folder = process.env.AVP_SCAN;
      if (!scanRoots.includes(folder)) scanRoots.push(folder);
      console.log('[AVP] scan result:', JSON.stringify(doRescan()));
    }
    // 文件关联/命令行启动：直接播放拖进来的视频（渲染层就绪后送达）
    deliverOpenFiles(extractVideoPaths(process.argv));
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
