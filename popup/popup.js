/**
 * popup.js - 확장 프로그램 팝업 UI 로직
 * 규칙 추가/삭제/미리보기/적용/내보내기/가져오기 기능을 제공합니다.
 */

const STORAGE_KEY = 'selectorRules';

// DOM 요소
const currentUrlEl = document.getElementById('currentUrl');
const urlPatternInput = document.getElementById('urlPattern');
const useCurrentUrlBtn = document.getElementById('useCurrentUrlBtn');
const selectorInput = document.getElementById('selectorInput');
const valueInput = document.getElementById('valueInput');
const addRuleBtn = document.getElementById('addRuleBtn');
const previewBtn = document.getElementById('previewBtn');
const applyAllBtn = document.getElementById('applyAllBtn');
const rulesListEl = document.getElementById('rulesList');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFileEl = document.getElementById('importFile');
const pickerToggleBtn = document.getElementById('pickerToggleBtn');
const pickerStatus = document.getElementById('pickerStatus');

let currentTabUrl = '';
let allRules = [];
let pickerEnabled = false;

// ==================== 초기화 ====================

async function init() {
  // 현재 탭 URL 가져오기
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) {
    currentTabUrl = tab.url;
    currentUrlEl.textContent = currentTabUrl;
    // URL 패턴도 현재 페이지의 origin + pathname을 기본값으로 설정
    try {
      const urlObj = new URL(currentTabUrl);
      urlPatternInput.value = urlObj.origin + urlObj.pathname;
    } catch (e) {
      urlPatternInput.value = currentTabUrl;
    }
  }

  // 저장된 규칙 불러오기
  await loadRules();
  renderRules();

  // 피커 모드 초기 상태 확인
  await checkPickerState();
}

async function loadRules() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  allRules = result[STORAGE_KEY] || [];
}

async function saveRules() {
  await chrome.storage.local.set({ [STORAGE_KEY]: allRules });
}

// ==================== 렌더링 ====================

function renderRules() {
  if (allRules.length === 0) {
    rulesListEl.innerHTML = '<div class="empty-state">아직 등록된 규칙이 없습니다.</div>';
    return;
  }

  rulesListEl.innerHTML = allRules.map((rule, index) => `
    <div class="rule-item">
      <div class="rule-info">
        <div class="rule-selector">${escapeHtml(rule.selector)}</div>
        <div class="rule-value">→ ${escapeHtml(String(rule.value))}</div>
        <div class="rule-url" title="${escapeHtml(rule.urlPattern || '')}">${escapeHtml(truncateUrl(rule.urlPattern))}</div>
      </div>
      <div class="rule-actions">
        <button class="btn-apply" data-action="apply" data-index="${index}" title="현재 탭에 적용">▶</button>
        <button class="btn-delete" data-action="delete" data-index="${index}" title="삭제">✕</button>
      </div>
    </div>
  `).join('');

  // 이벤트 위임
  rulesListEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', handleRuleAction);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncateUrl(url) {
  if (!url) return '* (전체)';
  if (url.length > 40) return url.substring(0, 40) + '...';
  return url;
}

// ==================== 이벤트 핸들러 ====================

// 현재 URL 버튼
useCurrentUrlBtn.addEventListener('click', () => {
  urlPatternInput.value = currentTabUrl;
});

// 규칙 추가
addRuleBtn.addEventListener('click', async () => {
  const selector = selectorInput.value.trim();
  const value = valueInput.value;
  const urlPattern = urlPatternInput.value.trim();

  if (!selector) {
    alert('CSS 셀렉터를 입력해주세요.');
    return;
  }

  const newRule = {
    id: Date.now().toString(),
    selector,
    value,
    urlPattern: urlPattern || '*',
    createdAt: new Date().toISOString(),
  };

  allRules.push(newRule);
  await saveRules();
  renderRules();

  // 현재 탭에 즉시 적용
  await applyToCurrentTab();

  // 입력 필드 초기화 (URL 패턴은 유지)
  selectorInput.value = '';
  valueInput.value = '';
  selectorInput.focus();
});

