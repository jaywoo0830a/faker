/**
 * content.js - 페이지에 주입되어 저장된 selector-value 규칙을 DOM에 적용합니다.
 * 새로고침 시 자동으로 적용되며, SPA 페이지에서는 MutationObserver로
 * 동적 DOM 변경에도 대응합니다.
 */

const STORAGE_KEY = 'selectorRules';
const APPLIED_ATTR = 'data-faker-applied';

/**
 * 현재 페이지 URL을 기반으로 매칭되는 규칙들을 가져옵니다.
 */
async function getMatchingRules() {
  const { [STORAGE_KEY]: allRules } = await chrome.storage.local.get(STORAGE_KEY);
  if (!allRules || !Array.isArray(allRules)) return [];

  const currentUrl = window.location.href;

  return allRules.filter((rule) => {
    // URL 패턴 매칭: 정확한 URL, 와일드카드(*) 지원
    const pattern = rule.urlPattern || '';
    if (!pattern) return false;

    // 와일드카드를 정규식으로 변환
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    return regex.test(currentUrl);
  });
}

/**
 * 단일 규칙을 DOM에 적용합니다.
 * @param {Object} rule - { selector, value, urlPattern }
 */
function applyRule(rule) {
  if (!rule.selector || rule.value === undefined) return;

  try {
    const elements = document.querySelectorAll(rule.selector);
    elements.forEach((el) => {
      applyValueToElement(el, rule.value);
    });
  } catch (e) {
    console.warn(`[Faker] Invalid selector "${rule.selector}":`, e.message);
  }
}

/**
 * 엘리먼트에 값을 적용합니다.
 * input/textarea/select 는 value 속성을,
 * contenteditable 은 textContent를,
 * 그 외에는 textContent를 설정합니다.
 */
function applyValueToElement(element, value) {
  const tagName = element.tagName.toLowerCase();
  const isContentEditable = element.isContentEditable;

  if (tagName === 'input') {
    const inputType = element.type;
    if (inputType === 'checkbox' || inputType === 'radio') {
      element.checked = Boolean(value);
    } else {
      element.value = value;
    }
  } else if (tagName === 'textarea') {
    element.value = value;
  } else if (tagName === 'select') {
    element.value = value;
  } else if (isContentEditable) {
    element.textContent = value;
  } else {
    element.textContent = value;
  }

  // 이벤트 발생시켜서 React/Angular 등 프레임워크가 변경을 감지하게 함
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.setAttribute(APPLIED_ATTR, 'true');
}

/**
 * 모든 매칭 규칙을 적용합니다.
 */
async function applyAllRules() {
  const rules = await getMatchingRules();
  for (const rule of rules) {
    applyRule(rule);
  }
}

// ==================== MutationObserver: 동적 DOM 감시 ====================
let observer = null;

function startObserver() {
  if (observer) return;

  observer = new MutationObserver((mutations) => {
    // 새로 추가된 노드가 있는 경우에만 규칙 재적용
    let hasNewNodes = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        hasNewNodes = true;
        break;
      }
    }
    if (hasNewNodes) {
      applyAllRules();
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}

// ==================== 메시지 수신 (popup에서 즉시 적용 요청) ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'applyRules') {
    applyAllRules().then(() => {
      sendResponse({ success: true });
    });
    return true; // 비동기 응답
  }

  if (message.action === 'previewRule') {
    // 단일 규칙 미리보기
    applyRule(message.rule);
    sendResponse({ success: true });
    return true;
  }
});

// ==================== 초기화 ====================
(function init() {
  applyAllRules();
  startObserver();
})();
