import { toast, pushNav } from './app.js';
import { icon } from './icons.js';

let allVideos = [];
let folderRecs = [];   // 剧集文件夹记录（title/tags/cover）
let roots = [];
let keyword = '';
let currentDir = null;

// 多选状态
const selVideos = new Set(); // 视频 id
const selDirs = new Set();   // 文件夹路径

export function initLibrary() {
  document.getElementById('scanBtn').addEventListener('click', async () => {
    const r = await window.api.scanFolder();
    if (r) {
      toast(`扫描完成：新增 ${r.added} 个，移除 ${r.removed} 个失效项，共 ${r.total} 个视频`);
      await refreshLibrary();
    }
  });
  document.getElementById('searchInput').addEventListener('input', (e) => {
    keyword = e.target.value.trim().toLowerCase();
    render();
  });

  const grid = document.getElementById('videoGrid');
  grid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    // 文件夹右键：选中并呼出文件夹菜单
    if (card.dataset.dir) {
      if (!selDirs.has(card.dataset.dir)) {
        selVideos.clear(); selDirs.clear();
        selDirs.add(card.dataset.dir);
        render();
      }
      showFolderContextMenu(e.clientX, e.clientY, card.dataset.dir);
      return;
    }
    // 右键未选中的卡片 = 只选中它再呼出菜单
    if (card.dataset.id && !selVideos.has(card.dataset.id) && !(card.dataset.dir && selDirs.has(card.dataset.dir))) {
      selVideos.clear(); selDirs.clear();
      selVideos.add(card.dataset.id);
      render();
    }
    showContextMenu(e.clientX, e.clientY);
  });
  // 长按（触屏/移动端习惯）呼出菜单
  let pressTimer = null;
  grid.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card');
    if (!card || e.pointerType !== 'touch') return;
    pressTimer = setTimeout(() => {
      if (card.dataset.id && !selVideos.has(card.dataset.id)) {
        selVideos.clear(); selDirs.clear();
        if (card.dataset.dir) selDirs.add(card.dataset.dir);
        else selVideos.add(card.dataset.id);
        render();
      }
      showContextMenu(e.clientX, e.clientY);
    }, 500);
  });
  grid.addEventListener('pointerup', () => clearTimeout(pressTimer));
  grid.addEventListener('pointermove', () => clearTimeout(pressTimer));
}

/** 离开片库视图时调用：清空选择并隐藏操作栏（UI 不带到其他页面） */
export function resetLibraryUI() {
  selVideos.clear(); selDirs.clear();
  const bar = document.getElementById('selectionBar');
  if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
  document.getElementById('ctxMenu')?.classList.add('hidden');
}

function open(v) {
  import('./app.js').then(m => m.showPlayer(v));
}

export async function refreshLibrary() {
  allVideos = await window.api.listVideos();
  folderRecs = (await window.api.listFolders?.()) || [];
  roots = await window.api.getRoots();
  render();
}

// ---- 页面状态快照（导航历史用） ----
export function librarySnapshot() {
  return { dir: currentDir };
}
export function restoreLibraryState(dir) {
  currentDir = dir || null;
  render();
}

// ---- 选中集合工具 ----
function videosUnderDirs(dirs) {
  const list = dirs.map(d => d.toLowerCase());
  return allVideos.filter(v => list.some(p => lower(v.folder).startsWith(p.endsWith('\\') ? p : p + '\\')));
}
function selVideoIds() {
  const under = videosUnderDirs([...selDirs]).map(v => v.id);
  return [...new Set([...selVideos, ...under])];
}
function selectionCount() { return selVideos.size + selDirs.size; }
function clearSelection() { selVideos.clear(); selDirs.clear(); updateSelectionBar(); render(); }

function toggleVideoSel(id) {
  selVideos.has(id) ? selVideos.delete(id) : selVideos.add(id);
  updateSelectionBar(); render();
}
function toggleDirSel(dir) {
  selDirs.has(dir) ? selDirs.delete(dir) : selDirs.add(dir);
  updateSelectionBar(); render();
}

// ---- 收藏（创建收藏分类）----

