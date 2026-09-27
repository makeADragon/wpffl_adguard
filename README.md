# wpffl_adguard — 개인 필터 모음

애드가드 / 유블록 오리진용 개인 필터.
**용도(일반 / 스트리밍) × 프로그램(AdGuard / uBlock Origin)** 기준으로 4개 파일로 관리합니다.

## 파일 구성

| 파일 | 대상 | 내용 |
|---|---|---|
| `adguard-general.txt` | AdGuard | 일반 사이트 (네이버, 쇼핑, 금융 등) |
| `adguard-streaming.txt` | AdGuard | 스트리밍 사이트 + Web P2P 차단 |
| `ublock-general.txt` | uBlock Origin | 일반 사이트 |
| `ublock-streaming.txt` | uBlock Origin | 스트리밍 사이트 + Web P2P 차단 |

> 참고: P2P 차단 규칙(`$websocket`, `$script`)은 구조상 **전역 규칙**이라 어느 사이트에서든 동작합니다.
> 관리 편의를 위해 스트리밍 파일에 모아둔 것입니다.

## 구독 URL

```
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/adguard-general.txt
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/adguard-streaming.txt
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/ublock-general.txt
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/ublock-streaming.txt
```

## 설치

**AdGuard (Windows / macOS)**
1. 설정 → 필터 → **커스텀 필터**에 위 URL 추가 (일반/스트리밍 각각)
2. 또는 설정 → 필터 → **사용자 규칙**에 파일 내용 붙여넣기

**uBlock Origin (Firefox 데스크톱 / 안드로이드)**
1. 대시보드 → **필터 목록** → 사용자 지정 목록에 URL 추가
2. 또는 대시보드 → **내 필터**에 파일 내용 붙여넣기

## P2P 차단 범위 (스트리밍 파일)

| 계층 | 규칙 | 커버 대상 | 부작용 |
|---|---|---|---|
| 트래커 `$websocket` | 공용 WebTorrent 트래커 | 공용 트래커로 시그널링하는 모든 사이트 | 거의 없음 (HTTP로 폴백) |
| 로더 `$script` | `p2p-media-loader-*` | Novage P2P Media Loader를 별도 로드하는 사이트 | 낮음 |
| 로더 `$script` | `*-p2p-engine` | cdnbye / SwarmCloud 계열 | 낮음 |
| 스크립틀릿 | `nowebrtc` (플레이어 호스트 나열식) | 자체 시그널링 / 번들 로더 사이트 | 해당 호스트 WebRTC만 비활성 |

**한계 (100% 아님)**

1. 자체 트래커/시그널링 도메인 → uBO 로거(웹소켓)로 도메인 확인 후 `||도메인^$websocket` 추가
2. p2p-media-loader를 플레이어 JS에 번들한 사이트 → 해당 플레이어 호스트를 `nowebrtc` 줄에 추가
3. 완전 차단이 필요하면 브라우저 설정: Firefox `about:config` → `media.peerconnection.enabled = false`

**확인 방법**

- uBO 로거 → `웹소켓` 유형만 보기 → tracker 연결이 빨간색(차단)이면 정상
- 플레이어 콘솔에서 `[P2P]` 로그 / `Object.keys(window).filter(k => /p2p|peer|torrent/i.test(k))`
- 영상 재생은 그대로 되어야 정상 (P2P만 꺼지고 HTTP CDN으로 폴백)

## 문법 메모 (AdGuard ↔ uBO)

- `nowebrtc`: AdGuard `#%#//scriptlet('nowebrtc')` / uBO `##+js(nowebrtc)`
- `nowoif` → AdGuard `prevent-window-open` (의미 유사 변환)
- `cokcok*.com##` 형태의 와일드카드 호스트는 확장 필터에서 비표준 → `[$domain=/^cokcok[^.]*\.com/]##` 정규식으로 변환
- AdGuard의 `$webrtc` 모디파이어는 제거됨 → WebRTC 차단은 scriptlet으로 처리
- uBO는 도메인 없는 generic 스크립틀릿(`##+js(...)`)을 무시함 → 호스트 나열식 사용
- 두 파일 모두 uBO 파서 / AdGuard agtree 파서로 문법 검증 완료 (2026.09.26)

## 유저스크립트

- `anti-devtools.user.js` — F12·우클릭·드래그·텍스트선택 차단 및 무한 debugger 루프를 무력화하는 범용 스크립트.
  Tampermonkey/Violentmonkey에서 새 스크립트로 등록해 사용 (`@run-at document-start`).
  구독 URL: https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/anti-devtools.user.js

## 관련 유저스크립트 (참고)

- 나무링크: https://cdn.jsdelivr.net/npm/@filteringdev/namulink@latest/dist/NamuLink.user.js
- 타이니쉴드: https://cdn.jsdelivr.net/npm/@filteringdev/tinyshield@latest/dist/tinyShield.user.js

## 변경 로그

- 2026.09.27: `anti-devtools.user.js` 추가. 관리자도구(F12/우클릭/드래그/선택) 차단 및
  무한 debugger 루프를 무력화하는 범용 유저스크립트 (Tampermonkey/Violentmonkey용).
- 2026.09.26: 짭플릭스(zzap###) 광고 차단 규칙 추가. 도메인 숫자는 가변값으로 처리
  (`[$domain=/^zzap[0-9]*\.[a-z]{2,}/]`). PC/모바일 공통 광고 배너(`#advertiseMain`),
  고정 팝업(`.popup_mdd`), PC URL 팝업(`.popup-frame`), 파트너 배너 차단 +
  팝업 광고 이미지 호스트(`sj.xiaoca.top`) 네트워크 차단.
  uBO 최신 파서 / AdGuard agtree 문법 검증 및 실사이트 DOM 확인 완료.
- 2026.09.26: `my_rule.txt` → 4개 파일(adguard/ublock × general/streaming)로 분리.
  P2P 차단에 cdnbye/SwarmCloud 트래커·로더 규칙 추가, AdGuard/uBO 문법 차이 반영.
- 2026.09.26: 독립 public 레포로 전환 (`makeADragon/wpffl_adguard`). 4개 raw URL 구독 방식 사용.
- 이전: `my_rule.txt` 단일 파일로 관리
