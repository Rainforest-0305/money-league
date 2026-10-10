/**
 * 대출 — 2026-09-05 President 지시.
 *   「충전 옆에 대출 버튼 만들고 본인 신용에 따라 대출 받을 수 있게 해.
 *     자산 담보 대출과 개인 신용 대출 중 선택할 수 있게 하고, 한도랑 금리는 보편적 금리
 *     책정 방식에 따라 책정해… 전부 변동금리로 해… 중도상환 수수료는 없애.」
 *   「만기 때 현금에서 자동상환… 현금 부족한데 담보 있으면 담보를 반대매매…
 *     연체되면 원리금을 차감해서 마이너스 계좌로 만들고, 마이너스 금액에 연체금리로 이자를 계속 붙여.」
 *
 * ★★화면은 «아무것도 계산하지 않는다». 한도·금리·신용등급·예상이자는 전부
 *   `store.loanTerms(kind)` → `world.loanTerms()` 한 벌에서 온다.
 *   ⛔여기서 `기준금리 + 가산` 을 다시 곱하지 마라 — 유동성 깊이를 화면이 다시 세다가
 *     SPX·NDX 에서 16배 갈렸던 사고와 «같은 형태»가 된다(U-7).
 *
 * ★★[문구] 이 화면의 문자열은 «임시 로컬 표»(아래 `L`)다. ⛔영구 해법이 아니다.
 *   `src/locales/*.json` 은 2026-09-05 현재 «광고 레인 소유»라 이 레인이 건드릴 수 없다.
 *   ⇒ 키 목록을 보고서에 적어 두었고, Partner 가 locales 에 넣으면 `L` 을 지우고
 *     `useTranslation('loan')` 로 갈아끼우면 된다. 표의 키 이름이 그대로 i18n 키다.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, Segment, Slider } from '../components/Primitives';
import { useStore, useTick } from '../store/hooks';
import { money, pct, signedMoney, gameDaysToRealMinutes } from '../lib/format';
import {
  LOAN_LTV_MAX,
  LOAN_MARGIN_CALL_LTV,
  LOAN_MIN_PRINCIPAL,
  LOAN_TERM_CHOICES,
  LOAN_TERM_DEFAULT,
} from '../lib/constants';
import type { LoanKind } from '../lib/engine/types';

/* ── 임시 문구 표 (locales 이관 대기) ─────────────────────────────────── */
const L = {
  ko: {
    title: '대출',
    total: '총 자산',
    debt: '부채',
    net: '순자산',
    netNote: '프로모션·랭킹·파산 판정은 «순자산» 기준이에요. 빌려도 순자산은 안 늘어요.',
    grade: '신용등급',
    score: '점수',
    secured: '담보대출',
    unsecured: '신용대출',
    limit: '한도',
    used: '이미 빌린 금액',
    avail: '더 빌릴 수 있어요',
    rate: '금리(연)',
    rateBreak: '기준 {{b}} + 가산 {{s}}',
    collateral: '담보 평가액',
    ltv: '담보 대비 대출',
    howMuch: '얼마나 빌릴까요?',
    when: '언제 갚을까요?',
    dayN: '{{n}}일 뒤',
    realMinutes: '게임 안에서 {{d}}일 = 실제 약 {{m}}분',
    interestDay: '하루 이자',
    interestTotal: '만기까지 이자(예상)',
    repayTotal: '만기 상환액(예상)',
    borrow: '빌리기',
    rulesTitle: '만기가 되면',
    rule1: '① 현금에서 원리금이 자동으로 빠져나가요',
    rule2: '② 현금이 모자라면 담보를 부족한 만큼만 팔아요',
    rule3: '③ 그래도 모자라면 잔액이 마이너스가 되고 연체 이자가 붙어요',
    noteVar: '변동금리예요. 기준금리가 바뀌면 이자도 같이 바뀌어요.',
    noteFee: '중도상환 수수료는 없어요. 언제든 갚을 수 있어요.',
    myLoans: '내 대출',
    principal: '원금',
    unpaid: '못 낸 이자',
    due: '만기',
    dueIn: '{{n}}일 남음',
    dueNow: '오늘 만기',
    repay: '갚기',
    repayAll: '전액',
    repayHalf: '절반',
    marginCall: '담보가 부족해요 · 갚거나 담보를 채워주세요',
    overdue: '연체 {{n}}일',
    empty: '아직 빌린 돈이 없어요',
    odTitle: '연체 잔액',
    odBody: '{{v}} 를 갚아야 새로 사거나 빌릴 수 있어요. 연체 이자 연 {{r}} 가 매일 붙어요.',
    odHow: '주식을 팔거나 배당·정산으로 들어온 돈이 자동으로 먼저 갚아요.',
    odNoTopup: '연체 중에는 충전이 열리지 않아요.',
    odInCash: '연체 잔액은 현금에서 이미 빠져 있어요. 그래서 부채에 또 더하지 않아요.',
    odBlock: '연체 {{v}} 를 먼저 갚아주세요',
    minNote: '최소 {{v}} 부터 빌릴 수 있어요',
    noRoom: '지금은 더 빌릴 수 없어요',
    bankruptcy: '파산 이력 {{n}}회 · 연체 이력 {{m}}회',
  },
  en: {
    title: 'Loans',
    total: 'Total assets',
    debt: 'Debt',
    net: 'Net worth',
    netNote: 'Promotions, ranking and bankruptcy use net worth. Borrowing does not raise it.',
    grade: 'Credit grade',
    score: 'Score',
    secured: 'Secured',
    unsecured: 'Unsecured',
    limit: 'Limit',
    used: 'Already borrowed',
    avail: 'Available now',
    rate: 'Rate (per year)',
    rateBreak: 'Base {{b}} + spread {{s}}',
    collateral: 'Collateral value',
    ltv: 'Loan to value',
    howMuch: 'How much?',
    when: 'When will you repay?',
    dayN: 'In {{n}} days',
    realMinutes: '{{d}} in-game days ≈ {{m}} real minutes',
    interestDay: 'Interest per day',
    interestTotal: 'Interest until maturity',
    repayTotal: 'Due at maturity',
    borrow: 'Borrow',
    rulesTitle: 'At maturity',
    rule1: '1. Principal and interest are taken from your cash',
    rule2: '2. If cash falls short, only enough collateral is sold',
    rule3: '3. If still short, your balance goes negative and overdue interest accrues',
    noteVar: 'Floating rate. Your interest moves with the base rate.',
    noteFee: 'No prepayment fee. Repay any time.',
    myLoans: 'Your loans',
    principal: 'Principal',
    unpaid: 'Unpaid interest',
    due: 'Maturity',
    dueIn: '{{n}} days left',
    dueNow: 'Due today',
    repay: 'Repay',
    repayAll: 'All',
    repayHalf: 'Half',
    marginCall: 'Collateral is short — repay or add collateral',
    overdue: '{{n}} days overdue',
    empty: 'No loans yet',
    odTitle: 'Overdue balance',
    odBody: 'Repay {{v}} to buy or borrow again. Overdue interest of {{r}} per year accrues daily.',
    odHow: 'Selling stocks, dividends and settlements repay it first, automatically.',
    odNoTopup: 'Top-ups stay closed while you are overdue.',
    odInCash: 'The overdue balance is already deducted from cash, so it is not added to debt again.',
    odBlock: 'Repay the overdue {{v}} first',
    minNote: 'Minimum {{v}}',
    noRoom: 'No room to borrow right now',
    bankruptcy: '{{n}} bankruptcies · {{m}} late payments',
  },
} as const;

