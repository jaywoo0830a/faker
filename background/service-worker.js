/**
 * service-worker.js - 백그라운드 서비스 워커
 *
 * 주 역할:
 * 1. 확장 프로그램 설치/업데이트 시 초기화
 * 2. 탭 업데이트(새로고침) 시 content script에 규칙 적용 트리거
 */

const STORAGE_KEY = 'selectorRules';

/**
 * URL 정규화 (content.js 와 동일한 로직)
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return u.origin + path;
  } catch (e) {
    return url.replace(/#.*$/, '').replace(/\/$/, '');
  }
}

function urlMatches(pattern, currentUrl) {
  if (!pattern) return false;
  if (pattern === '*') return true;
  const normalizedPattern = normalizeUrl(pattern);
  const normalizedCurrent = normalizeUrl(currentUrl);
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(normalizedCurrent);
}

// 설치 시 초기화
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Faker:BG] 🏁 Extension installed/updated');
  const { [STORAGE_KEY]: existing } = await chrome.storage.local.get(STORAGE_KEY);
  if (!existing) {
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    console.log('[Faker:BG] 📦 Initialized empty rules array');
  } else {
    console.log(`[Faker:BG] 📦 Existing rules: ${existing.length} rule(s)`);
  }
});

/**
 * 매칭된 규칙들을 탭에 직접 주입합니다 (content script 메시지 실패 시 폴백).
 */
async function injectRulesDirectly(tabId, matchedRules) {
  for (const rule of matchedRules) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, val) => {
          try {
            const els = document.querySelectorAll(sel);
            els.forEach((el) => {
              const tag = el.tagName.toLowerCase();
              if (tag === 'input') {
                if (el.type === 'checkbox' || el.type === 'radio') el.checked = Boolean(val);
                else el.value = String(val);
              } else if (tag === 'textarea' || tag === 'select') {
                el.value = String(val);
              } else if (el.isContentEditable) {
                el.textContent = String(val);
              } else {
                el.textContent = String(val);
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.setAttribute('data-faker-applied', 'true');
            });
            console.log('[Faker:BG:INJECT] Direct inject:', sel, '→', els.length, 'element(s)');
          } catch (e) { console.warn('[Faker:BG:INJECT] Error:', e); }
        },
        args: [rule.selector, rule.value],
      });
    } catch (e) {
      console.warn(`[Faker:BG] ⚠️ Direct injection failed for "${rule.selector}":`, e.message);
    }
  }
}

// 탭이 업데이트(새로고침/네비게이션)될 때 규칙 적용을 보장합니다.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('http')) return;

  console.log(`[Faker:BG] 🌐 Tab updated: tabId=${tabId}, url=${tab.url}, status=${changeInfo.status}`);

  const { [STORAGE_KEY]: rules } = await chrome.storage.local.get(STORAGE_KEY);
  console.log(`[Faker:BG] 📦 Storage has ${rules ? rules.length : 0} rule(s)`);
  if (!rules || rules.length === 0) return;

  const matchedRules = rules.filter((rule) => urlMatches(rule.urlPattern, tab.url));
  console.log(`[Faker:BG] 🎯 ${matchedRules.length}/${rules.length} rule(s) matched for this URL`);

  if (matchedRules.length === 0) return;

  // 1차: content script에 메시지 전송 시도 (여러 번 재시도)
  let contentScriptOk = false;
  const delays = [300, 1000, 2500];
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'applyRules' });
      console.log(`[Faker:BG] ✅ Message sent to tab ${tabId} after ${delay}ms`);
      contentScriptOk = true;
      break;
    } catch (e) {
      console.log(`[Faker:BG] ⚠️ Content script not ready at ${delay}ms: ${e.message}`);
    }
  }

  // 2차: content script 메시지가 실패하면 직접 주입 (폴백)
  if (!contentScriptOk) {
    console.log(`[Faker:BG] 🔄 Content script unreachable, using direct injection fallback...`);
    await injectRulesDirectly(tabId, matchedRules);
    console.log(`[Faker:BG] ✅ Direct injection completed for tab ${tabId}`);
  }

  // 3차: 5초 후 직접 주입 재시도 (페이지 JS가 값을 덮어썼을 경우 대비)
  setTimeout(async () => {
    console.log(`[Faker:BG] 🔄 Delayed direct injection for tab ${tabId}`);
    await injectRulesDirectly(tabId, matchedRules);
  }, 5000);
});

// popup에서 즉시 적용 요청
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'useSelector') {
    // popup으로 selector 전달은 popup.js에서 처리
    sendResponse({ success: true });
  }
  if (message.action === 'ruleAdded') {
    console.log('[Faker:BG] 📌 New rule added from content script picker');
    sendResponse({ success: true });
  }
});
