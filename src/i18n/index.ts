/**
 * react-i18next 설정.
 * 네임스페이스는 화면 단위(ui_spec 6장): common / onboarding / home / stock /
 * derivatives / rank / settings / recharge / journal.
 * 숫자·통화는 문자열에 박지 않고 lib/format.ts 의 Intl 헬퍼로 만들어 넣는다.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ko from '../locales/ko.json';
import en from '../locales/en.json';
import { store } from '../store/store';

export const NAMESPACES = [
  'common',
  'onboarding',
  'home',
  'stock',
  'derivatives',
  'rank',
  'settings',
  'recharge',
  'journal',
] as const;

/**
 * 미번역 키 노출 0건 보증 장치 (1/2) — 런타임.
 * 개발 모드에서만 켠다. 키가 비거나 오타면 화면에 `⚠키이름`으로 크게 드러나고
 * 콘솔에 에러가 남는다. 프로덕션 번들에서는 두 훅 모두 undefined 라 비용이 없다.
 * (2/2 는 빌드 전 검사 — scripts/check_i18n_keys.mjs, `npm run check:i18n`)
 */
const DEV = import.meta.env.DEV;

void i18n.use(initReactI18next).init({
  resources: { ko, en },
  lng: store.settings.lang,
  fallbackLng: 'ko',
  ns: NAMESPACES as unknown as string[],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  saveMissing: DEV,
  missingKeyHandler: DEV
    ? (lngs, ns, key, fallbackValue) => {
        console.error(`[i18n] missing key: ${ns}:${key} (lng=${lngs.join(',')}) fallback="${fallbackValue}"`);
      }
    : undefined,
  parseMissingKeyHandler: DEV ? (key: string) => `⚠${key}` : undefined,
});

export function setLanguage(lang: 'ko' | 'en'): void {
  void i18n.changeLanguage(lang);
  store.setSettings({ lang });
}

export default i18n;
