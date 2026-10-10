# 머니리그 — 앱인토스 `.ait` 래핑

작성 2026-08-10 / venture-frontend
범위: **패키지 생성까지.** 콘솔 등록·제출·검수요청·업로드는 Partner 게이트다. 여기서 하지 않았다.

라벨: **[측정]** 이 세션에서 직접 실행·렌더·디코드해서 봄 / **[추정]** 코드만 읽고 판단 / **[미확인]** 확인 못 함

---

## 0. 지금 상태 — 무엇이 «되고» 무엇이 «안 되는가»

### 되는 것 [측정]
| 항목 | 결과 |
|---|---|
| `.ait` 빌드 | 성공(첫 시도). 6,102,472 B |
| RN 호스트 번들 4종 | ios/android × 0.84.0/0.72.6 **4/4 존재** |
| 필수 SDK 4종 배선 | 사용자 식별키 · Safe Area · 네이티브 Storage · 내비게이션 바 |
| 네이티브 Storage 왕복 | `round-trip OK` (write→read 일치) |
| 이름 사본 일치 | 전 지점 일치, 오표기 **0건** |
| 실렌더(ko/en) | 페이지 에러 0 · 콘솔 에러 0 |
| **외부 네트워크 요청** | **0건** (ko/en 각 7요청, 전부 자기 오리진) |
| 타입검사 | `tsc --noEmit` 0 에러 |
| i18n 키 정합 | ko/en 446키 일치, warning 0 |
| 뒤로가기 정책 단위검증 | 20/20 PASS(양성대조 선행) |

### 안 되는 것 / 남은 것
| 항목 | 상태 |
|---|---|
| `appName` 콘솔 실값 | **[미확인]** 플레이스홀더 `moneyleague` |
| `brand.icon` publicUrl | **[미확인]** 빈 문자열 |
| **→ 그래서 현재 `.ait` 는 «제출 불가본»** | 파일명에 `UNSUBMITTABLE` 명시 |
| 실기기(진짜 토스 앱) 검증 | **미수행.** 브릿지 실응답 경로는 전부 [추정] |
| 네이티브 내비바 실제 표시 | **[미확인]** 로컬에서 띄울 수 없음 |

---

## 1. 🔴 미니앱 «이름» 사본 위치 — 바꿀 때 «전부» 같이 바꿔라

트랙 K 네온스레드가 **정확히 이 사유로 검수 반려**됐다:
「미니앱 이름이 앱 정보등록에 제출된 이름과 동일해야 해요」.
**이름은 한 곳에 있지 않다. 한 곳만 고치면 반드시 어긋난다.**

### 한글 이름 = 고쳐야 하는 곳

| # | 파일 | 위치 | 역할 | 빌드 후 어디로 |
|---|---|---|---|---|
| ① | `granite.config.ts` | `brand.displayName` | 미니앱 표시 이름 | RN 번들 4개 (번들당 2회) |
| ② | `index.html` | `<title>` | 브라우저/웹뷰 탭 제목 | `dist/web/index.html` 그대로 |
| ③ | `index.html` | `<meta name="description">` | 설명문 | 〃 |
| ④ | **`src/locales/ko.json`** | `common.appName` | ★ **화면에 실제 보이는 이름** | `dist/web/assets/bootstrap-*.js` |
| ⑤ | `src/locales/en.json` | `common.appName` | 영문 표시 이름 | 〃 |
| ⑥ | `src/lib/constants.ts` | `APP_NAME_KO` / `APP_NAME_EN` | 상수 정본 | 〃 |
| — | (콘솔) | 앱정보 `title` | **정본** | Partner 등록 |

### ★ ④가 핵심이다
`Home.tsx:60` 과 `Onboarding.tsx:144` 가 `t('common:appName')` 로 렌더한다.
**`index.html` 을 고쳐도 화면 이름은 안 바뀐다.** 실렌더로 확인한 사실 [측정]:

```
document.title      : 머니리그        ← index.html (②)
name render nodes   : [{"text":"머니리그","tag":"SPAN"}]   ← ko.json (④)
```

### 절대 건드리면 안 되는 것

