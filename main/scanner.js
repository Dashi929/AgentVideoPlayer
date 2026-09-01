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

module.exports = { scanFolder, videoId, VIDEO_EXT };