// Enter 키로 추가
valueInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addRuleBtn.click();
  }
});

selectorInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    valueInput.focus();
  }
});

// 미리보기 버튼
previewBtn.addEventListener('click', async () => {
  const selector = selectorInput.value.trim();
  const value = valueInput.value;

  if (!selector) {
    alert('CSS 셀렉터를 입력해주세요.');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: 'previewRule',
      rule: { selector, value: value || '' },
    });
  } catch (e) {
    console.warn('Preview failed:', e);
  }
});

// 입력값 변경 시 미리보기 버튼 활성화
[selectorInput, valueInput].forEach((input) => {
  input.addEventListener('input', () => {
    previewBtn.disabled = !selectorInput.value.trim();
  });
});

// 모두 적용 버튼
applyAllBtn.addEventListener('click', async () => {
  await applyToCurrentTab();
});

// 규칙 아이템 액션 (이벤트 위임)
async function handleRuleAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const index = parseInt(btn.dataset.index, 10);

  if (action === 'delete') {
    allRules.splice(index, 1);
    await saveRules();
    renderRules();
  }

  if (action === 'apply') {
    const rule = allRules[index];
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'previewRule',
        rule,
      });
    } catch (e) {
      console.warn('Apply single rule failed:', e);
    }
  }
}

// ==================== 탭에 규칙 적용 ====================

async function applyToCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'applyRules' });
  } catch (e) {
    // content script가 아직 로드되지 않은 경우, 스크립트 주입
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
      // 잠시 후 다시 시도
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'applyRules' });
        } catch (err) {
          console.warn('Retry apply failed:', err);
        }
      }, 300);
    } catch (err) {
      console.warn('Script injection failed (possibly a restricted page):', err);
    }
  }
}

// ==================== 내보내기 / 가져오기 ====================

exportBtn.addEventListener('click', () => {
  const data = JSON.stringify(allRules, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `faker-rules-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  URL.revokeObjectURL(url);
});

importBtn.addEventListener('click', () => {
  importFileEl.click();
});

importFileEl.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const imported = JSON.parse(text);

    if (!Array.isArray(imported)) {
      throw new Error('유효하지 않은 형식입니다. JSON 배열이어야 합니다.');
    }

    // 기존 규칙에 병합 (중복 id 제외)
    const existingIds = new Set(allRules.map((r) => r.id));
    const newRules = imported.filter((r) => !existingIds.has(r.id));

    allRules = [...allRules, ...newRules];
    await saveRules();
    renderRules();

    alert(`${newRules.length}개의 규칙을 가져왔습니다.`);
  } catch (err) {
    alert('가져오기 실패: ' + err.message);
  }

  // 파일 입력 초기화
  importFileEl.value = '';
});

// ==================== 셀렉터 피커 토글 ====================

pickerToggleBtn.addEventListener('click', async () => {
  pickerEnabled = !pickerEnabled;
  updatePickerUI();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: 'togglePicker',
      enabled: pickerEnabled,
    });
  } catch (e) {
    // content script가 없으면 주입 후 다시 시도
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            action: 'togglePicker',
            enabled: pickerEnabled,
          });
        } catch (err) { /* ignore */ }
      }, 300);
    } catch (err) { /* restricted page */ }
  }
});

function updatePickerUI() {
  if (pickerEnabled) {
    pickerToggleBtn.classList.add('active');
    pickerStatus.textContent = '켜짐';
  } else {
    pickerToggleBtn.classList.remove('active');
    pickerStatus.textContent = '꺼짐';
  }
}

async function checkPickerState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPickerState' });
    pickerEnabled = response?.active || false;
    updatePickerUI();
  } catch (e) { /* ignore */ }
}

// content script에서 셀렉터 사용 요청 수신
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.action === 'useSelector' && message.selector) {
    selectorInput.value = message.selector;
    valueInput.focus();
  }
});

// ==================== 시작 ====================
init();
