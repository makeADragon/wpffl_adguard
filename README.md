# wpffl_adguard

개인 설정 보관용 저장소입니다.

## 구독 URL

### AdGuard

```
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/adguard-general.txt
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/adguard-streaming.txt
```

### uBlock Origin

```
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/ublock-general.txt
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/ublock-streaming.txt
```

### 유저스크립트

```
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/anti-devtools.user.js
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/netflix-speed.user.js
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/youtube-adblock.user.js
```

### 유저스타일

```
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/youtube-feed.user.css
```

## Safari(오리집)에서 YouTube

Safari의 네이티브 콘텐츠 차단기는 다음을 지원하지 않습니다.

- `#%#` 뒤에 코드를 직접 쓰는 raw JS 규칙 (임의의 JavaScript 실행)
- `:has()`를 사용한 요소 가리기 (목록이 변환되지 않을 수 있음)

오리집의 고급 차단 확장은 `#%#//scriptlet('이름', ...)`과 `##+js(...)` 중 **이름 있는 scriptlet 일부**를 지원하지만, raw JS를 그대로 실행하지는 않습니다. 고급 차단이 켜져 있으면 오리집이 이미 내장 early scriptlet으로 YouTube 플레이어의 광고 데이터(`adPlacements`/`adSlots`/`playerAds`)를 제거합니다. 그래도 **AdGuard Base 필터만으로는 영상 광고 건너뛰기와 안티애드블록 팝업이 해결되지 않습니다.** 그 부분은 DOM을 직접 다루는 유저스크립트가 필요합니다.

오리집에서는 아래 순서로 적용하세요.

1. **오리집 › Safari 광고 차단**에서 `오리집`(고급 차단·유저스크립트) 확장을 켜고, 웹사이트 접근을 **허용**으로 설정합니다.
2. **유저스크립트** `youtube-adblock.user.js`를 설치합니다. 영상 광고 건너뛰기와 안티애드블록 팝업 제거를 담당합니다.
3. **(선택) 유저스타일** `youtube-feed.user.css`를 설치합니다. 유저스크립트도 같은 CSS를 넣으므로, 유저스크립트를 쓰면 없어도 됩니다. JavaScript 없이 CSS만 적용하고 싶을 때 사용하세요.
4. `adguard-streaming.txt`를 구독합니다. 일반 차단 규칙과 `google_ad_status` 보조 scriptlet이 들어 있습니다.

유저스크립트의 실행 영역을 고를 수 있으면 **페이지 안(page)** 으로 두세요. `페이지와 분리된 영역(isolated)`에서는 `ytInitialPlayerResponse` 패치가 적용되지 않지만, DOM 기반 광고 숨김·건너뛰기·팝업 제거는 동작합니다.

### 그래도 광고가 보이면

- 오리집 › Safari 광고 차단에서 `오리집`(고급 차단) 확장이 켜져 있고, Safari 설정에서 웹사이트 접근이 **허용**인지 확인하세요.
- YouTube가 **허용한 사이트**에 들어 있으면 그 사이트에서는 고급 차단이 꺼집니다. 목록에서 빼세요.
- 목록 화면에 **"규칙이 빠졌어요"** 경고가 뜨면 Safari 규칙 한도(90만 개)를 넘은 것입니다. AdGuard Base처럼 큰 목록을 끄거나 목록 수를 줄이세요.
- 목록을 바꾼 뒤에는 오리집의 **지금 모두 업데이트**를 누르고 YouTube를 새로고침하세요.

> YouTube는 광고 차단을 계속 바꾸기 때문에 이 방식도 언젠가 깨질 수 있습니다. 그때는 `youtube-adblock.user.js`의 선택자와 `google_ad_status` 처리부터 확인하세요.
