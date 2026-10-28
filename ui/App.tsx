import { t as tr, setLocale, useLocale, useLanguagePreference, type MessageKey } from './i18n';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Button, Heading, Link, Popover, Text } from '@radix-ui/themes';
import { uiRoutes, type ManagementState, type UiPage } from '../src/ui-contract';
import { api, ApiError, message } from './api';
import { Choice, Notice } from './components';
import { PROJECT_URL } from '../src/project';
import type { LanguagePreference } from '../src/i18n';
import { Details } from './Details';
import { TasksPage, type DetailTarget } from './pages/TasksPage';
import { SettingsPage } from './pages/SettingsPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { MemoryProfilesPage } from './pages/MemoryProfilesPage';
import { DashboardPage } from './pages/DashboardPage';
import { AssistantPage } from './pages/AssistantPage';
import { ChangelogPage } from './pages/ChangelogPage';
import { Icon, type IconName } from './Icon';

type NavigationPage = Exclude<UiPage, 'profiles'>;
const pageIcons: Record<NavigationPage, IconName> = { assistant: 'assistant', memory: 'memory', dashboard: 'dashboard', tasks: 'tasks', sessions: 'sessions', settings: 'settings', connections: 'connections', changelog: 'changelog' };
const navigationGroups: { label: MessageKey; pages: NavigationPage[] }[] = [
  { label: "nav.workspace", pages: ['dashboard', 'tasks', 'sessions'] },
  { label: "nav.personalization", pages: ['assistant', 'memory'] },
  { label: "nav.management", pages: ['settings', 'connections', 'changelog'] },
];
function currentRoute(): { page: NavigationPage; pathname: string; search: string } {
  const page = (Object.keys(uiRoutes) as UiPage[]).find(page => uiRoutes[page] === location.pathname) ?? 'dashboard';
  return { page: page === 'profiles' ? 'memory' : page, pathname: location.pathname, search: location.search.slice(1) };
}
export function App({ initial, startupError }: { initial?: ManagementState; startupError?: string }) {
  const locale = useLocale(), languagePreference = useLanguagePreference();
  const pages: Record<NavigationPage, string> = { assistant:tr("nav.assistantSettings"), memory:tr("nav.memoryProfiles"), dashboard: tr("nav.dashboard"), tasks: tr("nav.tasks"), sessions: tr("nav.sessions"), settings: tr("nav.projectPermissions"), connections: tr("nav.connections"), changelog:tr('changelog.title') };
  const navigation: Record<NavigationPage, string> = { ...pages, assistant:tr("nav.assistant"), settings:tr("nav.projects"), connections:tr("nav.connections") };
  const descriptions: Record<NavigationPage, string> = { assistant:tr("app.configureAssistantIdentityPresentationPreferences"), memory:tr("app.manageMemoriesConversationsNamesLanguagesTimeZones"), dashboard: tr("app.activityItemsNeedAttention"), tasks: tr("app.findTasksFollowTheirProgressResults"), sessions: tr("app.pickUpWhereEachConversationLeftOff"), settings: tr("app.chooseWhereAgentWorksWhatCan"), connections: tr("app.manageCodexFeishuGithubConnections"), changelog:tr('changelog.description') };
  const [state, setState] = useState(initial), [route, setRoute] = useState(currentRoute), [target, setTarget] = useState<DetailTarget | null>(null);
  const { page: view, pathname, search } = route;
  const memoryTab = pathname === uiRoutes.profiles || new URLSearchParams(search).get('tab') === 'profiles' ? 'profiles' : 'memory';
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(startupError ? { text: startupError, error: true } : null);
  const [refreshing, setRefreshing] = useState(false), [expired, setExpired] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const sequence = useRef(0), opener = useRef<HTMLElement | null>(null);
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
  const application = { applied: tr("app.savedConfigurationActive"), pending: tr("app.configurationSavedApplyActivate"), unknown: tr("app.serviceConfigurationVersionUnavailable"), stopped: tr("app.configurationApplyNextStart") };
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
      <div className="mobile-navigation"><label className="sr-only" htmlFor="workbench-page">{tr("nav.main")}</label>
        <Choice id="workbench-page" value={view} onChange={value => go(uiRoutes[value as NavigationPage])} options={navigationGroups.flatMap(group => group.pages.map(key => ({value:key,label:pages[key]})))} />
      </div>
      <div className="sidebar-foot"><div className="service-status"><span className={`dot ${state?.service.ready ? 'ready' : ''}`} />
        <Text weight="medium" size="2">{expired || !state ? tr("app.notAuthorized") : state.service.ready ? tr("app.feishuConnected") : state.service.running ? tr("app.connectionNotReady") : tr("app.serviceStopped")}</Text>
        {state && state.config.application !== 'applied' && <Text as="p" size="1" color="gray">{application[state.config.application]}</Text>}</div>
        <div className="language-control">
          <label className="sr-only" htmlFor="workbench-language">Language / 语言</label>
          <Choice id="workbench-language" value={languagePreference} onChange={value => setLocale(value as LanguagePreference)} options={[{ value: 'system', label: tr("language.system") }, { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }]} />
        </div>
        <div className="sidebar-links">
          <Popover.Root open={versionOpen} onOpenChange={setVersionOpen}><Popover.Trigger><Button className="version-button" variant="ghost" color="gray" size="1" aria-label={tr("app.versionLabel", __NAMO_VERSION__)}>v{__NAMO_VERSION__}<Icon name="info" size={13} /></Button></Popover.Trigger>
            <Popover.Content className="version-popover" size="2" aria-label={tr("app.versionInformation")}>
              <Heading as="h2" size="3">{tr("app.versionInformation")}</Heading>
              <dl><dt>{tr("app.workbenchVersion")}</dt><dd>v{__NAMO_VERSION__}</dd>
                <dt>{tr("app.runningServiceRelease")}</dt><dd>{state?.service.running && state.service.release?.running ? state.service.release.running.slice(0,12) : tr("app.notReported")}</dd>
                {state?.service.release?.installed && state.service.release.installed !== state.service.release.running && <><dt>{tr("app.installedServiceRelease")}</dt><dd>{state.service.release.installed.slice(0,12)}</dd></>}
              </dl><Text as="p" size="1" color="gray">{tr("app.localAccess")}</Text>
              <Link href={uiRoutes.changelog} onClick={event => { navigate(event, 'changelog'); setVersionOpen(false); }}>{tr('changelog.view')}</Link>
            </Popover.Content></Popover.Root>
          <Link className="project-link" href={PROJECT_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub · dofy/namo"><Icon name="external" /><span>GitHub</span></Link>
        </div>
      </div>
    </aside>
    <main>
      <header className={view === 'memory' ? 'memory-profiles-header' : undefined}><div><Heading as="h1" size="7">{pages[view]}</Heading>
        <Text as="p" size="2" color="gray">{descriptions[view]}</Text></div>
        <Button variant="outline" color="gray" disabled={!state || expired} loading={refreshing} onClick={async () => {
          setRefreshing(true); try { await refresh(); } catch (e) { notify(message(e), true); } finally { setRefreshing(false); }
        }}><Icon name="refresh" />{tr("common.refreshStatus")}</Button>
      </header>
      {notice && <Notice error={notice.error}>{notice.text}</Notice>}
      {state && <>
        {view === 'assistant' && (state.assistant ? <AssistantPage settings={state.assistant} editable={!expired && state.recoveryAvailable} save={api.assistantSave} reset={api.assistantReset} preview={api.assistantPreview} refresh={refresh} /> : <Notice>{tr("app.initializeServiceDatabaseFirst")}</Notice>)}
        <section hidden={view !== 'memory'} aria-label={tr("nav.memoryProfiles")}>
          <MemoryProfilesPage active={view === 'memory'} tab={memoryTab} onTabChange={tab => go(tab === 'profiles' ? `${uiRoutes.memory}?tab=profiles` : uiRoutes.memory)}
            profiles={state.profiles ?? { available: false, configRevision: state.config.revision, entries: [], reason: tr("app.workbenchNotSupportProfilesYetCloseRun") }}
            expired={expired} recoveryAvailable={state.recoveryAvailable} refresh={refresh} />
        </section>
        {view === 'dashboard' && <section aria-label={tr("app.dashboardContent")}><DashboardPage state={state} navigate={go} onOpen={onOpen} enabled={!expired} /></section>}
        {(view === 'tasks' || view === 'sessions') && <section aria-label={view === 'tasks' ? tr("app.taskContent") : tr("app.sessionContent")}><TasksPage key={view} kind={view} state={state} onOpen={onOpen} navigate={go} search={search} enabled={!expired} /></section>}
        <section hidden={view !== 'settings'} aria-label={tr("app.projectsPermissionsContent")}><SettingsPage config={state.config} recoveryAvailable={state.recoveryAvailable && !expired} refresh={refresh} notify={notify} /></section>
        <section hidden={view !== 'connections'} aria-label={tr("app.agentFeishuContent")}><ConnectionsPage state={state} refresh={refresh} expired={expired} /></section>
        {view === 'changelog' && <ChangelogPage />}
      </>}
    </main>
    <Details target={target} close={() => setTarget(null)} changed={refresh} notify={notify} restoreFocus={() => opener.current?.focus()} />
  </div>;
}
