# Cursay

macOS에서 말한 내용을 현재 앱의 입력란에 넣는 음성 입력 앱.

**현재 상태:** 설치형 앱 개발 중 · 공개 설치 파일 준비 중

[제품 설명](https://nodeoff.kr/products/cursay) · [소스 저장소](https://github.com/dhjin1125/cursay)

## 개발 환경에서 실행

macOS 개발 환경, Node.js 22 이상, pnpm

```sh
pnpm install
pnpm dev
```

개발용 앱 빌드는 `pnpm dist:mac`입니다. 마이크·손쉬운 사용 권한과 음성 인식 서비스 연결이 필요합니다. `fn`으로 현재 입력란에 입력하고 `Control + fn`으로 입력 대상을 고정합니다. 현재 빌드는 개발용 서명이며 일반 배포용 공증을 완료한 설치 파일은 제공하지 않습니다. 기존 macOS 권한을 유지하기 위해 내부 앱·도우미 식별자는 보존합니다.

## 운영자 정보

- 상호: 노드오프
- 대표: 진동현
- 사업자등록번호: 502-60-03676
- 운영 지역: 인천광역시
- 문의: [jin@nodeoff.kr](mailto:jin@nodeoff.kr)
- 회사 홈페이지: [nodeoff.kr](https://nodeoff.kr)

현재 개발 상태와 공개 주소는 회사 홈페이지와 함께 관리합니다.

## 공개 이력과 개발 경과

2026년 10월 7일 기존 비공개 작업을 정리해 처음 공개한 저장소입니다. 개발 시작일과 공개 커밋 날짜는 다릅니다. [개발 경과와 공개 범위](docs/development-history.md)를 확인해 주세요.

## 현재 연결 방식

현재 코드의 Codex/ChatGPT 연동을 Claude API 연동이라고 표시하지 않습니다. 내부 `local.minkyu.*` 레거시 식별자는 기존 macOS 권한 호환성을 위해 유지하며, 공개 운영자는 Nodeoff입니다. Nodeoff의 이번 Claude 도입 우선 제품은 [Nurse Board](https://nodeoff.kr/products/nurse-board#claude-plan)입니다.