| 대상 | 값 | 이유 |
|---|---|---|
| `granite.config.ts` `appName` | `moneyleague` | **딥링크 식별자·서버 컴파일 키.** 표시명 아님. 바꾸면 링크가 죽는다 |
| `package.json` `"name"` | `moneyleague-client` | npm 패키지 식별자 |
| 주석 안의 옛 이름 | — | 주석은 «이력»이다 |

★ **전역 치환 금지.** 위 6곳을 «지정»해서 고쳐라.

### 검증 — 소스 확인으로 끝내지 마라
검사기: `scratchpad/ait_verify.py <파일.ait>` (양성대조 내장)
1. `.ait` 는 **zip** 이다 → 생바이트 grep 무효. unzip 후 검사
2. RN 번들의 한글은 `\uXXXX` 이스케이프. ★**대문자**(`머`)도 있다 → `[0-9a-fA-F]`
3. 번들이 **4개**다. 전부 확인
4. 판정은 두 조건: 「맞는 이름이 있다」 **그리고** 「틀린 이름이 0건이다」

---

## 2. 4종 래핑(트랙 K) 레시피와 «다르게» 간 지점 — 이유 포함

| # | 지점 | 4종 | 머니리그 | 근거 |
|---|---|---|---|---|
| 1 | 게임 코드 추출 | 단일 HTML `<script>` 잘라내기 | **불필요** | 이미 Vite SPA. `vite build` 를 그대로 물림 |
| 2 | Storage 미러 | `window.__nativeStorageMirror` 전역 훅 | **훅 없음** | store/persistence 가 «우리 코드» → 래퍼 직접 호출. 번들 훅 0건이 정상 |
| 3 | 토스 밖 popstate | 바인딩함 | **바인딩 안 함** | ↓ §3 실측 결함 |
| 4 | 뒤로가기 | 항상 종료확인 | **라우터 인식 3단** | HashRouter SPA 라 화면 스택이 있다 |
| 5 | `navigationBar.theme` | dark(단색 게임) | **light** | 앱이 라이트/다크 런타임 전환. ↓ §4 |
| 6 | `withTitle` | false | **true** | 공식 게임 체크리스트 명문. ↓ §4 |

---

## 3. ⚠ 이식 중 «실측으로» 잡은 결함 — 그대로 가져왔으면 웹 배포본이 깨졌다

4종 레시피를 그대로 적용했더니 **토스 밖에서 평범한 화면 이동마다 종료 확인 모달이 떴다.**

원인: 4종은 화면 전환이 DOM 클래스 토글이라 history 를 안 썼다. 머니리그는
HashRouter → 화면 이동 = hashchange → **hashchange 는 popstate 를 발생시킨다** →
`initNavigationBar` 가 토스 밖에서 걸어둔 popstate 리스너가 매번 발화.

실측 로그(수정 전):
```
[nav] back at "/home"       -> exit    ← 종목 눌러 들어가기만 해도 「종료할까요?」
[nav] back at "/stock/NVDA" -> back
[nav] back at "/home"       -> exit
```

**조치**: 토스 밖에서는 (a) popstate 를 바인딩하지 않고 (b) 백 정책 자체를 설치하지 않는다.
수정 후 실측 — 위 로그가 **전부 사라졌다**:
```
[nav] not in Toss — back handling left to the browser (no popstate binding)
[nav] back policy skipped (not in Toss)
```
→ 웹 배포본(itch.io·GitHub Pages·MS Store 래핑)의 뒤로가기 동작은 **SDK 도입 전과 동일**하다.

---

## 4. 판단이 갈릴 수 있는 두 값 — 뒤집기 쉽게 한 줄로 몰아놨다

