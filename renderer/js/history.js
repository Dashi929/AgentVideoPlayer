/**
 * 历史记录页：列出播放过的视频（主进程 db.history，按最近播放排序）。
 * - 打开：走 history:open，与资源管理器双击视频完全同一条链路
 *   （不在片库中会先自动登记进片库，再进播放器，进度记忆/连播照常可用）
 * - 删除：只删这一条播放记录，不动片库记录，更不动磁盘文件
 */
import { toast } from './app.js';
import { icon } from './icons.js';

let items = [];
let allVideos = [];

export async function refreshHistory() {
  const [h, v] = await Promise.all([
    window.api.getHistory().catch(() => []),
    window.api.listVideos().catch(() => []),
  ]);
  items = h || [];
  allVideos = v || [];
  render();
}

function render() {
  const list = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');
  const meta = document.getElementById('historyMeta');
  if (!list || !empty) return;

  list.innerHTML = '';
  empty.classList.toggle('hidden', items.length > 0);
  meta.textContent = items.length ? `共 ${items.length} 条播放记录 · 点击可重新打开` : '';
  document.getElementById('clearHistoryBtn')?.classList.toggle('hidden', items.length === 0);

  for (const rec of items) list.appendChild(historyRow(rec));
}

function historyRow(rec) {
  const row = document.createElement('div');
  row.className = 'history-row';
  const v = allVideos.find(x => lower(x.path) === lower(rec.path));
  const pct = v?.position && v?.duration ? Math.round(v.position / v.duration * 100) : 0;
  const playInfo = rec.playedAt ? `播放于 ${fmtTime(rec.playedAt)}` : '';
  row.innerHTML = `
    <div class="hr-thumb">${v?.cover ? `<img src="${fileUrl(v.cover)}" />` : icon('film', 26)}</div>
    <div class="hr-body">
      <div class="hr-name">${escapeHtml(rec.name || nameOf(rec.path))}</div>
      <div class="hr-sub">${escapeHtml(rec.folder || '')}</div>
      <div class="hr-time">${escapeHtml(playInfo)}${pct > 0 ? ` · 已观看 ${pct}%` : ''}</div>
    </div>
    <div class="hr-actions">
      <button class="primary" data-act="open">${icon('play', 14)}<span>打开</span></button>
      <button data-act="remove">${icon('trash', 14)}<span>删除记录</span></button>
    </div>`;
  row.addEventListener('click', () => openRecord(rec));
  row.querySelector('[data-act="open"]').addEventListener('click', (e) => { e.stopPropagation(); openRecord(rec); });
  row.querySelector('[data-act="remove"]').addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.removeHistory([rec.path]).then((n) => {
      toast(n ? '已删除这条播放记录（文件仍在原处）' : '记录已不存在');
      refreshHistory();
    });
  });
  return row;
}

/** 与资源管理器双击同一链路：文件不在片库会先自动登记，再交给播放器 */
async function openRecord(rec) {
  const r = await window.api.openHistory(rec.path);
  if (!r?.ok) toast(r?.error || '打开失败');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return `今天 ${hm}`;
  if (sameDay(d, new Date(now.getTime() - 86400000))) return `昨天 ${hm}`;
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd} ${hm}`;
}

export function initHistory() {
  document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    if (!items.length) { toast('暂无播放记录'); return; }
    const ok = await confirmDialog(`确定清空全部 ${items.length} 条播放记录吗？\n只清空历史列表，不会影响片库，也不会删除任何视频文件。`);
    if (!ok) return;
    await window.api.clearHistory();
    toast('已清空播放历史');
    refreshHistory();
  });
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--bg3);border:1px solid #3a3f4a;border-radius:12px;padding:22px;width:440px">
        <div style="white-space:pre-wrap;line-height:1.7;margin-bottom:18px">${escapeHtml(message)}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="chNo">取消</button>
          <button id="chYes" class="primary">确认清空</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#chNo').addEventListener('click', () => done(false));
    overlay.querySelector('#chYes').addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}

const lower = (p) => String(p).toLowerCase();
function nameOf(p) { return String(p).split('\\').filter(Boolean).pop() || String(p); }
function fileUrl(p) {
  const s = String(p).split('\\').join('/');
  return s.startsWith('//') ? 'file://' + s : 'file:///' + s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
