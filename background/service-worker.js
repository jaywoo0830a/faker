/**
 * service-worker.js - 백그라운드 서비스 워커
 *
 * 주 역할:
 * 1. 확장 프로그램 설치/업데이트 시 초기화
 * 2. 탭 업데이트(새로고침) 시 content script에 규칙 적용 트리거
 */

const STORAGE_KEY = 'selectorRules';

// 설치 시 초기화
chrome.runtime.onInstalled.addListener(async () => {
  // 기존 데이터가 없으면 빈 배열로 초기화
  const { [STORAGE_KEY]: existing } = await chrome.storage.local.get(STORAGE_KEY);
  if (!existing) {
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  }
});

// 탭이 업데이트(새로고침/네비게이션)될 때 content script가 로드된 후
// 추가 보장 차원에서 규칙 적용 메시지를 보냅니다.
// (content script의 DOMContentLoaded/init 자체가 1차 적용을 담당하지만,
//  여기서는 혹시 모를 지연 로딩 케이스에 대비한 2차 메커니즘입니다.)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 페이지 로딩이 완료되었을 때만
  if (changeInfo.status !== 'complete') return;
  // chrome://, chrome-extension:// 등의 제한된 페이지는 건너뜀
  if (!tab.url || !tab.url.startsWith('http')) return;

  // 저장된 규칙이 있는지 확인
  const { [STORAGE_KEY]: rules } = await chrome.storage.local.get(STORAGE_KEY);
  if (!rules || rules.length === 0) return;

  // 현재 URL에 매칭되는 규칙이 있는지 빠르게 확인
  const hasMatch = rules.some((rule) => {
    const pattern = rule.urlPattern || '';
    if (!pattern) return false;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    return regex.test(tab.url);
  });

  if (!hasMatch) return;

  // 약간의 지연 후 content script에 적용 요청
  // (DOM이 완전히 렌더링될 시간을 줌)
  setTimeout(async () => {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'applyRules' });
    } catch (e) {
      // content script가 아직 준비되지 않은 경우 조용히 무시
      // (content script 자체에서도 자체적으로 적용하므로 문제 없음)
    }
  }, 500);
});