### `navigationBar.theme: 'light'`
자체 WCAG 계산(대조 검증 선행: #000/#fff=21.00, #777/#fff=4.48 로 계산기 정확성 확인):

| 아이콘 | 앱 라이트 `#f2f4f6` | 앱 다크 `#0c0e13` |
|---|---|---|
| `#191F28` (theme=light) | **15.02:1 PASS** | 1.17:1 FAIL |
| `#FFFFFF` (theme=dark) | 1.10:1 FAIL | **19.30:1 PASS** |

→ 이 표의 결론은 「**`transparentBackground: true` 를 쓰면 안 된다**」이다. 투명이면 절반은 반드시 FAIL.
→ 그래서 `transparentBackground: false`(솔리드 네이티브 바) + 앱 기본 외형인 `light`.
→ [미확인] 네이티브 바가 실제로 칠하는 배경색은 SDK 코드에서 확인 불가(plugins 는 값 검증만 하고 네이티브로 넘긴다).

### `navigationBar.withTitle: true` — 4종(false)과 다르다
공식 게임 체크리스트 원문: 「앱 정보에 등록한 브랜드 로고와 미니앱 이름(국문)을 내비게이션 바에 반영해요」
4종은 전체화면 타이틀 화면이 있어 중복 회피로 false 를 썼다. 머니리그는 전체화면 타이틀이
온보딩 1회뿐이라 중복 우려가 작다고 보고 문서 명문을 따랐다.
⚠ [추정] 홈 앱바(`Home.tsx:60`)가 이미 이름을 렌더하므로 실기기에서 **이름이 두 번** 보일 수 있다.
그러면 `granite.config.ts` 의 이 한 줄만 `false` 로 뒤집으면 된다.

---

## 5. Storage — 동기/비동기 임피던스를 어떻게 넘겼나

문제: 네이티브 Storage 는 **비동기**인데 이 앱의 읽기 경로는 **동기**다
(`store.ts` 생성자가 모듈 로드 시점에 localStorage 를 읽고, `persistence.loadGame()` 도 동기).

해결: **읽기 경로를 안 건드린다.**
```
[부팅] primeAppStorage()  네이티브 미러 → localStorage 역주입(없는 키만)
       그 «다음»에야 앱 모듈을 동적 import (main.tsx → bootstrap.tsx)
[저장] localStorage 즉시 + 네이티브 fire-and-forget
```
`main.tsx` 가 `bootstrap.tsx` 를 **동적** import 하는 이유가 이것이다.
정적 import 는 호이스팅되어 store 생성자가 프라이밍보다 먼저 돈다.

대상 키 5개 [측정] — `ml.session` `ml.settings` `ml.watchlist` `ml.onboarded` `ml.game`
※ `ml.seed` 는 **의도적 제외**. QA 재현용 디버그 시드라 영속되면 매번 같은 장세가 재현된다.

★ 함정: 세이브 삭제 시 **네이티브 미러도 지워야 한다**(`mirrorDrop`). 안 지우면
다음 부팅에 `primeAppStorage()` 가 지운 세이브를 되살린다. `clearGame()` / 손상 세이브
정리 두 곳 모두 처리했다.

---

## 6. 검증 결과 상세

### 6-1. mtime 3줄 [측정]
```
source -> 2026-08-10 05:16  (src/ + granite.config.ts 중 최신)
dist   -> 2026-08-10 05:18  (dist/web/index.html)   뒤가 새것 OK
.ait   -> 2026-08-10 05:18                          뒤가 새것 OK
```

### 6-2. 산출물
```
moneyleague_UNSUBMITTABLE_placeholder-appname-and-icon_20260810.ait
size 6,102,472 bytes
md5  7ab0c0dbcbd6a73553f67e0c15575639
deploymentId 019fe82d-a27a-7d01-bd5f-4f16f0c11fd0
```

### 6-3. 훅·디버그 — 「0건」이 아니다. 전건 정체를 밝힌다 [측정]
`.ait` 웹 자산 전수 스캔 결과 38건. **하나도 뭉개지 않고 분류했다.**

| 분류 | 건수 | 정체 | 판정 |
|---|---|---|---|
| `debugger` | **0** | — | 청정 |
| `__nativeStorageMirror` | **0** | 4종엔 3건 있다. 우리는 설계상 불필요 | **4종보다 깨끗** |
| `window.__` | 6 | `__CONSTANT_HANDLER_MAP`·`__GRANITE_NATIVE_EMITTER`(SDK 브릿지 감지, 필수) + `__reactRouterVersion`(라이브러리) | 우리가 심은 디버그 훅 아님 |
| `console.log` | 18 | 전부 `[toss-sdk]` 접두사 진단 로그. **게임 코드 0건** | ↓ |
| `http://` | 13 | 전부 **XML 네임스페이스 URI**(w3.org svg/xhtml/xlink/MathML). 네트워크 요청 아님 | 무해 |
| `https://` | 3 | React 에러 디코더 URL + `static.toss.im/ads/...` (**SDK 내장 문자열**) | ↓ |

**대조 근거**: 이미 파이프라인을 통과한 `neonthread.ait` 를 같은 검사기로 훑은 결과
`static.toss.im/ads/...`·`[toss-sdk]` 로그·`window.__CONSTANT_HANDLER_MAP` **전부 동일하게 존재**한다.
즉 SDK 내재분이며 우리 코드가 넣은 것이 아니다.

**그리고 실렌더에서 외부 요청은 0건이다** — 광고 SDK URL 은 문자열로만 존재하고 실제로 요청되지 않는다.

> ⚠ **표면화**: `@apps-in-toss` 를 앱 번들에 넣었으므로, 이제 **같은 `dist/` 를 쓰는 MS Store 빌드에도**
> 그 문자열이 들어간다. MS Store 심사는 이미 통과했고(President 확정) 그때 낸 패키지는 이 변경 «이전»
> 산출물이라 소급 영향은 없다. 다만 **향후 MS Store 재빌드 시** 「외부 서버와 통신하지 않으며」 문안과
> 함께 검토가 필요할 수 있다. 판단은 하지 않는다.

### 6-4. try/catch — 조용한 실패 후보, 세어서 출력 [측정]
총 **30건** (기존 18 + 이번 추가 12).

```
기존 앱 코드 (18)
  persistence.ts 5 | store.ts 3 | Onboarding.tsx 2
  OrderSheet 1 | constants 1 | bots 1 | gameWorld 1 | world 1
  LeverageOrder 1 | OptionOrder 1 | Recharge 1
이번 추가 (12)
  toss/storage.ts 4 | toss/env.ts 3 | toss/navigationBar.ts 2
  tossBoot.ts 2 | main.tsx 1
```
추가분 12건은 **전부 의도된 흡수**다(브릿지 부재·타임아웃·quota). 전부 `console.warn` 으로 흔적을 남기며
조용히 삼키지 않는다. 유일한 무음 catch 는 `localStorage` 접근 실패(프라이빗 모드)로, 원래 앱의 기존 정책과 같다.

### 6-5. 실렌더 [측정]
`qa_evidence/ait_render_20260810/` — `01_boot_ko.png` `02_boot_en.png` `render_report.json`

| | ko | en |
|---|---|---|
| `document.title` | 머니리그 | 머니리그 (정적, 런타임 덮어쓰기 없음) |
| `html lang` | ko | en |
| 화면 이름 | **머니리그** (SPAN) | **Money League** (SPAN) |
| 요청 / 외부 | 7 / **0** | 7 / **0** |
| 페이지·콘솔 에러 | 0 / 0 | 0 / 0 |

---

## 6-6. 추가 점검 (2026-08-11, 소스 무변경 — 재빌드 없음) [측정]

앞선 검증에서 **약한 고리 하나**를 스스로 찾아 메웠다.

### (a) 에셋 규격 검사기에 «자가시험 needle» 을 넣었다
1차 검사기는 PASS 만 출력했다 — 「검사가 통과」 ≠ 「검사가 돌았다」.
불합격 이미지 5종을 만들어 **검사기가 전부 잡는지 먼저 증명**하도록 고쳤다.

| needle | 검사기 반응 |
|---|---|
| 크기 1px 부족 (599×600) | CAUGHT `size (599,600) != (600,600)` |
| 투명 픽셀 존재 | CAUGHT `최소 alpha=0` |
| 둥근 모서리(모서리 흰색) | CAUGHT `모서리 4점 흰색` |
| PNG 아님(JPEG) | CAUGHT `format JPEG != PNG` |
| 알파채널 존재(전부 불투명) | CAUGHT `알파 채널 존재` |
| 정상 이미지 | PASS (거짓양성 없음) |

→ 그 뒤 본 검사에서 에셋 9점 **ALL PASS**. 이제 이 PASS 는 근거가 있다.
검사기: `Downloads\앱인토스_머니리그_에셋\verify_assets_selftest.py`

### (b) AsyncStorage 미사용 확인
소스 히트 1건은 `toss/storage.ts` 의 **「쓰지 마라」 주석**뿐. 빌드 산출물 웹 자산 3개 모두 **0건**.
(양성대조: 같은 스캔에서 `Storage.` 10건이 잡혀 검색기 작동 확인)

### (c) 네이티브 미러를 «우회하는» 쓰기 0건
| 경로 | 결과 |
|---|---|
| `localStorage.setItem/removeItem` (toss 레이어 밖) | **0건** |
| 별칭 경유 `ls.setItem/removeItem` (persistence.ts) | 3건 — **전부 mirrorSave/mirrorDrop 과 짝** |
| 미러 경유 호출 지점 | store.ts 6 + persistence.ts 3 = **9곳 전수** |
| `localStorage.getItem` | 4곳 — **동기 유지가 설계**(프라이밍이 선행) |

★ 첫 검색어(`localStorage.setItem`)는 `ls.setItem` 형태를 **놓쳤다**. 「0건」을 믿지 않고
검색어를 바꿔 재스캔해서 3건을 찾아냈고, 그 3건이 전부 미러와 짝인 것까지 문맥으로 확인했다.

### (d) ★ `.ait` 헤더 디코드 — 「config 에 썼다」 ≠ 「산출물에 들어갔다」

`webViewProps.type:'game'` 은 **게임 판정의 전부**인데, 그전까지는 `granite.config.ts` 를
읽어 확인했을 뿐 산출물을 열어보지 않았다. 컨테이너 preamble(protobuf)을 직접 디코드했다.

```
magic           AITBUNDL          zip 시작 오프셋 4971
field 1 varint  1                 ← isGame 플래그 [추정: 필드명은 wire 에 안 남는다]
field 3 string  moneyleague       ← appName
brand.displayName   머니리그        ← protobuf bytes 라 이스케이프 없이 그대로
brand.primaryColor  #6b4eff
brand.icon          <0B>          ← ★빈 문자열. «제출 불가본»의 하드 증거
webViewProps.type   game          ← ★★ 게임 판정 확인
  mediaPlaybackRequiresUserAction 0 / allowsInlineMediaPlayback 1 / bounces 0
  allowsBackForwardNavigationGestures 0 / pullToRefreshEnabled 0 / overScrollMode never
navigationBar   withBackButton 1 / withHomeButton 0 / withTitle 1 / theme light
sdk 2.10.8      deploymentId 019fe82d-a27a-7d01-bd5f-4f16f0c11fd0  (빌드 로그와 일치)
zip testzip()   None (37 엔트리 CRC 전부 정상)
```
→ `granite.config.ts` 의 값이 **전부 그대로** 들어갔다. 특히 기본값 `'partner'` 는 **0건**
(그게 들어갔다면 게임으로 인식되지 않는다).

★ **이 검사에서 검사기를 한 번 의심해 살아났다.** 1차 실행은 6개 중 5개가 FAIL 로 나왔는데,
원인은 값이 아니라 **내 디코더의 깊이 제한(depth<4)** 이었다 — 설정 맵이 `key=field1 /
value=field2>field5` 로 한 단계 더 중첩돼 있어 값에 도달하지 못했다.
그 상태에서는 「`partner` 없음」이라는 **양성대조까지 거짓 안심**이었다. 깊이를 12 로 올려
재실행하니 전건 PASS. **「FAIL/0건이면 내 검사기를 먼저 의심하라」가 실제로 적중한 사례다.**

검사기: `client/scripts/ait_header.py`

### (e) 그 교훈을 «내 다른 검사기»에 되먹였다 — `ait_verify.py` 2층 대조

(d)에서 드러난 것은 **「양성대조 자체가 무력화될 수 있다」**였다.
본 검사와 대조가 **같은 경로**를 타면 **같은 결함에 같이 걸려 둘 다 조용히 통과**한다.

`ait_verify.py` 의 기존 대조는 **문자열 층에서만** 놀았다(합성 문자열 → unescape → count).
그 층은 **zip 읽기·엔트리 열거·디코딩 결함을 원리적으로 못 잡는다** — (d)에서 나를 속인 바로 그 층이다.
그래서 대조를 두 층으로 나눴다:

| 층 | 무엇을 검증하나 | 결과 |
|---|---|---|
| **L1** 문자열 | unescape/count 로직. zip 을 **안 탄다** | PASS, **FIRE 수치 2** (침묵 아님을 수치로 확인) |
| **L2** 파이프 전체 | **가짜 `.ait`(zip)** 를 만들어 **본 검사와 같은 함수**에 통과시킨다 | 아래 3종 전부 CAUGHT |

```
N1 오표기 '머니 리그' 가 «이스케이프된 채» 번들에 → wrong=4, CAUGHT   (실제 반려 사유 재현)
N2 RN 번들이 3개                                  → CAUGHT
N3 번들에 이름 문자열이 아예 없음                    → CAUGHT
N4 정상 가짜본                                     → fails=0 (거짓양성 없음)
```
→ 그 뒤 실제 산출물 본 검사 **ALL PASS** (exit 0). 이제 이 PASS 는 **두 층에서 근거를 갖는다.**

★ 규율로 남긴다: **needle 은 검사 대상과 «다른 층»에 심어라. 그리고 대조가 «FIRE 했는지»를 «수치»로 확인해라 — 침묵을 통과로 읽지 마라.**

---

## 7. 재빌드 절차

```bash
npm run typecheck      # tsc --noEmit
npm run check:i18n     # ko/en 키 정합
npm run ait:build      # clean && ait build   ★ clean 필수
```
★ `clean` 없이 빌드하면 `dist/web/index.html` 이 이미 있어 **웹 빌드를 통째로 건너뛴다**
(early return) — 코드를 고쳐도 «옛 코드가 담긴» `.ait` 가 조용히 나온다.
`ait:build` 스크립트가 clean 을 앞에 물고 있으니 그대로 쓸 것.

⚠ `dist/web` 을 로컬 서버로 띄워둔 채 빌드하면 `clean` 이 EPERM 으로 실패한다(폴더 잠금). 서버부터 내려라.

### 콘솔값이 나오면
`granite.config.ts` 상단 **두 상수만** 고치고 재빌드:
```ts
const CONSOLE_APP_NAME__UNCONFIRMED = 'moneyleague';   // ← 콘솔 실값
const CONSOLE_ICON_URL__UNCONFIRMED = '';              // ← publicUrl
```
그 뒤 파일명의 `UNSUBMITTABLE` 을 떼라.

---

## 8. 백업
`client/_backup_dist_20260810/` — **SDK 도입 «전»** 2026-08-05 빌드 산출물(27파일, 2,693,337 B).
md5 대조로 복사 무결성 확인함.


---

## 9. 제출본 빌드 기록 (2026-08-18) — 미확정값 2개 «확정» 반영

### 9-1. 무엇이 바뀌었나
| 값 | 이전 | 확정값 | 출처 |
|---|---|---|---|
| `appName` | `'moneyleague'` **(추정)** | `'moneyleague'` | Partner 가 콘솔 `miniapp_get` 실조회 (miniAppId 65955 / serviceLink `intoss://moneyleague`) |
| `brand.icon` | `''` **(빈 문자열 = 제출불가)** | `https://static.toss.im/appsintoss/63105/cf3e3cfc-9c50-42e5-a0b4-329bd1164bfc.png` | Partner 가 `image_upload_url` 발급 후 PUT 200 |

상수명에서 `__UNCONFIRMED` 접미어 제거 → `CONSOLE_APP_NAME` / `CONSOLE_ICON_URL`.
문자열 값은 그대로였지만 **appName 도 재빌드로 다시 확정 상태에서 찍혔다**(추정→실측).

### 9-2. 산출물
```
client/moneyleague.ait          10,707,315 B   md5 0f819450b516249b8e7a8ca2c9eaef08
  deploymentId 01a0148f-19de-7c3f-b0a7-be105b98c050
백업: client/_backup_ait_20260818/moneyleague_UNSUBMITTABLE_..._20260810.ait
      6,102,472 B  md5 7ab0c0dbcbd6a73553f67e0c15575639  (빌드 «전» 복사, md5 동일 확인)
```
★ `ait build` 는 버저닝 없이 덮어쓴다. 빌드 전 백업이 필수다(이번엔 파일명이 달라 덮어쓰이진 않았다).

### 9-3. 검증 결과 (전부 재실행 [측정])
| 항목 | 결과 |
|---|---|
| 헤더 `appName` **정확일치**(substring 아님) | `'moneyleague'` == 콘솔값 **True** |
| 헤더 `brand.icon` | publicUrl 그대로 (82B string) |
| 헤더 field1(isGame) / `webViewProps.type` | `1` / `game` — 기본값 `partner` 0건 |
| **★양성대조** — 옛 .ait 을 «같은 검사기»에 | icon 검사가 **FAIL 로 발화** (빈 문자열 검출). 검사기가 산다는 증거 |
| `zipfile.testzip()` | `None` — 66 엔트리 CRC 전건 정상 (옛본 37 → 66) |
| web/ 산출물 | 58개: `index.html` + `bootstrap-CFZWnmOM.js` + `index-B6zaVSdY.js`/`index-Cd1IDGCL.js` + `index-D_wmbLN2.css` + 폰트 22 |
| **외부요청**(Playwright 실렌더, .ait 에서 꺼낸 web/ 을 그대로 서빙) | 일반 브라우저 7req/**0 외부**, 토스 웹뷰 모사 7req/**0 외부**, 페이지·콘솔 에러 0 |
| **★그 검사기의 양성대조** | 외부요청 3건짜리 페이지를 «같은 레코더»에 → **external=3 검출**. 0건이 침묵이 아님을 수치로 확인 |
| 서비스워커 | 일반 브라우저 등록 1 / **토스 웹뷰 모사 0** — `index.html` 의 `ReactNativeWebView` 분기가 실제로 동작 |
| 결제·IAP·광고 SDK | **우리 코드 0건.** .ait 내 히트 11파일은 전부 (a) SDK 내장 브릿지 export(`loadAppsInTossAdMob`·`IAP.*`·`requestTossPayPaysBilling`) (b) 종목 데이터의 `AppLovin Corporation` (c) React 의 `onDoubleClick` (d) privacy.html 의 「없다」는 문장 |
| **★그 검사기의 2층 대조** | L1 합성버퍼 12라벨 발화 / L2 가짜 .ait 의 needle 파일 발화 + clean 파일 침묵 = ALIVE |

증거: `qa_evidence/ait_render_20260818/` (render_report.json + 스크린샷 4장)

### 9-4. MS Store 자산 배제 (Partner 승인 후 적용) — .ait **-43.0%**

2026-08-18 MS Store PWA 작업이 `public/` 에 넣은 자산이 Vite 의 publicDir 규칙상
토스 `.ait` 에도 통째로 실렸었다. 토스에서는 **하나도 안 쓴다**(실측: manifest 는 런타임
요청조차 안 됨, SW 는 `ReactNativeWebView` 분기로 등록 자체가 안 됨).

**적용 방식** — `AIT_BUILD=1` 일 때만 도는 vite 플러그인 `ait-public-allowlist`
(`vite.config.ts`), 플래그 주입은 `scripts/ait_build.mjs` (POSIX/cmd 문법 차이를 피하려
node 래퍼로 심는다). `package.json` 의 `ait:build` 가 이 래퍼를 문다.
유지 목록은 `fonts`, `404.html` 둘뿐이고 **제외 목록은 `public/` 을 읽어 «유도»** 한다
— 나중에 뭐가 추가돼도 자동으로 걸린다.

```
[ait-public-allowlist] 제외 5건 (4,677,385 B): icons, manifest.json, privacy.html,
                       screenshots, sw.js  /  유지: fonts, 404.html
```
번들에 없는 파일을 index.html 이 참조하면 런타임 404 이므로 `manifest` /
`apple-touch-icon` / SW 등록 `<script>` 태그도 함께 제거한다. **각 제거는 정확히 1건
매치되지 않으면 `throw`** 한다 — 「패턴이 안 맞아 조용히 통과」가 0건 함정의 정확한 형태다.

★ **`publicDir: false` 로 짰다가 되돌렸다.** 그 방식에서는 vite 가 public 자산을 해석하지
못해 index.html 폰트 경로를 `./fonts/...` 로 재작성하지 **못하고 절대경로 `/fonts/...`**
로 남겼다(빌드 경고가 그대로 말해줬다). `base:'./'` 인 이 앱에서는 토스 웹뷰 404 다.
그래서 **복사는 그대로 시키고 뒤에서 지우는** 방식으로 바꿨다. 산출 경로가 검증된
이전 빌드와 완전히 같다.

### 9-5. 최종 산출물
```
client/moneyleague.ait          6,103,352 B   md5 16f2601a631b6e3cc16f40e77649da8b
  deploymentId 01a0149c-5e2e-7fea-842a-a48b4bc48bd5

백업 3본 (client/_backup_ait_20260818/)
  moneyleague_UNSUBMITTABLE_..._20260810.ait  6,102,472 B  7ab0c0db...  ★헤더검사기 양성대조 표본. 지우지 말 것
  moneyleague_20260818_v1_with-msstore-assets.ait 10,707,315 B  0f819450...
  moneyleague_20260818_v2_FINAL.ait            6,103,352 B  16f2601a...  (제출본과 동일)
```

### 9-6. 최종 검증 — 전항목 재실행 [측정]
| 항목 | v1(자산 포함) | **v2 최종** |
|---|---|---|
| `.ait` 크기 | 10,707,315 B | **6,103,352 B (-4,603,963 B, -43.0%)** |
| zip 엔트리 | 66 | **37** (web/ 58 → **29**) |
| `zipfile.testzip()` | None | **None** |
| 헤더 `appName` 정확일치 | True | **True** |
| 헤더 `brand.icon` | publicUrl | **publicUrl** |
| isGame / `webViewProps.type` | 1 / game | **1 / game** (`partner` 0건) |
| **★헤더검사기 양성대조**(옛 .ait) | FAIL 발화 | **FAIL 발화** |
| `ait_verify.py` | **FAIL** (`MoneyLeague` in manifest.json) | **ALL PASS · exit 0 · wrong 0** (금지어 목록 무수정) |
| 실렌더 요청/외부 (일반) | 7 / 0 | **7 / 0** |
| 실렌더 요청/외부 (토스 모사) | 7 / 0 | **7 / 0** |
| 실패요청(404 등) | 0 | **0** ← 폰트 경로 회귀 없음의 증거 |
| **★레코더 양성대조** | external=3 | **external=3** |
| SW 등록수 (일반 / 토스모사) | 1 / 0 | **0 / 0** (등록 스크립트 자체가 빠짐) |
| SDK 스캔 히트 | 11파일 | **10파일** (privacy.html 빠짐) — 전부 SDK 내장 브릿지·종목명 `AppLovin`·React `onDoubleClick` |
| **★스캐너 2층 대조** | L1 12라벨 / L2 FIRE+QUIET | **동일 ALIVE** |

### 9-7. MS Store 빌드 무영향 증명
플래그 «없이» `npm run build` 를 변경 전/후로 돌려 산출물을 대조했다.
```
BEFORE 58 files 7,400,274 B
AFTER  58 files 7,400,274 B
BEFORE에만 [] / AFTER에만 [] / md5 다른 파일 []   → IDENTICAL
```
★ 최종 config 로 **다시** 돌려서도 동일했다(중간에 방식을 바꿨으므로 재실행함).
머니리그는 MS Store 에 이미 라이브다 — `manifest.json` 의 `short_name` 은 **건드리지 않았다**.
