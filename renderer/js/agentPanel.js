import { toast } from './app.js';
import { icon } from './icons.js';

const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

let history = []; // {role, content} 文本摘要，用于多轮对话
let jobs = [];    // AI 队列快照

const OP_NAMES = { tag: '打标签', organize: '整理', cover: '封面', subtitle: '字幕' };
const STATUS_TEXT = {
  pending: '排队中', running: '处理中', cancelling: '等待撤销',
  done: '已完成', cancelled: '已撤销', failed: '失败',
};

export function initAgent() {
  // 队列面板
  const panel = document.createElement('div');
  panel.id = 'queuePanel';
  chatLog.appendChild(panel);
  window.api.onQueueUpdate?.((list) => {
    jobs = list || [];
    renderQueue();
    // 任务完成可能改动了标签/封面，刷新片库
    if (jobs.some(j => j.status === 'done' || j.status === 'cancelled')) {
      import('./library.js').then(m => m.refreshLibrary());
      import('./pages.js').then(m => m.refreshPages());
    }
  });

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';

    addMsg('user', text);
    const loading = addMsg('ai', '思考中…');

    try {
      const res = await window.api.runAgent(text, history);
      loading.remove();
      for (const step of res.steps || []) addStep(step);
      addMsg('ai', res.finalText || '(完成)');
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: res.finalText || '' });
      if (history.length > 20) history = history.slice(-20);
    } catch (err) {
      loading.remove();
      addMsg('ai', '出错了: ' + err.message);
    }
  });

  // 保存设置时若无 Key 给提示（在 AI 面板给入口）
  const tip = document.createElement('div');
  tip.className = 'msg ai';
  tip.textContent = '你好！我是片库 AI 助手。可以先到「设置」页配置 OpenAI 兼容 API，然后告诉我，比如：\n· 给没有标签的视频打上标签\n· 把视频按类型整理到子文件夹\n· 给所有视频换个更好看的封面';
  chatLog.appendChild(tip);
}

function renderQueue() {
  const panel = document.getElementById('queuePanel');
  if (!panel) return;
  panel.innerHTML = `<h3>AI 任务队列</h3>`;
  if (jobs.length === 0) {
    panel.innerHTML += `<div class="queue-empty">队列为空。在片库选中视频后选择 AI 功能，任务会加入这里逐个处理。</div>`;
    return;
  }
  for (const j of jobs) {
    const row = document.createElement('div');
    row.className = 'queue-item ' + j.status;
    const progress = j.status === 'running'
      ? `${j.i}/${j.total} · ${j.name}`
      : `${j.total} 个视频`;
    const canRemove = j.status !== 'cancelled' && j.status !== 'done';
    const logs = j.logs || [];
    row.innerHTML = `
      <div class="q-main">
        <span class="q-op">${OP_NAMES[j.op] || j.op}</span>
        <span class="q-status s-${j.status}">${STATUS_TEXT[j.status] || j.status}</span>
        <span class="q-prog">${progress}</span>
        ${j.error ? `<span class="q-err">${j.error}</span>` : ''}
      </div>
      ${logs.length ? `<button class="q-toggle" title="详细过程">${icon('chevron', 14)}</button>` : ''}
      ${canRemove ? '<button class="q-del" title="删除任务">✕</button>' : ''}`;
    row.querySelector('.q-del')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.queueRemove(j.id);
    });
    // 详细过程折叠区
    if (logs.length) {
      const wrap = document.createElement('details');
      wrap.className = 'q-details';
      if (j.status === 'running') wrap.open = true; // 处理中自动展开
      const pre = document.createElement('pre');
      pre.className = 'q-logs';
      pre.textContent = logs.join('\n');
      wrap.appendChild(pre);
      row.appendChild(wrap);
      row.querySelector('.q-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        wrap.open = !wrap.open;
      });
    }
    panel.appendChild(row);
  }
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function addStep(step) {
  const div = document.createElement('div');
  div.className = 'step' + (step.type === 'error' ? ' err' : '');
  switch (step.type) {
    case 'analysis':
      div.innerHTML = `🔍 分析 <span class="vid"></span>：<br>标签: ${(step.tags || []).join('、')}<br>标题: ${step.title || '-'}<br>简介: ${step.summary || '-'}`;
      div.querySelector('.vid').textContent = step.videoName || '';
      break;
    case 'tagged':
      div.innerHTML = `🏷 已给 <span class="vid"></span> 打标签: ${(step.tags || []).join('、')}`;
      div.querySelector('.vid').textContent = step.videoName || '';
      break;
    case 'renamed':
    case 'moved':
      div.textContent = '📁 ' + step.text;
      break;
    case 'cover':
      div.textContent = '🖼 已设置封面';
      break;
    case 'error':
      div.textContent = '✗ ' + step.text;
      break;
    case 'thinking': {
      // 模型思考过程（reasoning_content）
      const det = document.createElement('details');
      det.className = 'thinking';
      det.innerHTML = `<summary>💭 思考过程</summary><pre class="thinking-body"></pre>`;
      det.querySelector('.thinking-body').textContent = step.text;
      div.replaceWith(det);
      det.scrollIntoView({ block: 'end' });
      return;
    }
    case 'toolcall':
      div.innerHTML = `🔧 调用工具 <code class="tool-name"></code>`;
      div.querySelector('.tool-name').textContent = step.text;
      break;
    default:
      div.textContent = '· ' + (step.text || step.type);
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