// ---- 路径工具 ----
const lower = (p) => String(p).toLowerCase();
function nameOf(p) { return p.split('\\').filter(Boolean).pop() || p; }
function childSegments(dir) {
  const prefix = dir.endsWith('\\') ? dir : dir + '\\';
  const segs = new Map();
  for (const v of allVideos) {
    const f = v.folder;
    if (lower(f).startsWith(lower(prefix)) && lower(f) !== lower(dir)) {
      const next = f.slice(prefix.length).split('\\')[0];
      if (next) segs.set(next, (segs.get(next) || 0) + 1);
    }
  }
  return segs;
}
const videosIn = (dir) => allVideos.filter(v => lower(v.folder) === lower(dir));
const rootsContaining = () => roots.filter(r => allVideos.some(v => lower(v.folder).startsWith(lower(r)) || lower(v.folder) === lower(r)));

// ---- 搜索：文件夹 / 文件 / 标签 三类结果 + 过滤 ----
let searchFilter = 'all'; // 'all' | 'dir' | 'file' | 'tag'

function matchTermsIn(fields) {
  const terms = keyword.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every(t => fields.some(f => f.includes(t)));
}
/** 文件：文件名/显示名/标题命中（不含标签，标签单独作为一类结果） */
function isFileMatch(v) {
  return matchTermsIn([v.name, v.virtualName || '', v.title || ''].map(s => String(s).toLowerCase()));
}
const isTagMatch = (t) => matchTermsIn([String(t).toLowerCase()]);
const isDirMatch = (p) => matchTermsIn([nameOf(p).toLowerCase()]);

/** 库内全部文件夹路径 → 递归视频数（每个视频给所有祖先层级 +1） */
function allFolderPaths() {
  const set = new Map();
  for (const v of allVideos) {
    const parts = v.folder.split('\\').filter(Boolean);
    const isUNC = v.folder.startsWith('\\\\');
    let acc;
    if (isUNC) {
      if (parts.length < 2) continue;
      acc = '\\\\' + parts[0] + '\\' + parts[1];
    } else {
      acc = parts[0] + '\\';
    }
    set.set(acc, (set.get(acc) || 0) + 1);
    for (let i = isUNC ? 2 : 1; i < parts.length; i++) {
      acc = acc.endsWith('\\') ? acc + parts[i] : acc + '\\' + parts[i];
      set.set(acc, (set.get(acc) || 0) + 1);
    }
  }
  return set;
}

function computeSearchResults() {
  const files = allVideos.filter(isFileMatch);
  const tagCount = new Map();
  for (const v of allVideos) for (const t of (v.tags || [])) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const tags = [...tagCount.keys()].filter(isTagMatch).sort((a, b) => (tagCount.get(b) || 0) - (tagCount.get(a) || 0));
  const dirMap = allFolderPaths();
  const dirs = [...dirMap.keys()].filter(isDirMatch)
    .map(p => ({ path: p, count: dirMap.get(p) }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path, 'zh'));
  return { files, tags, tagCount, dirs };
}

