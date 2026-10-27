import { t as tr, setLocale, useLocale, useLanguagePreference } from './i18n';
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
import { ProfilesPage } from './pages/ProfilesPage';
import { DashboardPage } from './pages/DashboardPage';
import { AssistantPage } from './pages/AssistantPage';
import { MemoryPage } from './pages/MemoryPage';
import { Icon, type IconName } from './Icon';

const pageIcons: Record<UiPage, IconName> = { assistant:'profiles', memory:'sessions', dashboard: 'dashboard', tasks: 'tasks', sessions: 'sessions', settings: 'settings', profiles: 'profiles', connections: 'connections' };
const navigationGroups: { label: string; pages: UiPage[] }[] = [
  { label: '工作区', pages: ['dashboard', 'tasks', 'sessions'] },
  { label: '个性化', pages: ['assistant', 'memory', 'profiles'] },
  { label: '管理', pages: ['settings', 'connections'] },
];
function currentPage(): UiPage {
  return (Object.keys(uiRoutes) as UiPage[]).find(page => uiRoutes[page] === location.pathname) ?? 'dashboard';
}
export function App({ initial, startupError }: { initial?: ManagementState; startupError?: string }) {
  const locale = useLocale(), languagePreference = useLanguagePreference();
  const pages: Record<UiPage, string> = { assistant:tr("助手设置"), memory:tr("长期记忆"), dashboard: tr("概览"), tasks: tr("任务"), sessions: tr("会话"), settings: tr("项目与权限"), profiles: tr("用户档案"), connections: tr("Agent 与飞书") };
  const navigation: Record<UiPage, string> = { ...pages, assistant:tr('助手'), memory:tr('记忆'), settings:tr('项目管理'), profiles:tr('个人档案'), connections:tr('连接设置') };
  const descriptions: Record<UiPage, string> = { assistant:tr("设置助手的身份和表达偏好。"), memory:tr("管理明确保存的偏好、知识与交接。"), dashboard: tr("运行概况与需要你留意的事。"), tasks: tr("查找任务，查看执行进度与结果。"), sessions: tr("沿着上下文，找回每一条工作线。"), settings: tr("决定它在哪里工作，能做哪些事。"), profiles: tr("保存称呼、语言与时区。"), connections: tr("把本地 Agent 和飞书连接起来。") };
  const [state, setState] = useState(initial), [view, setView] = useState(currentPage), [target, setTarget] = useState<DetailTarget | null>(null);
  const [search, setSearch] = useState(() => location.search.slice(1));
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(startupError ? { text: startupError, error: true } : null);
  const [refreshing, setRefreshing] = useState(false), [expired, setExpired] = useState(false);
  const sequence = useRef(0), opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const restorePage = () => { setView(currentPage()); setSearch(location.search.slice(1)); setTarget(null); };
    window.addEventListener('popstate', restorePage);
    return () => window.removeEventListener('popstate', restorePage);
  }, []);
  useEffect(() => { document.title = `${pages[view]} · Namo`; }, [view, locale]);
  const go = useCallback((href: string) => {
    const oldPath = location.pathname;
    if (location.pathname + location.search !== href) history.pushState(null, '', href);
    setView(currentPage()); setSearch(location.search.slice(1)); setTarget(null);
    if (oldPath !== location.pathname) window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  const onOpen = (next: DetailTarget) => { opener.current = document.activeElement as HTMLElement; setTarget(next); };
  function navigate(event: MouseEvent<HTMLAnchorElement>, page: UiPage) {
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
  const application = { applied: tr("保存的配置已生效"), pending: tr("配置已保存，待应用"), unknown: tr("在线版本未报告配置版本"), stopped: tr("配置将在下次启动生效") };
  return <div className="app-shell">
    <aside className="sidebar">
      <a href={uiRoutes.dashboard} className="brand" onClick={event => navigate(event, 'dashboard')}><img src="/logo.png" alt={tr("Namo 狐狸标识")} /><span><span className="brand-wordmark">Namo</span><small>{tr("本地工作台")}</small></span></a>
      <nav className="desktop-navigation" aria-label={tr("主导航")}>{navigationGroups.map(group => <div className="nav-group" key={group.label}>
        <Text as="p" className="nav-group-label" size="1" color="gray">{tr(group.label)}</Text>
        <div className="nav-links">{group.pages.map(key =>
          <Button asChild key={key} variant={view === key ? 'soft' : 'ghost'} color={view === key ? 'orange' : 'gray'}>
            <a href={uiRoutes[key]} aria-current={view === key ? 'page' : undefined} onClick={event => navigate(event, key)}><Icon name={pageIcons[key]} size={18} /><span>{navigation[key]}</span></a>
          </Button>)}</div>
      </div>)}</nav>
      <div className="mobile-navigation"><label className="sr-only" htmlFor="workbench-page">{tr('主导航')}</label>
        <Choice id="workbench-page" value={view} onChange={value => go(uiRoutes[value as UiPage])} options={navigationGroups.flatMap(group => group.pages.map(key => ({value:key,label:pages[key]})))} />
      </div>
      <div className="sidebar-foot"><div className="service-status"><span className={`dot ${state?.service.ready ? 'ready' : ''}`} />
        <Text weight="medium" size="2">{expired || !state ? tr("尚未授权") : state.service.ready ? tr("飞书已连接") : state.service.running ? tr("连接尚未就绪") : tr("服务未运行")}</Text>
        {state && state.config.application !== 'applied' && <Text as="p" size="1" color="gray">{application[state.config.application]}</Text>}</div>
        <div className="language-control">
          <label className="sr-only" htmlFor="workbench-language">Language / 语言</label>
          <Choice id="workbench-language" value={languagePreference} onChange={value => setLocale(value as LanguagePreference)} options={[{ value: 'system', label: tr('跟随系统') }, { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }]} />
        </div>
        <div className="sidebar-links">
          <Popover.Root><Popover.Trigger><Button className="version-button" variant="ghost" color="gray" size="1" aria-label={tr('版本信息：{0}', __NAMO_VERSION__)}>v{__NAMO_VERSION__}<Icon name="info" size={13} /></Button></Popover.Trigger>
            <Popover.Content className="version-popover" size="2" aria-label={tr('版本信息')}>
              <Heading as="h2" size="3">{tr('版本信息')}</Heading>
              <dl><dt>{tr('工作台版本')}</dt><dd>v{__NAMO_VERSION__}</dd>
                <dt>{tr('运行中的服务发布')}</dt><dd>{state?.service.running && state.service.release?.running ? state.service.release.running.slice(0,12) : tr('尚未报告')}</dd>
                {state?.service.release?.installed && state.service.release.installed !== state.service.release.running && <><dt>{tr('已安装的服务发布')}</dt><dd>{state.service.release.installed.slice(0,12)}</dd></>}
              </dl><Text as="p" size="1" color="gray">{tr('只在本机访问')}</Text>
            </Popover.Content></Popover.Root>
          <Link className="project-link" href={PROJECT_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub · dofy/namo"><Icon name="external" /><span>GitHub</span></Link>
        </div>
      </div>
    </aside>
    <main>
      <header><div><Heading as="h1" size="7">{pages[view]}</Heading>
        <Text as="p" size="2" color="gray">{descriptions[view]}</Text></div>
        <Button variant="outline" color="gray" disabled={!state || expired} loading={refreshing} onClick={async () => {
          setRefreshing(true); try { await refresh(); } catch (e) { notify(message(e), true); } finally { setRefreshing(false); }
        }}><Icon name="refresh" />{tr("刷新状态")}</Button>
      </header>
      {notice && <Notice error={notice.error}>{notice.text}</Notice>}
      {state && <>
        {view === 'assistant' && (state.assistant ? <AssistantPage settings={state.assistant} editable={!expired && state.recoveryAvailable} save={api.assistantSave} reset={api.assistantReset} preview={api.assistantPreview} refresh={refresh} /> : <Notice>{tr('请先初始化服务数据库')}</Notice>)}
        {view === 'memory' && <MemoryPage editable={!expired && state.recoveryAvailable} unavailableReason={!state.recoveryAvailable?tr('请先初始化或升级服务数据库'):undefined} />}
        {view === 'dashboard' && <section aria-label={tr("概览内容")}><DashboardPage state={state} navigate={go} onOpen={onOpen} enabled={!expired} /></section>}
        {(view === 'tasks' || view === 'sessions') && <section aria-label={view === 'tasks' ? tr("任务内容") : tr("会话内容")}><TasksPage key={view} kind={view} state={state} onOpen={onOpen} navigate={go} search={search} enabled={!expired} /></section>}
        <section hidden={view !== 'settings'} aria-label={tr("项目与权限内容")}><SettingsPage config={state.config} recoveryAvailable={state.recoveryAvailable && !expired} refresh={refresh} notify={notify} /></section>
        <section hidden={view !== 'connections'} aria-label={tr("Agent 与飞书内容")}><ConnectionsPage config={state.config} /></section>
        <section hidden={view !== 'profiles'} aria-label={tr("用户档案内容")}><ProfilesPage profiles={state.profiles ?? { available: false, configRevision: state.config.revision, entries: [], reason: tr("当前工作台进程尚未支持用户档案，请关闭并重新运行 namo ui。") }} expired={expired} refresh={refresh} /></section>
      </>}
      <footer>{tr("Namo 把消息交给 Agent，也把执行状态交还给你。")}</footer>
    </main>
    <Details target={target} close={() => setTarget(null)} changed={refresh} notify={notify} restoreFocus={() => opener.current?.focus()} />
  </div>;
}
