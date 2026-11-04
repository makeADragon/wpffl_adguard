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
```

### 유저스타일

```
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/youtube-feed.user.css
```

## Safari(오리집)에서 YouTube

Safari의 네이티브 콘텐츠 차단기는 `#%#` 뒤에 코드를 직접 쓰는 raw JS 규칙과 `:has()`를 목록에서 완전히 지원하지 않습니다. YouTube 홈/검색 피드의 카드형 광고는 `youtube-feed.user.css` 유저스타일로 부모 카드까지 접을 수 있습니다.

영상 광고 건너뛰기와 광고 차단 감지 팝업 우회는 Safari 콘텐츠 차단기와 유저스타일만으로는 해결되지 않습니다. 현재 이 저장소에서는 다루지 않으며, 필요하면 wblock이나 Orion + uBlock Origin 같은 별도 도구를 사용하세요.

### 그래도 피드 광고가 보이면

- 오리집 › Safari 광고 차단에서 `오리집`(고급 차단) 확장이 켜져 있고, Safari 설정에서 웹사이트 접근이 **허용**인지 확인하세요.
- YouTube가 **허용한 사이트**에 들어 있으면 그 사이트에서는 고급 차단이 꺼집니다. 목록에서 빼세요.
- 목록 화면에 **"규칙이 빠졌어요"** 경고가 뜨면 Safari 규칙 한도(90만 개)를 넘은 것입니다. AdGuard Base처럼 큰 목록을 끄거나 목록 수를 줄이세요.
- 목록을 바꾼 뒤에는 오리집의 **지금 모두 업데이트**를 누르고 YouTube를 새로고침하세요.
