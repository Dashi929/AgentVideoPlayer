/**
 * AI 媒体增强：封面下载（联网优先，失败截帧兜底）、字幕下载（尽力而为）。
 * 封面/字幕只写本地 appdata，不动 NAS 上的原文件。
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const files = require('./files');
const ai = require('./ai');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** 用大模型清洗文件名为规范作品名；cover 模式下（folderHint 存在）要求有把握才返回 */
async function cleanTitle(name, folderHint, tags) {
  try {
    const context = [
      folderHint ? `所在文件夹: ${folderHint}` : '',
      tags?.length ? `已有标签: ${tags.join('/')}` : '',
    ].filter(Boolean).join('\n');
    const resp = await ai.chatWithRetry([{
      role: 'user',
      content: `文件名 "${name}"${context ? '\n' + context : ''}\n对应的影视/视频作品是什么？返回 JSON：{"title":"规范中文或英文标题","year":年份或null}。只返回 JSON。${folderHint ? '若没有较大把握判断真实作品名（文件名是番号、乱码或无意义字符时），返回 {"title":null}' : '若无法判断，title 用文件名去噪后的结果'}`,
    }], { temperature: 0.1 });
    const m = (ai.assistantMessage(resp)?.content || '').match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : '{}');
    if (folderHint && (!parsed.title || parsed.title === 'null')) return {};
    if (!parsed.title) parsed.title = path.basename(name, path.extname(name));
    return parsed;
  } catch {
    if (folderHint) return {};
    return { title: path.basename(name, path.extname(name)) };
  }
}

function fetchWithTimeout(url, ms = 12000, extraHeaders) {
  return fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...(extraHeaders || {}) },
    signal: AbortSignal.timeout(ms),
    redirect: 'follow',
  });
}

// JAV 站点需要年龄验证 cookie
const JAV_HEADERS = { Cookie: 'age=verified; existed=1', 'Accept-Language': 'zh-CN,zh;q=0.9' };
const JAV_GENRE_NOISE = new Set(['高清', '字幕', '中文字幕', '中文发']);
const isJavNoise = (g) => JAV_GENRE_NOISE.has(g) || /^[0-9]+p$/i.test(g);

/** 下载一张图片到临时文件，校验格式/尺寸/比例（海报类竖图，JAV 封面横图） */
async function downloadImage(url, dest, { ratioMin = 0.4, ratioMax = 1.6, minW = 150, minH = 150, headers } = {}) {
  try {
    const res = await fetchWithTimeout(url, 15000, headers);
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (!/image\/(jpe?g|png|webp)/.test(type)) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 15000) return false; // 太小多半是缩略图/占位
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    if (!isJpg && !isPng) return false;
    const dim = imageSize(buf);
    if (dim) {
      if (dim.w < minW || dim.h < minH) return false;
      const ratio = dim.w / dim.h;
      if (ratio < ratioMin || ratio > ratioMax) return false;
    }
    fs.writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

/** 番号规范化：MIDV114 / [xx]midv-114.mp4 → MIDV-114 */
function normalizeJavCode(name) {
  const base = path.basename(name, path.extname(name)).replace(/\[[^\]]*\]/g, ' ').trim();
  const m = base.match(/([A-Za-z]{2,6})-?(\d{2,5})/);
  return m ? (m[1] + '-' + m[2]).toUpperCase() : null;
}

// JAV 元数据站（搜索页 → 详情页 → og:image 封面/类型/演员）
const JAV_HOSTS = ['https://www.javbus.com', 'https://javsee.icu'];

