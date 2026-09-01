/**
 * 收藏夹 = 收藏分类的集合。
 * - 片库中对文件夹/多选视频点"收藏" → 创建一个收藏分类（文件夹名 / 新建收藏N）
 * - 标签页点星标 → 创建以标签命名的分类（再点删除该分类）
 * - 侧栏收藏夹列出全部分类（可折叠），右键/长按：重命名、复制、删除
 * - 点击分类 → 收藏夹页：全部视频 / 资源管理器 两种显示
 */
import { toast, pushNav } from './app.js';
import { resetLibraryUI } from './library.js';
import { icon } from './icons.js';

let allVideos = [];
let folderRecs = [];             // 剧集文件夹记录（封面/标题）
let selectedTag = null;          // 标签页当前查看的标签
let collections = [];            // 收藏分类
let activeCol = null;            // 收藏夹页当前分类 id
let favMode = localStorage.getItem('avp_favMode') || 'explorer'; // 收藏夹显示方式（默认资源管理器）
let favDir = null;               // 资源管理器当前目录
let favSideOpen = localStorage.getItem('avp_favSideOpen') !== '0';

const lower = (p) => String(p).toLowerCase();
const nameOf = (p) => p.split('\\').filter(Boolean).pop() || p;
function fileUrl(p) {
  const s = String(p).split('\\').join('/');
  return s.startsWith('//') ? 'file://' + s : 'file:///' + s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const folderRec = (p) => folderRecs.find(r => lower(r.path) === lower(p));

/** 一组目录的最近公共祖先（大小写不敏感；UNC 至少保留 \\host\share） */
function lcaOfDirs(dirs) {
  if (!dirs.length) return null;
  let segs = dirs[0].toLowerCase().split('\\');
  for (const d of dirs) {
    const parts = d.toLowerCase().split('\\');
    let i = 0;
    while (i < segs.length && i < parts.length && segs[i] === parts[i]) i++;
    segs = segs.slice(0, i);
  }
  const min = dirs[0].startsWith('\\\\') ? 4 : 1;
  if (segs.length < min) return null;
  return dirs[0].split('\\').slice(0, segs.length).join('\\');
}

export async function refreshPages() {
  allVideos = await window.api.listVideos();
  folderRecs = (await window.api.listFolders?.()) || [];
  collections = (await window.api.getCollections()) || [];
  renderFavSidebar();
  renderTagsPage();
  renderFavsPage();
}

// ---- 分类视频解析：显式 id + 目录下视频（去重） ----
function colVideos(col) {
  const set = new Map();
  const dirList = (col.dirs || []).map(d => d.toLowerCase());
  for (const id of (col.ids || [])) {
    const v = allVideos.find(x => x.id === id);
    if (v) set.set(v.id, v);
  }
  for (const v of allVideos) {
    if (dirList.some(d => lower(v.folder).startsWith(d.endsWith('\\') ? d : d + '\\'))) set.set(v.id, v);
  }
  return [...set.values()];
}

function openVideo(v) {
  import('./app.js').then(m => m.showPlayer(v));
}

// ---- 通用视频卡片 ----
function videoCard(v) {
  const card = document.createElement('div');
  card.className = 'card';
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
  card.addEventListener('click', () => openVideo(v));
  return card;
}

function folderCardEl(name, count, onOpen, rec) {
  const card = document.createElement('div');
  card.className = 'card folder-card';
  const title = rec?.title || name;
  card.innerHTML = `
    ${rec?.cover ? `<img class="thumb" src="${fileUrl(rec.cover)}" />`
              : `<div class="thumb-placeholder folder">${icon('folder', 46)}</div>`}
    <div class="info">
      <div class="title">${escapeHtml(title)}</div>
      <div class="filename">${count} 个视频${rec?.title && rec.title !== name ? ` · ${escapeHtml(name)}` : ''}</div>
    </div>`;
  card.addEventListener('click', onOpen);
  return card;
}

// ================= 标签页 =================
function renderTagsPage() {
  const host = document.getElementById('tagsPage');
  if (!host) return;
  const tagCount = new Map();
  for (const v of allVideos) for (const t of (v.tags || [])) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const untagged = allVideos.filter(v => !v.tags || v.tags.length === 0);

  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'page-head';
  if (selectedTag === null) {
    head.innerHTML = `<h2>标签</h2><div class="meta">点击标签查看视频；点星标创建/删除同名收藏分类</div>`;
    host.appendChild(head);

    const wrap = document.createElement('div');
    wrap.className = 'tag-cards';
    wrap.appendChild(tagCard('无标签', untagged.length, !!collectionNamed('无标签'),
      () => { pushNav(); selectedTag = '__none__'; renderTagsPage(); },
      () => toggleTagCollection('__none__', untagged)));
    for (const [t, c] of [...tagCount.entries()].sort((a, b) => b[1] - a[1])) {
      const vids = allVideos.filter(v => (v.tags || []).includes(t));
      wrap.appendChild(tagCard(t, c, !!collectionNamed(t),
        () => { pushNav(); selectedTag = t; renderTagsPage(); },
        () => toggleTagCollection(t, vids)));
    }
    host.appendChild(wrap);
  } else {
    const label = selectedTag === '__none__' ? '无标签' : selectedTag;
    head.innerHTML = `<h2>标签：${escapeHtml(label)}</h2>`;
    const back = document.createElement('button');
    back.className = 'ghost';
    back.innerHTML = icon('back', 15) + '<span> 返回标签列表</span>';
    back.addEventListener('click', () => { pushNav(); selectedTag = null; renderTagsPage(); });
    head.appendChild(back);
    host.appendChild(head);

    const list = selectedTag === '__none__' ? untagged : allVideos.filter(v => (v.tags || []).includes(selectedTag));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${list.length} 个视频`;
    host.appendChild(meta);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const v of [...list].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))) grid.appendChild(videoCard(v));
    host.appendChild(grid);
  }
}

const collectionNamed = (name) => collections.find(c => c.name === name);

function tagCard(label, count, starred, onOpen, onStar) {
  const card = document.createElement('div');
  card.className = 'tag-card';
  card.innerHTML = `
    <div class="tc-icon">${icon('list', 26)}</div>
    <div class="tc-body"><div class="tc-name">${escapeHtml(label)}</div><div class="tc-count">${count} 个视频</div></div>
    <button class="tc-star${starred ? ' on' : ''}" title="${starred ? '删除该收藏分类' : '创建同名收藏分类'}">${icon(starred ? 'star-fill' : 'star', 18)}</button>`;
  card.addEventListener('click', onOpen);
  card.querySelector('.tc-star').addEventListener('click', (e) => { e.stopPropagation(); onStar(); });
  return card;
}

/** 标签星标：创建以标签命名的收藏分类；已存在则删除该分类（配对操作） */
async function toggleTagCollection(tag, vids) {
  const existing = collectionNamed(tag);
  const label = tag === '__none__' ? '无标签' : tag;
  if (existing) {
    await window.api.deleteCollection(existing.id);
    toast(`已删除收藏分类「${label}」`);
  } else {
    if (!vids.length) { toast('该标签下没有视频'); return; }
    await window.api.createCollection(label, vids.map(v => v.id), []);
    toast(`⭐ 已创建收藏分类「${label}」（${vids.length} 个视频）`);
  }
  refreshPages();
}

// ================= 侧栏收藏夹（可折叠分类列表） =================
export function renderFavSidebar() {
  const head = document.getElementById('favSideHead');
  const list = document.getElementById('favSideList');
  const arrow = document.getElementById('favSideArrow');
  if (!head || !list) return;
  head.classList.toggle('open', favSideOpen);
  list.classList.toggle('hidden', !favSideOpen);
  if (arrow) arrow.innerHTML = icon(favSideOpen ? 'chevron-down' : 'chevron', 14);

  if (!head.dataset.bound) {
    head.dataset.bound = '1';
    head.addEventListener('click', () => {
      favSideOpen = !favSideOpen;
      localStorage.setItem('avp_favSideOpen', favSideOpen ? '1' : '0');
      renderFavSidebar();
    });
  }

  list.innerHTML = '';
  if (collections.length === 0) {
    list.innerHTML = `<div class="fav-side-empty">暂无收藏分类<br>在片库右键视频/文件夹可收藏</div>`;
    return;
  }
  for (const col of collections) {
    const n = colVideos(col).length;
    const div = document.createElement('div');
    div.className = 'tag-item' + (activeCol === col.id ? ' active' : '');
    div.innerHTML = `<span class="fav-ico">${icon('star', 14)}</span><span>${escapeHtml(col.name)}</span><span class="count">${n}</span>`;
    div.addEventListener('click', () => goCollection(col.id));
    bindFavEntryMenu(div, col);
    list.appendChild(div);
  }
}

function goCollection(id) {
  pushNav();
  activeCol = id; favDir = null; favMode = localStorage.getItem('avp_favMode') || 'explorer';
  resetLibraryUI();
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', false));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-favs'));
  renderFavSidebar();
  renderFavsPage();
}

// ---- 页面状态快照（导航历史用） ----
/** 从搜索结果等处打开某个标签的视频列表 */
export function openTag(tag) {
  pushNav();
  selectedTag = tag;
  resetLibraryUI();
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', false));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-tags'));
  renderTagsPage();
}

export function favsSnapshot() {
  return { col: activeCol, dir: favDir, mode: favMode };
}
export function restoreFavsState(s) {
  activeCol = s.col ?? null;
  favDir = s.dir ?? null;
  favMode = s.mode || localStorage.getItem('avp_favMode') || 'explorer';
  resetLibraryUI();
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', false));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-favs'));
  renderFavSidebar();
  renderFavsPage();
}
export function tagsSnapshot() {
  return { tag: selectedTag };
}
export function restoreTagsState(s) {
  selectedTag = s.tag ?? null;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', false));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-tags'));
  renderTagsPage();
}

/** 收藏分类右键 / 长按菜单：重命名、复制、删除 */
function bindFavEntryMenu(el, col) {
  const open = (x, y) => showFavCtxMenu(x, y, col);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); open(e.clientX, e.clientY); });
  let timer = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    timer = setTimeout(() => open(e.clientX, e.clientY), 500);
  });
  el.addEventListener('pointerup', () => clearTimeout(timer));
  el.addEventListener('pointermove', () => clearTimeout(timer));
}

function showFavCtxMenu(x, y, col) {
  const menu = document.getElementById('ctxMenu');
  menu.innerHTML = '';
  const add = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', () => { menu.classList.add('hidden'); fn(); });
    menu.appendChild(b);
  };
  const title = document.createElement('div');
  title.className = 'ctx-title';
  title.textContent = col.name;
  menu.appendChild(title);
  add('▶ 打开', () => goCollection(col.id));
  add('✏️ 重命名', () => renameCollection(col));
  add('📋 复制', () => copyCollection(col));
  add('🗑 删除', () => deleteCollection(col), 'danger');

  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + 'px';
}

async function renameCollection(col) {
  const newName = await inputDialog(`重命名收藏分类`, col.name);
  if (!newName || newName === col.name) return;
  await window.api.renameCollection(col.id, newName);
  toast(`已重命名为「${newName}」`);
  refreshPages();
}

async function copyCollection(col) {
  await window.api.copyCollection(col.id);
  toast(`已复制为副本`);
  refreshPages();
}

async function deleteCollection(col) {
  const ok = await confirmDialog(`确定删除收藏分类「${col.name}」？\n只删除该分类，不会删除视频文件，也不会影响其他分类。`);
  if (!ok) return;
  await window.api.deleteCollection(col.id);
  if (activeCol === col.id) { activeCol = null; }
  toast('已删除收藏分类');
  refreshPages();
}

// ================= 收藏夹页 =================
function renderFavsPage() {
  const host = document.getElementById('favsPage');
  if (!host) return;
  const col = collections.find(c => c.id === activeCol);
  host.innerHTML = '';

  if (!col) {
    host.innerHTML = `
      <div class="page-head"><h2>收藏夹</h2></div>
      <div class="empty" style="margin-top:12vh"><p>选择左侧的收藏分类</p><p class="sub">还没有收藏？在片库中右键文件夹或选中多个视频后点「收藏」</p></div>`;
    return;
  }

  const favs = colVideos(col);
  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `<h2>收藏夹 · ${escapeHtml(col.name)}</h2>`;
  const toggle = document.createElement('div');
  toggle.className = 'view-toggle';
  toggle.innerHTML = `
    <button class="${favMode === 'flat' ? 'active' : ''}" data-m="flat">全部视频</button>
    <button class="${favMode === 'explorer' ? 'active' : ''}" data-m="explorer">资源管理器</button>`;
  toggle.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    if (favMode !== b.dataset.m) pushNav();
    favMode = b.dataset.m;
    localStorage.setItem('avp_favMode', favMode);
    favDir = null; renderFavsPage();
  }));
  head.appendChild(toggle);
  host.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = favs.length ? `共 ${favs.length} 个收藏视频` : '该分类下暂无视频（源文件可能已被移除）';
  host.appendChild(meta);

  if (favs.length === 0) return;

  const grid = document.createElement('div');
  grid.className = 'grid';

  if (favMode === 'flat') {
    for (const v of [...favs].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))) grid.appendChild(videoCard(v));
    host.appendChild(grid);
    return;
  }

  // 资源管理器模式：顶层坍缩到"有实际视频的上一层文件夹"
  const dirs = [...new Set(favs.map(v => v.folder))];
  const lca = lcaOfDirs(dirs);

  if (!favDir) {
    if (lca) {
      const prefix = lca.endsWith('\\') ? lca : lca + '\\';
      const direct = favs.filter(v => lower(v.folder) === lower(lca));
      const childSegs = new Map();
      for (const v of favs) {
        const f = lower(v.folder);
        if (f === lower(lca)) continue;
        if (f.startsWith(lower(prefix))) {
          const seg = v.folder.slice(prefix.length).split('\\')[0];
          childSegs.set(seg, (childSegs.get(seg) || 0) + 1);
        }
      }
      if (childSegs.size === 0) {
        // 全部视频都在同一个文件夹：显示为一个文件夹，点进去才看视频
        grid.appendChild(folderCardEl(nameOf(lca) || lca, favs.length,
          () => { pushNav(); favDir = lca; renderFavsPage(); }, folderRec(lca)));
        meta.textContent = `共 ${favs.length} 个收藏视频 · 点击文件夹查看`;
      } else {
        for (const [seg, count] of [...childSegs.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
          const full = prefix + seg;
          grid.appendChild(folderCardEl(seg, count,
            () => { pushNav(); favDir = full; renderFavsPage(); }, folderRec(full)));
        }
        for (const v of [...direct].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))) grid.appendChild(videoCard(v));
        meta.textContent = `共 ${favs.length} 个收藏视频`;
      }
    } else {
      // 求不到公共祖先（跨盘/跨主机）：按共享根分组
      const segs = new Map();
      for (const v of favs) {
        const parts = v.folder.split('\\').filter(Boolean);
        const key = v.folder.startsWith('\\\\') ? '\\\\' + parts[0] + '\\' + parts[1] : parts[0] + '\\';
        segs.set(key, (segs.get(key) || 0) + 1);
      }
      for (const [dir, count] of segs) grid.appendChild(folderCardEl(nameOf(dir) || dir, count, () => { pushNav(); favDir = dir; renderFavsPage(); }, folderRec(dir)));
      meta.textContent = `共 ${favs.length} 个收藏视频 · 请进入文件夹浏览`;
    }
    if (grid.children.length) host.appendChild(grid);
    return;
  }

  // favDir 之内：子文件夹 + 直接视频
  const prefix = favDir.endsWith('\\') ? favDir : favDir + '\\';
  const childSegs = new Map();
  const list = [];
  for (const v of favs) {
    const f = lower(v.folder);
    if (f === lower(favDir)) list.push(v);
    else if (f.startsWith(lower(prefix))) {
      const seg = v.folder.slice(prefix.length).split('\\')[0];
      childSegs.set(seg, (childSegs.get(seg) || 0) + 1);
    }
  }

  // 面包屑：收藏名 →（相对 LCA 的层级）
  const bc = document.createElement('div');
  bc.id = 'breadcrumb';
  const mkCrumb = (label, dir) => {
    const s = document.createElement('span');
    s.className = 'crumb' + (dir === favDir ? ' active' : '');
    s.textContent = label;
    s.addEventListener('click', () => { if (dir !== favDir) { pushNav(); favDir = dir; renderFavsPage(); } });
    bc.appendChild(s);
  };
  mkCrumb(col.name, null);
  const lcaPrefix = lca ? (lca.endsWith('\\') ? lca : lca + '\\') : null;
  if (lca && (lower(favDir) === lower(lca) || lower(favDir).startsWith(lower(lcaPrefix)))) {
    const rel = favDir.slice(lca.length).replace(/^[\\/]+/, '');
    const parts = rel ? rel.split(/[\\/]/) : [];
    if (parts.length === 0) mkCrumb(nameOf(lca), favDir);
    let acc = lca;
    for (const p of parts) {
      acc = acc.endsWith('\\') ? acc + p : acc + '\\' + p;
      const sp = document.createElement('span');
      sp.className = 'crumb-sep'; sp.innerHTML = icon('chevron', 14);
      bc.appendChild(sp);
      mkCrumb(p, acc);
    }
  } else {
    const segs = favDir.split('\\').filter(Boolean);
    let acc = favDir.startsWith('\\\\') ? '\\\\' + segs[0] : segs[0] + '\\';
    mkCrumb(segs[0], acc);
    for (let i = 1; i < segs.length; i++) {
      acc = acc.endsWith('\\') ? acc + segs[i] : acc + '\\' + segs[i];
      const sp = document.createElement('span');
      sp.className = 'crumb-sep'; sp.innerHTML = icon('chevron', 14);
      bc.appendChild(sp);
      mkCrumb(segs[i], acc);
    }
  }
  host.appendChild(bc);

  for (const [seg, count] of [...childSegs.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    const full = prefix + seg;
    grid.appendChild(folderCardEl(seg, count, () => { pushNav(); favDir = full; renderFavsPage(); }, folderRec(full)));
  }
  const sorted = [...list].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  for (const v of sorted) grid.appendChild(videoCard(v));
  if (grid.children.length) host.appendChild(grid);
}

// ================= 弹窗 =================
function inputDialog(title, value, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--bg3);border:1px solid #3a3f4a;border-radius:12px;padding:22px;width:420px">
        <div style="margin-bottom:12px;font-weight:600">${escapeHtml(title)}</div>
        <input id="ivInput" style="width:100%" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder || '')}" />
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
          <button id="ivCancel">取消</button>
          <button id="ivOk" class="primary">确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#ivInput');
    input.focus(); input.select();
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#ivCancel').addEventListener('click', () => done(null));
    overlay.querySelector('#ivOk').addEventListener('click', () => done(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
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
          <button id="cdNo">取消</button>
          <button id="cdYes" class="danger-btn">确认删除</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#cdNo').addEventListener('click', () => done(false));
    overlay.querySelector('#cdYes').addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}
