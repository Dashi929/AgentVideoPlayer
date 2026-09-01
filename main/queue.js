/**
 * AI 任务队列：所有 AI 批量操作入队，串行逐个处理。
 * - 队列变化实时推送给渲染层（AI 助手页展示）
 * - 逐项容错：单个视频失败只记录日志并回滚该条的半成品写入，继续处理下一条
 * - 已成功处理的条目不受后续失败/撤销影响（快照在成功后标记 done）
 */
const db = require('./db');
const path = require('path');

let jobs = [];           // {id, op, items:[{kind:'video'|'dir',...}], status, i, total, snapshots, error, createdAt}
let running = false;
let jobId = 0;
let bridges = null;      // {captureFrames(path,times), runAgent(msg), sendToRenderer(ch,payload)}

function init(bridge) { bridges = bridge; }

function sanitize() {
  return jobs.map(j => ({
    id: j.id, op: j.op, status: j.status, i: j.i, total: j.total,
    name: j.items?.[j.i]?.name || '', done: j.status === 'done' ? j.total : j.i,
    error: j.error, createdAt: j.createdAt, count: j.total,
    logs: (j.logs || []).slice(-200),
  }));
}

function log(job, text) {
  if (!text) return;
  if (!job.logs) job.logs = [];
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  job.logs.push(`[${t}] ${text}`);
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  emit();
}

function emit() { bridges?.sendToRenderer('queue-update', sanitize()); }

function opLabel(op) {
  return {
    tag: 'AI 打标签', organize: 'AI 整理', cover: 'AI 封面', subtitle: 'AI 字幕',
    seriesTag: '剧集打标签', seriesCover: '剧集封面',
  }[op] || op;
}

function addJob(op, ids = [], dirs = []) {
  const items = [
    ...ids.map(id => {
      const v = db.getVideo(id);
      return { kind: 'video', id, name: v ? (v.virtualName || v.title || v.name) : id };
    }),
    ...dirs.map(d => ({ kind: 'dir', path: d, name: path.basename(d) || d })),
  ];
  const job = {
    id: 'q' + (++jobId) + '_' + Date.now().toString(36),
    op, ids, dirs, items,
    first: items[0]?.name || '',
    status: 'pending', i: 0, total: items.length, snapshots: [],
    logs: [`创建任务：${opLabel(op)}，共 ${items.length} 项`],
    createdAt: Date.now(),
  };
  jobs.push(job);
  emit();
  setImmediate(pump);
  return job.id;
}

function removeJob(id) {
  const job = jobs.find(j => j.id === id);
  if (!job) return;
  if (job.status === 'running') {
    job.cancelRequested = true;   // worker 在下个条目前停止并撤销
    job.status = 'cancelling';
  } else {
    jobs = jobs.filter(j => j.id !== id);
  }
  emit();
}

/** 是否有排队/执行中的任务（用于退出确认） */
function hasActive() {
  return jobs.some(j => j.status === 'pending' || j.status === 'running' || j.status === 'cancelling');
}

function activeCount() {
  return jobs.filter(j => j.status === 'pending' || j.status === 'running' || j.status === 'cancelling').length;
}

async function pump() {
  if (running) return;
  const job = jobs.find(j => j.status === 'pending');
  if (!job) return;
  running = true;
  job.status = 'running';
  emit();
  let failed = 0;
  try {
    for (; job.i < job.total; job.i++) {
      if (job.cancelRequested) break;
      const item = job.items[job.i];
      emit();
      const snapBefore = job.snapshots.length;
      try {
        if (item.kind === 'video') {
          const v = db.getVideo(item.id);
          if (v) await execItem(job, v);
        } else {
          await execDirItem(job, item);
        }
        // 本条成功：其快照不再参与撤销（已完成的视频不受影响）
        if (job.snapshots.length > snapBefore) job.snapshots[job.snapshots.length - 1].done = true;
      } catch (e) {
        // 逐项容错：只回滚本条的半成品写入，继续下一条
        failed++;
        log(job, `✗ 失败：${e.message}`);
        if (job.snapshots.length > snapBefore) await undoSnapshots([job.snapshots.pop()]);
      }
    }
    if (job.cancelRequested) {
      await undoJob(job);
      job.status = 'cancelled';
    } else {
      job.status = 'done';
      if (failed) job.error = `${failed}/${job.total} 个处理失败，详见日志`;
    }
  } catch (e) {
    job.status = 'failed';
    job.error = e.message;
    try { await undoJob(job); } catch {}
  }
  running = false;
  emit();
  setImmediate(pump);
}

