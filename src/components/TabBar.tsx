import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TabIcons } from './Primitives';

const TABS = [
  { to: '/home', icon: TabIcons.home, key: 'tabs.home' },
  { to: '/stocks', icon: TabIcons.stocks, key: 'tabs.stocks' },
  { to: '/derivatives', icon: TabIcons.derivatives, key: 'tabs.derivatives' },
  { to: '/rank', icon: TabIcons.rank, key: 'tabs.rank' },
  { to: '/settings', icon: TabIcons.me, key: 'tabs.me' },
] as const;

export function TabBar() {
  const { t } = useTranslation('common');
  return (
    <nav className="tabbar" aria-label={t('appName')}>
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => (isActive ? 'is-on' : '')}>
          {tab.icon}
          {t(tab.key)}
        </NavLink>
      ))}
    </nav>
  );
}
