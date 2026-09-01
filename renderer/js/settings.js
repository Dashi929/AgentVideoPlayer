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
}