async function execItem(job, v) {
  const snapshot = { id: v.id };
  const onStep = (s) => log(job, s);
  log(job, `▶ 开始处理（${job.i + 1}/${job.total}）：${v.virtualName || v.name}`);
  switch (job.op) {
    case 'tag': {
      // 联网搜索片源信息打标签；找不到 → 置空标签（进"无标签"）
      snapshot.tags = v.tags; snapshot.title = v.title;
      job.snapshots.push(snapshot);
      const r = await bridges.webTag(v, onStep);
      if (r.ok) {
        db.upsertVideo({ id: v.id, tags: r.tags, title: r.title || v.title });
        log(job, `✓ 打标签成功：${r.tags.join('、')}${r.title ? `（${r.title}）` : ''}`);
      } else {
        db.upsertVideo({ id: v.id, tags: [] });
        log(job, `✗ ${r.note || '未找到片源信息'} → 已放入"无标签"`);
      }
      break;
    }
    case 'organize': {
      // 按现有主标签分类（不调用视觉模型）
      snapshot.tags = v.tags; snapshot.virtualCategory = v.virtualCategory;
      job.snapshots.push(snapshot);
      const cat = (v.tags && v.tags[0]) || '未分类';
      const tags = [...new Set([...(v.tags || []), cat])];
      db.upsertVideo({ id: v.id, virtualCategory: cat, tags });
      log(job, `✓ 已分类为「${cat}」`);
      break;
    }
    case 'cover':
      snapshot.cover = v.cover;
      job.snapshots.push(snapshot);
      await bridges.coverFor(v, onStep);
      log(job, '✓ 封面已保存');
      break;
    case 'subtitle':
      await bridges.subtitleFor(v, onStep);
      log(job, '✓ 字幕已下载');
      break;
  }
}

/** 目录型任务（剧集/合集）：快照覆盖文件夹记录与各集的相关字段 */
function videosUnder(dir) {
  const p = String(dir).toLowerCase();
  const prefix = p.endsWith('\\') ? p : p + '\\';
  return db.allVideos().filter(v => {
    const f = String(v.folder).toLowerCase();
    return f === p || f.startsWith(prefix);
  });
}

async function execDirItem(job, item) {
  const onStep = (s) => log(job, s);
  log(job, `▶ 开始处理（${job.i + 1}/${job.total}）：📁 ${item.name}`);
  switch (job.op) {
    case 'seriesTag': {
      const before = db.getFolderByPath(item.path);
      job.snapshots.push({
        kind: 'series', dir: item.path,
        folder: before ? { ...before } : null,
        vids: videosUnder(item.path).map(v => ({ id: v.id, tags: v.tags, title: v.title })),
      });
      const r = await bridges.seriesTagFor(item.path, onStep);
      if (!r.ok) throw new Error(r.note || '未能识别剧集信息');
      log(job, `✓ ${r.title || item.name}：${(r.tags || []).join('、')}`);
      break;
    }
    case 'seriesCover': {
      const before = db.getFolderByPath(item.path);
      job.snapshots.push({
        kind: 'series', dir: item.path,
        folder: before ? { ...before } : null,
        vids: videosUnder(item.path).map(v => ({ id: v.id, cover: v.cover, tags: v.tags, title: v.title })),
      });
      const r = await bridges.seriesCoverFor(item.path, onStep);
      log(job, `✓ ${item.name}：文件夹${r.folderCover ? '海报已就位' : '封面用截帧'}，${r.count} 个视频已处理`);
      break;
    }
    default:
      throw new Error('不支持的操作：' + job.op);
  }
}

/** 撤销：按快照逆序恢复（已成功处理的条目跳过） */
async function undoJob(job) {
  await undoSnapshots(job.snapshots.filter(s => !s.done));
  if (job.op === 'subtitle') {
    // 字幕没有改库数据，删除本次下载的文件
    const fs = require('fs');
    const path = require('path');
    for (const id of job.ids) {
      const dir = path.join(db.coversDir(), '..', 'subtitles', id);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function undoSnapshots(snaps) {
  for (const s of [...snaps].reverse()) {
    if (s.kind === 'series') {
      // 剧集：恢复文件夹记录 + 各集字段
      if (s.folder) db.upsertFolder(s.folder);
      else db.removeFolder(s.dir);
      for (const w of s.vids || []) {
        const patch = { id: w.id };
        if ('tags' in w) patch.tags = w.tags;
        if ('title' in w) patch.title = w.title;
        if ('cover' in w) patch.cover = w.cover;
        db.upsertVideo(patch);
      }
      continue;
    }
    const patch = { id: s.id };
    if ('tags' in s) patch.tags = s.tags;
    if ('title' in s) patch.title = s.title;
    if ('virtualCategory' in s) patch.virtualCategory = s.virtualCategory;
    if ('cover' in s) patch.cover = s.cover;
    db.upsertVideo(patch);
  }
}

module.exports = { init, addJob, removeJob, opLabel, hasActive, activeCount };
