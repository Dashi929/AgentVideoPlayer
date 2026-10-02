const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.ogv', '.flv', '.wmv', '.ts']);

function videoId(filePath) {
  return crypto.createHash('sha1').update(filePath.toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * 递归扫描文件夹，增量更新数据库。
 * 返回 { added, removed, total }
 */
function scanFolder(folder) {
  const found = new Set();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) found.add(full);
    }
  };
  walk(folder);

  let added = 0;
  const existing = new Set(db.allVideos().map(v => v.path));
  for (const p of found) {
    if (existing.has(p)) continue;
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    db.upsertVideo({
      id: videoId(p),
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
    added++;
  }
  const removed = db.deleteVideosMissing();
  return { added, removed, total: db.allVideos().length };
}

/**
 * 浅层增量扫描：只看文件夹的直接子文件（播放列表只含本层视频），
 * 失效清理也只校验该文件夹内已登记的记录——不做全库 existsSync（网盘上会拖慢打开）。
 */
function scanFolderShallow(folder) {
  const total = () => db.allVideos().length;
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return { added: 0, removed: 0, total: total() }; }
  const found = new Set();
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(folder, e.name);
    if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) found.add(full);
  }
  let added = 0;
  const existing = new Set(db.allVideos().map(v => v.path));
  for (const p of found) {
    if (existing.has(p)) continue;
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    db.upsertVideo({
      id: videoId(p),
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
    added++;
  }
  const lower = (x) => String(x).toLowerCase();
  let removed = 0;
  for (const [id, v] of Object.entries(db.load().videos)) {
    if (lower(v.folder) === lower(folder) && !fs.existsSync(v.path)) { db.removeVideo(id); removed++; }
  }
  return { added, removed, total: total() };
}

module.exports = { scanFolder, scanFolderShallow, videoId, VIDEO_EXT };
