// ==UserScript==
// @name         YouTube 광고·안티애드블록 (Safari/오리집)
// @namespace    https://github.com/makeADragon/wpffl_adguard
// @version      1.0.0
// @description  홈 피드 광고 카드 제거, 영상 광고 자동 건너뛰기, 광고 차단 감지 팝업/재생 중단 우회
// @author       makeADragon
// @match        *://youtube.com/*
// @match        *://*.youtube.com/*
// @match        *://*.youtube-nocookie.com/*
// @exclude      *://studio.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
//
// Safari 콘텐츠 차단기(오리집 등)는 `#%#` raw JS를 실행하지 않습니다.
// 이 파일은 그 대신 유저스크립트로 페이지 안에서 직접 동작합니다.
// · 피드 광고: 광고 슬롯/스폰서 배지가 있는 카드의 부모까지 접습니다.
// · 영상 광고: 건너뛰기 버튼을 누르거나, 광고 영상을 끝으로 보내 즉시 종료합니다.
// · 안티애드블록: 감지 팝업을 숨기고 멈춘 영상을 다시 재생합니다.
//
// 오리집에서 실행 영역을 고를 수 있다면 '페이지 안'(page)으로 두세요.
// '페이지와 분리된 영역'(isolated)에서는 ytInitialPlayerResponse 패치가 적용되지 않지만,
// DOM 기반 광고 숨김/건너뛰기/팝업 제거는 그대로 동작합니다.

