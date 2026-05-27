/**
 * content.js - 페이지에 주입되어 저장된 selector-value 규칙을 DOM에 적용합니다.
 *
 * [핵심 기능]
 * 1. 저장된 규칙 자동 적용 (새로고침 후에도 유지)
 * 2. 셀렉터 피커 모드: 좌클릭으로 요소 선택 → CSS/XPath 후보 표시 → 복사/값 덮어쓰기
 * 3. MutationObserver로 SPA 동적 DOM 변경 대응
 */

const STORAGE_KEY = 'selectorRules';
const APPLIED_ATTR = 'data-faker-applied';
const PANEL_ID = '__faker_panel__';

// 로컬 캐시: storage.onChanged 로 동기화되어 항상 최신 상태 유지
let cachedRules = [];

// ==================== 1. 규칙 적용 ====================

/**
 * URL을 정규화하여 매칭에 사용합니다.
 * - trailing slash 제거
 * - hash 제거
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // pathname의 trailing slash 제거 (단, 루트 '/'는 유지)
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return u.origin + path;
  } catch (e) {
    // URL 파싱 실패 시 원본에서 hash만 제거
    return url.replace(/#.*$/, '').replace(/\/$/, '');
  }
}

/**
 * URL 패턴이 현재 URL과 매칭되는지 확인합니다.
 * - '*' 는 전체 매칭
 * - 패턴도 정규화 후 비교
 * - 내부 와일드카드 '*' 지원
 */
function urlMatches(pattern, currentUrl) {
  if (!pattern) return false;
  if (pattern === '*') return true;

  const normalizedPattern = normalizeUrl(pattern);
  const normalizedCurrent = normalizeUrl(currentUrl);

  // 와일드카드를 정규식으로 변환
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(normalizedCurrent);
}

/**
 * storage에서 규칙을 읽어옵니다. (promise + callback 폴백 + 재시도)
 */
async function fetchRulesFromStorage(retryCount = 0) {
  const MAX_RETRIES = 3;
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Faker] Storage read error:', chrome.runtime.lastError);
        if (retryCount < MAX_RETRIES) {
          setTimeout(() => resolve(fetchRulesFromStorage(retryCount + 1)), 500);
          return;
        }
        resolve(cachedRules);
        return;
      }
      const rules = result[STORAGE_KEY];
      if (Array.isArray(rules)) {
        cachedRules = rules;
        console.log(`[Faker] Loaded ${rules.length} rule(s) from storage`);
        resolve(rules);
      } else {
        // 첫 시도에서 빈 결과면 한 번 더 재시도
        if (retryCount === 0 && (!rules || rules.length === 0)) {
          setTimeout(() => resolve(fetchRulesFromStorage(retryCount + 1)), 400);
          return;
        }
        resolve(cachedRules);
      }
    });
  });
}

async function getMatchingRules() {
  const allRules = await fetchRulesFromStorage();
  if (!allRules || !Array.isArray(allRules) || allRules.length === 0) return [];

  const currentUrl = window.location.href;
  return allRules.filter((rule) => urlMatches(rule.urlPattern, currentUrl));
}

function applyRule(rule) {
  if (!rule.selector || rule.value === undefined) return;
  try {
    const elements = document.querySelectorAll(rule.selector);
    elements.forEach((el) => applyValueToElement(el, rule.value));
  } catch (e) {
    console.warn(`[Faker] Invalid selector "${rule.selector}":`, e.message);
  }
}

function applyValueToElement(element, value) {
  const tagName = element.tagName.toLowerCase();
  const isContentEditable = element.isContentEditable;
  if (tagName === 'input') {
    if (element.type === 'checkbox' || element.type === 'radio') {
      element.checked = Boolean(value);
    } else {
      element.value = value;
    }
  } else if (tagName === 'textarea' || tagName === 'select') {
    element.value = value;
  } else if (isContentEditable) {
    element.textContent = value;
  } else {
    element.textContent = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.setAttribute(APPLIED_ATTR, 'true');
}

async function applyAllRules() {
  const rules = await getMatchingRules();
  if (rules.length === 0) return;
  console.log(`[Faker] Applying ${rules.length} rule(s) to ${window.location.href}`);
  for (const rule of rules) {
    applyRule(rule);
  }
}

// storage 변경 감지 → 로컬 캐시 즉시 갱신 + 규칙 재적용
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEY]) {
    const newRules = changes[STORAGE_KEY].newValue;
    if (Array.isArray(newRules)) {
      cachedRules = newRules;
      console.log('[Faker] Storage changed, re-applying rules...');
      applyAllRules();
    }
  }
});

