/**
 * 실제 앱 부팅부. 원래 main.tsx 에 있던 내용 그대로이고, 앱인토스 SDK 배선
 * 한 줄만 끝에 추가했다.
 *
 * ★ main.tsx 에서 «분리»한 이유:
 *   store.ts 는 «모듈 로드 시점»에 생성자가 돌면서 localStorage 를 동기로 읽는다
 *   (store.ts 생성자: settings/onboarded/session/watchlist 4키).
 *   네이티브 Storage 는 비동기라, 미러 값을 localStorage 로 역주입하는
 *   primeAppStorage() 가 «이 모듈이 import 되기 전에» 끝나 있어야 한다.
 *   같은 파일에 두면 정적 import 가 호이스팅되어 순서를 보장할 수 없다.
 *   그래서 main.tsx 가 프라이밍을 마친 «뒤» 이 파일을 동적 import 한다.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import { App } from './App';
import { store } from './store/store';
import { bootTossIntegration } from './tossBoot';

void store.boot();

// 시스템 다크모드 변경 추종 (theme = system 일 때만)
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (store.settings.theme === 'system') store.applyDom();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

/**
 * 앱인토스 SDK 4종 배선. 렌더 «뒤»에 돌린다 — 브릿지 응답을 기다리느라
 * 첫 페인트가 늦어지면 안 된다. 절대 throw 하지 않으므로 실패해도 앱은 뜬다
 * (토스 밖 = itch.io·GitHub Pages·MS Store 배포본이 바로 그 상태다).
 */
void bootTossIntegration();