(() => {
  'use strict';

  const W = window;
  const DOC = document;
  if (W.__wpfflYtAdblock) return;
  W.__wpfflYtAdblock = true;

  // ---------------------------------------------------------------------------
  // 0) 광고가 정상 로드된 것처럼 보이는 전역값
  //    YouTube의 광고 차단 감지가 참조하는 값 중 하나입니다.
  // ---------------------------------------------------------------------------
  try {
    Object.defineProperty(W, 'google_ad_status', {
      configurable: false,
      enumerable: true,
      get: () => 1,
      set: () => {},
    });
  } catch {
    try { W.google_ad_status = 1; } catch { /* 이미 고정된 경우 */ }
  }

  // ---------------------------------------------------------------------------
  // 1) 플레이어 응답에서 광고 데이터 제거
  //    ytInitialPlayerResponse/ytInitialData가 페이지에 대입되는 순간 가로챕니다.
  // ---------------------------------------------------------------------------
  const AD_KEYS = [
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakHeartbeatParams',
    'enforcementMessageViewModel',
  ];

  function isAdSlotItem(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.adSlotRenderer || value.adPlacements || value.playerAds) return true;
    const content = (value.richItemRenderer && value.richItemRenderer.content) ||
      (value.richSectionRenderer && value.richSectionRenderer.content) ||
      value.content;
    if (content && content.adSlotRenderer) return true;
    // Shorts 피드의 광고 항목
    const reel = (value.command && value.command.reelWatchEndpoint) || value.reelWatchEndpoint;
    return !!(reel && reel.adClientParams && reel.adClientParams.isAd);
  }

  function stripAds(root) {
    if (!root || typeof root !== 'object') return root;
    const stack = [root];
    const seen = new WeakSet();
    let visited = 0;
    while (stack.length && visited < 50000) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      visited++;

      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          const value = node[i];
          if (!value || typeof value !== 'object') continue;
          // 피드 광고 카드의 데이터 단위
          if (isAdSlotItem(value)) {
            node.splice(i, 1);
          } else {
            stack.push(value);
          }
        }
        continue;
      }

      for (const key of AD_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        try { delete node[key]; } catch { try { node[key] = undefined; } catch { /* frozen */ } }
      }

      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return root;
  }

  function trapGlobal(name) {
    let value;
    let previous = null;
    try {
      const desc = Object.getOwnPropertyDescriptor(W, name);
      if (desc) {
        if (!desc.configurable) return;
        previous = desc;
        if (desc.get) {
          try { value = desc.get.call(W); } catch { /* 무시 */ }
        }
      }
      Object.defineProperty(W, name, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(next) {
          value = stripAds(next);
          // 오리집/AdGuard scriptlet이 먼저 건 setter가 있으면 그쪽에도 알려
          // 중첩 경로(예: auxiliaryUi...) 감시가 계속 동작하게 합니다.
          if (previous && previous.set) {
            try { previous.set.call(W, value); } catch { /* 무시 */ }
          }
        },
      });
    } catch { /* 페이지가 이미 정의한 경우 */ }
  }
  trapGlobal('ytInitialPlayerResponse');
  trapGlobal('ytInitialData');

  // JSON.parse로 들어오는 플레이어 응답도 같은 방식으로 정리합니다.
  try {
    const nativeParse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const value = nativeParse.call(this, text, reviver);
      if (value && typeof value === 'object') {
        if ('adPlacements' in value || 'playerAds' in value || 'adSlots' in value ||
            (value.playerResponse && typeof value.playerResponse === 'object')) {
          return stripAds(value);
        }
      }
      return value;
    };
  } catch { /* JSON.parse를 잠근 페이지 */ }

  // fetch로 받은 youtubei 응답도 정리합니다. (XHR은 필터 목록의 scriptlet이 담당)
  try {
    const nativeJson = Response.prototype.json;
    Response.prototype.json = function () {
      return nativeJson.call(this).then((value) => {
        const url = String(this.url || '');
        if (/\/youtubei\/v1\/(?:player|next|get_watch|reel_watch_sequence)/.test(url)) {
          return stripAds(value);
        }
        return value;
      });
    };
  } catch { /* Response가 없는 환경 */ }

  // ---------------------------------------------------------------------------
  // 2) CSS — 광고 슬롯, 부모 카드, 스폰서 배지, 안티애드블록 팝업
  // ---------------------------------------------------------------------------
  const CSS = `
    /* 광고 슬롯 자체 */
    ytd-ad-slot-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-display-ad-renderer,
    ytd-promoted-video-renderer,
    ytd-compact-promoted-video-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytd-promoted-sparkles-text-search-renderer,
    ytd-search-pyv-renderer,
    ytd-action-companion-ad-renderer,
    ytd-companion-slot-renderer,
    ytd-banner-promo-renderer,
    ytd-statement-banner-renderer,
    ytd-video-masthead-ad-v3-renderer,
    ytd-merch-shelf-renderer[is-from-merch-ad],
    #masthead-ad,
    #player-ads,
    #offer-module,
    ad-slot-renderer,
    ytm-promoted-video-renderer,
    ytm-promoted-sparkles-web-renderer,
    ytm-companion-ad-renderer,
    .ytp-ad-overlay-container,
    .ytp-ad-text-overlay,
    .ytp-ad-image-overlay,
    .ytp-ad-message-container,
    .ytp-ad-progress-list,
    .ytp-ad-simple-ad-badge,
    .ytp-ad-preview-container,
    .ytp-ad-duration-remaining,
    ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"] {
      display: none !important;
    }

    /* 광고 슬롯을 품은 피드 카드까지 접기 */
    ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer),
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytd-rich-item-renderer:has(ytd-in-feed-ad-layout-renderer),
    ytd-rich-item-renderer:has(ytd-display-ad-renderer),
    ytd-rich-item-renderer:has(ytd-promoted-video-renderer),
    ytd-rich-item-renderer:has(ytd-compact-promoted-video-renderer),
    ytd-rich-item-renderer:has(ytd-promoted-sparkles-web-renderer),
    ytd-rich-item-renderer:has(ytd-search-pyv-renderer),
    ytd-rich-item-renderer:has(ytd-statement-banner-renderer),
    ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
    ytd-reel-item-renderer:has(ytd-ad-slot-renderer),
    ytm-rich-item-renderer:has(ad-slot-renderer),
    ytm-rich-item-renderer:has(ytm-promoted-video-renderer),
    ytm-rich-item-renderer:has(ytm-promoted-sparkles-web-renderer),
    ytm-reel-item-renderer:has(ad-slot-renderer) {
      display: none !important;
    }

    /* 'Sponsored'/'광고' 배지가 붙은 카드 (aria-label 기준) */
    ytd-rich-item-renderer:has([aria-label="Sponsored" i]),
    ytd-rich-item-renderer:has([aria-label="Promoted" i]),
    ytd-rich-item-renderer:has([aria-label="Ad" i]),
    ytd-rich-item-renderer:has([aria-label="광고" i]),
    ytd-rich-item-renderer:has([aria-label="스폰서" i]),
    ytd-rich-item-renderer:has([aria-label="프로모션" i]),
    ytd-rich-item-renderer:has([aria-label="広告" i]),
    ytd-rich-item-renderer:has([aria-label="スポンサー" i]),
    ytd-rich-item-renderer:has([aria-label="赞助" i]),
    ytd-rich-item-renderer:has([aria-label="广告" i]),
    ytm-rich-item-renderer:has([aria-label="Sponsored" i]),
    ytm-rich-item-renderer:has([aria-label="광고" i]) {
      display: none !important;
    }

    /* 광고 차단 감지 팝업/배경 */
    ytd-enforcement-message-view-model,
    ytd-popup-container:has(ytd-enforcement-message-view-model),
    tp-yt-paper-dialog:has(ytd-enforcement-message-view-model) {
      display: none !important;
    }

    /* 스크립트가 직접 붙이는 클래스 */
    .wpffl-yt-hidden {
      display: none !important;
    }
  `;

  function injectCSS() {
    if (!DOC.documentElement || DOC.getElementById('wpffl-yt-css')) return;
    const style = DOC.createElement('style');
    style.id = 'wpffl-yt-css';
    style.textContent = CSS;
    (DOC.head || DOC.documentElement).appendChild(style);
  }
  injectCSS();
  if (!DOC.getElementById('wpffl-yt-css')) {
    DOC.addEventListener('DOMContentLoaded', injectCSS, { once: true });
  }

  // ---------------------------------------------------------------------------
  // 3) 피드 카드 스캔
  // ---------------------------------------------------------------------------
  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-rich-section-renderer',
    'ytd-reel-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytm-rich-item-renderer',
    'ytm-reel-item-renderer',
    'ytm-video-with-context-renderer',
    'ytm-compact-video-renderer',
  ].join(',');

  const AD_SELECTOR = [
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-display-ad-renderer',
    'ytd-promoted-video-renderer',
    'ytd-compact-promoted-video-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-text-search-renderer',
    'ytd-search-pyv-renderer',
    'ytd-action-companion-ad-renderer',
    'ytd-companion-slot-renderer',
    'ytd-statement-banner-renderer',
    'ad-slot-renderer',
    'ytm-promoted-video-renderer',
    'ytm-promoted-sparkles-web-renderer',
    'ytm-companion-ad-renderer',
  ].join(',');

  const BADGE_SELECTOR = [
    'yt-badge-shape',
    '.badge-shape-wiz__text',
    'ytd-badge-supported-renderer',
    'ytm-badge-and-byline-renderer',
    'ytm-badge-renderer',
    '[aria-label]',
  ].join(',');

  const SPONSORED_WORDS = [
    'sponsored', 'promoted', 'advertisement', 'ad',
    '광고', '스폰서', '프로모션',
    'スポンサー', '広告',
    '赞助', '赞助商', '广告', '廣告', '推广', '推薦', '推荐',
    'gesponsert', 'sponsorisé', 'patrocinado', 'promocionado', 'sponsorizzato',
    'sponsrad', 'sponsorlu', 'promotert', 'sponzorováno', 'promovat',
    'reklama', 'mainostettu', 'sponsorowana', 'promowane', 'anzeige', 'publicité', 'anúncio',
  ].join('|');
  const SPONSORED_TEXT = new RegExp('^(?:' + SPONSORED_WORDS + ')$', 'i');
  const SPONSORED_LABEL = new RegExp('^(?:' + SPONSORED_WORDS + ')(?:\\s|$|[·:：-])', 'i');

  function hasSponsoredBadge(card) {
    for (const node of card.querySelectorAll(BADGE_SELECTOR)) {
      const label = (node.getAttribute('aria-label') || '').trim();
      if (label && SPONSORED_LABEL.test(label)) return true;

      const text = (node.textContent || '').trim();
      if (!text || text.length > 40) continue;
      if (node.matches('yt-badge-shape, .badge-shape-wiz__text, ytd-badge-supported-renderer, ytm-badge-and-byline-renderer, ytm-badge-renderer') &&
          SPONSORED_TEXT.test(text)) {
        return true;
      }
    }
    return false;
  }

  function isAdCard(card) {
    if (!card || card.nodeType !== 1) return false;
    if (card.querySelector(AD_SELECTOR)) return true;
    return hasSponsoredBadge(card);
  }

  const cardDisplay = new WeakMap();

  function applyCard(card) {
    if (!card || card.nodeType !== 1) return;
    const ad = isAdCard(card);
    card.classList.toggle('wpffl-yt-hidden', ad);

    // CSP가 <style> 주입을 막는 경우에도 숨겨지도록 인라인 스타일을 함께 사용합니다.
    if (ad) {
      if (!cardDisplay.has(card)) cardDisplay.set(card, card.style.display);
      card.style.setProperty('display', 'none', 'important');
    } else if (cardDisplay.has(card)) {
      const previous = cardDisplay.get(card);
      cardDisplay.delete(card);
      if (previous) card.style.display = previous;
      else card.style.removeProperty('display');
    }
  }

  function scanNode(node) {
    if (!node || node.nodeType !== 1) return;
    const el = node;

    if (el.matches(AD_SELECTOR)) {
      const card = el.closest(CARD_SELECTOR);
      if (card) applyCard(card);
    }
    if (el.matches(CARD_SELECTOR)) applyCard(el);

    for (const ad of el.querySelectorAll(AD_SELECTOR)) {
      const card = ad.closest(CARD_SELECTOR);
      if (card) applyCard(card);
    }
    for (const card of el.querySelectorAll(CARD_SELECTOR)) applyCard(card);
  }

  function scanAll() {
    for (const card of DOC.querySelectorAll(CARD_SELECTOR)) applyCard(card);
  }

  // ---------------------------------------------------------------------------
  // 4) 영상 광고 건너뛰기
  // ---------------------------------------------------------------------------
  const PLAYER_SELECTOR = '#movie_player, .html5-video-player';
  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    'button[class*="ytp-ad-skip"]',
    'button[class*="ytp-skip-ad"]',
  ];
  const OVERLAY_CLOSE_SELECTORS = [
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-overlay-close-container button',
  ];

  const adVideos = new Map();
  let adSession = false;

  function getPlayer() {
    return DOC.querySelector(PLAYER_SELECTOR);
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function hasAdUi(player) {
    if (!player) return false;
    for (const el of player.querySelectorAll(
      '.ytp-ad-player-overlay, .ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining, ' +
      '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, ' +
      '.ytp-ad-preview-container, .ytp-ad-text-overlay, .ytp-ad-image-overlay'
    )) {
      if (isVisible(el)) return true;
    }
    return false;
  }

  function isAdPlaying(player) {
    if (!player) return false;
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) return true;
    return hasAdUi(player);
  }

  function endAdSession() {
    adSession = false;
    for (const [video, state] of adVideos) {
      if (!video.isConnected) continue;
      try {
        video.muted = state.muted;
        video.volume = state.volume;
        video.playbackRate = state.rate;
      } catch { /* 요소가 이미 교체됨 */ }
    }
    adVideos.clear();
  }

  function handleVideoAd() {
    const player = getPlayer();
    if (!player) return;

    if (!isAdPlaying(player)) {
      if (adSession) endAdSession();
      return;
    }

    adSession = true;

    // 건너뛰기 버튼이 있으면 바로 누릅니다.
    for (const selector of SKIP_SELECTORS) {
      const button = player.querySelector(selector);
      if (button && isVisible(button)) {
        try { button.click(); } catch { /* 무시 */ }
        break;
      }
    }

    // 오버레이 광고 닫기
    for (const selector of OVERLAY_CLOSE_SELECTORS) {
      const button = player.querySelector(selector);
      if (button && isVisible(button)) {
        try { button.click(); } catch { /* 무시 */ }
      }
    }

    // `ad-showing` 클래스만 남은 순간에 본 영상을 건드리지 않도록,
    // 실제 광고 UI가 보이거나 ad-interrupting 상태일 때만 탐색합니다.
    if (!hasAdUi(player) && !player.classList.contains('ad-interrupting')) return;

    // 건너뛸 수 없는 광고는 끝으로 보내 즉시 종료합니다.
    for (const video of player.querySelectorAll('video')) {
      if (!video.isConnected) continue;
      if (!adVideos.has(video)) {
        adVideos.set(video, {
          muted: video.muted,
          volume: video.volume,
          rate: video.playbackRate,
        });
      }

      // 광고 소리가 새지 않도록 재생 중에는 항상 음소거합니다.
      try { video.muted = true; } catch { /* 무시 */ }

      if (Number.isFinite(video.duration) && video.duration > 0.2) {
        if (video.currentTime < video.duration - 0.15) {
          try { video.currentTime = video.duration; } catch { /* 무시 */ }
        }
      } else {
        // 길이를 알 수 없는 광고(라이브 등)는 음소거 + 고배속
        try {
          video.playbackRate = 16;
          if (video.paused) {
            const played = video.play();
            if (played && played.catch) played.catch(() => {});
          }
        } catch { /* 무시 */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5) 광고 차단 감지 팝업 제거 + 재생 재개
  // ---------------------------------------------------------------------------
  const ADBLOCK_TEXT = /(?:ad\s*block(?:er)?|adblock|광고\s*차단|애드블록|广告拦截|広告ブロック|блокировщик)/i;
  let hiddenTarget = null;

  function findEnforcement() {
    const enforcement = DOC.querySelector('ytd-enforcement-message-view-model');
    if (enforcement) {
      // ytd-popup-container는 다른 팝업도 담는 공용 컨테이너라 통째로 숨기지 않습니다.
      return enforcement.closest('tp-yt-paper-dialog') || enforcement;
    }

    // 팝업 모델 이름이 바뀐 경우를 위한 텍스트 기반 fallback.
    for (const dialog of DOC.querySelectorAll('tp-yt-paper-dialog')) {
      if (ADBLOCK_TEXT.test(dialog.textContent || '')) return dialog;
    }
    for (const container of DOC.querySelectorAll('ytd-popup-container')) {
      if (!ADBLOCK_TEXT.test(container.textContent || '')) continue;
      return container.querySelector('tp-yt-paper-dialog, ytd-enforcement-message-view-model') || container;
    }
    return null;
  }

  function resumeVideo() {
    const player = DOC.querySelector('#movie_player, ytd-player, .html5-video-player');
    if (!player) return;
    for (const video of player.querySelectorAll('video')) {
      if (!video.paused) continue;
      try {
        const played = video.play();
        if (played && played.catch) played.catch(() => {});
      } catch { /* 무시 */ }
    }
  }

  function handleAntiAdblock() {
    const target = findEnforcement();
    if (!target) {
      // 이전에 숨긴 요소가 공용 컨테이너였다면 되돌려 이후 팝업이 막히지 않게 합니다.
      if (hiddenTarget) {
        hiddenTarget.style.removeProperty('display');
        hiddenTarget.removeAttribute('aria-hidden');
        hiddenTarget = null;
      }
      return;
    }
    if (hiddenTarget && hiddenTarget !== target) {
      hiddenTarget.style.removeProperty('display');
      hiddenTarget.removeAttribute('aria-hidden');
    }
    hiddenTarget = null;

    // 닫기 버튼이 있으면 먼저 눌러 YouTube 쪽 상태를 정상화합니다.
    const dismiss = target.querySelector('#dismiss-button, button[aria-label*="닫기"], button[aria-label*="Close" i]');
    if (dismiss && isVisible(dismiss)) {
      try { dismiss.click(); } catch { /* 무시 */ }
    }

    if (target.tagName === 'YTD-POPUP-CONTAINER') {
      // 공용 컨테이너를 지우면 다른 팝업까지 막히므로 숨기고, 감지가 끝나면 되돌립니다.
      hiddenTarget = target;
      target.style.setProperty('display', 'none', 'important');
      target.setAttribute('aria-hidden', 'true');
    } else {
      // 감지 팝업 자체는 DOM에서 제거합니다. display:none만 두면 YouTube가
      // '숨겨진 팝업'을 감지 신호로 다시 볼 수 있습니다.
      target.remove();
    }

    for (const backdrop of DOC.querySelectorAll('tp-yt-iron-overlay-backdrop')) {
      backdrop.removeAttribute('opened');
      backdrop.remove();
    }

    // 팝업이 잠근 배경 스크롤 해제
    for (const el of [DOC.documentElement, DOC.body, DOC.querySelector('ytd-app')]) {
      if (!el) continue;
      try {
        if (getComputedStyle(el).overflow === 'hidden') {
          el.style.setProperty('overflow', 'auto', 'important');
        }
      } catch { /* 무시 */ }
    }

    resumeVideo();
    setTimeout(resumeVideo, 400);
    setTimeout(resumeVideo, 1200);
  }

  // ---------------------------------------------------------------------------
  // 6) 시작 / SPA 이동
  // ---------------------------------------------------------------------------
  let observer = null;

  function start() {
    injectCSS();
    scanAll();
    handleAntiAdblock();
    handleVideoAd();

    if (!observer && DOC.documentElement) {
      observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) scanNode(node);
        }
        handleAntiAdblock();
      });
      observer.observe(DOC.documentElement, { childList: true, subtree: true });
    }
  }

  if (DOC.readyState === 'loading') {
    DOC.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  for (const event of ['yt-navigate-finish', 'yt-page-data-updated']) {
    DOC.addEventListener(event, () => {
      scanAll();
      handleAntiAdblock();
      handleVideoAd();
    }, true);
  }

  setInterval(handleVideoAd, 500);
  setInterval(handleAntiAdblock, 1000);
})();