// ==================== 2. MutationObserver ====================

let observer = null;
function startObserver() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) { hasNewNodes = true; break; }
    }
    if (hasNewNodes) applyAllRules();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

// ==================== 3. 셀렉터 생성 엔진 ====================

/**
 * 주어진 엘리먼트에 대해 안정적인 셀렉터 후보 목록을 생성합니다.
 * CSS 셀렉터와 XPath를 모두 제공하며, 고유성과 안정성 기준으로 정렬됩니다.
 */
function generateSelectorCandidates(el) {
  const candidates = [];

  // --- CSS Selectors ---

  // 1) ID 기반 (가장 안정적)
  if (el.id && /^[a-zA-Z_][\w\-]*$/.test(el.id)) {
    const sel = `#${CSS.escape(el.id)}`;
    candidates.push({ type: 'CSS', selector: sel, strategy: 'ID', score: scoreSelector(sel) });
  }

  // 2) data-testid / data-cy / data-test / aria-label (테스트 속성)
  for (const attr of ['data-testid', 'data-cy', 'data-test', 'data-test-id', 'aria-label']) {
    const val = el.getAttribute(attr);
    if (val && val.length < 80) {
      const sel = `[${attr}="${val.replace(/"/g, '\\"')}"]`;
      candidates.push({ type: 'CSS', selector: sel, strategy: attr, score: scoreSelector(sel) });
    }
  }

  // 3) name 속성 (input, select, textarea 등 폼 요소)
  if (el.name && el.name.length < 50) {
    const tag = el.tagName.toLowerCase();
    const sel = `${tag}[name="${el.name.replace(/"/g, '\\"')}"]`;
    candidates.push({ type: 'CSS', selector: sel, strategy: 'name', score: scoreSelector(sel) });
  }

  // 4) 고유 클래스 조합
  const classes = Array.from(el.classList).filter((c) => c.length > 0 && c.length < 40);
  if (classes.length > 0) {
    for (let i = classes.length; i >= 1; i--) {
      const subset = classes.slice(0, i);
      const sel = `${el.tagName.toLowerCase()}.${subset.map((c) => CSS.escape(c)).join('.')}`;
      candidates.push({ type: 'CSS', selector: sel, strategy: 'class', score: scoreSelector(sel) });
    }
  }

  // 5) nth-child 경로
  const nthPath = buildNthChildPath(el);
  if (nthPath) {
    candidates.push({ type: 'CSS', selector: nthPath, strategy: 'nth-child', score: scoreSelector(nthPath) });
  }

  // 6) 속성 조합 (href, placeholder, type, role, title, alt)
  for (const attr of ['href', 'placeholder', 'type', 'role', 'title', 'alt']) {
    const val = el.getAttribute(attr);
    if (val && val.length < 100) {
      const tag = el.tagName.toLowerCase();
      const sel = `${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`;
      candidates.push({ type: 'CSS', selector: sel, strategy: attr, score: scoreSelector(sel) });
    }
  }

  // --- XPath Selectors ---

  // 7) XPath: ID 기반
  if (el.id) {
    const xpath = `//*[@id="${el.id}"]`;
    candidates.push({ type: 'XPath', selector: xpath, strategy: 'XPath ID', score: scoreXPath(xpath) });
  }

  // 8) XPath: 속성 기반
  for (const attr of ['data-testid', 'data-cy', 'name', 'aria-label']) {
    const val = el.getAttribute(attr);
    if (val && val.length < 80) {
      const tag = el.tagName.toLowerCase();
      const xpath = `//${tag}[@${attr}="${val}"]`;
      candidates.push({ type: 'XPath', selector: xpath, strategy: `XPath @${attr}`, score: scoreXPath(xpath) });
    }
  }

  // 9) XPath: 절대 경로
  const absXPath = buildAbsoluteXPath(el);
  if (absXPath) {
    candidates.push({ type: 'XPath', selector: absXPath, strategy: 'XPath absolute', score: scoreXPath(absXPath) });
  }

  // 중복 제거 및 점수 순 정렬
  const seen = new Set();
  const unique = candidates.filter((c) => {
    const key = `${c.type}:${c.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.score - a.score);

  return unique;
}

function scoreSelector(sel) {
  let score = 0;
  try {
    const count = document.querySelectorAll(sel).length;
    if (count === 1) score += 100;
    else if (count <= 3) score += 40;
    else if (count <= 10) score += 10;
    score += Math.max(0, 50 - sel.length);
    if (sel.startsWith('#')) score += 30;
    if (/\[data-/.test(sel)) score += 25;
    if (/\[name=/.test(sel)) score += 10;
  } catch (e) { /* ignore */ }
  return score;
}

function scoreXPath(xpath) {
  let score = 0;
  try {
    const result = document.evaluate(
      xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    if (result.snapshotLength === 1) score += 95;
    else if (result.snapshotLength <= 3) score += 35;
    else if (result.snapshotLength <= 10) score += 8;
    score += Math.max(0, 40 - xpath.length);
    if (xpath.includes('@id')) score += 30;
    if (xpath.includes('@data-')) score += 25;
  } catch (e) { /* ignore */ }
  return score;
}

function buildNthChildPath(el) {
  const parts = [];
  let current = el;
  while (current && current !== document.body && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) break;
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    if (parent.id && /^[a-zA-Z_][\w\-]*$/.test(parent.id)) {
      parts.unshift(`#${CSS.escape(parent.id)}`);
      break;
    }
    const testId = parent.getAttribute('data-testid') || parent.getAttribute('data-cy');
    if (testId) {
      parts.unshift(`[data-testid="${testId}"]`);
      break;
    }
    current = parent;
  }
  return parts.length > 0 ? parts.join(' > ') : null;
}

