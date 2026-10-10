import { defineConfig } from '@apps-in-toss/web-framework/config';

/**
 * 머니리그 (Money League) — 앱인토스 미니앱 설정
 * 트랙 E / 05_주식투자게임_정적빌드
 *
 * ★ 경로 선택: 웹(web-framework) 경로다. RN(@apps-in-toss/framework) 경로가 아니다.
 *   `ait build` 는 이 파일의 **소스 문자열**에 '@apps-in-toss/web-framework' 가
 *   들어있는지로 빌드 전략을 고른다. 위 import 문을 지우거나 경로를 바꾸면
 *   RN 전략으로 떨어져 빌드가 깨진다.
 *
 * ★ 파일 이름이 granite.config.ts 인 것은 오타가 아니다. 웹 경로도 이 이름을 쓴다.
 *
 * ── 4종 래핑(트랙 K)과 근본적으로 다른 점 ────────────────────────────────────
 *   4종은 단일 HTML 게임이라 <script> 를 잘라내 public/game/ 으로 옮기는
 *   추출 절차가 필요했다. 머니리그는 **이미 Vite + React SPA** 라 그 단계가
 *   통째로 불필요하다 — web.commands.build 에 기존 vite 빌드를 그대로 물린다.
 */

/* ══════════════════════════════════════════════════════════════════════════
   ✅ 콘솔 확정값 (2026-08-18 실측 반영) — 교체 지점은 «여기 두 개»뿐이다
   ══════════════════════════════════════════════════════════════════════════
   둘 다 «빌드타임 인라인»이라 값을 바꾸면 반드시 재빌드해야 .ait 에 반영된다.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * [확정] 콘솔 등록 appName. **딥링크 식별자이자 서버 컴파일 키**다.
 *
 * 콘솔 등록값과 «글자 그대로» 일치하지 않으면 배포 단계에서 BUILD_FAILED 가
 * 난다(트랙 K 실측: 네온스레드가 'neon-thread' 로 추정 진행했다가 콘솔 실값이
 * 'neonthread' 여서 어긋났다).
 *
 * ★ 2026-08-18 Partner 가 앱인토스 콘솔 miniapp_get 으로 «직접 실조회»해 확정.
 *   miniAppId 65955 / serviceLink intoss://moneyleague / appName 'moneyleague'.
 *   더 이상 추정값이 아니다.
 *
 * ※ 이 값은 표시 이름이 «아니다». 화면에 보이는 이름은 brand.displayName 과
 *   locales/*.json 의 common.appName 이다. 혼동해서 같이 고치지 마라.
 */
const CONSOLE_APP_NAME = 'moneyleague';

/**
 * [확정] 콘솔 앱정보에 등록한 아이콘의 publicUrl.
 *
 * ★ 2026-08-18 Partner 가 image_upload_url 로 발급 후 PUT 200 완료한 실주소.
 *   빈 문자열 상태로 빌드된 .ait 는 «제출 불가본»이었다 — 이제 해소됐다.
 */
const CONSOLE_ICON_URL =
  'https://static.toss.im/appsintoss/63105/cf3e3cfc-9c50-42e5-a0b4-329bd1164bfc.png';

