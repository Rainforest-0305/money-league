/**
 * 머니리그 «고유» 앱인토스 배선 — 뒤로가기 정책 + 종료 확인 모달.
 *
 * src/toss/ 는 4종 래핑에서 검증된 범용 레이어라 그대로 두고, 이 앱에만
 * 해당하는 정책을 여기 모은다.
 *
 * ── ★ 왜 「뒤로가기 = 곧장 종료 확인」이면 안 되는가 ─────────────────────────
 * 4종 게임은 history API 를 안 써서 화면 스택이 없었다(뒤로가기 → 항상 종료
 * 확인). 머니리그는 HashRouter SPA 라 /home → /stock/NVDA → /leverage/NVDA
 * 로 «쌓인다». 종목 상세를 보다가 뒤로가기를 눌렀는데 종료 확인이 뜨면
 * 오작동이다.
 *
 * ── 정책 (routeBackAction() 하나로 결정. 순수 함수라 테스트 가능) ───────────
 *   풀스크린 라우트(/stock/:t · /leverage/:t · /option/:t · /trader/:id · /recharge)
 *     → 'back'  : 히스토리를 되돌린다
 *   탭 라우트 중 /home 이 «아닌» 것(/stocks · /derivatives · /rank · /settings)
 *     → 'home'  : 홈으로 보낸다(탭은 전부 «루트»다. 탭끼리 되돌아가지 않는다)
 *   /home · /start · 그 외
 *     → 'exit'  : 소비하지 않고 넘겨서 종료 확인 모달이 뜨게 한다
 *
 * ★ /start 로는 «절대» 되돌아가지 않는다. App.tsx 의 /start 라우트는 온보딩을
 *   무조건 렌더하므로, 이미 온보딩을 마친 사용자가 거기로 가면 온보딩 화면이
 *   다시 뜬다. 그래서 'back' 은 풀스크린 라우트에서만 쓴다.
 */
import i18next from 'i18next';
import { pushBackHandler, exitMiniApp, isInToss } from './toss';

/* ────────────────────────────── 뒤로가기 정책 ────────────────────────────── */

/** 탭바가 있는 «루트» 라우트. App.tsx 의 <AppFrame /> 자식들과 일치해야 한다. */
const TAB_ROUTES = ['/home', '/stocks', '/derivatives', '/rank', '/settings'];

/** 풀스크린(탭바 없음) 라우트의 «접두사». App.tsx 의 <AppFrame withTabs={false} /> 자식들. */
const FULLSCREEN_PREFIXES = ['/stock/', '/leverage/', '/option/', '/trader/', '/recharge'];

export type BackAction = 'back' | 'home' | 'exit';

/**
 * 현재 경로만 보고 뒤로가기 동작을 결정한다. 순수 함수 — DOM/전역에 의존하지
 * 않으므로 그대로 검사기에 넣어 양성대조를 돌릴 수 있다.
 * @param path HashRouter 의 경로부(예: '/stock/NVDA'). 해시(#)와 쿼리는 제거된 상태.
 */
export function routeBackAction(path: string): BackAction {
  if (FULLSCREEN_PREFIXES.some((p) => path.startsWith(p))) return 'back';
  if (TAB_ROUTES.includes(path) && path !== '/home') return 'home';
  return 'exit';
}

/** location.hash 에서 라우터 경로부만 뽑는다. '#/stock/NVDA?x=1' → '/stock/NVDA' */
export function currentRoutePath(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const noQuery = raw.split('?')[0] ?? '';
  return noQuery === '' ? '/' : noQuery;
}

/**
 * 히스토리를 실제로 되돌릴 수 있는가.
 * react-router(@remix-run/router 1.23.3)가 history.state 에 `idx` 를 기록한다
 * — 실측으로 확인한 필드다. 없으면(직접 진입 등) 되돌리지 않는 쪽이 안전하다.
 */
function canGoBack(): boolean {
  try {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    return typeof idx === 'number' && idx > 0;
  } catch {
    return false;
  }
}

/* ────────────────────────────── 종료 확인 모달 ────────────────────────────── */

const OVERLAY_ID = 'ait-exit-confirm';

/**
 * 앱 디자인 토큰(styles/tokens.css)을 그대로 쓴다 — 라이트/다크 테마를 자동으로
 * 따라간다. 하드코딩 hex 를 쓰면 다크모드에서 흰 카드가 튄다(토큰 파일 상단의
 * "하드코딩 hex 금지" 규칙과도 어긋난다).
 */
