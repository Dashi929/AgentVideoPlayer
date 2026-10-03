const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const dbPath = () => path.join(app.getPath('userData'), 'library.json');
const coversDir = () => path.join(app.getPath('userData'), 'covers');

let data = null;
let saveTimer = null;

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
  } catch {
    data = { videos: {}, settings: { apiBase: '', apiKey: '', chatModel: '', visionModel: '' } };
  }
  if (!data.videos) data.videos = {};
  if (!data.settings) data.settings = {};
  return data;
}

function save() {
  // 延迟合并写入，避免频繁 IO
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const p = dbPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, p);
    } catch (e) {
      console.error('db save failed', e);
    }
  }, 300);
}

function getSettings() { return load().settings; }
function updateSettings(patch) {
  const d = load();
  Object.assign(d.settings, patch);
  save();
  return d.settings;
}

function allVideos() { return Object.values(load().videos); }
function getVideo(id) { return load().videos[id]; }
function upsertVideo(v) {
  const d = load();
  const existing = d.videos[v.id];
  if (existing) Object.assign(existing, v);
  else d.videos[v.id] = v;
  save();
  return d.videos[v.id];
}
function getCollections() {
  if (!load().collections) load().collections = [];
  return load().collections;
}
function saveCollections(list) { load().collections = list; save(); }

// ---- 剧集文件夹（连续剧/合集）：元数据一次查询落到整个文件夹 ----
// 以小写路径为键：{ path, name, title, tags, cover, series }
function allFolders() {
  const d = load();
  if (!d.folders) d.folders = {};
  return Object.values(d.folders);
}
function getFolderByPath(p) {
  const d = load();
  if (!d.folders) d.folders = {};
  return d.folders[String(p).toLowerCase()] || null;
}
function upsertFolder(rec) {
  const d = load();
  if (!d.folders) d.folders = {};
  const key = String(rec.path).toLowerCase();
  d.folders[key] = Object.assign(d.folders[key] || { path: rec.path, name: rec.name }, rec);
  save();
  return d.folders[key];
}
function removeFolder(p) {
  const d = load();
  if (d.folders) delete d.folders[String(p).toLowerCase()];
  save();
}

// ---- 播放历史：只记"播放过"，与片库记录相互独立（删历史不动片库/磁盘，删片库也不清历史）----
const HISTORY_MAX = 300;
function allHistory() {
  const d = load();
  if (!d.history) d.history = [];
  return d.history;
}
/** 登记一次播放：同一路径只保留一条并置顶（路径大小写不敏感） */
function touchHistory(rec) {
  const d = load();
  if (!d.history) d.history = [];
  const key = String(rec.path).toLowerCase();
  const i = d.history.findIndex(h => String(h.path).toLowerCase() === key);
  const old = i >= 0 ? d.history.splice(i, 1)[0] : {};
  const entry = {
    path: rec.path,
    name: rec.name || old.name || path.basename(rec.path),
    folder: rec.folder || old.folder || path.dirname(rec.path),
    playedAt: Date.now(),
  };
  d.history.unshift(entry);
  if (d.history.length > HISTORY_MAX) d.history.length = HISTORY_MAX;
  save();
  return entry;
}
function removeHistory(paths) {
  const d = load();
  if (!d.history) d.history = [];
  const keys = new Set((paths || []).map(p => String(p).toLowerCase()));
  const before = d.history.length;
  d.history = d.history.filter(h => !keys.has(String(h.path).toLowerCase()));
  save();
  return before - d.history.length;
}
function clearHistory() {
  const d = load();
  const n = (d.history || []).length;
  d.history = [];
  save();
  return n;
}
/**
 * 首次启用历史功能时用片库已有的 lastPlayed 回填，老用户打开历史页不至于是空的。
 * 只在 history 字段从未初始化过时执行一次；用户清空过的（[]）不会被再次填充。
 */
function seedHistoryFromVideos() {
  const d = load();
  if (Array.isArray(d.history)) return 0;
  const played = Object.values(d.videos || {}).filter(v => (v.lastPlayed || 0) > 0);
  played.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  d.history = played.slice(0, HISTORY_MAX).map(v => ({
    path: v.path, name: v.name, folder: v.folder, playedAt: v.lastPlayed,
  }));
  save();
  return d.history.length;
}

function removeVideo(id) {
  delete load().videos[id];
  save();
}
function deleteVideosMissing(scanRoots) {
  // 移除已不存在于磁盘的条目
  const d = load();
  let removed = 0;
  for (const [id, v] of Object.entries(d.videos)) {
    if (!fs.existsSync(v.path)) { delete d.videos[id]; removed++; }
  }
  save();
  return removed;
}

module.exports = { load, save, getSettings, updateSettings, allVideos, getVideo, upsertVideo, removeVideo, deleteVideosMissing, dbPath, coversDir, getCollections, saveCollections, allFolders, getFolderByPath, upsertFolder, removeFolder, allHistory, touchHistory, removeHistory, clearHistory, seedHistoryFromVideos };