function buildAbsoluteXPath(el) {
  const parts = [];
  let current = el;
  while (current && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) break;
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${tag}[${index}]`);
    if (current.id) {
      return `//*[@id="${current.id}"]` + (parts.length > 1 ? '/' + parts.slice(1).join('/') : '');
    }
    current = parent;
  }
  return '/' + parts.join('/');
}

// ==================== 4. 플로팅 패널 UI ====================

let pickerActive = false;
let selectedElement = null;

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function createPanel() {
  if (document.getElementById(PANEL_ID)) return;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="__faker_header">
      <span class="__faker_title">🎭 Selector Picker</span>
      <div class="__faker_header_actions">
        <span class="__faker_tag"></span>
        <button class="__faker_close" id="__faker_close_btn">✕</button>
      </div>
    </div>
    <div class="__faker_value_row">
      <input type="text" id="__faker_value_input" placeholder="덮어쓸 값을 입력하세요..." />
      <button id="__faker_apply_btn" class="__faker_btn_primary">적용</button>
    </div>
    <div class="__faker_section_label">📋 셀렉터 후보 (클릭 → 복사)</div>
    <div class="__faker_candidates" id="__faker_candidates"></div>
    <div class="__faker_actions">
      <button id="__faker_add_rule_btn" class="__faker_btn_primary" style="width:100%">📌 현재 값으로 규칙 저장</button>
    </div>
  `;
  document.body.appendChild(panel);
  bindPanelEvents(panel);
  return panel;
}

function bindPanelEvents(panel) {
  panel.querySelector('#__faker_close_btn').addEventListener('click', closePanel);

  panel.querySelector('#__faker_apply_btn').addEventListener('click', () => {
    const val = panel.querySelector('#__faker_value_input').value;
    if (selectedElement) applyValueToElement(selectedElement, val);
  });

  panel.querySelector('#__faker_add_rule_btn').addEventListener('click', async () => {
    const val = panel.querySelector('#__faker_value_input').value;
    const bestBtn = panel.querySelector('.__faker_candidate_item.__faker_best');
    const selector = bestBtn?.dataset?.selector || '';
    if (!selectedElement || !selector) return;

    const currentUrl = window.location.href;
    const newRule = {
      id: Date.now().toString(),
      selector,
      value: val,
      urlPattern: currentUrl,
      createdAt: new Date().toISOString(),
    };

    const { [STORAGE_KEY]: allRules } = await chrome.storage.local.get(STORAGE_KEY);
    const rules = allRules || [];
    rules.push(newRule);
    await chrome.storage.local.set({ [STORAGE_KEY]: rules });

    try {
      await chrome.runtime.sendMessage({ action: 'ruleAdded', rule: newRule });
    } catch (e) { /* popup may not be open */ }

    closePanel();
  });

  makeDraggable(panel);
}

function makeDraggable(panel) {
  const header = panel.querySelector('.__faker_header');
  let offsetX = 0, offsetY = 0, dragging = false;

  header.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    offsetX = e.clientX - panel.offsetLeft;
    offsetY = e.clientY - panel.offsetTop;
    panel.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = (e.clientX - offsetX) + 'px';
    panel.style.top = (e.clientY - offsetY) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
    if (panel) panel.style.cursor = '';
  });
}

async function openPanel(el) {
  selectedElement = el;
  const panel = createPanel();
  if (!panel) return;

  const rect = el.getBoundingClientRect();
  const panelW = 340;
  let left = rect.right + 12;
  let top = rect.top;
  if (left + panelW > window.innerWidth - 10) {
    left = rect.left - panelW - 12;
  }
  if (left < 10) left = 10;
  if (top + 400 > window.innerHeight) {
    top = window.innerHeight - 420;
  }
  if (top < 10) top = 10;

  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  panel.classList.add('__faker_visible');

  const tagSpan = panel.querySelector('.__faker_tag');
  if (tagSpan) tagSpan.textContent = el.tagName.toLowerCase();

  const currentVal = getCurrentValue(el);
  panel.querySelector('#__faker_value_input').value = currentVal;

  const candidates = generateSelectorCandidates(el);
  renderCandidates(panel, candidates);
}

function getCurrentValue(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked);
    return el.value;
  }
  if (tag === 'textarea' || tag === 'select') return el.value;
  if (el.isContentEditable) return el.textContent || '';
  return el.textContent || '';
}

function renderCandidates(panel, candidates) {
  const container = panel.querySelector('#__faker_candidates');
  if (!container) return;

  const bestScore = candidates.length > 0 ? candidates[0].score : 0;

  container.innerHTML = candidates.map((c, i) => {
    const isBest = c.score === bestScore;
    const badge = isBest ? '<span class="__faker_badge">BEST</span>' : '';
    const starCount = c.score >= 150 ? '⭐⭐⭐' : c.score >= 100 ? '⭐⭐' : c.score >= 50 ? '⭐' : '';
    return `
      <div class="__faker_candidate_item ${isBest ? '__faker_best' : ''}"
           data-selector="${esc(c.selector)}" data-type="${c.type}">
        <div class="__faker_candidate_header">
          <span class="__faker_candidate_type __faker_type_${c.type.toLowerCase()}">${c.type}</span>
          <span class="__faker_candidate_strategy">${esc(c.strategy)}</span>
          ${badge}
          <span class="__faker_stars">${starCount}</span>
        </div>
        <code class="__faker_candidate_selector">${esc(c.selector)}</code>
        <div class="__faker_candidate_actions">
          <button class="__faker_btn_copy" data-selector="${esc(c.selector)}">📋 복사</button>
          <button class="__faker_btn_use" data-selector="${esc(c.selector)}">✅ 사용</button>
        </div>
      </div>
    `;
  }).join('');

  // 복사 버튼
  container.querySelectorAll('.__faker_btn_copy').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sel = btn.dataset.selector;
      await navigator.clipboard.writeText(sel);
      btn.textContent = '✅ 복사됨!';
      setTimeout(() => { btn.textContent = '📋 복사'; }, 1500);
    });
  });

  // 사용 버튼 → background로 전송
  container.querySelectorAll('.__faker_btn_use').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sel = btn.dataset.selector;
      try {
        await chrome.runtime.sendMessage({ action: 'useSelector', selector: sel });
      } catch (e) { /* popup may not be open */ }
      await navigator.clipboard.writeText(sel);
    });
  });

  // 아이템 클릭 → 복사
  container.querySelectorAll('.__faker_candidate_item').forEach((item) => {
    item.addEventListener('click', async () => {
      const sel = item.dataset.selector;
      await navigator.clipboard.writeText(sel);
      item.style.background = '#a6e3a1';
      item.style.color = '#1e1e2e';
      setTimeout(() => { item.style.background = ''; item.style.color = ''; }, 600);
    });
  });
}

function closePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.classList.remove('__faker_visible');
  selectedElement = null;
}

// ==================== 5. 피커 모드 ====================

function enablePickerMode() {
  if (pickerActive) return;
  pickerActive = true;
  document.addEventListener('click', onPickerClick, true);
  document.addEventListener('mouseover', onPickerHover, true);
  document.addEventListener('mouseout', onPickerOut, true);
  document.body.style.cursor = 'crosshair';
}

function disablePickerMode() {
  pickerActive = false;
  document.removeEventListener('click', onPickerClick, true);
  document.removeEventListener('mouseover', onPickerHover, true);
  document.removeEventListener('mouseout', onPickerOut, true);
  document.body.style.cursor = '';
  closePanel();
}

function onPickerClick(e) {
  const panel = document.getElementById(PANEL_ID);
  if (panel && panel.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  openPanel(e.target);
}

function onPickerHover(e) {
  const panel = document.getElementById(PANEL_ID);
  if (panel && panel.contains(e.target)) return;
  e.target.style.outline = '2px solid #cba6f7';
  e.target.style.outlineOffset = '-2px';
}

function onPickerOut(e) {
  e.target.style.outline = '';
  e.target.style.outlineOffset = '';
}

// ==================== 6. 메시지 수신 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'applyRules') {
    applyAllRules().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'previewRule') {
    applyRule(message.rule);
    sendResponse({ success: true });
    return true;
  }
  if (message.action === 'togglePicker') {
    message.enabled ? enablePickerMode() : disablePickerMode();
    sendResponse({ success: true });
    return true;
  }
  if (message.action === 'getPickerState') {
    sendResponse({ active: pickerActive });
    return true;
  }
});

// ==================== 7. 스타일 주입 ====================

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      z-index: 2147483647;
      width: 340px;
      max-height: 480px;
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      color: #cdd6f4;
      display: none;
      overflow: hidden;
      user-select: none;
    }
    #${PANEL_ID}.__faker_visible { display: block; }

    .__faker_header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: #181825;
      border-bottom: 1px solid #313244;
      cursor: move;
    }
    .__faker_title { font-weight: 700; color: #cba6f7; font-size: 13px; }
    .__faker_header_actions { display: flex; align-items: center; gap: 8px; }
    .__faker_tag {
      background: #45475a;
      color: #a6adc8;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: 'Fira Code', monospace;
    }
    .__faker_close {
      background: none;
      border: none;
      color: #6c7086;
      cursor: pointer;
      font-size: 16px;
      padding: 0 2px;
    }
    .__faker_close:hover { color: #f38ba8; }

    .__faker_value_row {
      display: flex;
      gap: 6px;
      padding: 10px 14px;
    }
    .__faker_value_row input {
      flex: 1;
      padding: 7px 10px;
      background: #313244;
      border: 1px solid #45475a;
      border-radius: 6px;
      color: #cdd6f4;
      font-size: 12px;
      outline: none;
    }
    .__faker_value_row input:focus { border-color: #cba6f7; }
    .__faker_btn_primary {
      padding: 7px 14px;
      background: #cba6f7;
      color: #1e1e2e;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
    }
    .__faker_btn_primary:hover { background: #b4befe; }

    .__faker_section_label {
      padding: 6px 14px;
      font-size: 11px;
      font-weight: 600;
      color: #a6adc8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .__faker_candidates {
      max-height: 220px;
      overflow-y: auto;
      padding: 0 8px 8px;
    }

    .__faker_candidate_item {
      background: #181825;
      border: 1px solid #313244;
      border-radius: 8px;
      padding: 8px 10px;
      margin-bottom: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .__faker_candidate_item:hover { border-color: #cba6f7; }
    .__faker_candidate_item.__faker_best { border-color: #a6e3a1; }

    .__faker_candidate_header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }
    .__faker_candidate_type {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 3px;
    }
    .__faker_type_css { background: #89b4fa; color: #1e1e2e; }
    .__faker_type_xpath { background: #f9e2af; color: #1e1e2e; }
    .__faker_candidate_strategy { font-size: 10px; color: #6c7086; }
    .__faker_badge {
      font-size: 9px;
      background: #a6e3a1;
      color: #1e1e2e;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 700;
    }
    .__faker_stars { font-size: 10px; margin-left: auto; }

    .__faker_candidate_selector {
      display: block;
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 11px;
      color: #89b4fa;
      word-break: break-all;
      margin-bottom: 4px;
      line-height: 1.4;
    }

    .__faker_candidate_actions {
      display: flex;
      gap: 4px;
    }
    .__faker_btn_copy, .__faker_btn_use {
      padding: 3px 8px;
      font-size: 10px;
      border: 1px solid #45475a;
      background: #313244;
      color: #cdd6f4;
      border-radius: 4px;
      cursor: pointer;
    }
    .__faker_btn_copy:hover, .__faker_btn_use:hover { background: #45475a; }

    .__faker_actions {
      padding: 8px 14px 12px;
      border-top: 1px solid #313244;
    }

    .__faker_candidates::-webkit-scrollbar { width: 4px; }
    .__faker_candidates::-webkit-scrollbar-track { background: transparent; }
    .__faker_candidates::-webkit-scrollbar-thumb { background: #45475a; border-radius: 2px; }
  `;
  document.head.appendChild(style);
}

