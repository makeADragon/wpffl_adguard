// ==UserScript==
// @name         DevTools 보호 해제 (범용)
// @namespace    local.anti-devtools
// @version      1.0.0
// @description  F12·우클릭·드래그·텍스트선택 차단 및 무한 debugger 루프를 무력화
// @author       wpffl_adguard
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
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

  console.log('%c[Anti-Anti-DevTools] 활성화 완료', 'color:#27ae60;font-weight:bold');
})();
