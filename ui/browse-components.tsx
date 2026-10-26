import { t as tr, getLocale, useLocale } from './i18n';
import { useEffect, useId, useState, type MouseEvent, type ReactNode } from 'react';
import { Button, Card, Link, Text, TextField } from '@radix-ui/themes';
import type { BrowseOptions, PageResult } from '../src/ui-contract';
import { message } from './api';
import { Choice, Field } from './components';
import { Icon } from './Icon';

export type Navigate = (href: string) => void;
export function LocalLink({ href, navigate, children, className, title }: { href: string; navigate: Navigate; children: ReactNode; className?: string; title?: string }) {
  function click(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(href);
  }
  return <Link href={href} onClick={click} className={className} title={title} underline="hover">{children}</Link>;
}
export function useRemote<T>(key: string, load: (signal: AbortSignal) => Promise<T>, revision: unknown, enabled = true) {
  const locale = useLocale();
  const [result, setResult] = useState<{ key: string; data: T }>(), [error, setError] = useState(''), [busy, setBusy] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); setBusy(true); setError('');
    void load(controller.signal).then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(e => { if (!controller.signal.aborted) setError(message(e)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [key, load, revision, enabled, locale]);
  return { data: result?.key === key ? result.data : undefined, error, busy };
}
export function DateTime({ value, empty = tr("尚未开始") }: { value: number | null | undefined; empty?: string }) {
  if (value == null) return <span className="muted">{empty}</span>;
  const date = new Date(value);
  return <time className="date-time" dateTime={date.toISOString()} title={date.toLocaleString(getLocale())}>
    <span>{date.toLocaleDateString(getLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' })}</span>
    <span className="muted">{date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
  </time>;
}
export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return tr("{0} 秒", seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return tr("{0} 分 {1} 秒", minutes, seconds % 60);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? tr("{0} 小时 {1} 分", hours, minutes % 60) : tr("{0} 天 {1} 小时", Math.floor(hours / 24), hours % 24);
}
export function Owner({ id, name }: { id: string; name: string }) {
  return <span className="owner"><span>{name || tr("未命名用户")}</span><span className="secondary-id" title={id}>{id}</span></span>;
}
export function Pagination({ page, onChange, busy }: { page: Omit<PageResult<unknown>, 'items'>; onChange: (page: number, size: number) => void; busy: boolean }) {
  const sizeId = useId();
  const start = page.total ? (page.page - 1) * page.pageSize + 1 : 0, end = Math.min(page.page * page.pageSize, page.total);
  return <div className="pagination" aria-label={tr("分页")}>
    <Text size="2" color="gray" role="status">{start}–{end}  {tr("/ 共")} {page.total}  {tr("条")}</Text>
    <div className="page-size"><Text as="label" htmlFor={sizeId} size="2" color="gray">{tr("每页条数")}</Text><Choice id={sizeId} value={String(page.pageSize)} disabled={busy} onChange={value => onChange(1, Number(value))} options={[25, 50, 100].map(size => ({ value: String(size), label: String(size) }))} /></div>
    <div className="page-buttons"><Button variant="outline" color="gray" size="2" disabled={busy || page.page <= 1} onClick={() => onChange(page.page - 1, page.pageSize)}><Icon name="left" />{tr("上一页")}</Button><Text size="2">{page.page} / {page.pages}</Text><Button variant="outline" color="gray" size="2" disabled={busy || page.page >= page.pages} onClick={() => onChange(page.page + 1, page.pageSize)}>{tr("下一页")}<Icon name="right" /></Button></div>
  </div>;
}
const taskStates = () => [['queued',tr("排队中")],['running',tr("执行中")],['waiting',tr("等待补充")],['succeeded',tr("已完成")],['failed',tr("未完成")],['interrupted',tr("已中断")],['needs_attention',tr("需要核对")],['cancelled',tr("已取消")],['problem',tr("全部执行异常")]];
const sessionStates = () => [['running',tr("执行中")],['waiting',tr("等待补充")],['queued',tr("排队中")],['idle',tr("空闲")],['current',tr("当前绑定会话")]];
const filterKeys = ['q', 'owner', 'project', 'state', 'from', 'to', 'sort', 'dateField'] as const;
const filters = (search: string) => Object.fromEntries(filterKeys.map(key => [key, new URLSearchParams(search).get(key) ?? ''])) as Record<typeof filterKeys[number], string>;
export function Filters({ kind, search, options, onSearch }: { kind: 'tasks' | 'sessions'; search: string; options?: BrowseOptions; onSearch: (query: URLSearchParams) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(() => filters(search));
  useEffect(() => setDraft(filters(search)), [search]);
  const change = (key: keyof typeof draft, value: string) => setDraft(old => ({ ...old, [key]: value }));
  const states = kind === 'tasks' ? taskStates() : sessionStates();
  const users = options?.users.map(user => ({ value: user.id, label: user.name ? `${user.name} (${user.id})` : user.id })) ?? [];
  if (draft.owner && !users.some(user => user.value === draft.owner)) users.push({ value: draft.owner, label: draft.owner });
  const projects = options?.projects.map(project => ({ value: `named:${project}`, label: project })) ?? [];
  if (draft.project.startsWith('named:') && !projects.some(project => project.value === draft.project)) projects.push({ value: draft.project, label: draft.project.slice(6) });
  const active = filterKeys.filter(key => key !== 'sort' && key !== 'dateField' && new URLSearchParams(search).has(key)).length;
  return <Card asChild size="2"><form className="browse-filters" aria-label={tr("列表筛选")} onSubmit={event => {
    event.preventDefault(); const query = new URLSearchParams(search); query.delete('page');
    for (const key of filterKeys) { if (draft[key]) query.set(key, draft[key]); else query.delete(key); }
    onSearch(query);
  }}>
    <div className="filter-primary">
      <Field label={tr("搜索")} htmlFor={`${id}-search`} className="filter-search"><TextField.Root id={`${id}-search`} type="search" value={draft.q} maxLength={200} onChange={e => change('q', e.target.value)} placeholder={kind === 'tasks' ? tr("任务内容、任务或会话编号") : tr("会话编号、任一任务内容")}><TextField.Slot><Icon name="search" /></TextField.Slot></TextField.Root></Field>
      <Field label={tr("用户")} htmlFor={`${id}-owner`}><Choice id={`${id}-owner`} value={draft.owner} onChange={value => change('owner', value)} options={[{ value: '', label: tr("全部用户") }, ...users]} /></Field>
      <Field label={tr("项目")} htmlFor={`${id}-project`}><Choice id={`${id}-project`} value={draft.project} onChange={value => change('project', value)} options={[{ value: '', label: tr("全部项目") }, { value: 'isolated', label: tr("隔离目录") }, ...projects]} /></Field>
      <Field label={tr("状态")} htmlFor={`${id}-state`}><Choice id={`${id}-state`} value={draft.state} onChange={value => change('state', value)} options={[{ value: '', label: tr("全部状态") }, ...states.map(([value, label]) => ({ value, label }))]} /></Field>
    </div>
    <div className="filter-secondary">
      {kind === 'tasks' && <Field label={tr("日期类型")} htmlFor={`${id}-date-type`} className="filter-date-type"><Choice id={`${id}-date-type`} value={draft.dateField || 'created'} onChange={value => change('dateField', value)} options={[{ value: 'created', label: tr("创建时间") }, { value: 'started', label: tr("开始时间") }, { value: 'finished', label: tr("结束时间") }]} /></Field>}
      <Field label={kind === 'tasks' ? tr("从") : tr("创建日期，从")} htmlFor={`${id}-from`}><TextField.Root id={`${id}-from`} type="date" value={draft.from} max={draft.to || undefined} onChange={e => change('from', e.target.value)} /></Field>
      <Field label={tr("到")} htmlFor={`${id}-to`}><TextField.Root id={`${id}-to`} type="date" value={draft.to} min={draft.from || undefined} onChange={e => change('to', e.target.value)} /></Field>
      <Field label={tr("排序")} htmlFor={`${id}-sort`} className="filter-sort"><Choice id={`${id}-sort`} value={draft.sort || 'newest'} onChange={value => change('sort', value)} options={[{ value: 'newest', label: kind === 'tasks' ? tr("创建时间从新到旧") : tr("最近活动从新到旧") }, { value: 'oldest', label: kind === 'tasks' ? tr("创建时间从旧到新") : tr("最近活动从旧到新") }]} /></Field>
      <div className="filter-actions"><Button type="submit"><Icon name="filter" />{tr("筛选")}{active ? ` (${active})` : ''}</Button><Button type="button" variant="ghost" color="gray" onClick={() => { const query = new URLSearchParams(search); for (const key of [...filterKeys, 'page']) query.delete(key); setDraft(filters(query.toString())); onSearch(query); }}><Icon name="reset" />{tr("重置")}</Button></div>
    </div>
  </form></Card>;
}