function render() {
  const grid = document.getElementById('videoGrid');
  const empty = document.getElementById('emptyHint');
  const meta = document.getElementById('libraryMeta');

  // 标签已独立成"标签"页面，片库侧栏不再显示标签列表
  const resultsMode = !!keyword;
  let list;
  let res = null;
  if (resultsMode) {
    res = computeSearchResults();
    const total = res.dirs.length + res.files.length + res.tags.length;
    meta.textContent = total
      ? `搜索“${keyword}”：文件夹 ${res.dirs.length} · 视频 ${res.files.length} · 标签 ${res.tags.length}`
      : `没有匹配“${keyword}”的内容`;
  } else if (currentDir) {
    list = videosIn(currentDir);
    meta.textContent = `${list.length} 个视频 · ${currentDir}`;
  } else {
    list = [];
    meta.textContent = `${allVideos.length} 个视频 · 请进入文件夹浏览`;
  }

  renderBreadcrumb(resultsMode);
  renderSearchFilters(resultsMode ? res : null);
  const totalResults = res ? res.dirs.length + res.files.length + res.tags.length : 0;
  empty.classList.toggle('hidden', resultsMode ? totalResults > 0 : allVideos.length > 0);
  grid.innerHTML = '';

  if (resultsMode) {
    if (totalResults === 0) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1;margin-top:8vh"><p>没有匹配的内容</p></div>`;
      updateSelectionBar();
      return;
    }
    const section = (label) => {
      const s = document.createElement('div');
      s.className = 'result-section';
      s.textContent = label;
      grid.appendChild(s);
    };
    const showDirs = searchFilter === 'all' || searchFilter === 'dir';
    const showTags = searchFilter === 'all' || searchFilter === 'tag';
    const showFiles = searchFilter === 'all' || searchFilter === 'file';
    if (showDirs && res.dirs.length) {
      section(`文件夹（${res.dirs.length}）`);
      for (const d of res.dirs) grid.appendChild(folderCard(nameOf(d.path), d.count, d.path));
    }
    if (showTags && res.tags.length) {
      section(`标签（${res.tags.length}）`);
      for (const t of res.tags) grid.appendChild(tagResultCard(t, res.tagCount.get(t) || 0));
    }
    if (showFiles && res.files.length) {
      section(`视频（${res.files.length}）`);
      for (const v of [...res.files].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))) grid.appendChild(videoCard(v));
    }
    updateSelectionBar();
    return;
  }

  if (!currentDir) {
    for (const r of rootsContaining()) grid.appendChild(folderCard(r, allVideos.filter(v => lower(v.folder).startsWith(lower(r))).length, r));
    if (roots.length === 0) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1;margin-top:10vh"><p>片库还是空的</p><p class="sub">点击右上角「添加文件夹」扫描本地或 NAS 视频</p></div>`;
    }
  } else {
    const children = childSegments(currentDir);
    for (const [seg, count] of [...children.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
      const full = currentDir.endsWith('\\') ? currentDir + seg : currentDir + '\\' + seg;
      grid.appendChild(folderCard(seg, count, full));
    }
  }
  const sorted = [...list].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  for (const v of sorted) grid.appendChild(videoCard(v));
  if (!resultsMode && currentDir && list.length === 0 && grid.children.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;margin-top:10vh"><p>此文件夹没有视频</p></div>`;
  }
  updateSelectionBar();
}

/** 搜索结果过滤条：全部 / 文件夹 / 文件 / 标签 */
function renderSearchFilters(res) {
  let bar = document.getElementById('searchFilters');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'searchFilters';
    document.getElementById('libraryMeta').after(bar);
  }
  bar.innerHTML = '';
  bar.classList.toggle('hidden', !res);
  if (!res) return;
  const mk = (label, key, count) => {
    const b = document.createElement('button');
    if (searchFilter === key) b.className = 'active';
    b.textContent = `${label} ${count}`;
    b.addEventListener('click', () => { searchFilter = key; render(); });
    bar.appendChild(b);
  };
  mk('全部', 'all', res.dirs.length + res.files.length + res.tags.length);
  mk('文件夹', 'dir', res.dirs.length);
  mk('文件', 'file', res.files.length);
  mk('标签', 'tag', res.tags.length);
}

/** 标签搜索结果卡片：点击进入标签页查看该标签的视频 */
function tagResultCard(tag, count) {
  const card = document.createElement('div');
  card.className = 'tag-card';
  card.innerHTML = `
    <div class="tc-icon">${icon('list', 26)}</div>
    <div class="tc-body"><div class="tc-name">${escapeHtml(tag)}</div><div class="tc-count">${count} 个视频</div></div>`;
  card.addEventListener('click', () => {
    import('./pages.js').then(m => m.openTag(tag));
  });
  return card;
}

function renderBreadcrumb(resultsMode) {
  let bc = document.getElementById('breadcrumb');
  if (!bc) {
    bc = document.createElement('div');
    bc.id = 'breadcrumb';
    document.getElementById('libraryMeta').before(bc);
  }
  bc.innerHTML = '';
  bc.classList.toggle('hidden', resultsMode);
  if (resultsMode) return;
  const mk = (label, dir) => {
    const s = document.createElement('span');
    s.className = 'crumb' + (dir === currentDir ? ' active' : '');
    s.textContent = label;
    s.addEventListener('click', () => { if (dir !== currentDir) { pushNav(); currentDir = dir; render(); } });
    bc.appendChild(s);
  };
  const sep = () => {
    const s = document.createElement('span');
    s.className = 'crumb-sep';
    s.innerHTML = icon('chevron', 14);
    bc.appendChild(s);
  };
  mk('片库', null);
  if (currentDir) {
    let root = roots.find(r => lower(currentDir) === lower(r) || lower(currentDir).startsWith(lower(r) + '\\') || lower(currentDir).startsWith(lower(r) + '/'));
    if (root) {
      const rest = currentDir.slice(root.length).replace(/^[\\/]+/, '');
      const parts = rest ? rest.split(/[\\/]/) : [];
      let acc = root;
      sep(); mk(nameOf(root), acc);
      for (const p of parts) { acc = acc.endsWith('\\') ? acc + p : acc + '\\' + p; sep(); mk(p, acc); }
    } else {
      sep(); mk(nameOf(currentDir), currentDir);
    }
  }
}

