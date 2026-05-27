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
  console.log(`[Faker] 📥 fetchRulesFromStorage() called, retry=${retryCount}, cachedRules.length=${cachedRules.length}`);

  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      console.log(`[Faker] 📥 storage.local.get() callback fired, result keys:`, Object.keys(result));

      if (chrome.runtime.lastError) {
        console.error(`[Faker] ❌ Storage read error:`, chrome.runtime.lastError.message);
        if (retryCount < MAX_RETRIES) {
          console.log(`[Faker] 🔄 Retrying storage read (${retryCount + 1}/${MAX_RETRIES})...`);
          setTimeout(() => resolve(fetchRulesFromStorage(retryCount + 1)), 500);
          return;
        }
        console.warn(`[Faker] ⚠️ Max retries reached, using cachedRules (${cachedRules.length} rules)`);
        resolve(cachedRules);
        return;
      }
      const rules = result[STORAGE_KEY];
      console.log(`[Faker] 📥 storage result: STORAGE_KEY="${STORAGE_KEY}", value type=${typeof rules}, isArray=${Array.isArray(rules)}, length=${rules ? rules.length : 'N/A'}`);
      if (rules) {
        console.log(`[Faker] 📥 Rules detail:`, JSON.stringify(rules, null, 2));
      }

      if (Array.isArray(rules)) {
        cachedRules = rules;
        console.log(`[Faker] ✅ Loaded ${rules.length} rule(s) from storage, cache updated`);
        resolve(rules);
      } else {
        console.log(`[Faker] ⚠️ No valid rules array in storage (got ${typeof rules}), cachedRules has ${cachedRules.length}`);
        if (retryCount === 0 && (!rules || (Array.isArray(rules) && rules.length === 0))) {
          console.log(`[Faker] 🔄 First attempt got empty, retrying...`);
          setTimeout(() => resolve(fetchRulesFromStorage(retryCount + 1)), 400);
          return;
        }
        resolve(cachedRules);
      }
    });
  });
}

async function getMatchingRules() {
  console.log(`[Faker] 🔍 getMatchingRules() called, currentUrl=${window.location.href}`);
  const allRules = await fetchRulesFromStorage();
  console.log(`[Faker] 🔍 allRules count=${allRules ? allRules.length : 0}`);

  if (!allRules || !Array.isArray(allRules) || allRules.length === 0) {
    console.log(`[Faker] 🔍 No rules to match, returning empty`);
    return [];
  }

  const currentUrl = window.location.href;
  const normalizedCurrent = normalizeUrl(currentUrl);
  console.log(`[Faker] 🔍 normalizedCurrent=${normalizedCurrent}`);

  const matched = allRules.filter((rule, idx) => {
    const pattern = rule.urlPattern || '';
    const result = urlMatches(pattern, currentUrl);
    console.log(`[Faker] 🔍 Rule #${idx}: pattern="${pattern}", selector="${rule.selector}", value="${rule.value}", MATCH=${result}`);
    return result;
  });

  console.log(`[Faker] 🔍 Matched ${matched.length}/${allRules.length} rule(s)`);
  return matched;
}

function applyRule(rule) {
  if (!rule.selector) {
    console.warn(`[Faker] ⚠️ applyRule skipped: no selector`, rule);
    return;
  }
  if (rule.value === undefined) {
    console.warn(`[Faker] ⚠️ applyRule skipped: value is undefined for selector "${rule.selector}"`);
    return;
  }
  try {
    const elements = document.querySelectorAll(rule.selector);
    console.log(`[Faker] 🎯 applyRule: selector="${rule.selector}", value="${rule.value}", found ${elements.length} element(s)`);
    elements.forEach((el, i) => {
      console.log(`[Faker] 🎯   Element #${i}: <${el.tagName.toLowerCase()}>, current value="${getCurrentValue(el)}"`);
      applyValueToElement(el, rule.value);
      console.log(`[Faker] 🎯   Element #${i}: AFTER set, value="${getCurrentValue(el)}"`);
    });
  } catch (e) {
    console.error(`[Faker] ❌ Invalid selector "${rule.selector}":`, e.message);
  }
}

function applyValueToElement(element, value) {
  const tagName = element.tagName.toLowerCase();
  const isContentEditable = element.isContentEditable;
  const prevValue = getCurrentValue(element);

  console.log(`[Faker] ✏️ applyValueToElement: <${tagName}>, type=${element.type || 'N/A'}, prev="${prevValue}", new="${value}"`);

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

  // 값이 실제로 적용되었는지 확인
  const afterValue = getCurrentValue(element);
  console.log(`[Faker] ✏️   After dispatch: "${afterValue}" (expected: "${value}") ${afterValue === String(value) ? '✅' : '⚠️ MISMATCH'}`);

  // 적용된 요소를 감시: 페이지 JS가 값을 덮어쓰면 다시 복원
  watchElement(element, value);
}

