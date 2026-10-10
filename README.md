# 머니리그 클라이언트 (build/client)

React 18 + TypeScript + Vite + react-i18next. `design/mockup_*.html` 7종을 그대로 구현한 것.

## 실행
```bash
npm install
npm run dev        # http://localhost:5173  (/api, /ws 는 8787 로 프록시)
npm run typecheck  # tsc --noEmit
npm run gen:data   # research/sp100_tickers.csv + design/bot_roster.csv -> src/data/*.generated.ts
```
서버(`build/server`)를 먼저 `npm start` 로 띄우면 실서버 모드(연결 배지 "실시간"),
안 띄우면 `src/lib/mockWorld.ts` 로컬 시뮬로 폴백한다(배지 "오프라인 연습"). 렌더는 항상 된다.

## 구조
| 경로 | 역할 |
|---|---|
| `src/styles/tokens.css` | ui_spec 1장 디자인 토큰 2벌(light/dark) + `[data-updown=us]` 색 토글. **hex 하드코딩 금지** |
| `src/store/store.ts` | 유일한 상태 소스. server/mock 모드 전환, 종목별 구독, 랭킹 3초 스로틀 |
| `src/lib/ws.ts` | WS 구독(지수 백오프 재연결). 가격 폴링 안 함 |
| `src/lib/mockWorld.ts` | 오프라인 폴백 시뮬(가격공식·수수료·증거금은 ARCHITECTURE 값 동일). **권위 아님** |
| `src/locales/*.json` | 화면 단위 8 네임스페이스. 숫자는 문자열에 안 박고 `lib/format.ts`(Intl)로 생성 |

## 확정 수치 (임의 변경 금지)
`src/lib/constants.ts` 가 ARCHITECTURE.md 미러. 앱 기동 시 `GET /api/config` 로 서버 실제값을 받아 덮어쓴다.

## 알려진 스펙 불일치 2건 (venture-cto 결정 대기)
1. **옵션 1계약 단위** — ARCHITECTURE 10-A.2 = 10주, 서버 `OPTION_CONTRACT_MULTIPLIER` = 1.
   클라이언트는 UI를 10주/계약으로 표기하고 주문 시 `CONTRACT_TO_SERVER_UNITS(=10)` 를 곱해 보낸다.
   서버가 10으로 고쳐지면 `SERVER_SHARES_PER_CONTRACT` 를 10으로 바꾸면 끝(환산값이 1이 된다).
2. **유지증거금 기준** — 목업 예시는 3배 청산 −13.3%(entry_notional 기준), 서버는 `initial_margin` 이라 −26.7%.
   서버 기준이 맞다(entry_notional 은 5배에서 개시 즉시 청산). 화면은 `/api/config` 의 `leverage.basis` 를 따라간다.

## 서버에 요청한 것 (없어도 동작하지만 있으면 더 정확해짐)
- `trade` 월드 이벤트의 스로틀 브로드캐스트 → 홈 체결 피드를 전부 실데이터로 전환 가능
- 종목별 `netOrderFlow` 노출 → "지금 분위기" 게이지의 근사치를 실값으로 교체 가능
- 타 참가자 통계(거래수/승률/청산수) API → 프로필 화면의 `—` 를 채울 수 있음
