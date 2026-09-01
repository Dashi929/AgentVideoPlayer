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

module.exports = { load, save, getSettings, updateSettings, allVideos, getVideo, upsertVideo, removeVideo, deleteVideosMissing, dbPath, coversDir, getCollections, saveCollections, allFolders, getFolderByPath, upsertFolder, removeFolder };