async function applyAllRules() {
  console.log(`[Faker] 🚀 applyAllRules() called for ${window.location.href}`);
  const rules = await getMatchingRules();
  console.log(`[Faker] 🚀 applyAllRules: ${rules.length} matching rule(s) found`);
  if (rules.length === 0) {
    console.log(`[Faker] 🚀 No rules to apply, skipping`);
    return;
  }
  for (const rule of rules) {
    applyRule(rule);
  }
  console.log(`[Faker] 🚀 applyAllRules: DONE`);
}

// ==================== 엘리먼트 감시 (페이지 JS가 값을 덮어쓰는 것 방어) ====================

const watchedElements = new Map(); // element -> { value, observer }

function watchElement(element, expectedValue) {
  // 이미 감시 중이면 observer 재사용
  if (watchedElements.has(element)) {
    watchedElements.get(element).value = expectedValue;
    return;
  }

  const observer = new MutationObserver(() => {
    const currentVal = getCurrentValue(element);
    const expected = watchedElements.get(element)?.value;
    if (expected !== undefined && String(currentVal) !== String(expected)) {
      console.log(`[Faker] 🛡️ Page JS changed value! Restoring: "${currentVal}" → "${expected}"`);
      // observer를 잠시 해제하고 값 복원 (무한 루프 방지)
      observer.disconnect();
      applyValueToElementSilently(element, expected);
      // 다시 감시 시작
      observer.observe(element, {
        attributes: true,
        characterData: true,
        childList: false,
        subtree: false,
      });
    }
  });

  // input/textarea는 attributes(value), contenteditable은 characterData 감시
  const tag = element.tagName.toLowerCase();
  const config = { attributes: true, attributeFilter: ['value'] };
  if (tag === 'input' || tag === 'textarea') {
    // input 이벤트도 감시 (React controlled components)
    element.addEventListener('input', () => {
      const currentVal = getCurrentValue(element);
      const expected = watchedElements.get(element)?.value;
      if (expected !== undefined && String(currentVal) !== String(expected)) {
        console.log(`[Faker] 🛡️ Input event changed value! Restoring: "${currentVal}" → "${expected}"`);
        applyValueToElementSilently(element, expected);
      }
    });
  }

  observer.observe(element, {
    attributes: true,
    characterData: true,
    childList: false,
    subtree: false,
  });

  watchedElements.set(element, { value: expectedValue, observer });
}

