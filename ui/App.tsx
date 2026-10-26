import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Heading, Text } from '@radix-ui/themes';
import type { ManagementState } from '../src/ui-contract';
import { api, ApiError, message } from './api';
import { Notice } from './components';
import { Details } from './Details';
import { TasksPage, type DetailTarget } from './pages/TasksPage';
import { SettingsPage } from './pages/SettingsPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ProfilesPage } from './pages/ProfilesPage';

const pages = { tasks: '任务与工作线', settings: '项目与权限', profiles: '用户档案', connections: 'Agent 与飞书' };
type Page = keyof typeof pages;
export function App({ initial, startupError }: { initial?: ManagementState; startupError?: string }) {
  const [state, setState] = useState(initial), [view, setView] = useState<Page>('tasks'), [target, setTarget] = useState<DetailTarget | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(startupError ? { text: startupError, error: true } : null);
  const [refreshing, setRefreshing] = useState(false), [expired, setExpired] = useState(false);
  const sequence = useRef(0), opener = useRef<HTMLElement | null>(null);
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current;
    try { const next = await api.state(signal); if (!signal?.aborted && request === sequence.current) setState(next); return next; }
    catch (e) { if (e instanceof ApiError && e.status === 401) setExpired(true); throw e; }
  }, []);
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
  const application = { applied: '保存的配置已生效', pending: '配置已保存，待应用', unknown: '在线版本未报告配置版本', stopped: '配置将在下次启动生效' };
  return <div className="app-shell">
    <aside className="sidebar">
      <a href="/" className="brand"><img src="/logo.png" alt="Namo 狐狸标识" /><span>Namo<small>本地工作台</small></span></a>
      <nav aria-label="主导航">{(Object.entries(pages) as [Page, string][]).map(([key, label]) =>
        <Button key={key} variant={view === key ? 'soft' : 'ghost'} color={view === key ? 'orange' : 'gray'} aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)}>{label}</Button>)}</nav>
      <div className="sidebar-foot"><span className={`dot ${state?.service.ready ? 'ready' : ''}`} />
        <Text weight="medium" size="2">{expired || !state ? '尚未授权' : state.service.ready ? '飞书已连接' : state.service.running ? '连接尚未就绪' : '服务未运行'}</Text>
        {state && <Text as="p" size="1" color="gray">{application[state.config.application]}</Text>}
        <Text as="p" size="1" color="gray">只在本机访问</Text>
      </div>
    </aside>
    <main>
      <header><div><Text as="p" size="2" color="gray">{view === 'tasks' ? '让每一件事，都有着落。' : view === 'settings' ? '决定它在哪里工作，能做哪些事。' : view === 'profiles' ? '保存称呼、语言与时区。' : '把本地 Agent 和飞书连接起来。'}</Text>
        <Heading as="h1" size="7">{pages[view]}</Heading></div>
        <Button variant="outline" color="gray" disabled={!state || expired} loading={refreshing} onClick={async () => {
          setRefreshing(true); try { await refresh(); } catch (e) { notify(message(e), true); } finally { setRefreshing(false); }
        }}>刷新状态</Button>
      </header>
      {notice && <Notice error={notice.error}>{notice.text}</Notice>}
      {state && <>
        <section hidden={view !== 'tasks'} aria-label="任务与工作线内容"><TasksPage state={state} onOpen={next => { opener.current = document.activeElement as HTMLElement; setTarget(next); }} /></section>
        <section hidden={view !== 'settings'} aria-label="项目与权限内容"><SettingsPage config={state.config} recoveryAvailable={state.recoveryAvailable && !expired} refresh={refresh} notify={notify} /></section>
        <section hidden={view !== 'connections'} aria-label="Agent 与飞书内容"><ConnectionsPage config={state.config} /></section>
        <section hidden={view !== 'profiles'} aria-label="用户档案内容"><ProfilesPage profiles={state.profiles ?? { available: false, configRevision: state.config.revision, entries: [], reason: '当前工作台进程尚未支持用户档案，请关闭并重新运行 namo ui。' }} expired={expired} refresh={refresh} /></section>
      </>}
      <footer>Namo 把消息交给 Agent，也把执行状态交还给你。</footer>
    </main>
    <Details target={target} close={() => setTarget(null)} changed={refresh} notify={notify} restoreFocus={() => opener.current?.focus()} />
  </div>;
}