async function javLookup(code, onStep = () => {}) {
  for (const host of JAV_HOSTS) {
    try {
      // 1) 直接访问详情页 host/CODE（最稳）
      onStep(`打开 ${new URL(host).hostname} 详情页…`);
      let page = null;
      const d = await fetchWithTimeout(`${host}/${code}`, 10000, JAV_HEADERS);
      if (d.ok) page = await d.text();
      // 2) 详情 404/年龄页 → 搜索页兜底
      if (!page || page.includes('Age Verification')) {
        onStep('详情页未命中，走搜索页…');
        const sr = await fetchWithTimeout(`${host}/search/${code}&type=1&parent=ce`, 10000, JAV_HEADERS);
        if (sr.ok) {
          const sp = await sr.text();
          const link = sp.match(/href="(https?:\/\/[^"]+\/(?:[A-Za-z]{2,6}-\d{2,5}))"[^>]*class="movie-box"/)?.[1]
            || sp.match(/class="movie-box"[^>]*href="(https?:\/\/[^"]+\/(?:[A-Za-z]{2,6}-\d{2,5}))"/)?.[1];
          if (link) {
            const dr = await fetchWithTimeout(link, 10000, JAV_HEADERS);
            if (dr.ok) page = await dr.text();
          }
        }
      }
      if (!page) { onStep('未取到详情页'); continue; }

      const coverPath = page.match(/class="bigImage"[^>]*href="([^"]+)"/)?.[1]
        || page.match(/href="([^"]+)"[^>]*class="bigImage"/)?.[1]
        || page.match(/property="og:image"\s+content="([^"]+)"/)?.[1];
      const cover = !coverPath ? null
        : coverPath.startsWith('http') ? coverPath
        : coverPath.startsWith('//') ? 'https:' + coverPath
        : host + coverPath;
      const rawTitle = page.match(/<title>([^<]+)<\/title>/)?.[1]?.trim();
      const title = (rawTitle || '').replace(new RegExp('^' + code + '\\s*', 'i'), '').replace(/\s*-\s*JavBus\s*$/i, '').trim();
      const genres = [...page.matchAll(/\/genre\/[^"]+">([^<]+)<\/a>/g)].map(m => m[1].trim()).filter(g => !isJavNoise(g));
      const actress = [...page.matchAll(/\/star\/[^"]+">([^<]+)<\/a>/g)].map(m => m[1].trim())[0];
      if (!cover && !title) { onStep('页面无封面/标题'); continue; }
      return { code, cover, title, genres, actress, source: new URL(host).hostname };
    } catch (e) {
      onStep(`${new URL(host).hostname} 查询失败：${String(e.message || e).slice(0, 60)}`);
    }
  }
  return null;
}
/** 读取图片宽高（JPEG/PNG 头部解析），用于海报比例校验 */
function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) { // PNG: IHDR
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: 扫 SOF 段
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}

/**
 * 为视频设置封面（内容优先，杜绝"下载一张不相干的图"）：
 * 1. 番号内容 → 直接智能截帧（保证匹配）
 * 2. 动画 → Bangumi API 官方封面
 * 3. 影视 → 豆瓣条目页海报（og:image）
 * 4. 都失败 → 智能截帧兜底
 */
/** 已注册的剧集文件夹记录（连续剧/合集），各集封面标签由文件夹统一管理 */
function seriesRecOf(folder) {
  const rec = folder ? db.getFolderByPath(folder) : null;
  return rec?.series ? rec : null;
}

