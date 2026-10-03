// ==UserScript==
// @name         kisskh 한글 도우미 (제목 번역 + 자막 개선)
// @namespace    local.kisskh.ko
// @version      1.0.3
// @description  kisskh.co 드라마 제목을 한국어로 표시하고, 자막을 개선합니다 (영한 동시자막 / AI 재번역).
// @author       wpffl_adguard
// @match        https://kisskh.co/*
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
  const SEARCH_API_RE = /\/api\/DramaList\/Search/;
  const WEEK_MS = 7 * 864e5;
  const LS = {
    settings: 'kkh_settings_v1',
    titles: 'kkh_titles_v1',
    search: 'kkh_search_v1',
    subsPrefix: 'kkh_sub_v1_',
    subsIndex: 'kkh_sub_index_v1'
  };
  const DEFAULTS = {
    titlesOn: true,
    subMode: 'dual', // off | dual | ai
    provider: 'gemini', // gemini | openai
    apiKey: '',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://api.openai.com/v1',
    tmdbKey: ''
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
  const titleCache = loadJSON(LS.titles, {});   // normEn -> {ko, en, ts}
  const searchCache = loadJSON(LS.search, {});  // normKo -> {en, ts}
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

  /* --- 1a. TMDB (API 키가 있을 때, 커버리지 최고) --- */
  async function tmdbLookup(raw) {
    if (!settings.tmdbKey) return null;
    for (const v of titleVariants(raw)) {
      for (const kind of ['tv', 'movie']) {
        try {
          const u = 'https://api.themoviedb.org/3/search/' + kind +
            '?api_key=' + encodeURIComponent(settings.tmdbKey) +
            '&language=ko-KR&include_adult=false&query=' + encodeURIComponent(v);
          const d = await fetchJson(u);
          if (!d.results || !d.results.length) continue;
          const pick = d.results.find(r => similarTitle(r.name || r.title || '', v)) || d.results[0];
          const name = pick.name || pick.title || '';
          if (HANGUL_RE.test(name)) return name;
          const orig = pick.original_name || pick.original_title || '';
          if (HANGUL_RE.test(orig)) return orig;
        } catch (e) {}
      }
    }
    return null;
  }

  /* --- 1b. Wikipedia (영문 문서 → 한국어 인터링크) --- */
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

  /* --- 1c. Wikidata (한국어 라벨) --- */
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

  /* --- 1d. 통합 조회 (캐시 → TMDB → Wikipedia → Wikidata) --- */
  let titleBlockUntil = 0; // 429(요청 제한) 발생 시 잠시 중단
  function noteError(e) {
    if (e && /429/.test(String(e.message || e))) titleBlockUntil = Date.now() + 90000;
  }

  const titlePending = new Map();
  async function lookupKoTitle(raw) {
    if (Date.now() < titleBlockUntil) return null;
    const key = normKey(titleVariants(raw)[0] || raw);
    if (!key) return null;
    const c = titleCache[key];
    if (c && (c.ko || Date.now() - c.ts < WEEK_MS)) return c.ko || null;
    if (titlePending.has(key)) return titlePending.get(key);
    const job = (async () => {
      let ko = null;
      try { ko = await tmdbLookup(raw); } catch (e) { noteError(e); }
      if (!ko) { try { ko = await wikiLookup(raw); } catch (e) { noteError(e); } }
      if (!ko) { try { ko = await wikidataLookup(raw); } catch (e) { noteError(e); } }
      titleCache[key] = { ko: ko || null, en: String(raw || '').trim(), ts: Date.now() };
      if (ko) {
        searchCache[normKey(ko)] = { en: String(raw || '').trim(), ts: Date.now() };
        saveJSON(LS.search, searchCache);
      }
      scheduleTitleSave();
      return ko;
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
      lookupKoTitle(job.text).then(ko => {
        if (ko) applyKorean(job.el, ko, job.text);
        else if (job.el.isConnected) job.el.dataset.kkhDone = '1';
      }).catch(() => {}).finally(() => {
        titleActive--;
        setTimeout(pumpTitleQueue, 150);
      });
    }
  }

  function applyKorean(el, ko, en) {
    if (!el || !el.isConnected) return;
    if (!ko || normKey(ko) === normKey(en)) { el.dataset.kkhDone = '1'; return; }
    el.dataset.kkhDone = '1';
    el.dataset.kkhEn = en;
    el.classList.add('kkh-title');
    const textNodes = Array.prototype.filter.call(el.childNodes, n => n.nodeType === 3 && n.textContent.trim());
    if (textNodes.length) {
      textNodes[0].textContent = ko;
      for (let i = 1; i < textNodes.length; i++) textNodes[i].textContent = '';
    } else {
      el.textContent = ko;
    }
    if (!el.getAttribute('title')) el.setAttribute('title', en);
  }

  function restoreTitles() {
    document.querySelectorAll('.kkh-title[data-kkh-en]').forEach(el => {
      el.textContent = el.dataset.kkhEn;
    });
  }

  function reapplyTitles() {
    document.querySelectorAll('.kkh-title[data-kkh-en]').forEach(el => {
      const en = el.dataset.kkhEn;
      const key = normKey(titleVariants(en)[0] || en);
      const c = titleCache[key];
      if (c && c.ko) applyKorean(el, c.ko, en);
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
    if (c && c.ko) { applyKorean(el, c.ko, text); return; }
    if (c && !c.ko && Date.now() - c.ts < WEEK_MS) { el.dataset.kkhDone = '1'; return; }
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
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this.__kkhUrl = typeof url === 'string' ? url : String(url);
      this.__kkhOpenArgs = Array.prototype.slice.call(arguments);
      this.__kkhHeaders = [];
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (name, value) {
      if (this.__kkhHeaders) this.__kkhHeaders.push([name, value]);
      return origSetHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const url = this.__kkhUrl || '';

      // (1) 자막 목록 응답 캡처 (읽기 전용)
      if (SUB_API_RE.test(url)) {
        this.addEventListener('load', () => {
          try {
            const data = parseXhrBody(this);
            if (Array.isArray(data)) onSubsCaptured(url, data);
          } catch (e) {}
        });
      }

      // (2) 한글 검색어 → 캐시된 영어 제목으로 즉시 치환 (동기, abort 위험 없음)
      if (SEARCH_API_RE.test(url)) {
        const m = url.match(/[?&]q=([^&]*)/);
        if (m) {
          const q = decodeURIComponent(m[1]);
          if (HANGUL_RE.test(q)) {
            const en = searchCacheLookup(q);
            if (en) {
              const newUrl = url.replace(/([?&]q=)[^&]*/, '$1' + encodeURIComponent(en));
              try {
                const args = this.__kkhOpenArgs.slice();
                args[1] = newUrl;
                const headers = (this.__kkhHeaders || []).slice();
                const rt = this.responseType, wc = this.withCredentials, to = this.timeout;
                origOpen.apply(this, args);
                this.responseType = rt;
                this.withCredentials = wc;
                this.timeout = to;
                headers.forEach(h => origSetHeader.call(this, h[0], h[1]));
                this.__kkhUrl = newUrl;
                return origSend.call(this, body);
              } catch (e) { /* 실패 시 원래 요청으로 진행 */ }
            }
          }
        }
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

  async function callTranslator(texts, ctx) {
    if (!settings.apiKey) throw new Error('API 키가 설정되지 않았습니다.');
    if (settings.provider === 'gemini') {
      const model = settings.model || 'gemini-2.5-flash';
      const u = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(settings.apiKey);
      const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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
        { role: 'system', content: SYSTEM_PROMPT },
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
  async function pacedCall(texts, ctx) {
    const wait = apiLastCall + apiPaceMs - Date.now();
    if (wait > 0) await sleep(wait);
    apiLastCall = Date.now();
    return callTranslator(texts, ctx);
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
    if (ck) {
      const cached = loadJSON(ck, null);
      if (cached && Array.isArray(cached) && cached.length === enCues.length) {
        applyAiLines(cues, enCues, cached);
        setStatus('AI 자막 적용됨 (캐시)');
        return;
      }
    }
    const BATCH = 25;
    const total = Math.ceil(enCues.length / BATCH);
    const lines = new Array(enCues.length).fill(null);
    const ctx = dramaContext();
    setStatus('AI 번역 시작… (0/' + total + ')');
    let done = 0;
    for (let a = 0; a < enCues.length; a += BATCH) {
      if (aiToken !== token) return; // 트랙이 바뀌면 중단
      const b = Math.min(a + BATCH, enCues.length);
      const texts = enCues.slice(a, b).map(c => c.text);
      const arr = await translateBatch(texts, ctx, token);
      if (aiToken !== token) return;
      if (arr) for (let i = 0; i < texts.length; i++) lines[a + i] = arr[i] || null;
      done++;
      setStatus('AI 번역 중… (' + done + '/' + total + ')');
      applyAiLines(cues, enCues, lines);
    }
    if (aiToken !== token) return;
    const missed = lines.filter(x => !x).length;
    if (ck && !missed) {
      try {
        localStorage.setItem(ck, JSON.stringify(lines));
        rememberSubCache(ck);
      } catch (e) {}
    }
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
   * 6. 한글 검색 지원
   * ------------------------------------------------------------------ */
  function searchCacheLookup(q) {
    const k = normKey(q);
    const c = searchCache[k];
    if (c && Date.now() - c.ts < 30 * 864e5) return c.en;
    for (const v of Object.values(titleCache)) {
      if (v && v.ko && normKey(v.ko) === k) return v.en || null;
    }
    return null;
  }

  async function resolveKoreanQuery(q) {
    const hit = searchCacheLookup(q);
    if (hit) return hit;
    let en = null;
    try {
      const su = 'https://www.wikidata.org/w/api.php?action=wbsearchentities' +
        '&search=' + encodeURIComponent(q) + '&language=ko&uselang=ko&format=json&origin=*&limit=8';
      const d = await fetchJson(su);
      const cands = d.search || [];
      const best = cands.find(x => /드라마|시리즈|텔레비전|방송|영화/.test(x.description || '')) || cands[0];
      if (best) {
        const eu = 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' + best.id +
          '&props=labels&languages=ko|en&format=json&origin=*';
        const d2 = await fetchJson(eu);
        const e = d2.entities && d2.entities[best.id];
        en = e && e.labels && e.labels.en && e.labels.en.value;
      }
    } catch (e) { noteError(e); }
    if (!en && settings.tmdbKey) {
      try {
        const tu = 'https://api.themoviedb.org/3/search/tv?api_key=' + encodeURIComponent(settings.tmdbKey) +
          '&language=en-US&query=' + encodeURIComponent(q);
        const d = await fetchJson(tu);
        if (d.results && d.results.length) en = d.results[0].name || d.results[0].original_name;
      } catch (e) { noteError(e); }
    }
    if (en) {
      searchCache[normKey(q)] = { en, ts: Date.now() };
      saveJSON(LS.search, searchCache);
    }
    return en;
  }

  // 사이트 검색창: 한글 입력 → 영어 제목으로 바꿔서 검색되게 함
  function hookSearchInput() {
    document.addEventListener('input', ev => {
      const t = ev.target;
      if (!t || t.id !== 'search') return;
      const v = t.value || '';
      if (!HANGUL_RE.test(v)) return;
      if (t.dataset.kkhResolving === v) return;
      t.dataset.kkhResolving = v;
      resolveKoreanQuery(v).then(en => {
        if (!en || !t.isConnected || t.value !== v) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(t, en);
        t.dispatchEvent(new Event('input', { bubbles: true }));
        setStatus('한글 검색 → "' + en + '" (으)로 변환');
      }).catch(() => {});
    }, true);
  }

  /* ------------------------------------------------------------------ *
   * 7. UI 패널
   * ------------------------------------------------------------------ */
  let panelEl = null, statusEl = null, fabEl = null;
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
    if (fabEl) fabEl.dataset.busy = text && /번역 중|번역 시작/.test(text) ? '1' : '';
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
      '#kkh-qres a{display:block;color:#9ecbff;text-decoration:none;padding:4px 0;border-bottom:1px solid #2c333c;font-size:12px}',
      '#kkh-qres a:hover{color:#fff}',
      '.kkh-hint{color:#98a2ad;font-size:11px;margin-top:3px}'
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
    const titleSec = h('div', { class: 'sec' }, [
      h('h3', { text: '제목' }),
      h('label', {}, [titleChk, h('span', { text: '한국어 제목으로 표시 (툴팁에 영어 유지)' })])
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

    // TMDB
    const tmdbInp = h('input', { type: 'text', placeholder: 'TMDB API 키 (선택)', value: settings.tmdbKey });
    tmdbInp.addEventListener('change', () => { settings.tmdbKey = tmdbInp.value.trim(); saveSettings(); setStatus('TMDB 키 저장됨 — 제목 조회 정확도 향상'); });
    const tmdbSec = h('div', { class: 'sec' }, [
      h('h3', { text: '제목 정확도 (선택)' }),
      tmdbInp,
      h('div', { class: 'kkh-hint', text: 'TMDB 무료 키를 넣으면 거의 모든 드라마의 한국어 제목을 찾습니다.' })
    ]);

    // 한글 검색
    const qInp = h('input', { id: 'kkh-q', type: 'text', placeholder: '한글로 검색 (예: 사랑의 불시착)' });
    const qBtn = h('button', { text: '찾기', style: 'margin-top:6px' });
    const qRes = h('div', { id: 'kkh-qres' });
    async function doSearch() {
      const q = qInp.value.trim();
      if (!q) return;
      qRes.textContent = '';
      setStatus('검색어 변환 중…');
      const en = HANGUL_RE.test(q) ? await resolveKoreanQuery(q) : q;
      if (!en) { setStatus('영어 제목을 찾지 못했습니다'); return; }
      setStatus('"' + en + '" 검색 중…');
      try {
        const d = await fetchJson('/api/DramaList/Search?q=' + encodeURIComponent(en) + '&type=0');
        const list = Array.isArray(d) ? d.slice(0, 8) : [];
        qRes.textContent = '';
        if (!list.length) { setStatus('결과 없음'); return; }
        for (const item of list) {
          const a = h('a', { href: '/Drama/' + encodeURIComponent(String(item.title || 'drama').replace(/\s+/g, '-')) + '?id=' + item.id });
          let ko = '';
          try { ko = (await lookupKoTitle(item.title)) || ''; } catch (e) {}
          a.textContent = (ko ? ko + ' — ' : '') + item.title;
          a.addEventListener('click', () => { qRes.textContent = ''; qInp.value = ''; });
          qRes.appendChild(a);
        }
        setStatus('검색 결과 ' + list.length + '건');
      } catch (e) { setStatus('검색 실패'); }
    }
    qBtn.addEventListener('click', doSearch);
    qInp.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    const searchSec = h('div', { class: 'sec' }, [
      h('h3', { text: '한글 검색' }),
      qInp, qBtn, qRes
    ]);

    // 캐시/정보
    const clearBtn = h('button', { text: '캐시 비우기' });
    clearBtn.addEventListener('click', () => {
      try {
        for (const k in titleCache) delete titleCache[k];
        for (const k in searchCache) delete searchCache[k];
        const idx = loadJSON(LS.subsIndex, []);
        idx.forEach(k => localStorage.removeItem(k));
        localStorage.removeItem(LS.subsIndex);
        localStorage.removeItem(LS.titles);
        localStorage.removeItem(LS.search);
      } catch (e) {}
      setStatus('캐시를 비웠습니다');
    });
    const infoSec = h('div', { class: 'sec' }, [
      h('h3', { text: '기타' }),
      clearBtn,
      h('div', { class: 'kkh-hint', text: 'v1.0.3 · 자막 캐시는 최근 30개 에피소드까지 보관' })
    ]);

    statusEl = h('div', { id: 'kkh-status' });

    [titleSec, subSec, aiSec, tmdbSec, searchSec, infoSec, statusEl].forEach(x => panelEl.appendChild(x));
    root.appendChild(fabEl);
    root.appendChild(panelEl);
    document.documentElement.appendChild(root);
  }

  /* ------------------------------------------------------------------ *
   * 8. 초기화
   * ------------------------------------------------------------------ */
  function init() {
    buildPanel();
    hookSearchInput();

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
      get searchCache() { return searchCache; },
      get queue() { return titleQueue.length; },
      get lastSubs() { return lastSubs; },
      get paceMs() { return apiPaceMs; },
      scanTitles: scanTitles,
      lookupKoTitle: lookupKoTitle,
      resolveKoreanQuery: resolveKoreanQuery,
      watchSubtitles: watchSubtitles
    };

    setStatus('준비됨 — 한국어 제목 표시 / 자막 개선');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
