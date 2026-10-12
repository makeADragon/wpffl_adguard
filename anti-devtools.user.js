// ==UserScript==
// @name         DevTools 보호 해제 (범용)
// @namespace    local.anti-devtools
// @version      1.3.0
// @description  F12·우클릭·드래그·선택 차단, 무한 debugger 루프, disable-devtool 등 관리자도구 감지 무력화 (넷플릭스·유튜브 제외)
// @author       wpffl_adguard
// @match        *://*/*
// @exclude      *://*.netflix.com/*
// @exclude      *://*.nflxvideo.net/*
// @exclude      *://*.nflxso.net/*
// @exclude      *://*.nflximg.net/*
// @exclude      *://*.youtube.com/*
// @exclude      *://youtu.be/*
// @exclude      *://*.youtube-nocookie.com/*
// @exclude      *://*.ytimg.com/*
// @exclude      *://*.googlevideo.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
// ※ 예외 사이트 추가 방법: 아래 코드의 EXCEPTION_DOMAINS 배열에 도메인만 추가하면 됩니다.
//   (메타데이터의 @exclude는 선택 사항 — 코드 검사만으로도 확실히 차단됩니다)

(function () {
  'use strict';

  // ---------- 0) 예외 사이트: 여기 등록한 사이트에서는 스크립트를 완전히 끕니다 ----------
  // 우클릭 등을 자체 기능으로 사용하는 사이트(예: 유튜브 연속재생 메뉴, 넷플릭스 플레이어 메뉴)를
  // 사용하려면 이 목록에 도메인을 추가하세요. 하위 도메인까지 자동으로 적용됩니다.
  const EXCEPTION_DOMAINS = [
    // --- 넷플릭스 ---
    'netflix.com',
    'nflxvideo.net',
    'nflxso.net',
    'nflximg.net',
    // --- 유튜브 (연속재생 등 우클릭 메뉴 보호) ---
    'youtube.com',
    'youtube-nocookie.com',
    'youtu.be',
    'ytimg.com',
    'googlevideo.com',
    // --- 필요 시 여기에 추가 ---
    // 'example.com',
    // 'tving.com',
  ];

  const _host = String(location.hostname || '').toLowerCase();
  const _excluded = EXCEPTION_DOMAINS.some(function (d) {
    d = String(d).toLowerCase();
    return _host === d || _host.endsWith('.' + d);
  });
  if (_excluded) return;

  if (window.__antiDevtoolsInstalled) return;
  window.__antiDevtoolsInstalled = true;

  // ---------- 1) 무한 debugger 루프 차단 ----------
  const _setInterval = window.setInterval;
  const _setTimeout = window.setTimeout;

  function hasDebugger(fn) {
    try {
      return typeof fn === 'function' &&
        /\bdebugger\b/.test(Function.prototype.toString.call(fn));
    } catch (e) { return false; }
  }

  window.setInterval = function (fn, delay, ...args) {
    if ((typeof fn === 'string' && /\bdebugger\b/.test(fn)) || hasDebugger(fn)) return 0;
    return _setInterval.call(this, fn, delay, ...args);
  };
  window.setTimeout = function (fn, delay, ...args) {
    if ((typeof fn === 'string' && /\bdebugger\b/.test(fn)) || hasDebugger(fn)) return 0;
    return _setTimeout.call(this, fn, delay, ...args);
  };

  // new Function('debugger') 형태 차단
  try {
    const NativeFunction = window.Function;
    const SafeFunction = function (...a) {
      const body = a.length ? String(a[a.length - 1]) : '';
      return /\bdebugger\b/.test(body) ? function () {} : NativeFunction.apply(null, a);
    };
    SafeFunction.prototype = NativeFunction.prototype;
    window.Function = SafeFunction;
    NativeFunction.prototype.constructor = SafeFunction;
  } catch (e) {}

  // ---------- 2) F12 / 단축키 차단 무력화 ----------
  function isDevtoolsKey(e) {
    const key = String(e.key || '').toUpperCase();
    const code = String(e.code || '').toUpperCase();
    const kc = e.keyCode || e.which || 0;
    const mod = e.ctrlKey || e.metaKey;
    if (code === 'F12' || key === 'F12' || kc === 123) return true;
    if (mod && e.shiftKey && 'IJCKU'.includes(key)) return true;
    if (mod && (key === 'U' || key === 'S' || key === 'P')) return true;
    return false;
  }
  window.addEventListener('keydown', function (e) {
    if (isDevtoolsKey(e)) {
      e.stopImmediatePropagation();
      e.stopPropagation();
    }
  }, true);

  // ---------- 3) 우클릭 / 선택 / 드래그 / 복사 차단 무력화 ----------
  ['contextmenu', 'selectstart', 'dragstart', 'copy', 'cut'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      e.stopImmediatePropagation();
      e.stopPropagation();
    }, true);
  });

  // ---------- 4) 창 크기 감지(outerWidth) 무력화 ----------
  try {
    Object.defineProperty(window, 'outerWidth',  { get: function () { return window.innerWidth;  }, configurable: true });
    Object.defineProperty(window, 'outerHeight', { get: function () { return window.innerHeight; }, configurable: true });
  } catch (e) {}

  // ---------- 5) console 기반 감지 무력화 ----------
  // disable-devtool 등은 console.log/table에 객체를 넘겨 DevTools가 열려 있을 때
  // getter/toString이 호출되는 것을 감지합니다. 객체/함수 인자는 원본 console에
  // 전달하지 않고 무시해 감지를 막습니다. (문자열·숫자 로그는 그대로 동작)
  (function () {
    function isPrimitive(v) {
      return v === null || (typeof v !== 'object' && typeof v !== 'function');
    }
    ['log', 'table', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml'].forEach(function (m) {
      try {
        var c = window.console;
        if (!c || typeof c[m] !== 'function') return;
        var orig = c[m];
        c['__orig_' + m] = orig;
        c[m] = function () {
          var args = Array.prototype.slice.call(arguments);
          for (var i = 0; i < args.length; i++) {
            if (!isPrimitive(args[i])) return; // 객체/함수 → 감지 트랩일 수 있으므로 무시
          }
          return orig.apply(c, arguments);
        };
      } catch (e) {}
    });
    try { if (window.console) window.console.clear = function () {}; } catch (e) {}
  })();

  // ---------- 6) 알려진 anti-devtool 스크립트 로드 차단 ----------
  (function () {
    var blocked = /disable-devtool|devtools-detect|devtools-detector|anti-devtool|debug-prevent/i;
    function isBlocked(el) {
      return el && el.tagName === 'SCRIPT' && blocked.test(String(el.src || ''));
    }
    var _append = Node.prototype.appendChild;
    var _insert = Node.prototype.insertBefore;
    Node.prototype.appendChild = function (el) {
      if (isBlocked(el)) return el;
      return _append.call(this, el);
    };
    Node.prototype.insertBefore = function (el, ref) {
      if (isBlocked(el)) return el;
      return _insert.call(this, el, ref);
    };
  })();

  console.log('%c[Anti-Anti-DevTools] 활성화 완료', 'color:#27ae60;font-weight:bold');
})();