async function coverFor(video, captureFrame, onStep = () => {}) {
  // 剧集文件夹内的视频：只截帧，不再逐集联网查封面
  const rec = seriesRecOf(video.folder);
  if (rec) {
    onStep(`属于剧集《${rec.title || rec.name}》，直接截帧作为封面`);
    return frameCover(video, captureFrame, onStep);
  }
  fs.mkdirSync(db.coversDir(), { recursive: true });
  const tmp = path.join(db.coversDir(), `dl_${video.id}.img`);
  const applyPoster = (from) => {
    const dest = path.join(db.coversDir(), video.id + '.jpg');
    fs.copyFileSync(tmp, dest);
    fs.rmSync(tmp, { force: true });
    db.upsertVideo({ id: video.id, cover: dest });
    onStep(`✓ 已采用${from}封面`);
    return { ok: true, source: from, title: video.title };
  };

  // 1) 番号内容：JAV 元数据站查封面/标题/类型，失败才截帧
  const code = normalizeJavCode(video.name);
  if (code) {
    onStep(`识别番号 ${code}`);
    const meta = await javLookup(code, onStep);
    if (meta?.cover) {
      onStep('下载封面…');
      // JAV 站图片有防盗链：必须带同源 Referer（否则 403）
      if (await downloadImage(meta.cover, tmp, {
        ratioMin: 0.9, ratioMax: 2.4, minW: 300, minH: 150,
        headers: { Referer: new URL(meta.cover).origin + '/', Cookie: 'age=verified; existed=1' },
      })) {
        // 顺带补全标题/标签（封面和打标签共享这套元数据）
        const patch = { id: video.id };
        if (meta.title && (!video.title || video.title === video.name)) patch.title = meta.title;
        db.upsertVideo(patch);
        const r = applyPoster('JAV 元数据站（' + meta.source + '）');
        if (meta.title) r.title = meta.title;
        return r;
      }
      onStep('封面下载/校验未通过');
    } else {
      onStep('元数据站未命中（站点可能需要代理才能访问）');
    }
    onStep('改用视频截帧（保证内容匹配）');
    return await frameCover(video, captureFrame, onStep);
  }

  // 智能识别标题：带上文件夹名和已有标签做上下文
  const folderHint = path.basename(video.folder);
  onStep('清洗文件名，确定作品名…');
  const info = await cleanTitle(video.name, folderHint, video.tags);
  if (!info.title) {
    onStep('无法识别作品名，改用视频截帧');
    return await frameCover(video, captureFrame, onStep);
  }
  onStep(`识别为：${info.title}${info.year ? '（' + info.year + '）' : ''}`);

  // 2) Bangumi（动画番剧最准，开放 API 无需密钥）
  try {
    onStep('查询 Bangumi 条目…');
    const res = await fetch('https://api.bgm.tv/search/subject/' + encodeURIComponent(info.title) + '?type=2&responseGroup=small', {
      headers: { 'User-Agent': 'AgentVideoPlayer/0.1 (personal media organizer)', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const subject = data.list?.[0];
      const img = subject?.images?.large || subject?.images?.common || subject?.images?.medium;
      if (img && await downloadImage(img, tmp)) {
        return applyPoster('Bangumi（' + (subject.name_cn || subject.name) + '）');
      }
      onStep('Bangumi 未命中');
    }
  } catch { onStep('Bangumi 查询失败'); }

  // 3) 豆瓣条目页海报（og:image）
  try {
    onStep('查询豆瓣条目海报…');
    const hits = await bingPageResults(`${info.title} ${info.year || ''} 豆瓣`.trim(), /douban\.com\/subject\/\d+/);
    for (const url of hits.slice(0, 2)) {
      const res = await fetchWithTimeout(url, 10000);
      if (!res.ok) continue;
      const html = await res.text();
      const og = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1];
      if (og && await downloadImage(og, tmp)) {
        return applyPoster('豆瓣（' + (html.match(/property="v:average">([\d.]+)</)?.[1] || '豆瓣') + '）');
      }
    }
    onStep('豆瓣未命中');
  } catch { onStep('豆瓣查询失败'); }

  // 4) 截帧兜底
  onStep('未找到权威海报，改用视频截帧（保证内容匹配）');
  return await frameCover(video, captureFrame, onStep);
}

/** 抓多帧并由渲染层打分，返回最佳一帧（避免黑屏/纯色帧） */
async function bestFrame(video, captureFrame, onStep = () => {}) {
  const dur = video.duration || 60;
  const times = [0.1, 0.3, 0.5, 0.7, 0.9].map(r => +(dur * r).toFixed(1));
  onStep('截取 5 帧并挑选画质最佳的一帧…');
  const frames = await captureFrame(video.path, times);
  if (frames.length === 0) throw new Error('截帧失败（无法解码视频，可安装 ffmpeg 后重试）');
  return frames.reduce((a, b) => (b.score ?? 0) > (a.score ?? 0) ? b : a, frames[0]);
}

/** 智能截帧：抓多帧取质量最高的一张作为视频封面 */
async function frameCover(video, captureFrame, onStep = () => {}) {
  const best = await bestFrame(video, captureFrame, onStep);
  files.setCover(video.id, Buffer.from(best.base64Jpeg, 'base64'));
  return { ok: true, source: 'frame', title: video.title };
}

/** 下载 .srt 字幕到本地 appdata（同 zip 解包），尽力而为 */
async function subtitleFor(video, onStep = () => {}) {
  const info = await cleanTitle(video.name);
  const destDir = path.join(db.coversDir(), '..', 'subtitles', video.id);
  fs.mkdirSync(destDir, { recursive: true });
  const existing = fs.existsSync(destDir) && fs.readdirSync(destDir).some(f => f.endsWith('.srt'));
  if (existing) {
    onStep('本地已有该视频的字幕');
    return { ok: true, existed: true };
  }
  const queries = [
    `${info.title} ${info.year || ''} 字幕 srt 下载`,
    `${info.title} subtitle srt`,
  ];
  for (const q of queries) {
    onStep(`搜索字幕：${q}`);
    const links = await bingPageLinks(q);
    for (const u of links.slice(0, 8)) {
      if (await trySaveSubtitle(u, destDir)) {
        onStep('字幕已下载');
        return { ok: true, dir: destDir };
      }
    }
  }
  throw new Error('未能自动找到可下载的字幕（可手动把 .srt 放到视频同目录）');
}

/** 网页搜索，提取直链 .srt/.zip 资源 */
async function bingPageLinks(query) {
  try {
    const res = await fetchWithTimeout('https://www.bing.com/search?q=' + encodeURIComponent(query));
    const html = await res.text();
    return [...html.matchAll(/href="(https?:\/\/[^"]+?\.(?:srt|zip|ass))"/gi)].map(m => m[1]);
  } catch {
    return [];
  }
}

async function trySaveSubtitle(url, destDir) {
  try {
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500 || buf.length > 20 * 1024 * 1024) return false;
    if (url.toLowerCase().endsWith('.srt')) {
      const text = buf.toString('utf8');
      if (!/-->\s/.test(text)) return false; // 校验 SRT 时间轴格式
      fs.writeFileSync(path.join(destDir, path.basename(url)), buf);
      return true;
    }
    if (url.toLowerCase().endsWith('.zip')) {
      // 用系统 PowerShell 解包
      const zipPath = path.join(destDir, 'dl.zip');
      fs.writeFileSync(zipPath, buf);
      const { execFile } = require('child_process');
      await new Promise((resolve) => {
        execFile('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
          { timeout: 20000 }, () => resolve());
      });
      fs.rmSync(zipPath, { force: true });
      const srt = fs.readdirSync(destDir).find(f => f.toLowerCase().endsWith('.srt'));
      return !!srt;
    }
    return false;
  } catch {
    return false;
  }
}

