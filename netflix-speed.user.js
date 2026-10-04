// ==UserScript==
// @name         Netflix Playback Speed Controller
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  넷플릭스 영상 배속을 단축키로 자유롭게 조절합니다.
// @author       AI Assistant
// @match        https://www.netflix.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 배속 상태를 화면에 보여주는 알림 팝업 생성
    const speedNotice = document.createElement('div');
    speedNotice.style.position = 'fixed';
    speedNotice.style.top = '80px';
    speedNotice.style.left = '40px';
    speedNotice.style.background = 'rgba(0, 0, 0, 0.7)';
    speedNotice.style.color = '#fff';
    speedNotice.style.padding = '10px 15px';
    speedNotice.style.borderRadius = '5px';
    speedNotice.style.fontSize = '20px';
    speedNotice.style.zIndex = '99999';
    speedNotice.style.display = 'none';
    speedNotice.style.pointerEvents = 'none';
    speedNotice.style.fontFamily = 'sans-serif';
    document.body.appendChild(speedNotice);

    let timeoutId;
    function showSpeed(speed) {
        speedNotice.textContent = `${speed.toFixed(2)}x`;
        speedNotice.style.display = 'block';
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            speedNotice.style.display = 'none';
        }, 1500);
    }

    // 단축키 이벤트 리스너
    window.addEventListener('keydown', function(e) {
        const video = document.querySelector('video');
        if (!video) return;

        // 대화창이나 검색창 입력 중일 때는 작동하지 않도록 방지
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

        let currentSpeed = video.playbackRate;

        if (e.key === ']') { // 배속 증가
            currentSpeed = Math.min(currentSpeed + 0.1, 16.0);
            video.playbackRate = currentSpeed;
            showSpeed(currentSpeed);
        } else if (e.key === '[') { // 배속 감소
            currentSpeed = Math.max(currentSpeed - 0.1, 0.1);
            video.playbackRate = currentSpeed;
            showSpeed(currentSpeed);
        } else if (e.key === '\\') { // 1배속 초기화
            video.playbackRate = 1.0;
            showSpeed(1.0);
        }
    }, true);
})();
