const db = require('./db');

/**
 * OpenAI 兼容客户端：POST {base}/chat/completions
 * 支持纯文本与多模态（image_url/base64）消息。
 */
function endpoint(base) {
  return base.replace(/\/+$/, '') + '/chat/completions';
}

async function chat(messages, { model, temperature = 0.3, tools, responseFormat } = {}) {
  const s = db.getSettings();
  if (!s.apiBase || !s.apiKey) throw new Error('未配置 AI API，请先到设置页填写 API 地址和 Key');
  const body = { model: model || s.chatModel || s.visionModel || 'gpt-4o-mini', messages, temperature };
  if (tools) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;
  const res = await fetch(endpoint(s.apiBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API 请求失败 ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

function assistantMessage(resp) {
  return resp.choices?.[0]?.message || null;
}

/** 简单重试（网络抖动） */
async function chatWithRetry(messages, opts = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await chat(messages, opts);
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

module.exports = { chat, chatWithRetry, assistantMessage };
