/**
 * 거시 이벤트(시황) 카드 — 홈 「지금 일어나는 일」 + 피드 소식 행.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★이 화면이 «존재하는 이유» (엔진 인계문서 2026-08-20 §6 실측)
 *
 *   같은 시드·같은 30게임일에서
 *     이벤트를 «읽고» 20배     +24.34%
 *     이벤트를 «읽고» 현물      +8.32%
 *     랜덤 현물                 +1.94%
 *     랜덤 20배                -70.17%
 *   ⇒ ★즉 이 게임의 «실력» = 「이벤트를 알아채는 것」이다.
 *     UI 가 그걸 «가능하게» 만들지 못하면 이 게임에는 실력이 없다.
 *
 * ★그러나 ⛔«떠먹여 주면» 그것도 실력이 아니다. 그래서 규칙 3개를 지킨다:
 *   ① 「지금 사세요」·「추천」·「유망」류를 ⛔쓰지 않는다 — 사실만 말한다(카피 금칙어표)
 *   ② 종목 단위로 오른다/내린다를 ⛔찍어 주지 않는다. 업종까지만이다
 *   ③ 업종조차 «부호가 갈리면» 말하지 않는다 — 실적 시즌이 그렇다(store.deriveMacroSectors)
 *   ⇒ ★남는 것은 「지금 이런 일이 있고, 이 업종들이 움직인다」는 사실뿐이다. 판단은 유저 몫이다.
 *
 * ★성능: ⛔blur·backdrop-filter·box-shadow 0건. 진행바는 width 가 아니라
 *   ★transform: scaleX 로 움직인다(레이아웃 재계산 없음). 매 틱(2초) 값이 바뀌는 유일한 부분이다.
 */
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { MacroLogItem, MacroSector, MacroType, MacroView } from '../lib/types';
import { Icon } from './Primitives';

/**
 * 이벤트 종류별 «재질».
 *
 * ★색을 «방향»(오름/내림)에 묶지 않았다 — 묶으면 카드 자체가 「사라/팔아라」가 된다.
 *   이건 날씨판이다. 방향은 업종 칩에만 있다.
 * ★아이콘은 앱 자체 SVG 세트에서만 쓴다(이모지 금지 — 기기마다 다르게 그려진다).
 */
const LOOK: Record<MacroType, { tone: string; icon: JSX.Element }> = {
  rate_cut: { tone: 'macro--brand', icon: Icon.percent },
  earnings_season: { tone: 'macro--gold', icon: Icon.receipt },
  recession_fear: { tone: 'macro--warn', icon: Icon.warn },
};

/** 남은 시간 표기 — 「곧 끝나요」 임계 (게임일) */
const ENDING_SOON_GAME_DAYS = 0.2;

/**
 * 홈 상단 「지금 일어나는 일」 카드.
 * ★진행 중인 이벤트가 «없으면 아무것도 그리지 않는다» — 빈 껍데기를 남기지 않는다.
 */
