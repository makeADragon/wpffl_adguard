// ==UserScript==
// @name         kisskh 한글 도우미 (제목 번역 + 자막 개선)
// @namespace    local.kisskh.ko
// @version      1.2.2
// @description  kisskh.co 드라마 제목을 한국어로 표시하고, 자막을 개선합니다 (영한 동시자막 / AI 재번역).
// @author       wpffl_adguard
// @match        https://kisskh.co/*
// @match        https://kisskh.do/*
// @match        https://kisskh.is/*
// @match        https://kisskh.la/*
// @match        https://kisskh.id/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';
  if (window.__kkhInstalled) return;
  window.__kkhInstalled = true;

  /* ------------------------------------------------------------------ *
   * 0. 공통 상수 / 설정
   * ------------------------------------------------------------------ */
  const HANGUL_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;
  const SUB_API_RE = /\/api\/Sub\/\d+/;
  const MEDIA_RE = /(\.m3u8|\.ts(\?|#|$)|\.m4s|\.mp4|\.aac|m3u8)/i;
  const mediaStats = {}; // host -> {n, total, last} — 버퍼링 원인 호스트 진단용
  const NEG_MS = 864e5; // 제목을 못 찾은 경우 재조회 간격 (1일)
  const LS = {
    settings: 'kkh_settings_v1',
    titles: 'kkh_titles_v1',
    subsPrefix: 'kkh_sub_v1_',
    subsIndex: 'kkh_sub_index_v1'
  };
  const DEFAULTS = {
    titlesOn: true,
    aiTitles: false, // 위키에 없으면 AI로 임시 번역 (기본 꺼짐)
    subMode: 'dual', // off | dual | ai
    provider: 'gemini', // gemini | openai
    apiKey: '',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://api.openai.com/v1'
  };

  function loadJSON(key, def) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : def;
    } catch (e) { return def; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function normKey(s) {
    return String(s || '').toLowerCase().replace(/[^0-9a-z\uAC00-\uD7A3]/g, '');
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function fetchJson(url, opts, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
      fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
        .then(r => {
          if (r.ok) return r.json();
          // 429 본문의 retryDelay(예: "18s")를 읽어 대기시간으로 활용한다
          return r.text().catch(() => '').then(body => {
            const err = new Error('HTTP ' + r.status);
            err.status = r.status;
            const m = String(body).match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
            if (m) err.retryAfterMs = Math.ceil(parseFloat(m[1]) * 1000);
            throw err;
          });
        })
        .then(j => { clearTimeout(timer); resolve(j); })
        .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  let settings = Object.assign({}, DEFAULTS, loadJSON(LS.settings, {}));
  function saveSettings() { saveJSON(LS.settings, settings); }

  /* ------------------------------------------------------------------ *
   * 1. 제목 캐시 / 검색 캐시
   * ------------------------------------------------------------------ */
  const titleCache = loadJSON(LS.titles, {});   // normEn -> {ko, ai, en, ts}
  let titleSaveTimer = null;
  function scheduleTitleSave() {
    if (titleSaveTimer) return;
    titleSaveTimer = setTimeout(() => { titleSaveTimer = null; saveJSON(LS.titles, titleCache); }, 700);
  }

  function titleVariants(raw) {
    const base = String(raw || '').replace(/\((\d{4})\)\s*$/, '').replace(/\s+/g, ' ').trim();
    const out = [];
    if (base) out.push(base);
    const dash = base.split(' - ')[0].trim();
    if (dash && dash !== base) out.push(dash);
    const colon = base.split(':')[0].trim();
    if (colon && colon !== base && colon.length >= 5) out.push(colon);
    return out;
  }

  function similarTitle(a, b) {
    const clean = s => String(s || '').toLowerCase()
      .replace(/^(the|a|an)\s+/i, '')
      .replace(/[^0-9a-z\uAC00-\uD7A3\s]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const x = clean(a), y = clean(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const wx = new Set(x.split(' ')), wy = new Set(y.split(' '));
    let inter = 0;
    for (const w of wx) if (wy.has(w)) inter++;
    return inter / Math.max(wx.size, wy.size) >= 0.7;
  }

  /* --- 1a. Wikipedia (영문 문서 → 한국어 인터링크) --- */
  async function wikiLookup(raw) {
    for (const v of titleVariants(raw)) {
      try {
        const u = 'https://en.wikipedia.org/w/api.php?action=query&generator=search' +
          '&gsrsearch=' + encodeURIComponent(v) + '&gsrlimit=3&gsrnamespace=0' +
          '&prop=langlinks&lllang=ko&format=json&origin=*';
        const d = await fetchJson(u);
        const pages = (d.query && d.query.pages) || {};
        const list = Object.values(pages).sort((a, b) => (a.index || 9) - (b.index || 9));
        for (const p of list) {
          const title = String(p.title || '').replace(/\s*\([^)]*\)\s*$/, '');
          if (!similarTitle(title, v)) continue;
          const ko = p.langlinks && p.langlinks[0] && p.langlinks[0]['*'];
          if (ko && HANGUL_RE.test(ko)) return ko;
        }
      } catch (e) {}
    }
    return null;
  }

  /* --- 1b. Wikidata (한국어 라벨) --- */
  async function wikidataLookup(raw) {
    for (const v of titleVariants(raw)) {
      try {
        const su = 'https://www.wikidata.org/w/api.php?action=wbsearchentities' +
          '&search=' + encodeURIComponent(v) + '&language=en&format=json&origin=*&limit=8';
        const d = await fetchJson(su);
        const cands = (d.search || []).filter(x =>
          similarTitle(x.label || '', v) &&
          /series|drama|television|film|anime/i.test(x.description || ''));
        if (!cands.length) continue;
        const ids = cands.slice(0, 3).map(x => x.id).join('|');
        const eu = 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' + ids +
          '&props=labels&languages=en|ko&format=json&origin=*';
        const d2 = await fetchJson(eu);
        for (const c of cands) {
          const e = d2.entities && d2.entities[c.id];
          const ko = e && e.labels && e.labels.ko && e.labels.ko.value;
          if (ko && HANGUL_RE.test(ko)) return ko;
        }
      } catch (e) {}
    }
    return null;
  }

  /* --- 1c. 통합 조회 (캐시 → Wikipedia → Wikidata) --- */
  let titleBlockUntil = 0; // 429(요청 제한) 발생 시 잠시 중단
  function noteError(e) {
    if (e && /429/.test(String(e.message || e))) titleBlockUntil = Date.now() + 90000;
  }

  const TITLE_PROMPT = [
    '당신은 영화/드라마 제목 번역가입니다. 주어진 영어 제목을 한국에서 통용되는 자연스러운 한국어 제목으로 옮기세요.',
    '규칙:',
    '1) 공식 한국어 개봉/방영 제목이 있으면 그것을 사용합니다.',
    '2) 괄호, 따옴표, 설명, 원제를 덧붙이지 말고 제목만 씁니다.',
    '3) 입력과 같은 개수의 문자열을 담은 JSON 배열만 출력합니다.'
  ].join('\n');

  async function translateTitleKo(raw) {
    if (!settings.apiKey || !settings.aiTitles) return null;
    try {
      const arr = await pacedCall([String(raw || '')], null, TITLE_PROMPT);
      const ko = arr && arr[0] ? String(arr[0]).replace(/^[\s"'\[\]]+|[\s"'\[\]]+$/g, '') : '';
      if (ko && HANGUL_RE.test(ko) && normKey(ko) !== normKey(raw)) return ko;
    } catch (e) { noteError(e); }
    return null;
  }

  const titlePending = new Map();
  async function lookupKoTitle(raw) {
    if (Date.now() < titleBlockUntil) return null;
    const key = normKey(titleVariants(raw)[0] || raw);
    if (!key) return null;
    const c = titleCache[key];
    if (c && (c.ko || Date.now() - c.ts < NEG_MS)) return { ko: c.ko || null, ai: !!c.ai };
    if (titlePending.has(key)) return titlePending.get(key);
    const job = (async () => {
      let ko = null, ai = false;
      try { ko = await wikiLookup(raw); } catch (e) { noteError(e); }
      if (!ko) { try { ko = await wikidataLookup(raw); } catch (e) { noteError(e); } }
      if (!ko && settings.aiTitles) {
        ko = await translateTitleKo(raw);
        ai = !!ko;
      }
      titleCache[key] = { ko: ko || null, ai: ai, en: String(raw || '').trim(), ts: Date.now() };
      scheduleTitleSave();
      return { ko: ko || null, ai: ai };
    })();
    titlePending.set(key, job);
    try { return await job; } finally { titlePending.delete(key); }
  }

  /* ------------------------------------------------------------------ *
   * 2. 제목 한국어 표시 (카드/상세/에피소드)
   * ------------------------------------------------------------------ */
  const titleQueue = [];
  let titleActive = 0;
  function pumpTitleQueue() {
    while (titleActive < 2 && titleQueue.length) {
      const job = titleQueue.shift();
      titleActive++;
      lookupKoTitle(job.text).then(res => {
        if (res && res.ko && (!res.ai || settings.aiTitles)) applyKorean(job.el, res.ko, job.text, res.ai);
        else if (job.el.isConnected) job.el.dataset.kkhDone = '1';
      }).catch(() => {}).finally(() => {
        titleActive--;
        setTimeout(pumpTitleQueue, 150);
      });
    }
  }

  function applyKorean(el, ko, en, ai) {
    if (!el || !el.isConnected) return;
    if (!ko || normKey(ko) === normKey(en)) { el.dataset.kkhDone = '1'; return; }
    el.dataset.kkhDone = '1';
    el.dataset.kkhEn = en;
    el.classList.add('kkh-title');
    if (ai) el.classList.add('kkh-ai'); else el.classList.remove('kkh-ai');
    const textNodes = Array.prototype.filter.call(el.childNodes, n => n.nodeType === 3 && n.textContent.trim());
    if (textNodes.length) {
      textNodes[0].textContent = ko;
      for (let i = 1; i < textNodes.length; i++) textNodes[i].textContent = '';
    } else {
      el.textContent = ko;
    }
    if (!el.getAttribute('title')) el.setAttribute('title', (ai ? '(AI 번역) ' : '') + en);
  }

  function restoreTitles() {
    document.querySelectorAll('.kkh-title[data-kkh-en]').forEach(el => {
      el.textContent = el.dataset.kkhEn;
      el.classList.remove('kkh-ai');
    });
  }

  function reapplyTitles() {
    document.querySelectorAll('.kkh-title[data-kkh-en]').forEach(el => {
      const en = el.dataset.kkhEn;
      const key = normKey(titleVariants(en)[0] || en);
      const c = titleCache[key];
      if (c && c.ko && (!c.ai || settings.aiTitles)) applyKorean(el, c.ko, en, c.ai);
    });
    scanTitles();
  }

  const seenTitles = new WeakSet();
  function isNearViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      const h = window.innerHeight || 900;
      return r.width > 0 && r.bottom > -500 && r.top < h + 500;
    } catch (e) { return true; }
  }

  function enqueueTitle(el) {
    if (!el.isConnected || el.dataset.kkhDone) return;
    const text = (el.textContent || '').trim();
    if (!text || text.length < 2 || text.length > 150) return;
    const key = normKey(titleVariants(text)[0] || text);
    const c = titleCache[key];
    if (c && c.ko) {
      if (c.ai && !settings.aiTitles) { el.dataset.kkhDone = '1'; return; }
      applyKorean(el, c.ko, text, c.ai);
      return;
    }
    if (c && !c.ko && Date.now() - c.ts < NEG_MS) { el.dataset.kkhDone = '1'; return; }
    titleQueue.push({ el, text });
    pumpTitleQueue();
  }

  function scanTitles() {
    if (!settings.titlesOn) return;
    const els = document.querySelectorAll('mat-card-title');
    for (const el of els) {
      if (seenTitles.has(el)) continue;
      const cls = String(el.className || '');
      if (cls.indexOf('mx-xl-5') >= 0) continue; // 섹션 헤더("Continue watching" 등)
      if (el.dataset.kkhDone) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length < 2 || text.length > 150) continue;
      if (/chevron_right/.test(text)) continue;
      if (!isNearViewport(el)) continue; // 화면 밖이면 다음 스캔(스크롤) 때 처리
      seenTitles.add(el);
      enqueueTitle(el);
    }
  }

  let scanTimer = null;
  function scheduleScanTitles() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scanTitles(); }, 350);
  }

  /* ------------------------------------------------------------------ *
   * 3. 자막: Sub API / SRT 가로채기
   * ------------------------------------------------------------------ */
  let lastSubs = null; // { epId, list }
  function onSubsCaptured(url, list) {
    const m = String(url).match(/\/api\/Sub\/(\d+)/);
    lastSubs = { epId: m ? m[1] : null, list: list, ts: Date.now() };
    if (settings.subMode !== 'off') setStatus('자막 목록 확인됨 (한국어 자막 선택 시 개선 적용)');
  }

  function parseXhrBody(xhr) {
    try {
      if (xhr.responseType === '' || xhr.responseType === 'text') {
        return JSON.parse(xhr.responseText);
      }
      return xhr.response;
    } catch (e) { return null; }
  }

  (function hookXHR() {
    const XHR = window.XMLHttpRequest;
    if (!XHR) return;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__kkhUrl = typeof url === 'string' ? url : String(url);
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const url = this.__kkhUrl || '';

      // (0) 재생 플레이리스트 URL 기억 (미리 받기용)
      if (/\.m3u8/i.test(url)) { lastM3u8Url = url; lastM3u8Href = location.href; }

      // (1) 자막 목록 응답 캡처 (읽기 전용)
      if (SUB_API_RE.test(url)) {
        this.addEventListener('load', () => {
          try {
            const data = parseXhrBody(this);
            if (Array.isArray(data)) onSubsCaptured(url, data);
          } catch (e) {}
        });
      }

      // (2) 미리 받아둔 세그먼트면 네트워크 대신 IndexedDB에서 응답
      if (warmUrls.has(url) && this.responseType === 'arraybuffer') {
        const xhr = this;
        let cancelled = false;
        const nativeAbort = xhr.abort;
        xhr.abort = function () { cancelled = true; try { nativeAbort.call(xhr); } catch (e) {} };
        idbGet(url).then(buf => {
          if (cancelled) return;
          if (!buf) { origSend.call(xhr, body); return; }
          try {
            Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });
            Object.defineProperty(xhr, 'status', { configurable: true, get: () => 200 });
            Object.defineProperty(xhr, 'statusText', { configurable: true, get: () => 'OK' });
            Object.defineProperty(xhr, 'response', { configurable: true, get: () => buf });
            xhr.getResponseHeader = function () { return null; };
            xhr.getAllResponseHeaders = function () { return ''; };
          } catch (e) {}
          xhr.dispatchEvent(new Event('readystatechange'));
          try { xhr.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: buf.byteLength, total: buf.byteLength })); } catch (e) {}
          xhr.dispatchEvent(new Event('load'));
          xhr.dispatchEvent(new Event('loadend'));
        }).catch(() => { try { if (!cancelled) origSend.call(xhr, body); } catch (e) {} });
        return;
      }

      // (3) 영상(m3u8/세그먼트) 요청 시간 집계 — 버퍼링 원인 호스트 확인용
      if (MEDIA_RE.test(url)) {
        const t0 = Date.now();
        const done = () => {
          const host = url.split('/')[2] || '?';
          const s = mediaStats[host] || (mediaStats[host] = { n: 0, total: 0, last: 0 });
          s.n++;
          s.last = Date.now() - t0;
          s.total += s.last;
        };
        this.addEventListener('load', done, { once: true });
        this.addEventListener('error', done, { once: true });
        this.addEventListener('abort', done, { once: true });
      }

      return origSend.apply(this, arguments);
    };
  })();

  // fetch 기반 요청도 캡처 (예비)
  (function hookFetch() {
    const origFetch = window.fetch;
    if (!origFetch) return;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\.m3u8/i.test(url)) { lastM3u8Url = url; lastM3u8Href = location.href; }
      return origFetch.apply(this, arguments).then(res => {
        if (SUB_API_RE.test(url)) {
          try {
            res.clone().json().then(data => {
              if (Array.isArray(data)) onSubsCaptured(url, data);
            }).catch(() => {});
          } catch (e) {}
        }
        return res;
      });
    };
  })();

  /* ------------------------------------------------------------------ *
   * 4. SRT 파싱 / 영어 자막 확보
   * ------------------------------------------------------------------ */
  const srtCache = new Map(); // url -> cues[]
  function parseSrt(text) {
    const out = [];
    const blocks = String(text).replace(/\r/g, '').replace(/^\uFEFF/, '').split(/\n\n+/);
    for (const b of blocks) {
      const lines = b.split('\n').filter(l => l.trim().length);
      if (lines.length < 2) continue;
      const ti = lines.findIndex(l => l.indexOf('-->') >= 0);
      if (ti < 0) continue;
      const m = lines[ti].match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
      if (!m) continue;
      const startMs = ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000) + +String(m[4]).padEnd(3, '0');
      const endMs = ((+m[5] * 3600 + +m[6] * 60 + +m[7]) * 1000) + +String(m[8]).padEnd(3, '0');
      out.push({ startMs, endMs, text: lines.slice(ti + 1).join('\n') });
    }
    return out;
  }
  async function getEnCues(url) {
    if (srtCache.has(url)) return srtCache.get(url);
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const cues = parseSrt(await r.text());
      srtCache.set(url, cues);
      return cues;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * 5. 자막 개선 (이중 자막 / AI 재번역)
   * ------------------------------------------------------------------ */
  let trackStateKey = null;   // label|src
  let appliedKey = null;      // 이중 자막 적용 완료 키
  let aiToken = null;         // AI 번역 취소 토큰
  let watchTimer = null;
  function scheduleWatchSubtitles(delay) {
    if (watchTimer) return;
    watchTimer = setTimeout(() => { watchTimer = null; watchSubtitles(); }, delay == null ? 100 : delay);
  }

  function findEnSub() {
    if (!lastSubs || !lastSubs.list) return null;
    return lastSubs.list.find(s => s.land === 'en') || null;
  }

  function buildEnIndex(enCues) {
    const byStart = new Map();
    enCues.forEach((c, i) => byStart.set(c.startMs, i));
    return byStart;
  }

  async function applyDual(cues, enCues) {
    const byStart = buildEnIndex(enCues);
    let changed = 0;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      let idx = byStart.has(Math.round(cue.startTime * 1000)) ? byStart.get(Math.round(cue.startTime * 1000)) : -1;
      if (idx < 0 && i < enCues.length && Math.abs(enCues[i].startMs - cue.startTime * 1000) < 120) idx = i;
      if (idx < 0) continue;
      const en = enCues[idx].text;
      const ko = cue.text || '';
      if (!en || ko.indexOf(en) >= 0) continue;
      cue.text = ko + '\n' + en;
      changed++;
    }
    return changed;
  }

  function dramaContext() {
    const m = location.pathname.match(/\/Drama\/([^/]+)/);
    const slug = m ? decodeURIComponent(m[1]).replace(/-/g, ' ') : '';
    const em = location.href.match(/[?&]ep=(\d+)/);
    return { title: slug, episode: em ? em[1] : '' };
  }

  const SYSTEM_PROMPT = [
    '당신은 한국어 자막 번역가입니다. 주어진 영어 자막 문장들을 한국 시청자를 위한 자연스럽고 매끄러운 구어체 한국어로 번역하세요.',
    '규칙:',
    '1) 각 문장의 의미, 말투, 인물 관계를 유지합니다.',
    '2) 등장인물 이름은 자연스러운 한국어 표기로 일관되게 옮깁니다.',
    '3) 설명이나 주석을 추가하지 않습니다.',
    '4) 입력 배열의 항목 수와 출력 배열의 항목 수가 정확히 같아야 합니다. 인접한 문장을 하나로 합치거나, 한 문장을 나누거나, 항목을 생략하지 마세요.',
    '5) JSON 배열 외에는 아무것도 출력하지 않습니다.'
  ].join('\n');

  function userPrompt(texts, ctx) {
    const head = ctx && (ctx.title || ctx.episode)
      ? '[작품: ' + (ctx.title || '?') + (ctx.episode ? ', 에피소드 ' + ctx.episode : '') + ']\n'
      : '';
    return head + JSON.stringify(texts, null, 0);
  }

  function parseJsonArray(txt) {
    const s = String(txt || '');
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a < 0 || b <= a) return null;
    try {
      const arr = JSON.parse(s.slice(a, b + 1));
      if (Array.isArray(arr) && arr.every(x => typeof x === 'string')) return arr;
    } catch (e) {}
    return null;
  }

  async function callTranslator(texts, ctx, sysPrompt) {
    if (!settings.apiKey) throw new Error('API 키가 설정되지 않았습니다.');
    if (settings.provider === 'gemini') {
      const model = settings.model || 'gemini-2.5-flash';
      const u = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(settings.apiKey);
      const body = {
        systemInstruction: { parts: [{ text: sysPrompt || SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt(texts, ctx) }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
      };
      const d = await fetchJson(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, 60000);
      const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
      const txt = parts.map(p => p.text || '').join('');
      const arr = parseJsonArray(txt);
      if (!arr) throw new Error('Gemini 응답 파싱 실패');
      return arr;
    }
    // OpenAI 호환
    const base = (settings.baseUrl || '').replace(/\/+$/, '');
    const u = base + '/chat/completions';
    const body = {
      model: settings.model || 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: sysPrompt || SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(texts, ctx) }
      ]
    };
    if (/deepseek\.com/i.test(base)) {
      // DeepSeek은 기본이 thinking(high) 모드 → 번역에는 끄고 JSON 출력을 강제한다
      body.thinking = { type: 'disabled' };
      body.response_format = { type: 'json_object' };
    }
    const d = await fetchJson(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify(body)
    }, 60000);
    const txt = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    const arr = parseJsonArray(txt);
    if (!arr) throw new Error('OpenAI 응답 파싱 실패');
    return arr;
  }

  function subCacheKey(epId) {
    return LS.subsPrefix + epId + '_' + settings.provider + '_' + (settings.model || '').replace(/[^\w.-]/g, '');
  }
  function pruneSubCache() {
    try {
      let idx = loadJSON(LS.subsIndex, []);
      idx = idx.filter(k => localStorage.getItem(k));
      while (idx.length > 30) {
        const k = idx.shift();
        localStorage.removeItem(k);
      }
      saveJSON(LS.subsIndex, idx);
    } catch (e) {}
  }
  function rememberSubCache(key) {
    try {
      let idx = loadJSON(LS.subsIndex, []);
      idx = idx.filter(k => k !== key);
      idx.push(key);
      saveJSON(LS.subsIndex, idx);
      pruneSubCache();
    } catch (e) {}
  }

  function applyAiLines(cues, enCues, lines) {
    const byStart = buildEnIndex(enCues);
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const ms = Math.round(cue.startTime * 1000);
      let idx = byStart.has(ms) ? byStart.get(ms) : (i < enCues.length ? i : -1);
      if (idx < 0) continue;
      const t = lines[idx];
      if (t) cue.text = t;
    }
  }

  // 페이싱: 429(요청 제한)가 나면 서버가 알려준 retryDelay만큼 기다리고,
  // 이후 요청 간 최소 간격을 자동으로 늘려 같은 제한에 반복해서 걸리지 않게 한다.
  let apiPaceMs = 0;     // 요청 사이 최소 간격 (429 발생 시 자동 상향)
  let apiLastCall = 0;   // 마지막 요청 시각
  async function pacedCall(texts, ctx, sysPrompt) {
    const wait = apiLastCall + apiPaceMs - Date.now();
    if (wait > 0) await sleep(wait);
    apiLastCall = Date.now();
    return callTranslator(texts, ctx, sysPrompt);
  }

  // 배치 번역: 모델이 문장을 합쳐서 개수가 안 맞으면 재시도 후 배치를 반으로
  // 쪼개 재귀 처리한다. 끝내 실패한 구간은 null로 남겨 사이트 자막을 유지한다.
  async function translateBatch(texts, ctx, token) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (aiToken !== token) return null;
      let arr = null, waitMs = 0;
      try {
        arr = await pacedCall(texts, ctx);
      } catch (e) {
        if (e && e.status === 429) {
          waitMs = Math.max(e.retryAfterMs || 5000, 5000) + 500;
          apiPaceMs = Math.max(apiPaceMs, waitMs);
          setStatus('요청 제한(429) — ' + Math.ceil(waitMs / 1000) + '초 후 재시도 (간격 ' + Math.ceil(apiPaceMs / 1000) + '초)');
        } else {
          waitMs = 1200 * (attempt + 1);
        }
      }
      if (arr && arr.length === texts.length) return arr;
      if (arr) {
        setStatus('AI 응답 개수 불일치 (' + arr.length + '/' + texts.length + ') — 다시 시도');
        waitMs = 1000;
      }
      if (waitMs) await sleep(waitMs);
    }
    if (texts.length <= 3) return new Array(texts.length).fill(null);
    const mid = Math.ceil(texts.length / 2);
    const left = (await translateBatch(texts.slice(0, mid), ctx, token)) || new Array(mid).fill(null);
    const right = (await translateBatch(texts.slice(mid), ctx, token)) || new Array(texts.length - mid).fill(null);
    return left.concat(right);
  }

  async function startAiTranslation(cues, enCues, token) {
    if (!settings.apiKey) {
      setStatus('AI 재번역: API 키를 설정해 주세요 (설정 패널)');
      return;
    }
    const epId = lastSubs && lastSubs.epId;
    const ck = epId ? subCacheKey(epId) : null;
    const lines = new Array(enCues.length).fill(null);
    let resumed = 0;
    if (ck) {
      // 저장된 번역(완료 또는 진행분)을 불러와 이어서 작업한다
      const cached = loadJSON(ck, null);
      if (cached && Array.isArray(cached) && cached.length === enCues.length) {
        for (let i = 0; i < cached.length; i++) lines[i] = cached[i] || null;
        resumed = lines.filter(x => x).length;
        if (resumed) applyAiLines(cues, enCues, lines);
        if (resumed === enCues.length) {
          setStatus('AI 자막 적용됨 (캐시)');
          return;
        }
      }
    }
    const BATCH = 25;
    const total = Math.ceil(enCues.length / BATCH);
    const ctx = dramaContext();
    setStatus(resumed
      ? 'AI 번역 이어서… (' + resumed + '/' + enCues.length + '줄 완료)'
      : 'AI 번역 시작… (0/' + total + ')');
    let done = 0;
    for (let a = 0; a < enCues.length; a += BATCH) {
      if (aiToken !== token) return; // 트랙이 바뀌면 중단
      const b = Math.min(a + BATCH, enCues.length);
      if (lines.slice(a, b).every(x => x)) { done++; continue; } // 이미 번역된 구간
      const texts = enCues.slice(a, b).map(c => c.text);
      const arr = await translateBatch(texts, ctx, token);
      if (aiToken !== token) return;
      if (arr) for (let i = 0; i < texts.length; i++) lines[a + i] = arr[i] || null;
      done++;
      setStatus('AI 번역 중… (' + done + '/' + total + ')');
      applyAiLines(cues, enCues, lines);
      if (ck) {
        // 진행분을 즉시 저장 → 중간에 끊어도 다음에 이어서 번역
        try {
          localStorage.setItem(ck, JSON.stringify(lines));
          rememberSubCache(ck);
        } catch (e) {}
      }
    }
    if (aiToken !== token) return;
    const missed = lines.filter(x => !x).length;
    setStatus(missed
      ? 'AI 자막 완료 — ' + missed + '개 구간은 사이트 자막 유지'
      : 'AI 자막 번역 완료 (' + total + '묶음)');
  }

  async function applySubtitleEnhancement(trackEl, cues, key) {
    if (settings.subMode === 'off') return;
    const enSub = findEnSub();
    if (!enSub) { appliedKey = key; setStatus('영어 자막을 찾지 못했습니다 (사이트 자막 유지)'); return; }
    const enCues = await getEnCues(enSub.src);
    if (!enCues || !enCues.length) { appliedKey = key; setStatus('영어 자막 파일을 읽지 못했습니다 (사이트 자막 유지)'); return; }
    if (settings.subMode === 'dual') {
      const n = await applyDual(cues, enCues);
      appliedKey = key;
      setStatus(n > 0 ? '이중 자막 적용 (' + n + '개)' : '이중 자막: 영어 원문 없음');
    } else if (settings.subMode === 'ai') {
      appliedKey = key;
      aiToken = key;
      startAiTranslation(cues, enCues, key);
    }
  }

  function attachTrackListener(trackEl) {
    if (!trackEl || trackEl.__kkhBound) return;
    trackEl.__kkhBound = true;
    trackEl.addEventListener('load', () => { scheduleWatchSubtitles(0); });
  }

  function watchSubtitles() {
    const video = document.querySelector('video');
    if (!video) { trackStateKey = null; return; }
    const trackEl = video.querySelector('track');
    if (!trackEl) return;
    attachTrackListener(trackEl);
    const label = trackEl.label || '';
    const src = trackEl.src || '';
    const key = label + '|' + src;
    if (key !== trackStateKey) {
      trackStateKey = key;
      appliedKey = null;
      aiToken = null;
    }
    if (label !== 'Korean') return;
    const tt = trackEl.track || (video.textTracks && video.textTracks[0]);
    if (!tt || !tt.cues || !tt.cues.length) return;
    if (appliedKey === key) return;
    applySubtitleEnhancement(trackEl, tt.cues, key);
  }

  /* ------------------------------------------------------------------ *
   * 5b. 캐시 워밍 (미리 받기) — 세그먼트를 IndexedDB에 저장/서빙/삭제
   * ------------------------------------------------------------------ */
  const WARM_DB = 'kkh_warm_v1';
  const WARM_STORE = 'seg';
  const WARM_INDEX_KEY = 'kkh_warm_index_v1';
  const warmIndex = loadJSON(WARM_INDEX_KEY, {}); // epId -> {title, epName, count, bytes, ts, urls}
  const warmUrls = new Set();
  Object.values(warmIndex).forEach(e => (e.urls || []).forEach(u => warmUrls.add(u)));
  let lastM3u8Url = null;
  let lastM3u8Href = '';
  let warmDbPromise = null;
  let warmActive = false, warmCancel = false;
  let warmStatusEl = null, warmResEl = null;

  function setWarmStatus(text) { if (warmStatusEl) warmStatusEl.textContent = text || ''; }
  function saveWarmIndex() { saveJSON(WARM_INDEX_KEY, warmIndex); }

  function openWarmDb() {
    if (warmDbPromise) return warmDbPromise;
    warmDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(WARM_DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(WARM_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return warmDbPromise;
  }
  function idbPut(key, val) {
    return openWarmDb().then(db => new Promise((res, rej) => {
      const tx = db.transaction(WARM_STORE, 'readwrite');
      tx.objectStore(WARM_STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    }));
  }
  function idbGet(key) {
    return openWarmDb().then(db => new Promise((res, rej) => {
      const tx = db.transaction(WARM_STORE, 'readonly');
      const rq = tx.objectStore(WARM_STORE).get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    }));
  }
  function idbDelete(keys) {
    return openWarmDb().then(db => new Promise((res, rej) => {
      const tx = db.transaction(WARM_STORE, 'readwrite');
      const os = tx.objectStore(WARM_STORE);
      keys.forEach(k => os.delete(k));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    }));
  }
  async function fetchTextTimeout(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally { clearTimeout(t); }
  }
  async function fetchBufTimeout(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } finally { clearTimeout(t); }
  }

  function currentEpId() {
    return (location.href.match(/[?&]ep=(\d+)/) || [])[1] || (lastSubs && lastSubs.epId) || '';
  }
  function currentEpName() {
    return (location.pathname.match(/Episode-([^/]+)/i) || [])[1] || currentEpId();
  }
  function queueLabel(job) {
    return (job.title || '드라마') + ' Ep' + (job.epName || job.epId);
  }

  // ---- 순차 큐 ----
  const WARM_QUEUE_KEY = 'kkh_warm_queue_v1';
  let warmQueue = loadJSON(WARM_QUEUE_KEY, []);
  if (!Array.isArray(warmQueue)) warmQueue = [];
  let queueRunning = false;
  let warmQueueEl = null;
  function saveWarmQueue() { saveJSON(WARM_QUEUE_KEY, warmQueue); }

  // 회차 하나를 받는다. 반환: 'done' | 'failed' | 'cancelled'
  async function warmJob(job) {
    warmActive = true;
    warmCancel = false;
    const fail = (msg) => { warmActive = false; setWarmStatus(msg); return 'failed'; };
    setWarmStatus(queueLabel(job) + ' — 목록 읽는 중…');
    let text = '';
    try {
      text = await fetchTextTimeout(job.m3u8Url, 15000);
    } catch (e) {
      return fail(queueLabel(job) + ' — 플레이리스트 실패: ' + (e.name === 'AbortError' ? '타임아웃' : (e.message || e)));
    }
    const base = job.m3u8Url.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    const urls = [];
    text.split('\n').forEach(line => {
      const l = line.trim();
      if (!l || l[0] === '#') return;
      if (/^https?:\/\//i.test(l)) urls.push(l);
      else if (l.slice(0, 2) === '//') urls.push('https:' + l);
      else urls.push(base + l);
    });
    if (!urls.length) return fail(queueLabel(job) + ' — 세그먼트를 찾지 못했습니다');
    const todo = urls.filter(u => !warmUrls.has(u));
    if (!todo.length) { warmActive = false; setWarmStatus(queueLabel(job) + ' — 이미 받아둔 회차입니다'); return 'done'; }
    if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
    const epId = job.epId;
    const total = todo.length;
    const stored = [];
    let done = 0, bytes = 0, persistedBytes = 0, next = 0;
    // 진행분을 주기적으로 인덱스에 기록 → 중간에 페이지를 닫아도 이어받기/삭제 가능
    const persistProgress = () => {
      if (!stored.length) return;
      const prev = warmIndex[epId] || {};
      const all = Array.from(new Set([].concat(prev.urls || [], stored)));
      warmIndex[epId] = {
        title: job.title || prev.title || '',
        epName: job.epName || prev.epName || '',
        count: all.length,
        bytes: (prev.bytes || 0) + (bytes - persistedBytes),
        ts: Date.now(),
        urls: all
      };
      persistedBytes = bytes;
      saveWarmIndex();
    };
    async function worker() {
      while (!warmCancel) {
        const i = next++;
        if (i >= total) return;
        try {
          const buf = await fetchBufTimeout(todo[i], 30000);
          await idbPut(todo[i], buf);
          stored.push(todo[i]);
          warmUrls.add(todo[i]); // 받는 즉시 재생에도 사용
          bytes += buf.byteLength;
          if (stored.length % 5 === 0) persistProgress();
          if (stored.length % 3 === 0 || stored.length === total) {
            setWarmStatus('미리 받기… ' + stored.length + '/' + total + ' (' + (bytes / 1048576).toFixed(0) + 'MB)');
          }
        } catch (e) {}
        done++;
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    warmActive = false;
    if (stored.length) {
      persistProgress();
      renderWarmList();
    }
    setWarmStatus(queueLabel(job) + (warmCancel
      ? ' — 중지됨 (' + stored.length + '개/' + (bytes / 1048576).toFixed(0) + 'MB)'
      : ' — 완료 (' + stored.length + '개/' + (bytes / 1048576).toFixed(0) + 'MB)'));
    return warmCancel ? 'cancelled' : 'done';
  }

  function enqueueCurrentEpisode() {
    const epId = currentEpId();
    const capEp = (String(lastM3u8Href).match(/[?&]ep=(\d+)/) || [])[1] || '';
    if (!lastM3u8Url || (epId && capEp && epId !== capEp)) { setWarmStatus('영상을 한 번 재생한 뒤 눌러주세요'); return; }
    if (!epId) { setWarmStatus('회차 정보를 찾지 못했습니다'); return; }
    const epName = currentEpName();
    if (warmQueue.some(j => j.epId === epId)) { setWarmStatus('이미 큐에 있습니다: ' + epName + '화'); return; }
    warmQueue.push({
      epId: epId,
      title: dramaContext().title || '',
      epName: epName,
      m3u8Url: lastM3u8Url,
      ts: Date.now()
    });
    saveWarmQueue();
    renderWarmQueue();
    setWarmStatus('큐에 추가됨: ' + epName + '화 (대기 ' + warmQueue.length + '개)');
    if (!queueRunning) runQueue();
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    renderWarmQueue();
    let failed = 0;
    while (warmQueue.length) {
      const job = warmQueue[0];
      const res = await warmJob(job);
      if (res === 'cancelled' || warmCancel) break;
      if (res === 'failed') failed++;
      if (warmQueue[0] === job) warmQueue.shift();
      saveWarmQueue();
      renderWarmQueue();
    }
    queueRunning = false;
    renderWarmQueue();
    if (!warmQueue.length) {
      setWarmStatus(failed
        ? '큐 완료 — 실패 ' + failed + '개 (해당 회차를 재생 후 다시 추가하면 이어받기)'
        : '큐 완료');
    }
  }

  function stopWarm() {
    if (warmActive) { warmCancel = true; setWarmStatus('중지 중…'); }
    else setWarmStatus('받는 중인 작업이 없습니다');
  }

  function renderWarmQueue() {
    if (!warmQueueEl) return;
    warmQueueEl.textContent = '';
    if (!warmQueue.length) return;
    warmQueue.forEach(job => {
      const isCurrent = queueRunning && warmQueue[0] === job && warmActive;
      const row = h('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:4px' });
      row.appendChild(h('span', {
        style: 'flex:1;word-break:break-all;font-size:11px;color:#c9d1d9',
        text: (isCurrent ? '▶ ' : '· ') + queueLabel(job) + (isCurrent ? ' (받는 중)' : ' (대기)')
      }));
      const btn = h('button', { text: '삭제' });
      if (isCurrent) { btn.disabled = true; btn.style.opacity = '.4'; }
      else btn.addEventListener('click', () => {
        warmQueue = warmQueue.filter(j => j !== job);
        saveWarmQueue();
        renderWarmQueue();
        setWarmStatus('큐에서 제거됨');
      });
      row.appendChild(btn);
      warmQueueEl.appendChild(row);
    });
  }

  async function deleteWarmEpisode(epId) {
    const e = warmIndex[epId];
    if (!e) return;
    setWarmStatus('삭제 중… ' + (e.title || epId));
    try { await idbDelete(e.urls || []); } catch (err) {}
    (e.urls || []).forEach(u => warmUrls.delete(u));
    delete warmIndex[epId];
    saveWarmIndex();
    renderWarmList();
    setWarmStatus('삭제됨: ' + ((e.title || '') + (e.epName ? ' Ep' + e.epName : '') || epId) + ' (' + ((e.bytes || 0) / 1048576).toFixed(0) + 'MB)');
  }

  function renderWarmList() {
    if (!warmResEl) return;
    warmResEl.textContent = '';
    const ids = Object.keys(warmIndex).sort((a, b) => (warmIndex[b].ts || 0) - (warmIndex[a].ts || 0));
    if (!ids.length) {
      warmResEl.appendChild(h('div', { class: 'kkh-hint', text: '받아둔 회차가 없습니다.' }));
      return;
    }
    ids.forEach(id => {
      const e = warmIndex[id];
      const row = h('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:4px' });
      const label = h('span', {
        style: 'flex:1;word-break:break-all;font-size:11px;color:#c9d1d9',
        text: ((e.title || '') || '드라마') + (e.epName ? ' Ep' + e.epName : ' · ep ' + id) +
          ' — ' + e.count + '개/' + ((e.bytes || 0) / 1048576).toFixed(0) + 'MB'
      });
      const btn = h('button', { text: '삭제' });
      btn.addEventListener('click', () => deleteWarmEpisode(id));
      row.appendChild(label);
      row.appendChild(btn);
      warmResEl.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ *
   * 6. UI 패널
   * ------------------------------------------------------------------ */
  let panelEl = null, statusEl = null, fabEl = null;
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
    if (fabEl) fabEl.dataset.busy = text && /번역 중|번역 시작|번역 이어서/.test(text) ? '1' : '';
  }

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k === 'style') el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => el.appendChild(c));
    return el;
  }

  function buildPanel() {
    if (document.getElementById('kkh-root')) return;
    const style = document.createElement('style');
    style.textContent = [
      '#kkh-root{position:fixed;right:14px;bottom:14px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR",sans-serif}',
      '#kkh-fab{width:46px;height:46px;border-radius:50%;border:none;background:#7b1fa2;color:#fff;font-size:17px;font-weight:700;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.4)}',
      '#kkh-fab[data-busy="1"]{background:#d32f2f}',
      '#kkh-panel{position:absolute;right:0;bottom:56px;width:300px;max-height:70vh;overflow:auto;background:#20242b;color:#e8eaed;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.55);padding:12px 13px;font-size:12.5px;line-height:1.5}',
      '#kkh-panel h3{margin:0 0 8px;font-size:13px;color:#d0b3e8}',
      '#kkh-panel .sec{margin:10px 0;padding-top:9px;border-top:1px solid #333a44}',
      '#kkh-panel label{display:flex;align-items:center;gap:6px;cursor:pointer}',
      '#kkh-panel select,#kkh-panel input[type=text],#kkh-panel input[type=password]{width:100%;box-sizing:border-box;background:#14181e;color:#e8eaed;border:1px solid #3a424d;border-radius:6px;padding:5px 7px;margin-top:4px;font-size:12px}',
      '#kkh-panel button{cursor:pointer;background:#39404b;color:#fff;border:none;border-radius:6px;padding:5px 9px;font-size:12px}',
      '#kkh-panel button:hover{background:#4a5361}',
      '#kkh-status{min-height:16px;margin-top:8px;color:#9fd6a0;font-size:11.5px;word-break:break-all}',
      '.kkh-hint{color:#98a2ad;font-size:11px;margin-top:3px}',
      '.kkh-title.kkh-ai{opacity:.82}'
    ].join('');
    document.documentElement.appendChild(style);

    const root = h('div', { id: 'kkh-root' });
    fabEl = h('button', { id: 'kkh-fab', title: 'kisskh 한글 도우미', text: '한' });
    fabEl.addEventListener('click', () => { panelEl.style.display = panelEl.style.display === 'none' ? 'block' : 'none'; });

    panelEl = h('div', { id: 'kkh-panel', style: 'display:none' });

    // 제목
    const titleChk = h('input', { type: 'checkbox' });
    titleChk.checked = !!settings.titlesOn;
    titleChk.addEventListener('change', () => {
      settings.titlesOn = titleChk.checked;
      saveSettings();
      if (settings.titlesOn) reapplyTitles(); else restoreTitles();
    });
    const aiTitleChk = h('input', { type: 'checkbox' });
    aiTitleChk.checked = !!settings.aiTitles;
    aiTitleChk.addEventListener('change', () => {
      settings.aiTitles = aiTitleChk.checked;
      saveSettings();
      if (!settings.aiTitles) {
        // 끄면 AI로 임시 번역해 둔 제목은 원제로 되돌린다
        document.querySelectorAll('.kkh-title.kkh-ai[data-kkh-en]').forEach(el => {
          el.textContent = el.dataset.kkhEn;
          el.classList.remove('kkh-ai');
        });
        setStatus('AI 제목 번역 꺼짐');
      } else {
        // 켜면 '제목 없음'으로 캐시된 항목을 지워 바로 다시 조회되게 한다
        for (const k in titleCache) if (!titleCache[k].ko) delete titleCache[k];
        saveJSON(LS.titles, titleCache);
        if (settings.titlesOn) reapplyTitles();
        setStatus('AI 제목 번역 켜짐 (위키에 없는 제목만)');
      }
    });
    const titleSec = h('div', { class: 'sec' }, [
      h('h3', { text: '제목' }),
      h('label', {}, [titleChk, h('span', { text: '한국어 제목으로 표시 (툴팁에 영어 유지)' })]),
      h('label', {}, [aiTitleChk, h('span', { text: '위키에 없으면 AI로 임시 번역 (API 키 필요)' })])
    ]);

    // 자막 모드
    const subSel = h('select');
    [['off', '끄기 (사이트 자막 그대로)'], ['dual', '영한 동시 자막 (추천)'], ['ai', 'AI 재번역 (한국어, API 키 필요)']]
      .forEach(([v, t]) => { const o = h('option', { value: v, text: t }); if (settings.subMode === v) o.selected = true; subSel.appendChild(o); });
    subSel.addEventListener('change', () => {
      settings.subMode = subSel.value;
      saveSettings();
      trackStateKey = null; appliedKey = null; aiToken = null;
      setStatus(settings.subMode === 'off' ? '자막 개선 꺼짐' : '자막 모드: ' + subSel.options[subSel.selectedIndex].text);
    });
    const subSec = h('div', { class: 'sec' }, [
      h('h3', { text: '자막' }),
      h('div', { text: '모드' }), subSel,
      h('div', { class: 'kkh-hint', text: '한국어 자막을 선택하면 적용됩니다. (플레이어 자막 메뉴)' })
    ]);

    // AI 설정
    const provSel = h('select');
    [['gemini', 'Gemini (무료 키)'], ['openai', 'OpenAI 호환 (OpenAI/OpenRouter/Ollama 등)']]
      .forEach(([v, t]) => { const o = h('option', { value: v, text: t }); if (settings.provider === v) o.selected = true; provSel.appendChild(o); });
    const keyInp = h('input', { type: 'password', placeholder: 'API 키', value: settings.apiKey });
    const modelInp = h('input', { type: 'text', placeholder: '모델', value: settings.model });
    const baseInp = h('input', { type: 'text', placeholder: 'Base URL', value: settings.baseUrl });
    const aiSec = h('div', { class: 'sec' }, [
      h('h3', { text: 'AI 재번역 설정' }),
      h('div', { text: '제공자' }), provSel,
      keyInp, modelInp, baseInp,
      h('div', { class: 'kkh-hint', text: 'Gemini: aistudio.google.com 에서 무료 키 발급. DeepSeek: 제공자 "OpenAI 호환", Base URL https://api.deepseek.com, 모델 deepseek-flash. 키는 브라우저 localStorage에만 저장됩니다.' })
    ]);
    provSel.addEventListener('change', () => { settings.provider = provSel.value; saveSettings(); });
    keyInp.addEventListener('change', () => { settings.apiKey = keyInp.value.trim(); saveSettings(); });
    modelInp.addEventListener('change', () => { settings.model = modelInp.value.trim(); saveSettings(); });
    baseInp.addEventListener('change', () => { settings.baseUrl = baseInp.value.trim(); saveSettings(); });

    // 미리 받기 (캐시 워밍)
    const warmBtn = h('button', { text: '회차 미리 받기' });
    warmBtn.addEventListener('click', () => enqueueCurrentEpisode());
    const warmStopBtn = h('button', { text: '중지', style: 'margin-left:6px' });
    warmStopBtn.addEventListener('click', () => stopWarm());
    const warmStartBtn = h('button', { text: '큐 시작' });
    warmStartBtn.addEventListener('click', () => runQueue());
    const warmClearQBtn = h('button', { text: '큐 비우기', style: 'margin-left:6px' });
    warmClearQBtn.addEventListener('click', () => {
      if (queueRunning) { setWarmStatus('받는 중에는 큐를 비울 수 없습니다 (중지 후)'); return; }
      warmQueue = [];
      saveWarmQueue();
      renderWarmQueue();
      setWarmStatus('큐를 비웠습니다');
    });
    const warmAllBtn = h('button', { text: '받아둔 것 전체 삭제', style: 'margin-top:4px' });
    warmAllBtn.addEventListener('click', async () => {
      const ids = Object.keys(warmIndex);
      if (!ids.length) { setWarmStatus('받아둔 회차가 없습니다'); return; }
      setWarmStatus('전체 삭제 중…');
      for (const id of ids) { await deleteWarmEpisode(id); }
      setWarmStatus('전체 삭제 완료');
    });
    warmStatusEl = h('div', { class: 'kkh-hint' });
    warmQueueEl = h('div', {});
    warmResEl = h('div', {});
    const warmSec = h('div', { class: 'sec' }, [
      h('h3', { text: '미리 받기 (캐시 워밍)' }),
      h('div', {}, [warmBtn, warmStopBtn]),
      h('div', { style: 'margin-top:4px' }, [warmStartBtn, warmClearQBtn]),
      warmStatusEl,
      h('div', { class: 'kkh-hint', text: '받을 회차 (순차 처리)' }),
      warmQueueEl,
      h('div', { class: 'kkh-hint', text: '받아둔 회차' }),
      warmResEl,
      warmAllBtn,
      h('div', { class: 'kkh-hint', text: '회차를 재생해 플레이리스트가 로드된 뒤 추가하면 순서대로 하나씩 받습니다. 편당 약 300MB, 이 브라우저에만 저장.' })
    ]);

    // 캐시/정보
    const clearBtn = h('button', { text: '캐시 비우기' });
    clearBtn.addEventListener('click', () => {
      try {
        for (const k in titleCache) delete titleCache[k];
        const idx = loadJSON(LS.subsIndex, []);
        idx.forEach(k => localStorage.removeItem(k));
        localStorage.removeItem(LS.subsIndex);
        localStorage.removeItem(LS.titles);
      } catch (e) {}
      setStatus('캐시를 비웠습니다');
    });
    const mediaBtn = h('button', { text: '영상 호스트 통계', style: 'margin-left:6px' });
    const mediaRes = h('div', { class: 'kkh-hint' });
    mediaBtn.addEventListener('click', () => {
      const rows = Object.keys(mediaStats).map(host => {
        const s = mediaStats[host];
        return { host: host, n: s.n, avg: Math.round(s.total / s.n), last: s.last };
      }).sort((a, b) => b.avg - a.avg);
      if (!rows.length) { mediaRes.textContent = '아직 영상 요청이 감지되지 않았습니다.'; return; }
      mediaRes.textContent = '';
      rows.forEach(r => {
        mediaRes.appendChild(h('div', {
          text: r.host + ' — ' + r.n + '회, 평균 ' + r.avg + 'ms, 최근 ' + r.last + 'ms'
        }));
      });
    });
    const infoSec = h('div', { class: 'sec' }, [
      h('h3', { text: '기타' }),
      clearBtn, mediaBtn, mediaRes,
      h('div', { class: 'kkh-hint', text: 'v1.2.2 · 번역 진행분 자동 저장, 캐시 최근 30개 에피소드' })
    ]);

    statusEl = h('div', { id: 'kkh-status' });

    [titleSec, subSec, aiSec, warmSec, infoSec, statusEl].forEach(x => panelEl.appendChild(x));
    renderWarmList();
    renderWarmQueue();
    root.appendChild(fabEl);
    root.appendChild(panelEl);
    document.documentElement.appendChild(root);
  }

  /* ------------------------------------------------------------------ *
   * 7. 초기화
   * ------------------------------------------------------------------ */
  function init() {
    buildPanel();

    // 제목 감시 (MutationObserver + 주기 스캔 + 스크롤)
    const mo = new MutationObserver(() => scheduleScanTitles());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scanTitles, 4000);
    window.addEventListener('scroll', () => scheduleScanTitles(), { passive: true, capture: true });
    scanTitles();

    // 자막 감시 (트랙 src/자막 로드 이벤트 + 주기 폴백)
    const tmo = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.target && m.target.tagName === 'TRACK') { scheduleWatchSubtitles(50); return; }
        if (m.type === 'childList') { scheduleWatchSubtitles(200); return; }
      }
    });
    tmo.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'label']
    });
    setInterval(watchSubtitles, 2000);

    // 디버그/고급 사용자용 API
    window.__kkh = {
      get settings() { return settings; },
      get titleCache() { return titleCache; },
      get queue() { return titleQueue.length; },
      get lastSubs() { return lastSubs; },
      get paceMs() { return apiPaceMs; },
      get mediaStats() { return mediaStats; },
      get warmIndex() { return warmIndex; },
      get lastM3u8Url() { return lastM3u8Url; },
      get warmQueue() { return warmQueue; },
      enqueueCurrentEpisode: enqueueCurrentEpisode,
      runQueue: runQueue,
      scanTitles: scanTitles,
      lookupKoTitle: lookupKoTitle,
      watchSubtitles: watchSubtitles
    };

    setStatus('준비됨 — 한국어 제목 표시 / 자막 개선');

    // 큐에 대기 중인 회차는 자동으로 시작하지 않고, 버튼으로 시작하게 안내한다
    if (warmQueue.length) setWarmStatus('대기 ' + warmQueue.length + '개 — "큐 시작"을 누르면 받습니다');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
