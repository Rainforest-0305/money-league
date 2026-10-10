/**
 * 출석표 — «7일 스트립» + 요약 (2026-08-30 President 지시
 *   「출석표 같은 걸로 플레이어들이 날마다 보상이 는다는 걸 알게 해야지」).
 *
 * ★이 파일은 «표시»만 한다. 규칙(곡선·streak·지급)은 `lib/attendance.ts` 와 `store.claimAttendance` 한 벌이다.
 *   ⛔여기서 금액을 적거나 streak 을 계산하지 마라 — 칸의 금액은 `ATTENDANCE_REWARDS` 에서 «그대로» 읽는다.
 *
 * ★칸 상태 3종 — 전부 `cyclePosition(streak)` 하나에서 «유도»된다:
 *   받은 날(is-done)   : 오늘 칸보다 앞. 브랜드 원 + 체크.
 *   오늘(is-today)     : 정적 강조(선 + 약한 면). ⛔펄스·애니메이션 없음 — 광고·게임 루프와 GPU 를 나눈다.
 *   남은 날            : 보통. 7일차(is-peak)만 금색으로 «크게» — 곡선의 핵심이 2.5배 점프라 그 칸이 커야 한다.
 * ★8일차부터는 «새 주기»다: streak 8 → pos 1 ⇒ 1칸만 체크, 나머지는 남은 날. 하루 걸러 반토막 나면
 *   pos 도 뒤로 간다 — ⛔거짓으로 앞칸을 채우지 않는다. 「하루 쉬어도 이어져요」는 «사실»이라 그대로 둔다.
 *
 * ★두 곳에서 같은 몸통을 쓴다: 충전 화면의 출석 카드(광고 2배 버튼은 거기에만) · 홈 칩이 여는 시트(재열람 전용).
 */
import { useTranslation } from 'react-i18next';
import { Icon } from './Primitives';
import { ATTENDANCE_CYCLE_DAYS, ATTENDANCE_REWARDS, cyclePosition } from '../lib/attendance';
import { compactMoney, money } from '../lib/format';

export function AttendanceStrip({ streak, claimedToday }: { streak: number; claimedToday: boolean }) {
  const { t } = useTranslation('recharge');
  const pos = cyclePosition(Math.max(1, streak));
  return (
    <div className="attstrip" role="list">
      {ATTENDANCE_REWARDS.map((usd, i) => {
        const day = i + 1;
        const done = day < pos || (day === pos && claimedToday);
        const today = day === pos;
        const peak = day === ATTENDANCE_CYCLE_DAYS;
        const cls = `attstrip__c${done ? ' is-done' : ''}${today ? ' is-today' : ''}${peak ? ' is-peak' : ''}`;
        const label = today
          ? t('attendCellToday', { n: day, v: money(usd, 0) })
          : done
            ? t('attendCellDone', { n: day, v: money(usd, 0) })
            : t('attendCellLeft', { n: day, v: money(usd, 0) });
        return (
          <div key={day} className={cls} role="listitem" aria-label={label} aria-current={today ? 'date' : undefined}>
            <span className="attstrip__d num" aria-hidden="true">
              {done ? Icon.checkSm(12) : day}
            </span>
            <span className="attstrip__v num" aria-hidden="true">
              {compactMoney(usd)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 제목 줄 + 스트립 + 한 줄 설명들. 광고 2배 버튼은 «여기 없다» — 부르는 쪽(충전 화면)이 붙인다.
 * @param titleId 시트의 aria-labelledby 가 가리킬 제목 id
 */
export function AttendanceSummary({
  streak,
  claimedToday,
  nextUsd,
  titleId,
}: {
  streak: number;
  claimedToday: boolean;
  nextUsd: number;
  titleId?: string;
}) {
  const { t } = useTranslation('recharge');
  const shown = Math.max(1, streak);
  const pos = cyclePosition(shown);
  const peakUsd = ATTENDANCE_REWARDS[ATTENDANCE_CYCLE_DAYS - 1];
  return (
    <>
      <div className="attsum__top">
        <span id={titleId} className="attsum__t">
          {t('attendTitle', { n: shown })}
        </span>
        <span className="attsum__next num">{t('attendNext', { v: money(nextUsd, 0) })}</span>
      </div>
      <AttendanceStrip streak={shown} claimedToday={claimedToday} />
      <p className="hint attline" style={{ marginTop: 12 }}>
        {claimedToday ? t('attendDone') : t('attendStreak', { n: shown })}
      </p>
      {/* ★7일차 «전»에만 — 마지막 칸이 왜 큰지 한 줄로. 7일차 당일엔 이미 그 칸이 오늘이라 말할 게 없다 */}
      {pos < ATTENDANCE_CYCLE_DAYS && (
        <p className="hint attline attline--peak">{t('attendPeak', { n: ATTENDANCE_CYCLE_DAYS, v: money(peakUsd, 0) })}</p>
      )}
      {/* ★「하루 쉬어도 이어져요」 — 경고문이 아니라 «사실» 한 줄이다. 리셋 공포가 이탈로 직결된다 */}
      <p className="hint attline">{t('attendGrace')}</p>
    </>
  );
}
