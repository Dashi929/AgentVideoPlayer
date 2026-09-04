import { initLibrary, refreshLibrary, resetLibraryUI, librarySnapshot, restoreLibraryState } from './library.js';
import { initPlayer } from './player.js';
import { initAgent } from './agentPanel.js';
import { initSettings } from './settings.js';
import { refreshPages, favsSnapshot, restoreFavsState, tagsSnapshot, restoreTagsState } from './pages.js';
import { icon } from './icons.js';

// 填充所有静态图标：data-icon="名称" 或 "名称@尺寸"（默认 16，随文字对齐）
document.querySelectorAll('[data-icon]').forEach(el => {
  const [name, size] = String(el.dataset.icon).split('@');
  el.insertAdjacentHTML('afterbegin', icon(name, +(size || 16)));
});

// ---- 导航历史：后退总是回到上一个页面（含文件夹层级），而不是主页 ----
const navStack = [];      // 各页面跳转前的状态快照
let navSwitching = false; // 恢复历史时不再重复入栈

function activeViewId() {
  return document.querySelector('.view.active')?.id.replace('view-', '') || null;
}

function snapshotOf(view) {
  if (view === 'library') return { view, ...librarySnapshot() };
  if (view === 'favs') return { view, ...favsSnapshot() };
  if (view === 'tags') return { view, ...tagsSnapshot() };
  return { view };
}

/** 在任何页面/层级跳转之前调用：把当前页面状态压入历史 */
export function pushNav() {
  if (navSwitching) return;
  const v = activeViewId();
  if (!v || v === 'player') return; // 播放器不作为回退目标
  const snap = snapshotOf(v);
  if (navStack.length && JSON.stringify(navStack[navStack.length - 1]) === JSON.stringify(snap)) return;
  navStack.push(snap);
  if (navStack.length > 50) navStack.shift();
}

/** 后退：恢复上一次的页面与层级；无历史时回片库 */
export function goBack() {
  const prev = navStack.pop();
  navSwitching = true;
  try {
    if (!prev) {
      document.querySelector('[data-view="library"]')?.click();
      restoreLibraryState(null);
      return;
    }
    if (prev.view === 'library') {
      document.querySelector('[data-view="library"]')?.click();
      restoreLibraryState(prev.dir);
    } else if (prev.view === 'favs') {
      restoreFavsState(prev);
    } else if (prev.view === 'tags') {
      restoreTagsState(prev);
    } else {
      document.querySelector(`[data-view="${prev.view}"]`)?.click();
    }
  } finally {
    setTimeout(() => { navSwitching = false; }, 0);
  }
}

// 视图路由：切走片库时清空多选状态，操作栏 UI 不带到其他页面
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    pushNav(); // 记录切换前的页面
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach(v =>
      v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
    if (btn.dataset.view !== 'library') resetLibraryUI();
    if (btn.dataset.view === 'tags' || btn.dataset.view === 'favs') refreshPages();
  });
});

export function showPlayer(video) {
  pushNav();
  document.querySelector('[data-view="player"]')?.click();
  // player 视图没有导航按钮，直接切换
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('active', v.id === 'view-player'));
  window.__openVideo(video);
}

export function toast(text, ms = 3000) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

initLibrary();
initPlayer({ refreshLibrary });
initAgent();
initSettings();

// 注册主进程的截帧请求处理（无 ffmpeg 时的回退通道）
if (window.api.onCaptureFrames) window.api.onCaptureFrames();

// AI 整理快捷入口：跳到 AI 页并预填指令
document.getElementById('aiTagBtn').addEventListener('click', () => {
  document.querySelector('[data-view="agent"]').click();
  document.getElementById('chatInput').value =
    '请给片库中没有标签的视频逐个分析并打上标签，然后按主标签整理到子文件夹，并给每个视频设置封面。';
  document.getElementById('chatInput').focus();
});

refreshLibrary().then(refreshPages);

// 外部打开（双击视频文件/「打开方式」/命令行）：主进程已把文件登记进片库，这里直接进播放器
if (window.api.onOpenVideoFile) {
  window.api.onOpenVideoFile((videos) => {
    const v = (videos || []).find(Boolean);
    if (v) showPlayer(v);
  });
  window.api.rendererReady();
}
