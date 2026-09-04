import { toast } from './app.js';

export function initSettings() {
  const apiBase = document.getElementById('setApiBase');
  const apiKey = document.getElementById('setApiKey');
  const chatModel = document.getElementById('setChatModel');
  const visionModel = document.getElementById('setVisionModel');
  const testResult = document.getElementById('testResult');

  window.api.getSettings().then(s => {
    apiBase.value = s.apiBase || '';
    apiKey.value = s.apiKey || '';
    chatModel.value = s.chatModel || '';
    visionModel.value = s.visionModel || '';
  });

  document.getElementById('saveSettings').addEventListener('click', async () => {
    await window.api.updateSettings({
      apiBase: apiBase.value.trim(),
      apiKey: apiKey.value.trim(),
      chatModel: chatModel.value.trim(),
      visionModel: visionModel.value.trim(),
    });
    testResult.textContent = '✓ 已保存';
    testResult.className = 'ok';
  });

  document.getElementById('testAiBtn').addEventListener('click', async () => {
    // 先保存再测试
    await window.api.updateSettings({
      apiBase: apiBase.value.trim(),
      apiKey: apiKey.value.trim(),
      chatModel: chatModel.value.trim(),
      visionModel: visionModel.value.trim(),
    });
    testResult.textContent = '测试中…';
    testResult.className = '';
    const r = await window.api.testAi();
    if (r.ok) {
      testResult.textContent = `✓ 连接成功（模型回复: ${r.reply}）`;
      testResult.className = 'ok';
    } else {
      testResult.textContent = `✗ ${r.error}`;
      testResult.className = 'err';
    }
  });

  // ---- 系统文件关联（Windows）----
  const assocTitle = document.getElementById('assocTitle');
  const assocForm = document.getElementById('assocForm');
  const assocStatus = document.getElementById('assocStatus');

  async function refreshAssoc() {
    let st;
    try { st = await window.api.assocStatus(); } catch { return; }
    if (!st || !st.supported) {
      assocTitle.classList.add('hidden');
      assocForm.classList.add('hidden');
      return;
    }
    assocStatus.className = '';
    if (st.state === 'registered') { assocStatus.textContent = '✓ 已注册'; assocStatus.className = 'ok'; }
    else if (st.state === 'stale') { assocStatus.textContent = '⚠ 程序位置已变化，请重新注册'; assocStatus.className = 'err'; }
    else assocStatus.textContent = '未注册';
  }

  document.getElementById('assocRegisterBtn').addEventListener('click', async () => {
    assocStatus.textContent = '注册中…';
    assocStatus.className = '';
    const r = await window.api.assocRegister();
    if (r.ok) {
      toast('已注册。在资源管理器右键视频 →「打开方式」选 AgentVideoPlayer 并勾选「始终」，即可设为默认播放器', 6000);
    } else {
      assocStatus.textContent = '✗ ' + (r.error || '注册失败');
      assocStatus.className = 'err';
    }
    refreshAssoc();
  });
  document.getElementById('assocRemoveBtn').addEventListener('click', async () => {
    await window.api.assocUnregister();
    refreshAssoc();
  });
  refreshAssoc();
}
