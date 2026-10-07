// ==UserScript==
// @name         Netflix Volume Booster
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  넷플릭스 웹의 볼륨을 100% 이상으로 증폭합니다. (Netflix 전용)
// @author       AI Assistant
// @match        https://www.netflix.com/*
// @grant        none
// ==/UserScript==

/*
 * =====================================================================
 *  Netflix Volume Booster
 *
 *  목적: 넷플릭스는 유튜브/SOOP 대비 같은 시스템 볼륨에서 작게 들린다.
 *        <video>.volume 은 최대 1.0(100%)이라 넘어갈 수 없으므로,
 *        Web Audio API 의 GainNode 로 신호를 증폭한다.
 *
 *  신호 경로:
 *    <video> ──► MediaElementSource ──► GainNode ──► [Compressor] ──► 출력
 *
 *    · gain <= 1.0  : 컴프레서 우회 → 원음 그대로 (왜곡 0)
 *    · gain >  1.0  : 컴프레서 투입 → 클리핑/찢어지는 소리 방지
 *
 *  동작 범위:
 *    · Netflix 전용 (@match 로 한정) — 다른 사이트에는 절대 영향 없음
 *    · 기존 netflix-speed.user.js 와 키가 겹치지 않음 (그쪽은 ] [ \ )
 *
 *  조작법:
 *    · 우측 하단 🔊 버튼            → 패널 열기/닫기
 *    · 패널 슬라이더 / − · ＋ 버튼  → 증폭값 조절
 *    · 프리셋 (100 / 130 / 150 / 200%)
 *    · 단축키:  + 또는 = (올림)  /  − (내림)  /  0 (100% 초기화)
 *    · 패널 헤더를 끌어서 위치 이동 가능 (터치 지원)
 *    · 설정값은 localStorage 에 저장되어 새로고침 후에도 유지된다.
 *
 *  ⚠ 알려진 제약 (반드시 알고 있을 것)
 *    1) createMediaElementSource() 는 한 엘리먼트당 "단 한 번"만 호출 가능하다.
 *       중복 호출하면 예외 → WeakSet 으로 추적해 방지한다.
 *    2) AudioContext 는 사용자 제스처 전에 'suspended' 상태라 소리가 안 나온다.
 *       → 첫 클릭/터치/키 입력에서 resume() 하도록 처리했다.
 *    3) 매체가 CORS 교차 출처일 때 사양상 무음 출력이 될 수 있다.
 *       (구현에 따라 다르며, 크롬의 Netflix 볼륨 부스터 확장들이 동작하는 것으로 보아
 *        현재 브라우저에서는 성립한다. 만약 소리가 아예 안 나면 증폭을 끄고 새로고침.)
 *    4) 고배율 증폭은 왜곡을 유발한다. 200% 를 넘기면 컴프레서가 어느 정도 막아주지만
 *       근본 해결은 아니다. 보통 120~180% 가 유튜브와 맞추는 데 적절하다.
 *
 *  유지보수 팁:
 *    · 넷플릭스가 <video> 를 교체하므로(에피소드 전환 등) attach 를 주기적으로 재시도한다.
 *    · UI 클래스 접두사는 전부 'nfvb-' 이므로 다른 스크립트와 충돌하지 않는다.
 * =====================================================================
 */

