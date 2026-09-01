const fs = require('fs');
const path = require('path');
const db = require('./db');

/**
 * AI 的所有"写"操作都是虚拟的：真实文件不动，
 * 重命名/分类/封面只记录在本地 appdata 的数据库里。
 */

/** 虚拟重命名：只改显示名 */
function renameVideo(id, newName) {
  const v = db.getVideo(id);
  if (!v) throw new Error('视频不存在: ' + id);
  const safe = newName.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!safe) throw new Error('文件名不能为空');
  db.upsertVideo({ id, virtualName: safe, title: safe });
  return { virtual: true, oldName: v.name, displayName: safe };
}

/** 虚拟整理：只记录分类，同时把分类加为标签方便筛选 */
function organizeVideo(id, category) {
  const v = db.getVideo(id);
  if (!v) throw new Error('视频不存在: ' + id);
  const cat = (category || '未分类').replace(/[\\/:*?"<>|]/g, '_').trim();
  const tags = [...new Set([...(v.tags || []), cat])];
  db.upsertVideo({ id, virtualCategory: cat, tags });
  return { virtual: true, category: cat };
}

/** 封面图片保存到本地 appdata，共享盘只读 */
function setCover(id, frameBuffer) {
  const v = db.getVideo(id);
  if (!v) throw new Error('视频不存在: ' + id);
  const coverDir = db.coversDir();
  fs.mkdirSync(coverDir, { recursive: true });
  const dest = path.join(coverDir, v.id + '.jpg');
  fs.writeFileSync(dest, frameBuffer);
  db.upsertVideo({ id, cover: dest });
  return { cover: dest };
}

module.exports = { renameVideo, organizeVideo, setCover };