// ---- 卡片 ----
function selBox(selected, onToggle) {
  const b = document.createElement('button');
  b.className = 'sel-box' + (selected ? ' on' : '');
  b.title = '选择';
  b.innerHTML = selected ? icon('check', 13) : '';
  b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  return b;
}

function folderCard(name, count, fullDir) {
  const card = document.createElement('div');
  card.className = 'card folder-card' + (selDirs.has(fullDir) ? ' selected' : '');
  card.dataset.dir = fullDir;
  const rec = folderRecs.find(r => String(r.path).toLowerCase() === String(fullDir).toLowerCase());
  const title = rec?.title || name;
  card.innerHTML = `
    ${rec?.cover ? `<img class="thumb" src="${fileUrl(rec.cover)}" />`
              : `<div class="thumb-placeholder folder">${icon('folder', 46)}</div>`}
    <div class="info">
      <div class="title">${escapeHtml(title)}</div>
      <div class="filename">${count} 个视频${rec?.title && rec.title !== name ? ` · ${escapeHtml(name)}` : ''}</div>
    </div>`;
  card.prepend(selBox(selDirs.has(fullDir), () => toggleDirSel(fullDir)));
  card.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) { toggleDirSel(fullDir); return; }
    pushNav();
    keyword = '';
    const input = document.getElementById('searchInput');
    if (input) input.value = '';
    currentDir = fullDir; render();
  });
  return card;
}

function videoCard(v) {
  const card = document.createElement('div');
  card.className = 'card' + (selVideos.has(v.id) ? ' selected' : '');
  card.dataset.id = v.id;
  const progress = v.position && v.duration ? (v.position / v.duration * 100) : 0;
  card.innerHTML = `
    ${v.cover ? `<img class="thumb" src="${fileUrl(v.cover)}" />`
              : `<div class="thumb-placeholder">${icon('film', 34)}</div>`}
    <div class="info">
      <div class="title">${escapeHtml(v.title || v.virtualName || v.name)}</div>
      <div class="filename">${escapeHtml(v.virtualName && v.virtualName !== v.name ? `${v.virtualName}（原: ${v.name}）` : v.name)}</div>
      <div class="tags">${(v.tags || []).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>
    </div>
    ${progress > 0 ? `<div class="progress-line" style="position:absolute;bottom:0;left:0;right:0"><div style="width:${progress}%"></div></div>` : ''}`;
  card.prepend(selBox(selVideos.has(v.id), () => toggleVideoSel(v.id)));
  card.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) { toggleVideoSel(v.id); return; }
    open(v);
  });
  return card;
}

// ---- 右键 / 长按菜单 ----
let ctxAiOpen = false; // 菜单是否处于 AI 二级面板