const GENRES = ['剧情', '喜剧', '动作', '科幻', '动画', '爱情', '悬疑', '惊悚', '恐怖', '犯罪', '冒险', '战争', '奇幻', '运动', '家庭', '古装', '武侠', '西部', '历史', '传记', '音乐', '歌舞', '灾难', '同性', '纪录片', '短片', '真人秀', '脱口秀', '儿童'];

/**
 * 联网搜片源信息打标签（不使用视觉模型）：
 * 文件名 → 必应搜索豆瓣等条目页 → 抓取类型/标题 → 生成标签。
 * 找不到可靠信息返回 { ok:false }，由调用方放进"无标签"。
 */
async function webTag(video, onStep = () => {}) {
  // 已注册的剧集文件夹：标签沿用文件夹记录，不再逐集查询
  const rec = seriesRecOf(video.folder);
  if (rec) {
    onStep(`属于剧集《${rec.title || rec.name}》，沿用文件夹标签`);
    return { ok: true, tags: rec.tags || [], title: rec.title };
  }

  // 番号内容：JAV 元数据站的类型/演员就是现成标签
  const code = normalizeJavCode(video.name);
  if (code) {
    onStep(`识别番号 ${code}，查询 JAV 元数据站…`);
    const meta = await javLookup(code, onStep);
    if (meta?.genres?.length || meta?.actress) {
      const tags = [...new Set([...(meta.actress ? [meta.actress] : []), ...(meta.genres || [])])].slice(0, 6);
      const patch = { id: video.id, tags };
      if (meta.title) patch.title = meta.title;
      db.upsertVideo(patch);
      onStep(`✓ 打标签成功：${tags.join('、')}${meta.title ? `（${meta.title}）` : ''}`);
      return { ok: true, tags, title: meta.title };
    }
    onStep('元数据站未命中（站点可能需要代理才能访问）→ 放入"无标签"');
    return { ok: false, note: 'JAV 元数据站未查到该番号' };
  }

  onStep('清洗文件名，确定搜索关键词…');
  const info = await cleanTitle(video.name);
  onStep('识别为：' + info.title + (info.year ? '（' + info.year + '）' : ''));
  return tagFromTitle(info, onStep);
}

