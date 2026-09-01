const path = require('path');
const fs = require('fs');
const db = require('./db');
const ai = require('./ai');
const media = require('./media');
const files = require('./files');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_videos',
      description: '列出片库中的视频（id、文件名、路径、已有标签）。可按 keyword 过滤。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '按文件名/标题/标签模糊过滤，可省略' },
          untagged_only: { type: 'boolean', description: '只列出还没有标签的视频' },
          limit: { type: 'integer', description: '最多返回数量，默认 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tag_video_online',
      description: '联网搜索片源信息（豆瓣等）为视频打标签并设置标题。找不到可靠信息时视频会进入"无标签"。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '视频 id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tag_video',
      description: '给视频设置标签数组和标题（整体替换）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          title: { type: 'string', description: '新的显示标题，可省略' },
        },
        required: ['id', 'tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_video',
      description: '给视频设置一个更清晰的显示名（虚拟重命名，不会修改真实文件，仅保存在本地）。保留原扩展名的含义，new_name 不含扩展名。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, new_name: { type: 'string', description: '不含扩展名' } },
        required: ['id', 'new_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'organize_video',
      description: '给视频分配一个分类（虚拟整理，不会移动真实文件，分类会记录并显示在片库标签中）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', description: '分类名，通常用主标签' },
        },
        required: ['id', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_cover',
      description: '截取视频指定时间点的帧并设置为封面。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          time: { type: 'number', description: '截帧时间（秒），默认视频 25% 处' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rescan_folder',
      description: '重新扫描片库文件夹，同步新增/删除的视频。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const SYSTEM_PROMPT = `你是 AgentVideoPlayer 的 AI Agent，帮助用户管理和整理本地视频片库。
你可以调用工具列出视频、联网搜索片源信息打标签、打标签、重命名、分类、设置封面。
规则：
- 打标签使用 tag_video_online（联网搜索片源信息，不分析画面）；网上找不到的视频会进入"无标签"。
- 用户让你"整理"时：对未打标签的视频调用 tag_video_online，再按主标签调用 organize_video 分类。
- 重命名建议格式如 "2024-日本旅行-vlog"，去掉无意义的乱码文件名。这些都是虚拟操作，真实文件不会被改动。
- 每一步操作后向用户简要汇报做了什么。批量操作时逐个处理，不要一次说一大堆没做的计划。
- 工具报错时告知用户原因，不要假装成功。`;

/**
 * frameProvider: async ({videoPath, times}) => [{time, base64Jpeg}]
 * 由渲染层用隐藏 video+canvas 实现（无 ffmpeg 时也能工作）。
 */
function makeFrameProvider(sendToRenderer) {
  return async function getFrames(videoPath, times) {
    // 优先 ffmpeg
    const outDir = media.tempFramesDir();
    const ffmpegFrames = await media.extractFrames(videoPath, times, outDir, path.basename(videoPath, path.extname(videoPath)));
    if (ffmpegFrames.length > 0) {
      return ffmpegFrames.map(f => ({ base64Jpeg: fs.readFileSync(f).toString('base64'), time: 0 }));
    }
    // 回退：让渲染层截帧
    try {
      return await sendToRenderer('capture-frames', { videoPath, times });
    } catch (e) {
      console.error('renderer frame capture failed', e);
      return [];
    }
  };
}

async function runAgent(userMessage, history, sendToRenderer, rescan) {
  const getFrames = makeFrameProvider(sendToRenderer);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const steps = []; // 给前端展示的执行记录
  const emit = (step) => { steps.push(step); return step; };

  for (let round = 0; round < 25; round++) {
    const resp = await ai.chatWithRetry(messages, { tools: TOOLS, temperature: 0.3 });
    const msg = ai.assistantMessage(resp);
    // 展示模型的思考过程（DeepSeek-R1 等推理模型返回 reasoning_content）
    if (msg?.reasoning_content) {
      emit({ type: 'thinking', text: String(msg.reasoning_content) });
    }
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { finalText: msg.content || '(无回复)', steps };
    }

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      // 详细展示每次工具调用及参数
      emit({ type: 'toolcall', text: `${name}(${JSON.stringify(args)})` });
      let result;
      try {
        result = await execTool(name, args, { getFrames, emit, rescan });
      } catch (e) {
        result = { error: e.message };
        emit({ type: 'error', text: `${name} 失败: ${e.message}` });
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 20000) });
    }
  }
  return { finalText: '(达到最大轮次，已停止)', steps };
}

async function execTool(name, args, { getFrames, emit, rescan }) {
  switch (name) {
    case 'list_videos': {
      let list = db.allVideos().map(v => ({ id: v.id, name: v.name, path: v.path, tags: v.tags, title: v.title }));
      if (args.untagged_only) list = list.filter(v => !v.tags || v.tags.length === 0);
      if (args.keyword) {
        const k = args.keyword.toLowerCase();
        list = list.filter(v =>
          v.name.toLowerCase().includes(k) ||
          (v.title || '').toLowerCase().includes(k) ||
          (v.tags || []).some(t => t.toLowerCase().includes(k)));
      }
      list = list.slice(0, args.limit || 50);
      emit({ type: 'tool', text: `列出 ${list.length} 个视频` });
      return list;
    }
    case 'tag_video_online': {
      const v = db.getVideo(args.id);
      if (!v) throw new Error('视频不存在');
      const media = require('./aiMedia');
      const r = await media.webTag(v);
      if (r.ok) {
        db.upsertVideo({ id: v.id, tags: r.tags, title: r.title || v.title });
        emit({ type: 'tagged', videoId: v.id, videoName: v.name, tags: r.tags, title: r.title });
        return r;
      }
      db.upsertVideo({ id: v.id, tags: [] });
      emit({ type: 'tool', text: `${v.name}：网上未找到片源信息，已放入"无标签"` });
      return { ok: false, note: r.note };
    }
    case 'tag_video': {
      const v = db.getVideo(args.id);
      if (!v) throw new Error('视频不存在');
      const tags = (args.tags || []).map(t => String(t).trim()).filter(Boolean).slice(0, 10);
      const patch = { id: v.id, tags };
      if (args.title) patch.title = String(args.title);
      db.upsertVideo(patch);
      emit({ type: 'tagged', videoId: v.id, videoName: v.name, tags, title: patch.title });
      return { ok: true, tags };
    }
    case 'rename_video': {
      const r = files.renameVideo(args.id, args.new_name);
      emit({ type: 'renamed', text: `显示名 → ${r.displayName}（未改动真实文件）` });
      return r;
    }
    case 'organize_video': {
      const r = files.organizeVideo(args.id, args.category);
      emit({ type: 'moved', text: `分类「${r.category}」（未移动真实文件）` });
      return r;
    }
    case 'set_cover': {
      const v = db.getVideo(args.id);
      if (!v) throw new Error('视频不存在');
      const dur = v.duration || 60;
      const t = args.time != null ? args.time : dur * 0.25;
      const frames = await getFrames(v.path, [+t.toFixed(1)]);
      if (frames.length === 0) throw new Error('截帧失败');
      const r = files.setCover(v.id, Buffer.from(frames[0].base64Jpeg, 'base64'));
      emit({ type: 'cover', videoId: v.id, cover: r.cover });
      return r;
    }
    case 'rescan_folder': {
      emit({ type: 'tool', text: '重新扫描片库' });
      const r = rescan ? rescan() : { note: '无扫描目录' };
      return r;
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

/** 独立截帧入口：供 AI 封面等模块使用（sendToRenderer 为 main 提供的回退通道） */
function captureFrames(videoPath, times, sendToRenderer) {
  return makeFrameProvider(sendToRenderer)(videoPath, times);
}

module.exports = { runAgent, TOOLS, captureFrames };