function showContextMenu(x, y, aiOpen = false) {
  ctxAiOpen = aiOpen;
  const menu = document.getElementById('ctxMenu');
  menu.innerHTML = '';
  const ids = selVideoIds();
  const n = selectionCount();
  const single = n === 1 && selVideos.size === 1;
  const singleVideo = single ? allVideos.find(v => v.id === [...selVideos][0]) : null;

  const add = (label, iconName, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = (iconName ? icon(iconName, 15) : '') + `<span>${label}</span>`;
    b.addEventListener('click', () => { menu.classList.add('hidden'); fn(); });
    menu.appendChild(b);
  };
  const sep = () => {
    const s = document.createElement('div');
    s.className = 'ctx-sep';
    menu.appendChild(s);
  };
  const title = document.createElement('div');
  title.className = 'ctx-title';
  title.textContent = n > 1 ? `已选 ${n} 项（${ids.length} 个视频）` : '操作';
  menu.appendChild(title);

  if (ctxAiOpen) {
    // AI 二级面板
    const back = document.createElement('button');
    back.innerHTML = icon('back', 15) + '<span>返回</span>';
    back.addEventListener('click', () => showContextMenu(x, y, false));
    menu.appendChild(back);
    sep();
    add('AI 打标签', 'sparkle', () => runBatch('tag', ids));
    add('AI 整理分类', 'folder', () => runBatch('organize', ids));
    add('AI 下载字幕', 'subtitle', () => runBatch('subtitle', ids));
    add('AI 添加封面', 'camera', () => runBatch('cover', ids));
  } else {
    if (singleVideo) add('播放', 'play', () => open(singleVideo));
    // 取消收藏只在收藏页面出现；收藏只在非收藏页面出现
    add('⭐ 收藏', 'star-fill', () => favoriteSelection());
    if (singleVideo) add('编辑标签', 'list', () => editTagsDialog(singleVideo));
    sep();
    add('从片库移除（不动文件）', 'close', () => removeFromLibrary());
    add('删除磁盘文件（危险）', 'close', () => deleteFilesConfirm(), 'danger');
    sep();
    // AI 功能整合：先点 AI，再选具体功能
    add('AI 功能', 'robot', () => showContextMenu(x, y, true), 'ai-entry');
  }

  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - 240) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + 'px';
}

function targetDirs() { return [...selDirs]; }

/** 文件夹右键菜单：收藏整个文件夹 / 对文件夹下视频跑 AI / 作为连续剧整体处理 */
function showFolderContextMenu(x, y, dir) {
  const menu = document.getElementById('ctxMenu');
  menu.innerHTML = '';
  const ids = videosIn(dir).map(v => v.id);
  const add = (label, iconName, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = (iconName ? icon(iconName, 15) : '') + `<span>${label}</span>`;
    b.addEventListener('click', () => { menu.classList.add('hidden'); fn(); });
    menu.appendChild(b);
  };
  const title = document.createElement('div');
  title.className = 'ctx-title';
  title.textContent = `${nameOf(dir)}（${ids.length} 个视频）`;
  menu.appendChild(title);

  add('⭐ 收藏整个文件夹', 'star-fill', () => favoriteSelection());
  add('AI 打标签', 'sparkle', () => runBatch('tag', ids));
  add('AI 整理分类', 'folder', () => runBatch('organize', ids));
  add('AI 添加封面', 'camera', () => runBatch('cover', ids));
  if (ids.length >= 2) {
    // 连续剧/合集：以文件夹为单位，各集只截帧
    add('📺 连续剧·打标签（整季查一次）', 'sparkle', () => runBatch('seriesTag', [], [dir]));
    add('📺 连续剧·封面（海报+各集截帧）', 'camera', () => runBatch('seriesCover', [], [dir]));
  }

  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - 240) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + 'px';
}

/** 收藏选中内容 → 创建一个收藏分类 */
async function favoriteSelection() {
  const ids = selVideoIds();
  const dirs = targetDirs();
  if (ids.length === 0 && dirs.length === 0) { toast('没有可收藏的内容'); return; }
  const name = (dirs.length === 1 && ids.length === 0) ? null : null; // 命名交给主进程（文件夹名/新建收藏N）
  const col = await window.api.createCollection(name, ids, dirs);
  const n = ids.length + dirs.length;
  toast(`⭐ 已创建收藏分类「${col.name}」（${n} 项）`);
  clearSelection();
  import('./pages.js').then(m => m.refreshPages());
}

async function removeFromLibrary() {
  const paths = [...selVideos].map(id => allVideos.find(v => v.id === id)?.path).filter(Boolean);
  paths.push(...targetDirs());
  const n = await window.api.removeVideos(paths);
  toast(`已从片库移除 ${n} 条记录（磁盘文件未动）`);
  clearSelection();
  refreshLibrary();
}

async function deleteFilesConfirm() {
  const ids = selVideoIds();
  const ok = await confirmDialog(`确定要物理删除 ${ids.length} 个视频文件吗？\n此操作不可恢复，NAS 共享盘上的文件也会被删除！`);
  if (!ok) return;
  const results = await window.api.deleteFiles(ids);
  const fail = results.filter(r => !r.ok).length;
  toast(fail ? `删除完成，${fail} 个失败（可能无权限）` : `已删除 ${results.length} 个文件`);
  clearSelection();
  refreshLibrary();
}