type Key = keyof (typeof L)['ko'];

export function Loan() {
  const s = useStore();
  useTick();
  const nav = useNavigate();
  const { i18n } = useTranslation('common');
  const ko = i18n.language !== 'en';
  /** 임시 문구 표 조회 — locales 이관 시 `t()` 로 그대로 대체된다 */
  const tx = (k: Key, v?: Record<string, string | number>) => {
    let out: string = L[ko ? 'ko' : 'en'][k];
    if (v) for (const [kk, vv] of Object.entries(v)) out = out.split(`{{${kk}}}`).join(String(vv));
    return out;
  };

  const [kind, setKind] = useState<LoanKind>('secured');
  const [term, setTerm] = useState<number>(LOAN_TERM_DEFAULT);
  const [amount, setAmount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const p = s.portfolio;
  /* ★한도·금리·신용은 «엔진이 답한다». 화면은 받아 적기만 한다 */
  const terms = useMemo(
    () => {
      try {
        return s.loanTerms(kind);
      } catch {
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s, kind, s.tickVersion]
  );

  const overdraft = p?.overdraft ?? 0;
  const overdrawn = overdraft > 0;
  const avail = Math.max(0, Math.floor(terms?.available ?? 0));
  const canBorrow = !overdrawn && avail >= LOAN_MIN_PRINCIPAL;
  const size = Math.min(Math.max(LOAN_MIN_PRINCIPAL, amount ?? Math.floor(avail / 2)), Math.max(LOAN_MIN_PRINCIPAL, avail));
  const dayInterest = size * (terms?.dailyInterestPerDollar ?? 0);
  const termInterest = dayInterest * term;

  const submit = async () => {
    if (!canBorrow || busy) return;
    setErr(null);
    setBusy(true);
    try {
      await s.openLoan(kind, size, term);
      s.pushToast(`${tx('borrow')} ${money(size, 0)}`);
      setAmount(null);
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      setErr(code);
    } finally {
      setBusy(false);
    }
  };

  const repay = async (id: string, amt: number) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await s.repayLoan(id, amt);
      s.pushToast(`${tx('repay')} ${money(amt, 0)}`);
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      setErr(code);
    } finally {
      setBusy(false);
    }
  };

  const loans = p?.loans ?? [];

  return (
    <div className="screen" style={{ background: 'var(--bg)' }}>
      <div className="appbar">
        <button className="iconbtn" onClick={() => nav(-1)} aria-label="close">
          {Icon.close}
        </button>
        <span style={{ fontSize: 17, fontWeight: 800 }}>{tx('title')}</span>
      </div>

      <div className="scroll" style={{ padding: '4px var(--gutter) 0' }}>
        {/* ── 연체 배너 — 있으면 «가장 먼저» 본다. 여기가 막힌 이유의 자리다 ── */}
        {overdrawn && (
          <div
            className="card"
            /* ★★색은 «경고»(--warn)다. ⛔`--down` 을 쓰지 마라 — 그건 «시장 방향» 색이고
                 한국 표기(updown:'kr')에서는 ★파랑이다. 연체 경고가 파랗게 나온다(실렌더로 발견).
                 방향과 경고는 다른 축이다. */
            style={{ marginTop: 8, padding: 16, background: 'var(--warn-weak)', border: '1px solid var(--warn)' }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--warn)' }}>{tx('odTitle')}</span>
              <span className="num" style={{ fontSize: 22, fontWeight: 800, color: 'var(--warn)' }}>
                {signedMoney(-overdraft)}
              </span>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 8, lineHeight: 1.5 }}>
              {tx('odBody', { v: money(overdraft), r: pct((p?.overdraftRate ?? 0) * 100, 2) })}
            </p>
            <p style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>{tx('odHow')}</p>
            <p style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>{tx('odNoTopup')}</p>
          </div>
        )}

        {/* ── 자산 요약 — 숫자 먼저(토스 문법). 총자산·부채·순자산 세 값을 «같이» 본다 ── */}
        <div className="card" style={{ marginTop: 12, padding: '6px 16px' }}>
          <div className="kv">
            <span className="kv__k">{tx('total')}</span>
            <span className="kv__v num">{money(p?.equity ?? 0)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{tx('debt')}</span>
            {/* ★★«대출 잔액»만 적는다. ⛔연체 잔액을 여기 더하지 마라 —
                 연체는 «현금이 음수인 것»이라 위 총자산에 ★이미 반영돼 있다. 더하면
                 화면에서 「총자산 − 부채 ≠ 순자산」이 되어 유저가 계산을 못 한다(실렌더로 발견). */}
            <span className="kv__v num" style={{ color: (p?.debt ?? 0) > 0 ? 'var(--warn)' : undefined }}>
              {money(p?.debt ?? 0)}
            </span>
          </div>
          <div className="divider" />
          <div className="kv kv--strong">
            <span className="kv__k">{tx('net')}</span>
            <span className="kv__v num">{money(p?.netWorth ?? 0)}</span>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>{tx('netNote')}</p>
        {overdrawn && <p className="hint" style={{ marginTop: 4 }}>{tx('odInCash')}</p>}

        {/* ── 신용 ── */}
        <div className="card card--sub" style={{ marginTop: 14, padding: '6px 16px' }}>
          <div className="kv">
            <span className="kv__k">{tx('grade')}</span>
            <span className="kv__v num" style={{ fontWeight: 800 }}>
              {p?.creditGrade ?? '-'} · {tx('score')} {p?.creditScore ?? 0}
            </span>
          </div>
          {((p?.bankruptcyCount ?? 0) > 0 || (p?.delinquencyCount ?? 0) > 0) && (
            <>
              <div className="divider" />
              <div className="kv">
                <span className="kv__k" style={{ color: 'var(--down)' }}>
                  {tx('bankruptcy', { n: p?.bankruptcyCount ?? 0, m: p?.delinquencyCount ?? 0 })}
                </span>
                <span className="kv__v" />
              </div>
            </>
          )}
        </div>

        {/* ── 담보 / 신용 ── */}
        <div style={{ marginTop: 18 }}>
          <Segment
            size="lg"
            value={kind}
            onChange={(v) => {
              setKind(v);
              setAmount(null);
            }}
            options={[
              { value: 'secured' as const, label: tx('secured') },
              { value: 'unsecured' as const, label: tx('unsecured') },
            ]}
          />
        </div>

        {/* ── 한도·금리 ── */}
        <div className="card card--sub" style={{ marginTop: 16, padding: '6px 16px' }}>
          <div className="kv">
            <span className="kv__k">{tx('limit')}</span>
            <span className="kv__v num">{money(terms?.limit ?? 0)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{tx('used')}</span>
            <span className="kv__v num">{money(terms?.outstanding ?? 0)}</span>
          </div>
          <div className="divider" />
          <div className="kv kv--strong">
            <span className="kv__k">{tx('avail')}</span>
            <span className="kv__v num">{money(avail)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">
              {tx('rate')}{' '}
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                {tx('rateBreak', {
                  b: pct((terms?.policyRate ?? 0) * 100, 2),
                  s: pct(((terms?.spreadBp ?? 0) / 100), 2),
                })}
              </span>
            </span>
            <span className="kv__v num">{pct((terms?.rate ?? 0) * 100, 2)}</span>
          </div>
          {kind === 'secured' && (
            <>
              <div className="divider" />
              <div className="kv">
                <span className="kv__k">
                  {tx('collateral')} <span style={{ fontSize: 11, opacity: 0.8 }}>LTV {pct(LOAN_LTV_MAX * 100, 0)}</span>
                </span>
                <span className="kv__v num">{money(terms?.collateral ?? 0)}</span>
              </div>
              <div className="divider" />
              <div className="kv">
                <span className="kv__k">
                  {tx('ltv')}{' '}
                  {/* ★이 숫자가 «무엇인지» 화면이 말한다. 「· 85%」만 있으면 아무 뜻도 아니다 */}
                  <span style={{ fontSize: 11, opacity: 0.8 }}>
                    {ko ? `${pct(LOAN_MARGIN_CALL_LTV * 100, 0)} 넘으면 반대매매` : `sold off above ${pct(LOAN_MARGIN_CALL_LTV * 100, 0)}`}
                  </span>
                </span>
                <span
                  className="kv__v num"
                  style={{ color: (terms?.ltv ?? 0) > LOAN_MARGIN_CALL_LTV ? 'var(--down)' : undefined }}
                >
                  {pct((terms?.ltv ?? 0) * 100, 1)}
                </span>
              </div>
            </>
          )}
        </div>

        {/* ── 금액 ── */}
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{tx('howMuch')}</span>
            <span className="num" style={{ fontSize: 20, fontWeight: 800 }}>
              {money(canBorrow ? size : 0, 0)}
            </span>
          </div>
          <Slider
            value={Math.min(size, Math.max(LOAN_MIN_PRINCIPAL, avail))}
            min={LOAN_MIN_PRINCIPAL}
            max={Math.max(LOAN_MIN_PRINCIPAL, avail)}
            step={100}
            onChange={setAmount}
            tone="up"
            label={tx('howMuch')}
          />
          <div className="pillrow pillrow--even" style={{ marginTop: 10 }}>
            {[0.25, 0.5, 1].map((f) => (
              <button
                key={f}
                type="button"
                className={`pill ${size === Math.floor(avail * f) ? 'pill--on' : ''}`}
                onClick={() => setAmount(Math.max(LOAN_MIN_PRINCIPAL, Math.floor(avail * f)))}
              >
                {pct(f * 100, 0)}
              </button>
            ))}
          </div>
        </div>

        {/* ── 만기 ── */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 10 }}>{tx('when')}</div>
          <div style={{ display: 'flex', gap: 7 }}>
            {LOAN_TERM_CHOICES.map((d) => (
              <button
                key={d}
                type="button"
                className={`pill ${term === d ? 'pill--on' : ''}`}
                style={{ flex: 1, textAlign: 'center' }}
                onClick={() => setTerm(d)}
                aria-pressed={term === d}
              >
                {tx('dayN', { n: d })}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8 }}>
            {tx('realMinutes', { d: term, m: gameDaysToRealMinutes(term) })}
          </div>
        </div>

        {/* ── 예상 이자 ── */}
        <div className="card card--sub" style={{ marginTop: 16, padding: '6px 16px' }}>
          <div className="kv">
            <span className="kv__k">{tx('interestDay')}</span>
            <span className="kv__v num">{money(dayInterest)}</span>
          </div>
          <div className="divider" />
          <div className="kv">
            <span className="kv__k">{tx('interestTotal')}</span>
            <span className="kv__v num">{money(termInterest)}</span>
          </div>
          <div className="divider" />
          <div className="kv kv--strong">
            <span className="kv__k">{tx('repayTotal')}</span>
            <span className="kv__v num">{money(size + termInterest)}</span>
          </div>
        </div>

        {/* ── 만기 처리 규칙 — «경고»가 아니라 «규칙»이다. 숫자와 순서만 적는다 ── */}
        <div className="card card--sub" style={{ marginTop: 14, padding: '12px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 8 }}>{tx('rulesTitle')}</div>
          {[tx('rule1'), tx('rule2'), tx('rule3')].map((r) => (
            <p key={r} style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.6, margin: '2px 0' }}>
              {r}
            </p>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>{tx('noteVar')}</p>
        <p className="hint" style={{ marginTop: 4 }}>{tx('noteFee')}</p>

        {/* ── 내 대출 ── */}
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 10 }}>{tx('myLoans')}</div>
          {loans.length === 0 ? (
            <p className="hint">{tx('empty')}</p>
          ) : (
            loans.map((l) => {
              const owed = l.principal + l.accruedInterest;
              return (
                <div key={l.id} className="card card--sub" style={{ padding: '12px 16px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, fontWeight: 800 }}>
                      {l.kind === 'secured' ? tx('secured') : tx('unsecured')}{' '}
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>{l.grade}</span>
                    </span>
                    <span className="num" style={{ fontSize: 18, fontWeight: 800 }}>
                      {money(owed)}
                    </span>
                  </div>
                  <div className="kv" style={{ marginTop: 6 }}>
                    <span className="kv__k">{tx('principal')}</span>
                    <span className="kv__v num">{money(l.principal)}</span>
                  </div>
                  {l.accruedInterest > 0 && (
                    <div className="kv">
                      <span className="kv__k" style={{ color: 'var(--down)' }}>
                        {tx('unpaid')}
                      </span>
                      <span className="kv__v num" style={{ color: 'var(--down)' }}>
                        {money(l.accruedInterest)}
                      </span>
                    </div>
                  )}
                  <div className="kv">
                    <span className="kv__k">{tx('rate')}</span>
                    <span className="kv__v num">{pct(l.rate * 100, 2)}</span>
                  </div>
                  {l.delinquentDays > 0 && (
                    <p style={{ fontSize: 12, color: 'var(--down)', marginTop: 6 }}>
                      {tx('overdue', { n: l.delinquentDays })}
                    </p>
                  )}
                  {l.marginCallDay >= 0 && (
                    <p style={{ fontSize: 12, color: 'var(--down)', marginTop: 6 }}>{tx('marginCall')}</p>
                  )}
                  <div className="pillrow pillrow--even" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="pill"
                      disabled={busy}
                      onClick={() => void repay(l.id, Math.max(1, owed / 2))}
                    >
                      {tx('repayHalf')}
                    </button>
                    <button
                      type="button"
                      className="pill pill--on"
                      disabled={busy}
                      onClick={() => void repay(l.id, owed)}
                    >
                      {tx('repayAll')}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {err && (
          <div
            className="note"
            style={{ marginTop: 12, background: 'var(--down-weak)', color: 'var(--down)', fontWeight: 700 }}
          >
            <span aria-hidden style={{ display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>
              {Icon.warn}
            </span>
            <span>{err}</span>
          </div>
        )}
        <div className="scroll-pad" />
      </div>

      {/* ★버튼이 죽으면 «이유»가 같은 자리에 있다 — 회색 버튼만 남기지 않는다 */}
      <div className="cta">
        <div style={{ minHeight: 18, marginBottom: 6, textAlign: 'center' }}>
          {overdrawn ? (
            /* ★푸터는 «막힌 이유»만 한 줄로. 자세한 설명은 위 배너가 이미 했다 —
               같은 문장을 두 번 적으면 고정 푸터가 두 줄로 밀려 버튼이 내려간다(실렌더로 확인).
               ★색은 경고(--warn) — `--down` 은 시장 방향 색이라 KR 표기에서 파랗다. */
            <span className="hint num" style={{ color: 'var(--warn)', fontWeight: 700 }}>
              {tx('odBlock', { v: money(overdraft) })}
            </span>
          ) : avail < LOAN_MIN_PRINCIPAL ? (
            <span className="hint num">{tx('noRoom')}</span>
          ) : (
            <span className="hint num">{tx('minNote', { v: money(LOAN_MIN_PRINCIPAL, 0) })}</span>
          )}
        </div>
        <button type="button" className="btn btn--lg btn--gold" disabled={!canBorrow || busy} onClick={() => void submit()}>
          {tx('borrow')}
          <span className="btn__sub num">{money(canBorrow ? size : 0, 0)}</span>
        </button>
      </div>
    </div>
  );
}
