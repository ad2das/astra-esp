# Astra Attack ESP

아스트라 어택 (https://astra-attack.pages.dev/) 용 ESP 오버레이 유저스크립트.
적 박스 · HP 바 · 이름 · 무기 · 거리 · 트레이서 표시. PC + 모바일.

## 설치 (폰 / 안드로이드)

1. **Firefox** 설치 → 설정 → 확장에서 **Tampermonkey** 설치
2. 아래 링크를 탭 → Tampermonkey 설치 화면이 뜨면 **설치** 누르면 끝

**설치 링크**
https://raw.githubusercontent.com/ad2das/astra-esp/main/astra-esp.user.js

> 아이폰은 Firefox 대신 **Userscripts** 앱(Safari 확장)에 같은 내용을 붙여넣으면 된다.

## 설치 (PC)

- Tampermonkey가 있으면 위 링크 그대로 설치
- 없으면: 게임 페이지를 열고 "처음 플레이하기" 버튼이 뜨기 전에 `F12` → Console에
  `astra-esp.user.js` 내용 전체 붙여넣기 → Enter

## 사용법

- 좌상단 **ESP** 칩 탭 = 켜기/끄기, 드래그 = 위치 이동 (위치 저장됨)
- **M** 팀원 표시 / **T** 트레이서 / **S** 내 캐릭터
- 적이 잡히면 칩 옆에 적 숫자가 뜨고, 박스 위에 이름 · 무기 · 거리, 왼쪽에 HP 바가 그려진다
- PC 키: `F6` 트레이서 / `F7` 팀원 / `F8` 마스터 / `F9` 본인

## 참고

- 서버가 가까이 온 적만 복제해 주는 구조라 대략 20m 안쪽 적만 뜬다 (게임 자체가 쓰는 것과 같은 데이터)
- 처음에 잠깐 안 뜨면 화면을 한 번 휙 돌려보면 카메라가 잡히면서 바로 뜬다
- 업데이트: Tampermonkey가 이 파일을 주기적으로 확인해서 자동 업데이트한다