function runBatch(op, ids, dirs = []) {
  if (ids.length === 0 && dirs.length === 0) { toast('没有可操作的内容'); return; }
  window.api.queueAdd(op, ids, dirs);
  const names = {
    tag: 'AI 打标签', organize: 'AI 整理', cover: 'AI 封面', subtitle: 'AI 字幕',
    seriesTag: '连续剧打标签', seriesCover: '连续剧封面',
  };
  const n = ids.length + dirs.length;
  toast(`已加入 AI 队列：${names[op]}（${n} 项，可在 AI 助手页查看/取消）`);
  clearSelection();
}

// ---- 选中操作栏 ----
function ensureSelectionBar() {
  let bar = document.getElementById('selectionBar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'selectionBar';
  bar.classList.add('hidden');
  document.body.appendChild(bar);
  return bar;
}

function updateSelectionBar() {
  const bar = ensureSelectionBar();
  const n = selectionCount();
  if (n === 0) { bar.classList.add('hidden'); bar.innerHTML = ''; barState.ai = false; return; }
  bar.classList.remove('hidden');
  const ids = selVideoIds();
  const btn = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  bar.innerHTML = `<span class="sel-count">已选 ${n} 项（${ids.length} 个视频）</span>`;

  if (barState.ai) {
    // AI 二级面板：先点 AI，再选功能
    bar.appendChild(btn('← 返回', () => { barState.ai = false; updateSelectionBar(); }, 'ghost'));
    bar.appendChild(btn('打标签', () => runBatch('tag', ids), 'primary'));
    bar.appendChild(btn('整理', () => runBatch('organize', ids), 'primary'));
    bar.appendChild(btn('字幕', () => runBatch('subtitle', ids), 'primary'));
    bar.appendChild(btn('封面', () => runBatch('cover', ids), 'primary'));
    return;
  }

  // 取消收藏在收藏夹页面进行
  bar.appendChild(btn('⭐ 收藏', () => favoriteSelection()));
  // 取消收藏在收藏夹页面进行
  bar.appendChild(btn('🤖 AI', () => { barState.ai = true; updateSelectionBar(); }, 'primary'));
  bar.appendChild(btn('从片库移除', () => removeFromLibrary()));
  bar.appendChild(btn('删除文件', () => deleteFilesConfirm(), 'danger'));
  bar.appendChild(btn('✕ 取消', () => { barState.ai = false; clearSelection(); }, 'ghost'));
}

const barState = { ai: false };

function showSelectionBarWithProgress() {
  const bar = ensureSelectionBar();
  bar.classList.remove('hidden');
  bar.innerHTML = `<span class="sel-progress">AI 处理中…</span>`;
}

// ---- 通用确认框（Electron 不支持 confirm()）----
function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--bg3);border:1px solid #3a3f4a;border-radius:12px;padding:22px;width:440px">
        <div style="white-space:pre-wrap;line-height:1.7;margin-bottom:18px">${escapeHtml(message)}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="cdNo">取消</button>
          <button id="cdYes" class="danger-btn">确认删除</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#cdNo').addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.querySelector('#cdYes').addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

/** Electron 不支持 prompt()，用自定义输入框编辑标签 */
function editTagsDialog(v) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--bg3);border:1px solid #3a3f4a;border-radius:12px;padding:22px;width:420px">
      <div style="margin-bottom:12px;font-weight:600">编辑标签：${escapeHtml(v.virtualName || v.name)}</div>
      <input id="tagInput" style="width:100%" value="${escapeHtml((v.tags || []).join(', '))}"
        placeholder="用逗号分隔，如：动画, 战斗" />
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button id="tagCancel">取消</button>
        <button id="tagSave" class="primary">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#tagInput');
  input.focus(); input.select();
  const close = () => overlay.remove();
  overlay.querySelector('#tagCancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#tagSave').addEventListener('click', async () => {
    const tags = input.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    await window.api.updateVideo({ id: v.id, tags });
    close();
    toast('标签已保存（仅写入本地 appdata）');
    refreshLibrary();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') overlay.querySelector('#tagSave').click();
    if (e.key === 'Escape') close();
  });
}

function fileUrl(p) {
  const s = String(p).split('\\').join('/');
  return s.startsWith('//') ? 'file://' + s : 'file:///' + s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