export default defineConfig({
  appName: CONSOLE_APP_NAME,

  brand: {
    /**
     * 미니앱 표시 이름(국문). RN 호스트 번들의 brandDisplayName 으로 주입된다.
     *
     * ★ 이름은 «한 곳에 있지 않다». 6개 사본이 있고 한 곳만 고치면 반드시
     *   어긋난다(트랙 K 네온스레드가 정확히 이 사유로 검수 반려됐다:
     *   「미니앱 이름이 앱 정보등록에 제출된 이름과 동일해야 해요」).
     *   전체 목록은 README.md 「미니앱 이름 사본 위치」 표를 봐라.
     *
     * ★ 화면에 실제로 보이는 이름은 이 값이 «아니라»
     *   src/locales/ko.json 의 common.appName 이다(Home.tsx:60,
     *   Onboarding.tsx:144 가 t('common:appName') 로 렌더). 이 값만 고치면
     *   번들 메타는 바뀌어도 «화면은 안 바뀐다».
     *
     * ★ 2026-08-19 «머니리그» → «머니 리그»(띄어쓰기). 우리도 트랙 K 와 같은
     *   사유로 반려당했다(reviewRequestId 146453, 요청 3초 만에 자동 거부).
     *   콘솔 앱정보 승인분이 「머니 리그」였고 번들 6곳이 전부 붙여쓰기였다.
     *   ★콘솔 등록명이 정본이다. 여기만 되돌리지 마라.
     */
    displayName: '머니 리그',

    /**
     * primaryColor — 앱 브랜드 컬러.
     *
     * 실측 근거 2곳이 이미 일치한다(추가 판단 불요):
     *   src/styles/tokens.css:8  `--brand: #6b4eff`  (라이트 테마 브랜드색)
     *   index.html:6             `<meta name="theme-color" content="#6B4EFF">`
     * 대소문자만 다르고 같은 값이다. 다크 테마의 --brand(#8e76ff)는 밝기를
     * 올린 파생색이라 대표색으로는 부적합(흰 배경 대비 3.40:1 < 4.5:1).
     * #6b4eff 는 흰 배경 대비 5.05:1 로 기준을 넘는다(자체 계산, 대조 검증:
     * #000/#fff=21.00, #777/#fff=4.48 로 계산기 정확성 확인).
     */
    primaryColor: '#6b4eff',

    icon: CONSOLE_ICON_URL,
  },

  web: {
    host: 'localhost',
    /** vite.config.ts 의 strictPort 5183 과 «일치»시킨다(다른 트랙이 5173 점유). */
    port: 5183,
    /**
     * ★ 이 명령들은 npm run 이 아니라 npx 로 실행된다. 'run build' 처럼 쓰면
     *   `npx run build` 가 되어 실패한다. 반드시 실행 파일명만 쓴다.
     *
     * ※ package.json 의 "build" 는 `tsc -b && vite build` 지만 여기서는
     *   `vite build` 만 쓴다. tsc -b 는 타입검사일 뿐 번들 산출물에 영향이
     *   없고, ait 빌드 파이프 안에서 죽으면 원인 파악이 어려워진다.
     *   타입검사는 `npm run typecheck` 로 «따로» 돌린다.
     */
    commands: {
      dev: 'vite',
      build: 'vite build',
    },
  },

  /**
   * permissions: 빈 배열.
   * 머니리그는 위치·카메라·마이크·연락처·사진·알림 어느 것도 쓰지 않는다.
   * 외부 네트워크 호출 0건(fetch/XHR/WebSocket/axios 전수 grep 0), 폰트까지
   * 동봉한 완전 오프라인 정적 SPA다.
   */
  permissions: [],

  /**
   * webViewProps — ★ 게임 판정의 전부다.
   *
   *   type: 'game' 이 없으면 기본값 'partner' 로 떨어져 게임으로 인식되지
   *   않는다(@apps-in-toss/cli: `const isGame = config.webViewProps?.type === "game"`).
   *   타입 정의에 'game' 이 @deprecated 로 표기돼 있으나(→ 'partner' 권장),
   *   그건 «웹뷰 프레임 스타일» 관점의 안내이고 .ait 메타의 isGame 플래그는
   *   여전히 이 문자열로만 결정된다. 머니리그는 게임 카테고리로 제출하므로
   *   'game' 을 명시한다.
   *
   *   ※ 웹 경로 config 에는 appType 이 없다(AppsInTossWebConfig 가
   *     Omit<AppsInTossPluginOptions,'appType'|'target'>). RN 경로의
   *     appType:'game' 을 여기 쓰면 타입 에러다.
   *
   *   나머지는 전부 «기본값이 이 앱에 해로운» 것들이라 명시적으로 끈다.
   */
  webViewProps: {
    type: 'game',

    /** 효과음(settings.sound) 재생을 사용자 탭 없이 허용. */
    allowsInlineMediaPlayback: true,
    mediaPlaybackRequiresUserAction: false,

    /**
     * bounces / pullToRefreshEnabled / overScrollMode:
     *   머니리그는 종목 리스트·랭킹(211행)·차트가 «세로 스크롤» 화면이다.
     *   당겨서 새로고침이 걸리면 스크롤 상단에서 오작동하고, 새로고침은
     *   진행 중인 주문 시트·틱 루프를 통째로 날린다.
     */
    bounces: false,
    pullToRefreshEnabled: false,
    overScrollMode: 'never',

    /**
     * ★ 공식 게임 체크리스트 명문 요건:
     *   「운영체제의 뒤로가기 제스처는 사용할 수 없어요」
     *   추가로 이 앱은 주문 시트·레버리지 확인 모달을 가로 드래그 근처에서
     *   조작하므로 스와이프 이탈이 특히 위험하다.
     */
    allowsBackForwardNavigationGestures: false,
  },

  /**
   * navigationBar — 빌드타임 «고정»값이다. 화면별/런타임 동적 전환 API가 없다.
   *
   * ── theme 을 'light' 로 정한 근거 (이 앱 고유 계산, 인용 아님) ─────────────
   * ★ 머니리그는 4종 게임과 «조건이 다르다». 4종은 다크 단색 게임이라 dark
   *   고정이 자명했다. 머니리그는 라이트/다크를 **런타임에 전환**한다
   *   (store.ts:438 이 data-theme 을 갈아끼움, 기본값 theme:'system').
   *   theme 은 빌드타임 고정이라 어느 쪽을 골라도 반대 테마에서는 어긋난다.
   *
   * 자체 WCAG 계산(대조 검증 선행: #000/#fff=21.00, #777/#fff=4.48 일치):
   *   아이콘 #191F28(light) on 앱 라이트 --bg #f2f4f6  = 15.02:1  PASS
   *   아이콘 #FFFFFF(dark)  on 앱 라이트 --bg #f2f4f6  =  1.10:1  FAIL
   *   아이콘 #191F28(light) on 앱 다크  --bg #0c0e13  =  1.17:1  FAIL
   *   아이콘 #FFFFFF(dark)  on 앱 다크  --bg #0c0e13  = 19.30:1  PASS
   *
   * → 이 표가 말하는 건 「transparentBackground: true 는 쓰면 안 된다」는 것이다.
   *   투명으로 두면 아이콘이 앱 배경 위에 얹혀 «절반의 경우 반드시 FAIL» 한다.
   *   따라서 transparentBackground: false — 네이티브 솔리드 바를 쓴다. 그러면
   *   아이콘은 그 바 «자체» 배경 위에 놓여 앱 테마와 무관하게 항상 읽힌다.
   *   [미확인] 네이티브 바가 실제로 칠하는 배경색은 SDK 코드에서 확인되지
   *   않는다(plugins 는 값을 검증만 하고 네이티브 호스트로 넘긴다).
   *   그 상태에서 theme 은 «앱의 기본 외형»에 맞춘다 — index.html 이
   *   `<html data-theme="light">` 로 시작하고 라이트가 기본 경험이므로 'light'.
   *
   * ── withTitle: true 로 정한 근거 — ★ 4종 래핑(false)과 «다르게» 갔다 ───────
   * 공식 게임 출시 체크리스트 명문:
   *   「앱 정보에 등록한 브랜드 로고와 미니앱 이름(국문)을 내비게이션 바에
   *     반영해요」
   * 4종은 각자 전체화면 타이틀 화면이 있어 중복 회피로 false 를 썼다.
   * 머니리그는 전체화면 타이틀이 온보딩 1회뿐이고 이후로는 일반 앱형 UI라
   * 중복 우려가 작다. 문서 명문을 따르는 쪽이 검수에서 안전하다고 판단했다.
   *
   * ⚠ [추정] 홈 화면 자체 앱바(Home.tsx:60)가 이미 '머니리그'를 렌더하므로
   *   네이티브 바와 «이름이 두 번» 보일 수 있다. 로컬 렌더로는 네이티브 바를
   *   띄울 수 없어 확인 불가다. 실기기에서 중복이 확인되면 이 한 줄만
   *   false 로 뒤집으면 된다(되돌리기 쉬운 결정이라 문서 준수를 우선했다).
   */
  navigationBar: {
    withBackButton: true,
    withTitle: true,
    transparentBackground: false,
    theme: 'light',
  },

  /**
   * outdir: 웹 빌드 산출물 디렉터리. vite 기본 출력(dist)과 일치해야 한다.
   *
   * ★ 함정: ait build 는 outdir 안의 내용을 outdir/web/ 으로 옮긴 뒤
   *   outdir/web/index.html 존재를 요구한다. 그런데 «이미» dist/web/index.html
   *   이 있으면 웹 빌드를 통째로 건너뛴다(early return) — 코드를 고치고
   *   재빌드해도 «옛 코드가 담긴» .ait 가 조용히 나온다.
   *   => 재빌드 전 반드시 `npm run clean`. package.json 의 ait:build 가
   *      clean 을 앞에 물고 있다.
   */
  outdir: 'dist',
});