function applyValueToElementSilently(element, value) {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'input') {
    if (element.type === 'checkbox' || element.type === 'radio') {
      element.checked = Boolean(value);
    } else {
      element.value = value;
    }
  } else if (tagName === 'textarea' || tagName === 'select') {
    element.value = value;
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    element.textContent = value;
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
      <span class="__faker_title">Selector Picker</span>
      <div class="__faker_header_actions">
        <span class="__faker_tag"></span>
        <button class="__faker_close" id="__faker_close_btn">&times;</button>
      </div>
    </div>
    <div class="__faker_value_row">
      <input type="text" id="__faker_value_input" placeholder="Enter value to set..." />
      <button id="__faker_apply_btn" class="__faker_btn_primary">Apply</button>
    </div>
    <div class="__faker_section_label">Selector Candidates &middot; click to copy</div>
    <div class="__faker_candidates" id="__faker_candidates"></div>
    <div class="__faker_actions">
      <button id="__faker_add_rule_btn" class="__faker_btn_primary" style="width:100%">Save rule with current value</button>
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

  container.innerHTML = candidates.map((c) => {
    const isBest = c.score === bestScore;
    const badge = isBest ? '<span class="__faker_badge">best</span>' : '';
    // 점수를 안정성 레이블로 변환
    let stability = '';
    if (c.score >= 150) stability = 'High';
    else if (c.score >= 100) stability = 'Medium';
    else stability = 'Low';
    return `
      <div class="__faker_candidate_item ${isBest ? '__faker_best' : ''}"
           data-selector="${esc(c.selector)}" data-type="${c.type}">
        <div class="__faker_candidate_header">
          <span class="__faker_candidate_type __faker_type_${c.type.toLowerCase()}">${c.type}</span>
          <span class="__faker_candidate_strategy">${esc(c.strategy)}</span>
          ${badge}
          <span class="__faker_stability">${stability}</span>
        </div>
        <code class="__faker_candidate_selector">${esc(c.selector)}</code>
        <div class="__faker_candidate_actions">
          <button class="__faker_btn_copy" data-selector="${esc(c.selector)}">Copy</button>
          <button class="__faker_btn_use" data-selector="${esc(c.selector)}">Use</button>
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
      btn.textContent = 'Copied';
      btn.classList.add('__faker_copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('__faker_copied');
      }, 1500);
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
    /* ---- Design tokens (Catppuccin Mocha) ---- */
    #${PANEL_ID} {
      --fk-bg:        #1e1e2e;
      --fk-surface:   #181825;
      --fk-overlay:   #11111b;
      --fk-border:    #313244;
      --fk-border-hi: #45475a;
      --fk-text:      #cdd6f4;
      --fk-text-dim:  #a6adc8;
      --fk-muted:     #6c7086;
      --fk-primary:   #cba6f7;
      --fk-accent:    #89b4fa;
      --fk-success:   #a6e3a1;
      --fk-danger:    #f38ba8;
      --fk-warning:   #f9e2af;
      --fk-font:      -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --fk-mono:      'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;

      position: fixed;
      z-index: 2147483647;
      width: 340px;
      max-height: 480px;
      background: var(--fk-bg);
      border: 1px solid var(--fk-border-hi);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      font-family: var(--fk-font);
      font-size: 0.8125rem;
      color: var(--fk-text);
      display: none;
      overflow: hidden;
      user-select: none;
    }
    #${PANEL_ID}.__faker_visible { display: block; }

    .__faker_header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.625rem 0.875rem;
      background: var(--fk-surface);
      border-bottom: 1px solid var(--fk-border);
      cursor: move;
    }
    .__faker_title {
      font-weight: 700;
      color: var(--fk-primary);
      font-size: 0.8125rem;
    }
    .__faker_header_actions { display: flex; align-items: center; gap: 0.5rem; }
    .__faker_tag {
      background: var(--fk-border-hi);
      color: var(--fk-text-dim);
      padding: 0.125rem 0.5rem;
      border-radius: 4px;
      font-size: 0.6875rem;
      font-family: var(--fk-mono);
    }
    .__faker_close {
      background: none;
      border: none;
      color: var(--fk-muted);
      cursor: pointer;
      font-size: 1.125rem;
      padding: 0;
      line-height: 1;
    }
    .__faker_close:hover { color: var(--fk-danger); }

    .__faker_value_row {
      display: flex;
      gap: 0.375rem;
      padding: 0.625rem 0.875rem;
    }
    .__faker_value_row input {
      flex: 1;
      padding: 0.4375rem 0.625rem;
      background: var(--fk-overlay);
      border: 1px solid var(--fk-border-hi);
      border-radius: 6px;
      color: var(--fk-text);
      font-size: 0.75rem;
      font-family: var(--fk-font);
      outline: none;
    }
    .__faker_value_row input:focus {
      border-color: var(--fk-primary);
      box-shadow: 0 0 0 2px rgba(203,166,247,0.15);
    }
    .__faker_btn_primary {
      padding: 0.4375rem 0.875rem;
      background: var(--fk-primary);
      color: var(--fk-bg);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.75rem;
      font-family: var(--fk-font);
    }
    .__faker_btn_primary:hover { background: #b4befe; }

    .__faker_section_label {
      padding: 0.375rem 0.875rem;
      font-size: 0.6875rem;
      font-weight: 600;
      color: var(--fk-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .__faker_candidates {
      max-height: 220px;
      overflow-y: auto;
      padding: 0 0.5rem 0.5rem;
    }
    .__faker_candidate_item {
      background: var(--fk-surface);
      border: 1px solid var(--fk-border);
      border-radius: 8px;
      padding: 0.5rem 0.625rem;
      margin-bottom: 0.375rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .__faker_candidate_item:hover { border-color: var(--fk-primary); }
    .__faker_candidate_item.__faker_best { border-color: var(--fk-success); }

    .__faker_candidate_header {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      margin-bottom: 0.25rem;
    }
    .__faker_candidate_type {
      font-size: 0.625rem;
      font-weight: 700;
      padding: 0.0625rem 0.375rem;
      border-radius: 3px;
    }
    .__faker_type_css { background: var(--fk-accent); color: var(--fk-bg); }
    .__faker_type_xpath { background: var(--fk-warning); color: var(--fk-bg); }
    .__faker_candidate_strategy { font-size: 0.625rem; color: var(--fk-muted); }
    .__faker_badge {
      font-size: 0.5625rem;
      background: var(--fk-success);
      color: var(--fk-overlay);
      padding: 0.0625rem 0.3125rem;
      border-radius: 3px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .__faker_stability {
      font-size: 0.625rem;
      margin-left: auto;
      color: var(--fk-muted);
    }

    .__faker_candidate_selector {
      display: block;
      font-family: var(--fk-mono);
      font-size: 0.6875rem;
      color: var(--fk-accent);
      word-break: break-all;
      margin-bottom: 0.25rem;
      line-height: 1.4;
    }
    .__faker_candidate_actions {
      display: flex;
      gap: 0.25rem;
    }
    .__faker_btn_copy, .__faker_btn_use {
      padding: 0.1875rem 0.5rem;
      font-size: 0.625rem;
      font-family: var(--fk-font);
      border: 1px solid var(--fk-border-hi);
      background: var(--fk-overlay);
      color: var(--fk-text);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .__faker_btn_copy:hover, .__faker_btn_use:hover { background: var(--fk-border-hi); }
    .__faker_btn_copy.__faker_copied {
      background: var(--fk-success);
      color: var(--fk-overlay);
      border-color: var(--fk-success);
    }

    .__faker_actions {
      padding: 0.5rem 0.875rem 0.75rem;
      border-top: 1px solid var(--fk-border);
    }

    .__faker_candidates::-webkit-scrollbar { width: 4px; }
    .__faker_candidates::-webkit-scrollbar-track { background: transparent; }
    .__faker_candidates::-webkit-scrollbar-thumb { background: var(--fk-border-hi); border-radius: 2px; }
  `;
  document.head.appendChild(style);
}

// ==================== 8. 초기화 (안정적인 자동 적용) ====================

/**
 * body가 준비될 때까지 기다렸다가 규칙을 적용합니다.
 */
async function initWithRetry(retryCount = 0) {
  const MAX_RETRIES = 5;
  const RETRY_DELAY = 800;

  console.log(`[Faker] 🏁 initWithRetry(#${retryCount}), readyState=${document.readyState}, body=${!!document.body}`);

  if (!document.body && retryCount < MAX_RETRIES) {
    console.log(`[Faker] ⏳ Waiting for document.body... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
    setTimeout(() => initWithRetry(retryCount + 1), RETRY_DELAY);
    return;
  }

  // 캐시 프리워밍
  try {
    console.log(`[Faker] 🔥 Pre-warming cache...`);
    await fetchRulesFromStorage();
    console.log(`[Faker] 🔥 Cache pre-warmed: ${cachedRules.length} rules`);
  } catch (e) {
    console.error(`[Faker] ❌ Cache pre-warm failed:`, e);
  }

  // 규칙 적용
  try {
    await applyAllRules();
    console.log(`[Faker] ✅ Auto-apply completed on page load`);
  } catch (e) {
    console.error(`[Faker] ❌ Initial apply failed:`, e);
    if (retryCount < MAX_RETRIES) {
      setTimeout(() => initWithRetry(retryCount + 1), RETRY_DELAY);
      return;
    }
  }

  startObserver();

  // 2차, 3차, 4차 보장 적용 (늦게 렌더링되는 요소, SPA, 페이지 JS override 대비)
  [1500, 4000, 8000].forEach((delay) => {
    setTimeout(async () => {
      console.log(`[Faker] 🔄 Delayed re-apply after ${delay}ms`);
      try {
        await applyAllRules();
      } catch (e) { console.warn(`[Faker] ⚠️ Delayed apply failed at ${delay}ms:`, e); }
    }, delay);
  });

  // Heartbeat: 30초 동안 5초마다 재적용 시도
  let heartbeatCount = 0;
  const MAX_HEARTBEATS = 6;
  const heartbeat = setInterval(async () => {
    heartbeatCount++;
    console.log(`[Faker] 💓 Heartbeat #${heartbeatCount}/${MAX_HEARTBEATS}`);
    try {
      await applyAllRules();
    } catch (e) { /* ignore */ }
    if (heartbeatCount >= MAX_HEARTBEATS) {
      console.log(`[Faker] 💓 Heartbeat finished`);
      clearInterval(heartbeat);
    }
  }, 5000);
}

// 페이지가 이미 로드된 상태면 바로 시작, 아니면 DOMContentLoaded 대기
console.log(`[Faker] 🔌 Content script loaded, readyState=${document.readyState}`);
if (document.readyState === 'loading') {
  console.log(`[Faker] 🔌 Waiting for DOMContentLoaded...`);
  document.addEventListener('DOMContentLoaded', () => {
    console.log(`[Faker] 🔌 DOMContentLoaded fired`);
    injectStyles();
    initWithRetry();
  });
} else {
  console.log(`[Faker] 🔌 Document already loaded, starting immediately`);
  injectStyles();
  initWithRetry();
}
