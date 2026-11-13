import { t as tr, setLocale, useLocale, useLanguagePreference, type MessageKey } from './i18n';
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { Button, Dialog, Flex, Heading, Link, Popover, Tabs, Text } from '@radix-ui/themes';
import { uiRoutes, type ManagementState, type UiPage } from '../src/ui-contract';
import { api, ApiError, message } from './api';
import { Choice, Notice } from './components';
import { REPOSITORY_URL } from '../src/repository';
import type { LanguagePreference } from '../src/i18n';
import { Details } from './Details';
import { TasksPage, type DetailTarget } from './pages/TasksPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { SettingsPage } from './pages/SettingsPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { OperationsPanel } from './OperationsPanel';
import { MemoryProfilesPage } from './pages/MemoryProfilesPage';
import { DashboardPage } from './pages/DashboardPage';
import { AssistantPage } from './pages/AssistantPage';
import { ChangelogPage } from './pages/ChangelogPage';
import { ModelCatalogProvider } from './components/ModelSelect';
import { Icon, type IconName } from './Icon';
import { ThemeSwitch } from './ThemeSwitch';
import { PageWatermark } from './components/PageWatermark';

type NavigationPage = Exclude<UiPage, 'profiles'>;
const pageIcons: Record<NavigationPage, IconName> = { assistant: 'assistant', memory: 'memory', dashboard: 'dashboard', tasks: 'tasks', schedules: 'schedules', sessions: 'sessions', settings: 'settings', connections: 'connections', changelog: 'changelog' };
const navigationGroups: { label: MessageKey; pages: NavigationPage[] }[] = [
  { label: "nav.workspace", pages: ['dashboard', 'tasks', 'schedules', 'sessions'] },
  { label: "nav.personalization", pages: ['assistant', 'memory'] },
  { label: "nav.management", pages: ['settings', 'changelog'] },
];
function currentRoute(): { page: NavigationPage; pathname: string; search: string } {
  const page = (Object.keys(uiRoutes) as UiPage[]).find(page => uiRoutes[page] === location.pathname) ?? 'dashboard';
  return { page: page === 'profiles' ? 'memory' : page === 'connections' ? 'settings' : page, pathname: location.pathname, search: location.search.slice(1) };
}
function serviceLabel(state: ManagementState | undefined, expired: boolean): string {
  return expired || !state ? tr('app.notAuthorized') : state.service.ready ? tr('app.feishuConnected') : state.service.running ? tr('app.connectionNotReady') : tr('app.serviceStopped');
}
function SidebarControls({ state, expired, navigate, onRefresh, refreshing, mobile = false }: {
  state: ManagementState | undefined; expired: boolean; navigate: (event: MouseEvent<HTMLAnchorElement>, page: NavigationPage) => void; onRefresh: () => void; refreshing: boolean; mobile?: boolean;
}) {
  const languagePreference = useLanguagePreference(), languageId = useId();
  const [versionOpen, setVersionOpen] = useState(false);
  const application = { applied: tr('app.savedConfigurationActive'), pending: tr('app.configurationSavedApplyActivate'), unknown: tr('app.serviceConfigurationVersionUnavailable'), stopped: tr('app.configurationApplyNextStart') };
  return <div className={mobile ? 'mobile-menu-controls' : 'sidebar-foot'}><div className="service-status"><div className="service-status-row"><div><span className={`dot ${state?.service.ready ? 'ready' : ''}`} />
    <Text weight="medium" size="2">{serviceLabel(state, expired)}</Text></div>
    <Button className="service-refresh" variant="ghost" color="gray" size="1" aria-label={tr('common.refreshStatus')} title={tr('common.refreshStatus')} disabled={!state || expired} loading={refreshing} onClick={onRefresh}><Icon name="refresh" /></Button></div>
    {state && state.config.application !== 'applied' && <Text as="p" size="1" color="gray">{state.config.automaticConfiguration&&state.config.application==='pending'?tr(state.config.configurationReload==='error'?'settings.configurationReloadError':'settings.configurationDraining'):application[state.config.application]}</Text>}</div>
    <ThemeSwitch />
    <div className="language-control"><label className="sr-only" htmlFor={languageId}>Language / 语言</label>
      <Choice id={languageId} value={languagePreference} onChange={value => setLocale(value as LanguagePreference)} options={[{ value: 'system', label: tr('language.system') }, { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }]} />
    </div>
    <div className="sidebar-links">
      <Popover.Root open={versionOpen} onOpenChange={setVersionOpen}><Popover.Trigger><Button className="version-button" variant="ghost" color="gray" size="1" aria-label={tr('app.versionLabel', __NAMO_VERSION__)}>v{__NAMO_VERSION__}<Icon name="info" size={13} /></Button></Popover.Trigger>
        <Popover.Content className="version-popover" size="2" aria-label={tr('app.versionInformation')}>
          <Flex justify="between" align="center" gap="3"><Heading as="h2" size="3">{tr('app.versionInformation')}</Heading><Popover.Close><Button type="button" variant="soft" color="gray" size="1"><Icon name="close"/>{tr('common.close')}</Button></Popover.Close></Flex>
          <dl><dt>{tr('app.workbenchVersion')}</dt><dd>v{__NAMO_VERSION__}</dd>
            <dt>{tr('app.runningServiceRelease')}</dt><dd>{state?.service.running && state.service.release?.running ? state.service.release.running.slice(0,12) : tr('app.notReported')}</dd>
            {state?.service.release?.installed && state.service.release.installed !== state.service.release.running && <><dt>{tr('app.installedServiceRelease')}</dt><dd>{state.service.release.installed.slice(0,12)}</dd></>}
          </dl><Text as="p" size="1" color="gray">{tr('app.localAccess')}</Text>
          <Link href={uiRoutes.changelog} onClick={event => { navigate(event, 'changelog'); setVersionOpen(false); }}>{tr('changelog.view')}</Link>
        </Popover.Content></Popover.Root>
      <Link className="repository-link" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub · dofy/namo"><Icon name="external" /><span>GitHub</span></Link>
    </div>
  </div>;
}
export function App({ initial, startupError }: { initial?: ManagementState; startupError?: string }) {
  const locale = useLocale();
  const pages: Record<NavigationPage, string> = { assistant:tr("nav.assistantSettings"), memory:tr("nav.memoryProfiles"), dashboard: tr("nav.dashboard"), tasks: tr("nav.tasks"), schedules:tr('nav.schedules'), sessions: tr("nav.sessions"), settings: tr("nav.directories"), connections: tr("nav.connections"), changelog:tr('changelog.title') };
  const navigation: Record<NavigationPage, string> = { ...pages, assistant:tr("nav.assistant"), settings:tr("nav.directories"), connections:tr("nav.connections") };
  const descriptions: Record<NavigationPage, string> = { assistant:tr("app.configureAssistantIdentityPresentationPreferences"), memory:tr("app.manageMemoriesConversationsNamesLanguagesTimeZones"), dashboard: tr("app.activityItemsNeedAttention"), tasks: tr("app.findTasksFollowTheirProgressResults"), schedules:tr('schedules.description'), sessions: tr("app.pickUpWhereEachConversationLeftOff"), settings: tr("settings.pageDescription"), connections: tr("app.manageCodexFeishuGithubConnections"), changelog:tr('changelog.description') };
  const [state, setState] = useState(initial), [route, setRoute] = useState(currentRoute), [target, setTarget] = useState<DetailTarget | null>(null);
  const { page: view, pathname, search } = route;
  const requestedSettingsTab = new URLSearchParams(search).get('tab');
  const settingsTab = requestedSettingsTab === 'feishu' || requestedSettingsTab === 'connections' || requestedSettingsTab === 'maintenance' ? requestedSettingsTab : pathname === uiRoutes.connections ? 'connections' : 'work';
  const memoryTab = pathname === uiRoutes.profiles || new URLSearchParams(search).get('tab') === 'profiles' ? 'profiles' : 'memory';
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(startupError ? { text: startupError, error: true } : null);
  const [refreshing, setRefreshing] = useState(false), [expired, setExpired] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sequence = useRef(0), opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const closeOnDesktop = () => { if (window.innerWidth > 820) setMenuOpen(false); };
    window.addEventListener('resize', closeOnDesktop);
    return () => window.removeEventListener('resize', closeOnDesktop);
  }, []);
  useEffect(() => {
    const restorePage = () => { setRoute(currentRoute()); setTarget(null); };
    window.addEventListener('popstate', restorePage);
    return () => window.removeEventListener('popstate', restorePage);
  }, []);
  useEffect(() => { document.title = `${pages[view]} · Namo`; }, [view, locale]);
  const go = useCallback((href: string) => {
    const oldPath = location.pathname;
    if (location.pathname + location.search !== href) history.pushState(null, '', href);
    setRoute(currentRoute()); setTarget(null);
    if (oldPath !== location.pathname) window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  const onOpen = (next: DetailTarget) => { opener.current = document.activeElement as HTMLElement; setTarget(next); };
  function navigate(event: MouseEvent<HTMLAnchorElement>, page: NavigationPage) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(uiRoutes[page]);
  }
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current;
    try { const next = await api.state(signal); if (!signal?.aborted && request === sequence.current) setState(next); return next; }
    catch (e) { if (e instanceof ApiError && e.status === 401) setExpired(true); throw e; }
  }, []);
  useEffect(() => {
    if (!initial || expired) return;
    const controller = new AbortController();
    setNotice(null);
    void refresh(controller.signal).catch(e => { if (!controller.signal.aborted) notify(message(e), true); });
    return () => controller.abort();
  }, [locale, initial, expired, refresh, notify]);
  useEffect(() => {
    if (!initial || expired || target) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try { await refresh(controller.signal); } catch (e) { if (!controller.signal.aborted) notify(message(e), true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(tick, 5000); }
    };
    timer = setTimeout(tick, 5000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [initial, expired, target, refresh, notify]);
  const refreshStatus = async () => {
    setRefreshing(true);
    try { await refresh(); } catch (e) { notify(message(e), true); } finally { setRefreshing(false); }
  };
  return <div className="app-shell">
    <aside className="sidebar">
      <a href={uiRoutes.dashboard} className="brand" onClick={event => navigate(event, 'dashboard')}><img src="/logo.png" alt={tr("app.namoFoxLogo")} /><span><span className="brand-wordmark">Namo</span><small>{tr("app.localWorkbench")}</small></span></a>
      <nav className="desktop-navigation" aria-label={tr("nav.main")}>{navigationGroups.map(group => <div className="nav-group" key={group.label}>
        <Text as="p" className="nav-group-label" size="1" color="gray">{tr(group.label)}</Text>
        <div className="nav-links">{group.pages.map(key =>
          <Button asChild key={key} variant={view === key ? 'soft' : 'ghost'} color={view === key ? 'orange' : 'gray'}>
            <a href={uiRoutes[key]} aria-current={view === key ? 'page' : undefined} onClick={event => navigate(event, key)}><Icon name={pageIcons[key]} size={18} /><span>{navigation[key]}</span></a>
          </Button>)}</div>
      </div>)}</nav>
      <div className="mobile-masthead-status"><span className={`dot ${state?.service.ready ? 'ready' : ''}`} />
        <span>{serviceLabel(state, expired)}</span>
      </div>
      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Dialog.Trigger><Button className="mobile-menu-trigger" variant="soft" color="gray"><Icon name="menu" size={19}/><span>{tr('nav.menu')}</span></Button></Dialog.Trigger>
        <Dialog.Content className="mobile-menu-dialog" aria-describedby={undefined}>
          <div className="mobile-menu-header"><div><Dialog.Title>{tr('nav.main')}</Dialog.Title><Text as="p" size="1" color="gray">{tr('app.localWorkbench')}</Text></div>
            <Dialog.Close><Button variant="ghost" color="gray" aria-label={tr('common.close')}><Icon name="close" size={20}/></Button></Dialog.Close></div>
          <nav className="mobile-menu-navigation" aria-label={tr('nav.main')}>
            {navigationGroups.map(group => <div className="mobile-menu-group" key={group.label}>
              <Text as="p" size="1" color="gray">{tr(group.label)}</Text>
              <div className="mobile-menu-links">{group.pages.map(key => <a key={key} href={uiRoutes[key]} aria-current={view === key ? 'page' : undefined} onClick={event => { navigate(event, key); setMenuOpen(false); }}>
                  <Icon name={pageIcons[key]} size={18}/><span>{navigation[key]}</span>
                </a>)}</div>
            </div>)}
          </nav>
          <SidebarControls state={state} expired={expired} navigate={(event, page) => { navigate(event, page); setMenuOpen(false); }} onRefresh={() => void refreshStatus()} refreshing={refreshing} mobile />
        </Dialog.Content>
      </Dialog.Root>
      <SidebarControls state={state} expired={expired} navigate={navigate} onRefresh={() => void refreshStatus()} refreshing={refreshing} />
    </aside>
    <main className={`workbench-main page-${view}`}>
      <header className="page-header"><div className="page-heading"><span className="page-icon"><PageWatermark name={pageIcons[view]} /></span><div><Heading as="h1" size="7">{pages[view]}</Heading>
        <Text as="p" size="2" color="gray">{descriptions[view]}</Text></div></div>

      </header>
      {notice && <Notice error={notice.error}>{notice.text}</Notice>}
      {state && <ModelCatalogProvider revision={state.config.revision}>
        {view === 'assistant' && (state.assistant ? <AssistantPage settings={state.assistant} editable={!expired && state.recoveryAvailable} save={api.assistantSave} reset={api.assistantReset} preview={api.assistantPreview} refresh={refresh} /> : <Notice>{tr("app.initializeServiceDatabaseFirst")}</Notice>)}
        <section hidden={view !== 'memory'} aria-label={tr("nav.memoryProfiles")}>
          <MemoryProfilesPage active={view === 'memory'} tab={memoryTab} onTabChange={tab => go(tab === 'profiles' ? `${uiRoutes.memory}?tab=profiles` : uiRoutes.memory)}
            profiles={state.profiles ?? { available: false, configRevision: state.config.revision, entries: [], reason: tr("app.workbenchNotSupportProfilesYetCloseRun") }}
            config={state.config} expired={expired} recoveryAvailable={state.recoveryAvailable} refresh={refresh} />
        </section>
        {view === 'dashboard' && <section aria-label={tr("app.dashboardContent")}><DashboardPage state={state} navigate={go} onOpen={onOpen} enabled={!expired} /></section>}
        {(view === 'tasks' || view === 'sessions') && <section aria-label={view === 'tasks' ? tr("app.taskContent") : tr("app.sessionContent")}><TasksPage key={view} kind={view} state={state} onOpen={onOpen} navigate={go} search={search} enabled={!expired} /></section>}
        {view === 'schedules' && <SchedulesPage state={state} search={search} navigate={go} enabled={!expired} />}
        <section className="settings-container" hidden={view !== 'settings'} aria-label={tr("nav.directories")}>
          <Tabs.Root className="settings-tabs" value={settingsTab} onValueChange={tab => go(tab === 'work' ? uiRoutes.settings : `${uiRoutes.settings}?tab=${tab}`)}>
            <Tabs.List aria-label={tr('settings.sections')}>
              <Tabs.Trigger value="work"><Icon name="settings" />{tr('settings.workSection')}</Tabs.Trigger>
              <Tabs.Trigger value="feishu"><Icon name="sessions" />{tr('settings.feishuMessages')}</Tabs.Trigger>
              <Tabs.Trigger value="connections"><Icon name="connections" />{tr('nav.connections')}</Tabs.Trigger>
              <Tabs.Trigger value="maintenance"><Icon name="activity" />{tr('settings.maintenanceSection')}</Tabs.Trigger>
            </Tabs.List>
            <SettingsPage tab={settingsTab} onTabChange={tab => go(`${uiRoutes.settings}?tab=${tab}`)} config={state.config} profiles={state.profiles} recoveryAvailable={state.recoveryAvailable && !expired} refresh={refresh} notify={notify}
              operations={<OperationsPanel state={state} expired={expired}/>} />
            <Tabs.Content value="connections" forceMount hidden={settingsTab !== 'connections'} className="settings-tab-panel">
              <ConnectionsPage state={state} refresh={refresh} expired={expired} />
            </Tabs.Content>
          </Tabs.Root>
        </section>
        {view === 'changelog' && <ChangelogPage />}
      </ModelCatalogProvider>}
    </main>
    <Details target={target} close={() => setTarget(null)} changed={refresh} notify={notify} restoreFocus={() => opener.current?.focus()} />
  </div>;
}
