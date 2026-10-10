/*
 * [venture-cto 2026-08-05] BrowserRouter -> HashRouter.
 *
 * 정적 호스팅에는 SPA rewrite 가 없다. BrowserRouter 로 `/money-league/rank` 를
 * 직접 열거나 새로고침하면 서버가 그 경로의 파일을 찾다가 404 를 준다.
 * `App.tsx` 의 `<Route path="*">` 폴백은 **JS 가 로드된 뒤에만** 도는지라 구제 못 한다.
 *
 * 대안이던 `404.html` 리다이렉트 트릭은 원본 URL 을 잃고 히스토리 의미가 깨진다.
 * HashRouter 는 `index.html#/rank` 라 서버가 항상 index.html 만 주면 되고,
 * `vite.config.ts` 의 `base: './'`(상대경로)와 맞물려 **배포 경로를 몰라도** 동작한다.
 * games.mirialert.com/money-league/ · rainforest-0305.github.io/{게임} ·
 * itch.io · CrazyGames 어디에 얹혀도 설정 변경이 필요 없다.
 */
import { Navigate, Route, HashRouter as Router, Routes } from 'react-router-dom';
import { AppFrame } from './components/AppFrame';
import { BootOverlay } from './components/BootOverlay';
import { Onboarding } from './screens/Onboarding';
import { Home } from './screens/Home';
import { Stocks } from './screens/Stocks';
import { StockDetail } from './screens/StockDetail';
import { Derivatives } from './screens/Derivatives';
import { LeverageOrder } from './screens/LeverageOrder';
import { OptionOrder } from './screens/OptionOrder';
import { ContractOrder } from './screens/ContractOrder';
import { Leaderboard } from './screens/Leaderboard';
import { TraderProfile } from './screens/TraderProfile';
import { Settings } from './screens/Settings';
import { Journal } from './screens/Journal';
import { Recharge } from './screens/Recharge';
import { Loan } from './screens/Loan';
import { useParams } from 'react-router-dom';
import { useStore } from './store/hooks';

/**
 * ★★주문 화면은 «URL 파라미터가 바뀌면 다른 주문»이다 — 상태를 물려받으면 안 된다.
 *
 * ★실사고(2026-08-21, 실동작 검증에서 잡힘):
 *   `/contract/swap/BKNG` → `/contract/forward/NVDA` 로 이동했을 때 React Router 는
 *   ★같은 라우트 패턴이라 «컴포넌트를 그대로 둔다»(useState 가 초기화되지 않는다).
 *   ⇒ 스왑에서 쓰던 `side = 'a'` 가 «선도 화면에 그대로 남았다».
 *     · 선도의 세그먼트는 long/short 뿐이라 ★«아무것도 선택되지 않은» 상태로 보이고
 *     · 엔진은 `side === 'long' ? 1 : -1` 이라 ★«숏 가격»으로 조건을 뽑았다
 *     · 게다가 호가 세션 키가 `forward|NVDA||a` 가 되어 ★같은 계약인데 시드가 갈렸다
 *   ⇒ ★에러가 나지 않는다. 화면이 조용히 «다른 상품의 상태»로 동작한다.
 *
 * ★고침: `key` 로 «다른 파라미터 = 다른 인스턴스»를 React 에 알린다.
 *   ⛔useEffect 로 초기화하지 않는다 — 그러면 «한 프레임» 동안 옛 상태로 계산된 값이
 *     그려지고, 그 프레임에 확정 버튼을 누를 수 있다.
 */
function Keyed({ render }: { render: (k: string) => JSX.Element }) {
  const params = useParams();
  return render(Object.values(params).join('/'));
}

function Gate({ children }: { children: JSX.Element }) {
  const s = useStore();
  if (!s.session || !s.onboarded) return <Navigate to="/start" replace />;
  return children;
}

export function App() {
  return (
    <Router>
      {/* ★부팅 화면은 라우터 «안»이지만 Routes «밖»이다 — 어느 화면에서 새로고침해도 덮는다 */}
      <BootOverlay />
      <Routes>
        <Route
          path="/start"
          element={
            <div className="app-shell">
              <Onboarding />
            </div>
          }
        />

        {/* 탭바가 있는 화면 */}
        <Route element={<AppFrame />}>
          <Route path="/home" element={<Gate><Home /></Gate>} />
          <Route path="/stocks" element={<Gate><Stocks /></Gate>} />
          <Route path="/derivatives" element={<Gate><Derivatives /></Gate>} />
          <Route path="/rank" element={<Gate><Leaderboard /></Gate>} />
          <Route path="/settings" element={<Gate><Settings /></Gate>} />
        </Route>

        {/* 풀스크린 (탭바 없음) */}
        <Route element={<AppFrame withTabs={false} />}>
          <Route path="/stock/:ticker" element={<Gate><StockDetail /></Gate>} />
          {/* ★주문 화면 3종은 «파라미터마다 새 인스턴스»다 — Keyed 주석 참조 */}
          <Route path="/leverage/:ticker" element={<Gate><Keyed render={(k) => <LeverageOrder key={k} />} /></Gate>} />
          <Route path="/option/:ticker" element={<Gate><Keyed render={(k) => <OptionOrder key={k} />} /></Gate>} />
          {/* ★선도·스왑 «공유» 주문폼 — product 로 필드 표시 여부만 갈린다 */}
          <Route path="/contract/:product/:ticker" element={<Gate><Keyed render={(k) => <ContractOrder key={k} />} /></Gate>} />
          <Route path="/trader/:id" element={<Gate><TraderProfile /></Gate>} />
          {/* ★거래 일지 — 설정의 「거래 내역」 행이 여는 화면(2026-08-21 신설) */}
          <Route path="/journal" element={<Gate><Journal /></Gate>} />
          <Route path="/recharge" element={<Gate><Recharge /></Gate>} />
          {/* ★대출 (2026-09-05 President 지시). 진입은 충전 화면의 「대출」 버튼 */}
          <Route path="/loan" element={<Gate><Loan /></Gate>} />
        </Route>

        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </Router>
  );
}
