/**
 * 상대 트레이더 «제안» 카드 3장 — 선도 · 스왑 전용.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★차익거래 방지 3장치 중 «UI 가 지켜야 하는» 부분이 여기 전부 있다
 *   (사양서 §3. ⛔「밸런스」가 아니라 «구조적 공짜»를 막는 것이다).
 *
 *   ① 서로 다른 아키타입에서 «비복원» 추출  → ★엔진(world.pickArchetypes)이 보장한다
 *   ② 플레이어가 상대를 «지정 불가»          → ★배정은 무작위. 「이 사람으로 해줘」 UI 가 «없다».
 *                                              3장 중 «고르는» 것만 허용된다(사양서 명시)
 *   ③ ★«재추첨 금지»                        → ⛔이 파일에 ★「다시 뽑기」 버튼이 «없다».
 *                                              시드는 store.quoteSessionId() 가 고정한다
 *
 * ★그리고 ★유저가 «새로고침을 찾지 않게» 고정 안내를 «먼저» 보여준다 —
 *   안 그러면 「더 좋은 조건이 있을 텐데」 하고 뒤로가기를 반복한다(그게 재추첨 시도다).
 *
 * ★성능: ⛔blur·backdrop-filter·큰 그림자 0건. 3장뿐이라 리스트 비용도 없다.
 */
import { useTranslation } from 'react-i18next';
import type { CounterQuote } from '../lib/engine/types';
import { Icon } from './Primitives';

/**
 * 「평균보다 유리/불리」의 기준.
 * ★vsFairBp 는 «공정가 대비»(양수 = 플레이어에게 불리)다. 0 을 기준으로 가른다.
 * ★0 근처를 「보통」으로 두지 않는 이유: 3장 중 «상대 비교»가 이 카드의 목적이고,
 *   3단계로 나누면 가운데 등급이 대부분을 먹어 정보가 사라진다.
 */
export function QuoteCards({
  quotes,
  selected,
  onSelect,
  renderPrice,
}: {
  quotes: CounterQuote[];
  selected: number;
  onSelect: (i: number) => void;
  /** 상품마다 «가격»의 뜻이 다르다 — 선도는 계약가, 스왑은 캐리스프레드다 */
  renderPrice: (q: CounterQuote) => string;
}) {
  const { t } = useTranslation('derivatives');
  if (quotes.length === 0) return null;

  return (
    <div className="sec--tight" style={{ marginTop: 18 }}>
      <div className="qhead">
        <span className="sec__h" style={{ marginBottom: 0 }}>
          {t('quote.title')}
        </span>
        {/* ★고정 안내 — 「새로고침이 어디 있지」를 «묻기 전에» 답한다 */}
        {/*
          ★Icon.info 는 fill/stroke 를 «인라인으로 갖고 있지 않다» — `.iconbtn svg` CSS 에
            의존하는 옛 세대 아이콘이다. 그래서 «버튼 밖»에 놓으면 ★검은 원으로 찍힌다
            (실렌더에서 실제로 ● 로 나왔다).
          ⇒ Primitives 쪽에 인라인 속성을 넣어 근본을 고쳤고, 여기서도 .qfixed svg 로
            한 번 더 못 박는다 — 방어는 두 겹이어야 한 겹이 뚫려도 티가 난다.
        */}
        <span className="qfixed">
          <span aria-hidden>{Icon.info}</span>
          {t('quote.fixedNote')}
        </span>
      </div>

      <div className="qlist" role="radiogroup" aria-label={t('quote.title')}>
        {quotes.map((q, i) => {
          const good = q.vsFairBp < 0;
          return (
            <button
              key={`${q.strategy}-${i}`}
              type="button"
              role="radio"
              aria-checked={selected === i}
              className={`qcard ${selected === i ? 'is-on' : ''}`}
              onClick={() => onSelect(i)}
            >
              <span className="qcard__l">
                <span className="qcard__nm">{q.nickname}</span>
                <span className={`qcard__vs ${good ? 'is-good' : ''}`}>
                  {t(good ? 'quote.favorable' : 'quote.unfavorable')}
                </span>
              </span>
              <span className="qcard__r">
                <span className="qcard__p num">{renderPrice(q)}</span>
                {/* ★최량 1장에만 배지. 3장 다 붙이면 배지가 정보가 아니다 */}
                {i === 0 && <span className="badge badge--purple">{t('quote.best')}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <p className="hint" style={{ marginTop: 8 }}>
        {t('info.spreadNote')}
      </p>
    </div>
  );
}