/** 由规范作品名联网提取类型标签（豆瓣条目页 → 搜索摘要 → 模型归纳） */
async function tagFromTitle(info, onStep = () => {}) {
  const q = `${info.title} ${info.year || ''} 豆瓣`.trim();
  const hits = await bingPageResults(q, /douban\.com\/subject\/\d+/);
  let genres = [];
  let foundTitle = null;
  let rating = null;

  // 1) 抓豆瓣条目页（能拿到权威类型）
  for (const url of hits.slice(0, 2)) {
    try {
      const res = await fetchWithTimeout(url, 10000);
      if (!res.ok) continue;
      const html = await res.text();
      foundTitle = html.match(/<title[^>]*>([^<]+)[\s(（]/)?.[1]?.trim() || foundTitle;
      rating = html.match(/property="v:average">([\d.]+)</)?.[1] || rating;
      genres = [...html.matchAll(/property="v:genre">([^<]+)</g)].map(m => m[1].trim());
      if (genres.length) {
        onStep('豆瓣解析成功：' + genres.join('/'));
        break;
      }
    } catch { /* 下一个 */ }
  }

  // 2) 豆瓣拿不到 → 从搜索结果摘要里提取类型词
  if (genres.length === 0) {
    onStep('豆瓣条目不可用，改从搜索摘要提取类型…');
    const snippets = await bingSnippets(q);
    onStep('获得 ' + snippets.length + ' 条摘要');
    const text = snippets.join(' ');
    genres = GENRES.filter(g => text.includes(g));
    if (genres.length) onStep('摘要命中类型：' + genres.join('/'));
  }

  // 3) 交给文本模型从摘要中归纳（限定词表，避免瞎编）
  if (genres.length === 0) {
    onStep('尝试用模型从摘要归纳标签…');
    try {
      const snippets = await bingSnippets(q);
      if (snippets.length) {
        const resp = await ai.chatWithRetry([{
          role: 'user',
          content: `以下是影视作品《${info.title}》的搜索摘要：\n${snippets.join('\n').slice(0, 1500)}\n请从中提取 3-6 个简短中文标签（类型/题材，如 科幻、悬疑、太空、怪兽），必须出自摘要原文，不要编造。返回 JSON {"tags":[],"title":"作品规范名"}。摘要里没有可靠信息则返回 {"tags":[]}`,
        }], { temperature: 0.1 });
        const m = (ai.assistantMessage(resp)?.content || '').match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : '{}');
        if (Array.isArray(parsed.tags) && parsed.tags.length) {
          genres = parsed.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6);
          foundTitle = parsed.title || foundTitle;
          onStep('模型归纳出标签：' + genres.join('/'));
        } else {
          onStep('模型未从摘要中得到可靠标签');
        }
      }
    } catch { /* 模型不可用就算了 */ }
  }

  if (genres.length === 0) {
    return { ok: false, query: q, note: '网上未找到可靠的片源信息' };
  }
  const tags = [...new Set(genres)].slice(0, 6);
  return { ok: true, tags, title: foundTitle || info.title, rating, query: q };
}

/** 文件夹（含子目录）下的全部视频 */
function videosUnderDir(dir) {
  const p = String(dir).toLowerCase();
  const prefix = p.endsWith('\\') ? p : p + '\\';
  return db.allVideos().filter(v => {
    const f = String(v.folder).toLowerCase();
    return f === p || f.startsWith(prefix);
  });
}