function buildOverlay(onConfirm: () => void, onCancel: () => void): HTMLDivElement {
  const t = (k: string) => String(i18next.t(`common:exit.${k}`));

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('title'));
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:9999',
    'background:var(--scrim)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:20px',
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'width:min(320px,86vw)',
    'background:var(--surface)',
    'border-radius:var(--r-card)',
    'padding:24px 20px 16px',
    'text-align:center',
    'color:var(--t1)',
    'box-shadow:var(--shadow)',
  ].join(';');

  const title = document.createElement('p');
  title.textContent = t('title');
  title.style.cssText = 'margin:0 0 6px;font-size:17px;font-weight:800;letter-spacing:-0.02em;';

  const sub = document.createElement('p');
  sub.textContent = t('body');
  sub.style.cssText = 'margin:0 0 20px;font-size:13px;color:var(--t2);line-height:1.5;';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = t('cancel');
  cancelBtn.style.cssText =
    'flex:1;height:var(--cta-h);border-radius:var(--r-btn);border:1px solid var(--line);' +
    'background:var(--surface-2);color:var(--t1);font-size:15px;font-weight:700;cursor:pointer;';
  cancelBtn.addEventListener('click', onCancel);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = t('confirm');
  confirmBtn.style.cssText =
    'flex:1;height:var(--cta-h);border-radius:var(--r-btn);border:none;' +
    'background:var(--brand);color:#fff;font-size:15px;font-weight:800;cursor:pointer;';
  confirmBtn.addEventListener('click', onConfirm);

  row.append(cancelBtn, confirmBtn);
  card.append(title, sub, row);
  overlay.append(card);
  return overlay;
}

function showExitConfirm(): void {
  if (document.getElementById(OVERLAY_ID) !== null) return; // 중복 표시 방지

  const close = () => document.getElementById(OVERLAY_ID)?.remove();

  document.body.appendChild(
    buildOverlay(() => {
      close();
      void exitMiniApp();
    }, close)
  );
}

/* ────────────────────────────── 설치 ────────────────────────────── */

/**
 * 뒤로가기 핸들러 2단을 «순서대로» 등록한다.
 * pushBackHandler 는 «나중에 등록된 것이 먼저» 호출되므로, 등록 순서는
 * 우선순위의 역순이다.
 *
 *   1) 먼저 push → 종료 확인 (가장 낮은 우선순위, 항상 소비)
 *   2) 나중 push → 라우터 뒤로가기 (먼저 실행되고, 처리 못 하면 false 로 넘김)
 *
 * @returns 해제 함수
 */
export function installBackPolicy(): () => void {
  /**
   * ★ 토스 «안»에서만 설치한다. 토스 밖(itch.io·GitHub Pages·MS Store 래핑)에는
   *   닫을 미니앱도, 네이티브 뒤로가기 버튼도 없다. 설치하면 이득 없이
   *   위험만 생긴다 — 실측으로 확인된 결함이 있다(navigationBar.ts 주석 참고:
   *   hashchange → popstate 로 «평범한 화면 이동»마다 종료 확인이 떴다).
   *   이 가드 덕에 웹 배포본의 뒤로가기 동작은 «SDK 도입 전과 완전히 동일»하다.
   */
  if (!isInToss()) {
    console.log('[toss-sdk][nav] back policy skipped (not in Toss)');
    return () => {};
  }

  const offExit = pushBackHandler(() => {
    showExitConfirm();
    return true; // 항상 소비 → 자동 closeView 가 절대 일어나지 않는다
  });

  const offRouter = pushBackHandler(() => {
    const path = currentRoutePath(window.location.hash);
    const action = routeBackAction(path);
    console.log(`[toss-sdk][nav] back at "${path}" -> ${action}`);

    if (action === 'back') {
      if (canGoBack()) {
        window.history.back();
      } else {
        // 딥링크로 상세 화면에 «직접» 진입한 경우 되돌릴 히스토리가 없다.
        window.location.hash = '#/home';
      }
      return true;
    }
    if (action === 'home') {
      window.location.hash = '#/home';
      return true;
    }
    return false; // 'exit' → 다음(종료 확인) 핸들러로 넘긴다
  });

  return () => {
    offRouter();
    offExit();
  };
}

/**
 * 앱 부팅 후 호출. SDK 초기화 결과를 콘솔에 남기고 뒤로가기 정책을 설치한다.
 * 절대 throw 하지 않는다.
 */
export async function bootTossIntegration(): Promise<void> {
  try {
    const { initTossSdk } = await import('./toss');
    const runtime = await initTossSdk();
    installBackPolicy();
    console.log(
      `[toss-sdk] money-league integration ready (inToss=${runtime.inToss}, ` +
        `identity=${runtime.identity.source})`
    );
  } catch (err) {
    // 여기까지 오면 SDK 통합만 죽고 게임은 정상 동작한다(웹 배포본과 동일).
    console.warn('[toss-sdk] integration failed, app continues without it:', err);
  }
}

/** 토스 안에서만 의미 있는 배선인지 알려준다(로그/진단용). */
export { isInToss };