// ==================== 8. 초기화 (안정적인 자동 적용) ====================

/**
 * body가 준비될 때까지 기다렸다가 규칙을 적용합니다.
 * 실패 시 최대 5회 재시도합니다.
 */
async function initWithRetry(retryCount = 0) {
  const MAX_RETRIES = 5;
  const RETRY_DELAY = 800;

  if (!document.body && retryCount < MAX_RETRIES) {
    console.log(`[Faker] Waiting for document.body... (attempt ${retryCount + 1})`);
    setTimeout(() => initWithRetry(retryCount + 1), RETRY_DELAY);
    return;
  }

  // 먼저 캐시를 프리워밍 (applyAllRules 호출 전에 storage 읽기 보장)
  try {
    await fetchRulesFromStorage();
  } catch (e) {
    console.warn('[Faker] Cache pre-warm failed:', e);
  }

  try {
    await applyAllRules();
    console.log('[Faker] Auto-apply completed on page load');
  } catch (e) {
    console.warn('[Faker] Initial apply failed:', e);
    if (retryCount < MAX_RETRIES) {
      setTimeout(() => initWithRetry(retryCount + 1), RETRY_DELAY);
      return;
    }
  }

  startObserver();

  // 2차 보장: 1.5초 / 4초 후 추가 적용 (늦게 렌더링되는 요소, SPA 대비)
  [1500, 4000].forEach((delay) => {
    setTimeout(async () => {
      try {
        await applyAllRules();
      } catch (e) { /* ignore */ }
    }, delay);
  });
}

// 페이지가 이미 로드된 상태면 바로 시작, 아니면 DOMContentLoaded 대기
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    initWithRetry();
  });
} else {
  injectStyles();
  initWithRetry();
}