/**
 * 连续剧/合集：以文件夹为单位打标签（整个文件夹只查一次元数据）。
 * 结果写入文件夹记录，同时应用到各集视频，方便标签页与搜索命中。
 */
async function seriesTagFor(dir, onStep = () => {}) {
  const name = path.basename(dir);
  const parent = path.basename(path.dirname(dir));
  const vids = videosUnderDir(dir);
  onStep(`以文件夹为单位打标签：《${name}》（${vids.length} 个视频）`);

  let tags = [];
  let title = null;
  const code = normalizeJavCode(name);
  if (code) {
    onStep(`文件夹名识别番号 ${code}，查询 JAV 元数据站…`);
    const meta = await javLookup(code, onStep);
    if (meta?.genres?.length || meta?.actress) {
      tags = [...new Set([...(meta.actress ? [meta.actress] : []), ...(meta.genres || [])])].slice(0, 6);
      title = meta.title || null;
    }
  }
  if (!tags.length && !title) {
    onStep('清洗文件夹名，确定搜索关键词…');
    const info = await cleanTitle(name, parent);
    if (!info.title) {
      onStep('无法从文件夹名识别剧集，取消');
      return { ok: false, note: '未能识别剧集信息' };
    }
    onStep(`识别为：${info.title}${info.year ? '（' + info.year + '）' : ''}`);
    const r = await tagFromTitle(info, onStep);
    if (!r.ok) return { ok: false, note: r.note };
    tags = r.tags;
    title = r.title || info.title;
  }

  // 注册为剧集文件夹，并把标签应用到各集
  db.upsertFolder({ path: dir, name, title: title || name, tags, series: true });
  for (const v of vids) {
    const patch = { id: v.id, tags };
    if (title && (!v.title || v.title === v.name)) patch.title = title;
    db.upsertVideo(patch);
  }
  onStep(`✓ 文件夹与 ${vids.length} 个视频已打标签：${tags.join('、')}${title ? `（${title}）` : ''}`);
  return { ok: true, tags, title, count: vids.length };
}