export function MacroCard({ view }: { view: MacroView }) {
  const { t, i18n } = useTranslation('home');
  const ko = i18n.language !== 'en';
  const look = LOOK[view.type];

  return (
    <section className={`macro ${look.tone}`} aria-labelledby={`macro-${view.id}`}>
      <div className="macro__head">
        <span className="macro__icon" aria-hidden>
          {look.icon}
        </span>
        <h3 className="macro__title" id={`macro-${view.id}`}>
          {t(`common:${view.titleKey}`)}
        </h3>
        <span className="macro__remain num">{remainLabel(t, view)}</span>
      </div>

      <p className="macro__body">{t(`common:${view.bodyKey}`)}</p>

      {/*
        ★진행바 — 「지속되는 일」임을 «보여주는» 부분이다.
        ★aria: 진행률을 스크린리더에도 그대로 준다. 시각 표현만으로 끝내지 않는다.
      */}
      <div
        className="macro__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(view.progress * 100)}
        aria-label={t('macroOngoing')}
      >
        <i style={{ transform: `scaleX(${view.progress.toFixed(3)})` }} />
      </div>

      {view.sectors.length > 0 ? (
        <div className="macro__sectors">
          <span className="macro__label">{t('macroSectorsLabel')}</span>
          <span className="macro__chips">
            {view.sectors.map((sec) => (
              <SectorChip key={sec.nameKo} sec={sec} ko={ko} />
            ))}
          </span>
        </div>
      ) : (
        /*
         * ★업종 칩이 «없을 때» 침묵하지 않는다 — 왜 없는지 말한다.
         *   실적 시즌: 같은 업종 안에서도 종목마다 부호가 갈린다(엔진 실측).
         *   그때 「업종이 없다」가 아니라 ★「업종이 아니라 종목으로 갈린다」가 사실이다.
         */
        <div className="macro__sectors">
          <span className="macro__label">{t(view.splitsByStock ? 'macroSplit' : 'macroWholeMarket')}</span>
        </div>
      )}
    </section>
  );
}

/**
 * 업종 칩 — ★누르면 그 업종 종목 목록으로 간다.
 *
 * ★이게 「이벤트를 읽는다 → 어느 종목을 볼까」의 «고리»다. 고리가 없으면
 *   이벤트 카드는 그냥 읽고 지나가는 배너가 된다.
 * ★터치 타깃: Web 기준 WCAG 2.2 AA = 24 CSS px. 칩 높이 28px 로 넘긴다
 *   (iOS 44pt / Android 48dp 는 «네이티브» 기준이라 여기 적용 대상이 아니다).
 */
function SectorChip({ sec, ko }: { sec: MacroSector; ko: boolean }) {
  const { t } = useTranslation('home');
  const nav = useNavigate();
  const name = ko ? sec.nameKo : sec.nameEn;
  return (
    <button
      type="button"
      className={`macro__chip ${sec.dir > 0 ? 'is-up' : 'is-down'}`}
      onClick={() => nav(`/stocks?sector=${encodeURIComponent(sec.nameKo)}`)}
      aria-label={t('macroSectorGo', { s: name })}
    >
      {name}
      <span aria-hidden>{sec.dir > 0 ? '▲' : '▼'}</span>
    </button>
  );
}

function remainLabel(t: (k: string, o?: Record<string, unknown>) => string, v: MacroView): string {
  if (v.remainGameDays < ENDING_SOON_GAME_DAYS) return t('macroEndingSoon');
  return t('macroRemainDays', { d: v.remainGameDays.toFixed(1) });
}

/**
 * 피드에 섞이는 «소식 행».
 *
 * ★거래 행과 «구분»되어야 한다. 구분은 3겹이다:
 *   ① 아이콘 칩의 색이 이벤트 종류색이다(거래는 --surface-2 / 청산은 --warn-weak)
 *   ② ★「소식」 배지가 붙는다 — 글로 구분되지 않으면 색맹 사용자에게는 구분이 없다
 *   ③ 시각 표기가 «게임일»이다. 거래 행은 「N초 전」(실제 시간)이다 —
 *      시황은 며칠 단위 사건이라 초 단위로 재는 게 오히려 틀린 표기다
 */
export function MacroFeedRow({ item }: { item: MacroLogItem }) {
  const { t } = useTranslation('home');
  const look = LOOK[item.type];
  return (
    <div className="macrorow">
      <span className={`macrorow__icon ${look.tone}`} aria-hidden>
        {look.icon}
      </span>
      <span className="macrorow__text">
        <b>{t(`common:${item.titleKey}`)}</b>
        <span className="badge badge--weak macrorow__tag">{t('macroNewsBadge')}</span>
        <span className="macrorow__sub">{t(`common:${item.bodyKey}`)}</span>
      </span>
      <span className="macrorow__when num">{t('macroFeedDay', { n: item.gameDay + 1 })}</span>
    </div>
  );
}