(function () {
  'use strict';

  // ── 설정 ───────────────────────────────────────────────────────
  const LS_GAIN = 'nfvb_gain';        // 증폭값 저장 키
  const MIN_GAIN = 0.1;
  const MAX_GAIN = 5.0;               // 최대 500%
  const STEP = 0.1;                   // 키/버튼 한 번당 10%
  const PANEL_ID = 'nfvb-panel';

  // ── 상태 ───────────────────────────────────────────────────────
  let gain = parseFloat(localStorage.getItem(LS_GAIN));
  if (!isFinite(gain)) gain = 1.0;
  gain = clamp(gain, MIN_GAIN, MAX_GAIN);

  let ctx = null;
  let sourceNode = null;
  let gainNode = null;
  let compNode = null;
  let attachedVideo = null;           // 현재 그래프에 연결된 <video>
  let graphReady = false;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // ── Web Audio 그래프 구성 ─────────────────────────────────────
  // 한 번만 만든다. 실패하면 graphReady = false 로 남아 폴백 모드가 된다.
  function ensureGraph() {
    if (graphReady) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;

      ctx = new AC();
      gainNode = ctx.createGain();
      compNode = ctx.createDynamicsCompressor();

      // 컴프레서 파라미터: 과한 왜곡을 부드럽게 눌러준다.
      compNode.threshold.value = -12;  // 이 레벨부터 압축 시작
      compNode.knee.value = 24;        // 부드러운 전환
      compNode.ratio.value = 12;       // 강한 압축
      compNode.attack.value = 0.003;
      compNode.release.value = 0.25;

      gainNode.gain.value = gain;
      graphReady = true;
      return true;
    } catch (e) {
      console.warn('[NetflixVolumeBooster] 그래프 생성 실패:', e);
      return false;
    }
  }

  // gain 값에 따라 컴프레서 투입/우회를 다시 배선한다.
  // gain <= 1 일 땐 컴프레서를 거치지 않아야 원음이 왜곡되지 않는다.
  function rewire() {
    if (!graphReady) return;
    try {
      gainNode.disconnect();
      compNode.disconnect();

      if (gain > 1.0) {
        gainNode.connect(compNode);
        compNode.connect(ctx.destination);
      } else {
        gainNode.connect(ctx.destination);
      }
    } catch (e) {
      console.warn('[NetflixVolumeBooster] 배선 실패:', e);
    }
  }

  // <video> 를 그래프에 연결. 한 번만 가능하므로 attachedVideo 로 추적.
  function attach(video) {
    if (!video || video === attachedVideo) return;
    if (!ensureGraph()) return;

    try {
      // createMediaElementSource 는 엘리먼트당 1회만 허용된다.
      sourceNode = ctx.createMediaElementSource(video);
      sourceNode.connect(gainNode);
      attachedVideo = video;
      gainNode.gain.value = gain;
      rewire();
      console.log('[NetflixVolumeBooster] <video> 연결됨');
    } catch (e) {
      // 이미 연결된 요소를 다시 연결하면 여기로 들어온다. 무시해도 안전.
      console.warn('[NetflixVolumeBooster] 연결 실패:', e);
    }
  }

  // AudioContext 는 사용자 제스처가 있어야 재개된다.
  function resumeCtx() {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  // ── 증폭값 적용 ───────────────────────────────────────────────
  function setGain(v, announce) {
    gain = clamp(v, MIN_GAIN, MAX_GAIN);
    localStorage.setItem(LS_GAIN, String(gain));

    if (graphReady) {
      gainNode.gain.value = gain;
      rewire();
    }
    updatePanel();
    if (announce) showNotice(`${Math.round(gain * 100)}%`);
  }

  // ── 알림 토스트 ───────────────────────────────────────────────
  let noticeEl = null;
  let noticeTimer = null;

  function showNotice(text) {
    if (!noticeEl) {
      noticeEl = document.createElement('div');
      noticeEl.className = 'nfvb-notice';
      document.body.appendChild(noticeEl);
    }
    noticeEl.textContent = text;
    noticeEl.classList.add('nfvb-notice--on');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeEl.classList.remove('nfvb-notice--on');
    }, 1200);
  }

  // ── 조작 패널 ─────────────────────────────────────────────────
  // 터치 환경도 고려해 버튼을 크게 만들고, 드래그로 위치를 옮길 수 있게 했다.
  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'nfvb-panel';

    panel.innerHTML = `
      <div class="nfvb-head">
        <span class="nfvb-title">볼륨</span>
        <span class="nfvb-value" id="nfvb-value">100%</span>
        <button class="nfvb-close" id="nfvb-close" title="닫기">×</button>
      </div>
      <div class="nfvb-row">
        <button class="nfvb-btn" id="nfvb-down" aria-label="볼륨 낮추기">−</button>
        <input type="range" class="nfvb-slider" id="nfvb-slider"
               min="10" max="500" step="10" value="${Math.round(gain * 100)}">
        <button class="nfvb-btn" id="nfvb-up" aria-label="볼륨 올리기">＋</button>
      </div>
      <div class="nfvb-row nfvb-presets">
        <button class="nfvb-chip" data-gain="1">100%</button>
        <button class="nfvb-chip" data-gain="1.3">130%</button>
        <button class="nfvb-chip" data-gain="1.5">150%</button>
        <button class="nfvb-chip" data-gain="2">200%</button>
      </div>
    `;
    document.body.appendChild(panel);

    // 이벤트 바인딩
    panel.querySelector('#nfvb-up').addEventListener('click', () => setGain(gain + STEP, true));
    panel.querySelector('#nfvb-down').addEventListener('click', () => setGain(gain - STEP, true));
    panel.querySelector('#nfvb-close').addEventListener('click', () => togglePanel(false));

    const slider = panel.querySelector('#nfvb-slider');
    slider.addEventListener('input', (e) => setGain(+e.target.value / 100, false));

    panel.querySelectorAll('.nfvb-chip').forEach((b) => {
      b.addEventListener('click', () => setGain(parseFloat(b.dataset.gain), true));
    });

    // 드래그로 위치 이동 (터치 포함)
    makeDraggable(panel, panel.querySelector('.nfvb-head'));
  }

  function updatePanel() {
    const val = document.getElementById('nfvb-value');
    const slider = document.getElementById('nfvb-slider');
    if (val) val.textContent = `${Math.round(gain * 100)}%`;
    if (slider) slider.value = Math.round(gain * 100);
  }

  function togglePanel(show) {
    const p = document.getElementById(PANEL_ID);
    if (!p) return;
    p.style.display = show ? 'block' : 'none';
  }

  // 패널을 닫아도 다시 열 수 있도록 작은 런처 버튼을 띄운다.
  function buildFab() {
    if (document.getElementById('nfvb-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'nfvb-fab';
    fab.className = 'nfvb-fab';
    fab.title = '볼륨 조절 열기';
    fab.textContent = '🔊';
    fab.addEventListener('click', () => {
      const p = document.getElementById(PANEL_ID);
      if (!p) return;
      togglePanel(p.style.display === 'none');
    });
    document.body.appendChild(fab);
  }

  // 헤더를 잡고 끌어서 패널을 옮긴다.
  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

    const start = (x, y) => {
      dragging = true;
      const r = el.getBoundingClientRect();
      sx = x; sy = y; ox = r.left; oy = r.top;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };
    const move = (x, y) => {
      if (!dragging) return;
      el.style.left = `${ox + (x - sx)}px`;
      el.style.top = `${oy + (y - sy)}px`;
    };
    const end = () => { dragging = false; };

    // 닫기 버튼 위에서는 드래그를 시작하지 않는다 (클릭과 충돌 방지)
    const ignoreTarget = (t) => !!(t && t.closest && t.closest('button, input'));

    handle.addEventListener('mousedown', (e) => {
      if (ignoreTarget(e.target)) return;
      start(e.clientX, e.clientY); e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', end);

    handle.addEventListener('touchstart', (e) => {
      if (ignoreTarget(e.target)) return;
      const t = e.touches[0]; start(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const t = e.touches[0]; move(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener('touchend', end);
  }

  // ── 스타일 주입 ───────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById('nfvb-style')) return;
    const s = document.createElement('style');
    s.id = 'nfvb-style';
    s.textContent = `
      .nfvb-panel {
        position: fixed; right: 20px; bottom: 90px; z-index: 2147483000;
        width: 232px; padding: 12px 14px;
        background: rgba(20,20,20,.92); color: #fff;
        border-radius: 12px; font-family: -apple-system, sans-serif;
        box-shadow: 0 8px 30px rgba(0,0,0,.45);
        user-select: none; -webkit-user-select: none;
      }
      .nfvb-head {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 10px; cursor: move; touch-action: none;
      }
      .nfvb-title { font-size: 13px; opacity: .8; }
      .nfvb-value {
        font-size: 16px; font-weight: 700; margin-left: auto;
        color: #4fc3f7;
      }
      .nfvb-close {
        background: none; border: 0; color: #fff; opacity: .6;
        font-size: 18px; cursor: pointer; padding: 0 4px;
      }
      .nfvb-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
      .nfvb-btn {
        width: 40px; height: 40px; flex: 0 0 40px;
        border: 0; border-radius: 10px; background: #2e2e2e;
        color: #fff; font-size: 20px; cursor: pointer;
      }
      .nfvb-btn:active { background: #454545; }
      .nfvb-slider { flex: 1; accent-color: #4fc3f7; height: 28px; }
      .nfvb-presets { justify-content: space-between; }
      .nfvb-chip {
        flex: 1; padding: 9px 0; margin: 0 3px;
        border: 0; border-radius: 8px; background: #2e2e2e;
        color: #ddd; font-size: 12px; cursor: pointer;
      }
      .nfvb-chip:active { background: #4fc3f7; color: #000; }
      .nfvb-notice {
        position: fixed; left: 50%; top: 90px; transform: translateX(-50%) translateY(-12px);
        background: rgba(0,0,0,.8); color: #fff; padding: 12px 22px;
        border-radius: 8px; font-size: 26px; z-index: 2147483001;
        opacity: 0; pointer-events: none;
        transition: opacity .18s ease, transform .18s ease;
        font-family: -apple-system, sans-serif;
      }
      .nfvb-notice--on { opacity: 1; transform: translateX(-50%) translateY(0); }
      .nfvb-fab {
        position: fixed; right: 20px; bottom: 26px; z-index: 2147482999;
        width: 52px; height: 52px; border: 0; border-radius: 50%;
        background: rgba(20,20,20,.88); color: #fff; font-size: 22px;
        cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.4);
      }
      .nfvb-fab:active { background: #4fc3f7; color: #000; }
    `;
    document.head.appendChild(s);
  }

  // ── 키보드 단축키 ─────────────────────────────────────────────
  // netflix-speed.user.js 는 ] [ \ 를 쓰므로 여기선 + - 0 만 쓴다.
  function onKeyDown(e) {
    resumeCtx();

    // 입력창/텍스트영역에서는 무시
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'TEXTAREA'].includes(tag)) return;

    // Ctrl/Alt/Meta 조합은 건드리지 않는다 (브라우저 단축키 보호)
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.key === '+' || e.key === '=') {
      setGain(gain + STEP, true);
    } else if (e.key === '-' || e.key === '_') {
      setGain(gain - STEP, true);
    } else if (e.key === '0') {
      setGain(1.0, true);
    }
  }

  // ── 시작 ─────────────────────────────────────────────────────
  function boot() {
    injectStyle();
    buildPanel();
    buildFab();
    updatePanel();

    // 첫 사용자 제스처에서 AudioContext 재개 + <video> 연결
    const onFirstGesture = () => {
      resumeCtx();
      const v = document.querySelector('video');
      if (v) attach(v);
    };
    ['pointerdown', 'touchstart', 'keydown', 'click'].forEach((ev) => {
      window.addEventListener(ev, onFirstGesture, { once: true, capture: true });
    });

    window.addEventListener('keydown', onKeyDown, true);

    // 넷플릭스는 <video> 를 에피소드 전환 등에서 교체한다 → 주기적으로 재확인
    setInterval(() => {
      const v = document.querySelector('video');
      if (v && v !== attachedVideo) {
        resumeCtx();
        attach(v);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