// 文件夹封面的存储名（由小写路径稳定生成）
function folderCoverId(dir) {
  return 'f' + require('crypto').createHash('md5').update(String(dir).toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * 连续剧/合集封面：文件夹查权威海报（番号站 → Bangumi → 豆瓣 → 首集截帧兜底），
 * 各集视频只做截帧封面（保证内容匹配，不再逐集联网查询）。
 */
async function seriesCoverFor(dir, captureFrame, onStep = () => {}) {
  fs.mkdirSync(db.coversDir(), { recursive: true });
  const name = path.basename(dir);
  const parent = path.basename(path.dirname(dir));
  const vids = videosUnderDir(dir);
  onStep(`以文件夹为单位下封面：《${name}》（${vids.length} 个视频）`);

  // 1) 文件夹海报
  const coverId = folderCoverId(dir);
  const tmp = path.join(db.coversDir(), `dl_${coverId}.img`);
  const applyFolderPoster = (from, extra = {}) => {
    const dest = path.join(db.coversDir(), coverId + '.jpg');
    fs.copyFileSync(tmp, dest);
    fs.rmSync(tmp, { force: true });
    db.upsertFolder({ path: dir, name, cover: dest, series: true, ...extra });
    onStep(`✓ 文件夹已采用${from}`);
    return true;
  };
  let done = false;

  const code = normalizeJavCode(name);
  if (code) {
    onStep(`文件夹名识别番号 ${code}，查询 JAV 元数据站…`);
    const meta = await javLookup(code, onStep);
    if (meta?.cover) {
      onStep('下载封面…');
      if (await downloadImage(meta.cover, tmp, {
        ratioMin: 0.9, ratioMax: 2.4, minW: 300, minH: 150,
        headers: { Referer: new URL(meta.cover).origin + '/', Cookie: 'age=verified; existed=1' },
      })) {
        applyFolderPoster('JAV 元数据站（' + meta.source + '）封面', meta.title ? { title: meta.title } : {});
        done = true;
      } else {
        onStep('封面下载/校验未通过');
      }
    } else {
      onStep('元数据站未命中');
    }
  }

  if (!done) {
    const info = await cleanTitle(name, parent);
    if (info.title) {
      onStep(`识别为：${info.title}${info.year ? '（' + info.year + '）' : ''}`);
      // Bangumi（动画剧集最准，开放 API 无需密钥）
      try {
        onStep('查询 Bangumi 条目…');
        const res = await fetch('https://api.bgm.tv/search/subject/' + encodeURIComponent(info.title) + '?type=2&responseGroup=small', {
          headers: { 'User-Agent': 'AgentVideoPlayer/0.1 (personal media organizer)', Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const data = await res.json();
          const subject = data.list?.[0];
          const img = subject?.images?.large || subject?.images?.common || subject?.images?.medium;
          if (img && await downloadImage(img, tmp)) {
            applyFolderPoster('Bangumi（' + (subject.name_cn || subject.name) + '）封面', { title: info.title });
            done = true;
          } else {
            onStep('Bangumi 未命中');
          }
        }
      } catch { onStep('Bangumi 查询失败'); }
      // 豆瓣条目页海报（og:image）
      if (!done) {
        try {
          onStep('查询豆瓣条目海报…');
          const hits = await bingPageResults(`${info.title} ${info.year || ''} 豆瓣`.trim(), /douban\.com\/subject\/\d+/);
          for (const url of hits.slice(0, 2)) {
            const res = await fetchWithTimeout(url, 10000);
            if (!res.ok) continue;
            const html = await res.text();
            const og = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1];
            if (og && await downloadImage(og, tmp)) {
              applyFolderPoster('豆瓣封面', { title: info.title });
              done = true;
              break;
            }
          }
          if (!done) onStep('豆瓣未命中');
        } catch { onStep('豆瓣查询失败'); }
      }
    } else {
      onStep('无法从文件夹名识别剧集，海报走截帧兜底');
    }
  }

  if (!done && vids.length) {
    onStep('未找到权威海报，用第一个视频截帧作为文件夹封面');
    try {
      const best = await bestFrame(vids[0], captureFrame, onStep);
      const dest = path.join(db.coversDir(), coverId + '.jpg');
      fs.writeFileSync(dest, Buffer.from(best.base64Jpeg, 'base64'));
      db.upsertFolder({ path: dir, name, cover: dest, series: true });
      onStep('✓ 文件夹封面已用截帧生成');
      done = true;
    } catch (e) {
      onStep('文件夹截帧兜底失败：' + e.message);
    }
  }
  fs.rmSync(tmp, { force: true });

  // 2) 各集视频：只截帧（内容匹配）
  for (let i = 0; i < vids.length; i++) {
    const v = vids[i];
    try {
      onStep(`[${i + 1}/${vids.length}] ${v.name}：截帧封面`);
      await frameCover(v, captureFrame, onStep);
    } catch (e) {
      onStep(`✗ ${v.name}：${e.message}`);
    }
  }
  return { ok: true, folderCover: done, count: vids.length };
}

/** 必应网页搜索，返回命中 pattern 的链接 */
async function bingPageResults(query, pattern) {
  try {
    const res = await fetchWithTimeout('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=15');
    const html = await res.text();
    const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1])
      .filter(u => pattern.test(u));
    return [...new Set(links)];
  } catch {
    return [];
  }
}

/** 必应搜索结果摘要文本 */
async function bingSnippets(query, n = 6) {
  try {
    const res = await fetchWithTimeout('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=10');
    const html = await res.text();
    const out = [];
    // 抓取结果标题与摘要
    for (const m of html.matchAll(/<h2[^>]*>[\s\S]*?<\/h2>/g)) {
      const t = m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t.length > 8) out.push(t);
      if (out.length >= n) break;
    }
    for (const m of html.matchAll(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/g)) {
      const t = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t.length > 20) out.push(t);
      if (out.length >= n + 4) break;
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = { coverFor, subtitleFor, cleanTitle, webTag, javLookup, normalizeJavCode, seriesTagFor, seriesCoverFor };
