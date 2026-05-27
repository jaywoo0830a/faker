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
  // 기존 데이터가 없으면 빈 배열로 초기화
  const { [STORAGE_KEY]: existing } = await chrome.storage.local.get(STORAGE_KEY);
  if (!existing) {
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  }
});

// 탭이 업데이트(새로고침/네비게이션)될 때 content script에 규칙 적용을 보장합니다.
// content script 자체에서도 init 시 자동 적용하지만,
// 여기서는 지연 렌더링 / SPA 케이스에 대비한 2차, 3차 재시도 메커니즘입니다.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('http')) return;

  // 저장된 규칙이 있는지 확인
  const { [STORAGE_KEY]: rules } = await chrome.storage.local.get(STORAGE_KEY);
  if (!rules || rules.length === 0) return;

  // 현재 URL에 매칭되는 규칙이 있는지 빠르게 확인
  const hasMatch = rules.some((rule) => urlMatches(rule.urlPattern, tab.url));

  if (!hasMatch) return;

  // 여러 차례 재시도로 확실하게 적용
  const delays = [300, 1000, 2500, 5000];
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'applyRules' });
      console.log(`[Faker] Applied rules to tab ${tabId} after ${delay}ms`);
      break; // 성공하면 이후 재시도 중단
    } catch (e) {
      // content script가 아직 준비되지 않음 → 다음 딜레이까지 대기 후 재시도
      console.log(`[Faker] Retry applying to tab ${tabId} (${delay}ms)...`);
    }
  }
});
