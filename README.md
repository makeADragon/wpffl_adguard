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

### 유저스타일 (오리집 등 Safari 콘텐츠 차단기용)

YouTube 홈 피드의 카드형 광고를 부모 카드까지 숨깁니다.

- **AdGuard / uBlock Origin**: `adguard-streaming.txt` / `ublock-streaming.txt`의 YouTube 규칙으로 처리하므로 이 파일은 필요하지 않습니다.
- **오리집 등 Safari 콘텐츠 차단기**: 필터 변환 과정에서 `:has()` 규칙이 빠질 수 있어 이 유저스타일을 사용합니다.

```
https://raw.githubusercontent.com/makeADragon/wpffl_adguard/main/youtube-feed.user.css
```
