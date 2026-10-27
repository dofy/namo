import { t as tr } from '../i18n';
import { Icon } from '../Icon';
import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Heading, Text, TextArea, TextField } from '@radix-ui/themes';
import type { ConfigValues, ConfigView } from '../../src/ui-contract';
import { api, message } from '../api';
import { Choice, ConfirmButton, Field, Notice } from '../components';

type ProjectRow = { id: string; name: string; path: string };
interface Draft extends Omit<ConfigValues, 'projects' | 'readPaths' | 'denyPaths' | 'timeoutMs' | 'concurrency' | 'progressDelayMs' | 'progressIntervalMs' | 'progressHeartbeatMs'> {
  projects: ProjectRow[]; readPaths: string; denyPaths: string; timeoutSeconds: string; concurrency: string; newSecret: string;
  progressDelayMs:string;progressIntervalMs:string;progressHeartbeatMs:string;
}
function fromConfig(config: ConfigView): Draft {
  const v = config.values;
  return { ...v, projects: Object.entries(v.projects).map(([name, path]) => ({ id: crypto.randomUUID(), name, path })),
    reactions:v.reactions!==false,progressUpdates:v.progressUpdates!==false,
    readPaths: v.readPaths.join('\n'), denyPaths: v.denyPaths.join('\n'), timeoutSeconds: String(v.timeoutMs / 1000), concurrency: String(v.concurrency), newSecret: '',
    progressDelayMs:String(v.progressDelayMs??12000),progressIntervalMs:String(v.progressIntervalMs??5000),progressHeartbeatMs:String(v.progressHeartbeatMs??30000) };
}
function toPatch(draft: Draft): ConfigValues & { newSecret: string } {
  const projects: Record<string, string> = {};
  for (const row of draft.projects) {
    const name = row.name.trim(), path = row.path.trim();
    if (!name || !path) throw Error(tr("请填完整项目名和目录，或移除空行"));
    if (Object.hasOwn(projects, name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw Error(tr("项目名重复或不可用"));
    projects[name] = path;
  }
  const { timeoutSeconds, ...values } = draft;
  return { ...values, projects, ...(values.projectAccess?{projectAccess:Object.fromEntries(Object.entries(values.projectAccess).filter(([name])=>Object.hasOwn(projects,name)))}:{}), concurrency: Number(draft.concurrency), timeoutMs: Number(timeoutSeconds) * 1000,
    progressDelayMs:Number(draft.progressDelayMs),progressIntervalMs:Number(draft.progressIntervalMs),progressHeartbeatMs:Number(draft.progressHeartbeatMs),
    readPaths: draft.readPaths.split('\n').map(x => x.trim()).filter(Boolean), denyPaths: draft.denyPaths.split('\n').map(x => x.trim()).filter(Boolean) };
}
export function SettingsPage({ config, recoveryAvailable, refresh, notify }: {
  config: ConfigView; recoveryAvailable: boolean; refresh: () => Promise<unknown>; notify: (text: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => fromConfig(config)), [revision, setRevision] = useState(config.revision);
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const observedRevision = useRef(config.revision);
  function reset(value: ConfigView) { setDraft(fromConfig(value)); setRevision(value.revision); setDirty(false); setError(''); }
  useEffect(() => {
    // A completed save may precede a failed status refresh. Do not replace the
    // saved form with a cached, older parent projection when saving finishes.
    if (!dirty && !saving && observedRevision.current !== config.revision && revision !== config.revision) reset(config);
    observedRevision.current = config.revision;
  }, [config, dirty, saving, revision]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(d => ({ ...d, [key]: value })); setDirty(true); }
  const projects = [...new Set(draft.projects.map(p => p.name.trim()).filter(Boolean))];
  const booleanFields = (keys: ['networkAccess' | 'allowLocalCommits' | 'cards' | 'requireMention' | 'reactions' | 'progressUpdates', string][]) => <div className="checks">{keys.map(([key, label]) =>
    <Text as="label" size="2" key={key}><Checkbox checked={draft[key]!==false} disabled={saving || (key === 'allowLocalCommits' && draft.sandbox === 'read-only')}
      onCheckedChange={value => edit(key, value === true)} /> {label}</Text>)}</div>;
  return <form onSubmit={async event => {
    event.preventDefault(); if (saving) return; setSaving(true); setError('');
    try { const saved = await api.save(revision, toPatch(draft)); reset(saved); notify(tr("配置已保存并备份原值。需要应用后才会改变在线服务。")); await refresh(); }
    catch (e) { setError(message(e)); } finally { setSaving(false); }
  }}>
    {error && <Notice error>{error}</Notice>}
    {!config.valid && <Notice>{tr("配置尚未通过校验，请检查项目目录和权限后保存。")}</Notice>}
    {dirty && revision !== config.revision && <Notice>{tr("配置已被其他页面或程序修改。当前草稿保留；请先核对，或放弃修改并载入已保存配置。")}</Notice>}
    <fieldset disabled={saving}>
      <div className="section-title"><Heading as="h2" size="4">{tr("允许工作的项目")}</Heading>
        <Button type="button" variant="soft" onClick={() => edit('projects', [...draft.projects, { id: crypto.randomUUID(), name: '', path: '' }])}><Icon name="plus" />{tr("添加项目")}</Button></div>
      <Text as="p" size="2" color="gray">{tr("只开放具体项目目录。修改默认项目不会移动已有任务。")}</Text>
      <div className="projects">{draft.projects.map((project, index) => <div className="project-row" key={project.id}>
        <TextField.Root aria-label={tr("项目名 {0}", index + 1)} placeholder={tr("项目名")} value={project.name} onChange={e => edit('projects', draft.projects.map(p => p.id === project.id ? { ...p, name: e.target.value } : p))} />
        <TextField.Root aria-label={tr("项目目录 {0}", index + 1)} placeholder={tr("项目目录的完整路径")} value={project.path} onChange={e => edit('projects', draft.projects.map(p => p.id === project.id ? { ...p, path: e.target.value } : p))} />
        <Button type="button" variant="soft" color="gray" aria-label={tr("移除项目 {0}", project.name || index + 1)} onClick={() => edit('projects', draft.projects.filter(p => p.id !== project.id))}><Icon name="close" />{tr("移除")}</Button>
      </div>)}</div>
      <Field label={tr("默认项目")} htmlFor="default-project"><Choice id="default-project" value={draft.defaultProject || '$isolated'}
        onChange={value => edit('defaultProject', value === '$isolated' ? '' : value)} disabled={saving}
        options={[{ value: '$isolated', label: tr("使用隔离目录") }, ...projects.map(value => ({ value, label: value }))]} /></Field>
      <section className="form-section"><Heading as="h2" size="4">{tr("执行权限")}</Heading>
        <Field label={tr("文件权限")} htmlFor="sandbox"><Choice id="sandbox" value={draft.sandbox} disabled={saving}
          onChange={value => { setDraft(d => ({ ...d, sandbox: value as Draft['sandbox'], allowLocalCommits: value === 'read-only' ? false : d.allowLocalCommits })); setDirty(true); }}
          options={[{ value: 'read-only', label: tr("只读查看") }, { value: 'workspace-write', label: tr("允许修改项目文件") }]} /></Field>
        {booleanFields([['networkAccess', tr("允许命令联网")], ['allowLocalCommits', tr("允许本地 Git 提交")]])}
        <Text as="p" size="1" color="gray">{tr("推送和部署仍需单独确认。当前是 Agent 行为约束，尚未提供强制审批执行入口。")}</Text>
        <details><summary>{tr("额外路径权限")}</summary>
          <Field label={tr("额外可读目录（每行一个）")} htmlFor="read-paths"><TextArea id="read-paths" rows={3} value={draft.readPaths} onChange={e => edit('readPaths', e.target.value)} /></Field>
          <Field label={tr("禁止访问的目录（每行一个）")} htmlFor="deny-paths"><TextArea id="deny-paths" rows={3} value={draft.denyPaths} onChange={e => edit('denyPaths', e.target.value)} /></Field>
          <Text as="p" size="1" color="gray">{tr("服务配置、数据和登录目录始终排除，不会因这里的设置而开放。")}</Text>
        </details>
      </section>
      <section className="form-section"><Heading as="h2" size="4">{tr("执行方式")}</Heading><div className="form-grid">
        <Field label={tr("模型（留空使用 Codex 默认）")} htmlFor="model"><TextField.Root id="model" autoComplete="off" value={draft.model} onChange={e => edit('model', e.target.value)} /></Field>
        <Field label={tr("Codex 命令或完整路径")} htmlFor="bin"><TextField.Root id="bin" required value={draft.bin} onChange={e => edit('bin', e.target.value)} /></Field>
        <Field label={tr("最多同时执行")} htmlFor="concurrency"><TextField.Root id="concurrency" type="number" min="1" max="8" required value={draft.concurrency} onChange={e => edit('concurrency', e.target.value)} /></Field>
        <Field label={tr("每次执行时限（秒）")} htmlFor="timeout"><TextField.Root id="timeout" type="number" min="1" max="7200" required value={draft.timeoutSeconds} onChange={e => edit('timeoutSeconds', e.target.value)} /></Field>
      </div></section>
      <section className="form-section"><Heading as="h2" size="4">{tr("飞书消息")}</Heading>
        {booleanFields([['requireMention', tr("群聊中仅响应 @")], ['cards', tr("使用任务卡片与操作按钮")],['reactions',tr("接收后添加表情回应")],['progressUpdates',tr("发送处理进度更新")]])}
        <div className="form-grid">
          <Field label={tr("首次进度提示延迟（毫秒）")} htmlFor="progress-delay"><TextField.Root id="progress-delay" type="number" min="1000" max="120000" required value={draft.progressDelayMs} onChange={e=>edit('progressDelayMs',e.target.value)} /></Field>
          <Field label={tr("进度更新最短间隔（毫秒）")} htmlFor="progress-interval"><TextField.Root id="progress-interval" type="number" min="5000" max="60000" required value={draft.progressIntervalMs} onChange={e=>edit('progressIntervalMs',e.target.value)} /></Field>
          <Field label={tr("进度心跳间隔（毫秒）")} htmlFor="progress-heartbeat"><TextField.Root id="progress-heartbeat" type="number" min="30000" max="300000" required value={draft.progressHeartbeatMs} onChange={e=>edit('progressHeartbeatMs',e.target.value)} /></Field>
        </div>
        <Text as="p" size="1" color="gray">{tr("关闭进度更新后不会发送常规处理提示；错误、等待、结果和必要状态仍会保留。时间设置仅在启用进度更新时生效。")}</Text>
        <Text as="p" size="1" color="gray">{tr("启用按钮前，在飞书后台订阅 card.action.trigger 回调并发布应用。未配置时可继续使用文字命令。")}</Text>
        <details><summary>{tr("更新应用 Secret")}</summary>
          <Field label={tr("新 Secret（留空保持原值）")} htmlFor="new-secret"><TextField.Root id="new-secret" type="password" autoComplete="new-password" maxLength={256} value={draft.newSecret} onChange={e => edit('newSecret', e.target.value)} /></Field>
          <Text as="p" size="1" color="gray">{tr("仅写入本机配置，页面不会读取或显示原凭据。")}</Text>
        </details>
      </section>
    </fieldset>
    <div className="save-bar"><Text as="p" size="2" color="gray">{dirty ? tr("有未保存修改。") : tr("保存后单独应用，服务才会使用新配置。")}</Text>
      {dirty && <ConfirmButton title={tr("放弃未保存的修改？")} description={tr("页面将载入当前已保存配置，尚未保存的草稿会被丢弃。")} action={tr("放弃修改")} disabled={saving}
        onConfirm={async () => { const latest = await api.state(); reset(latest.config); await refresh(); }}><Icon name="reset" />{tr("放弃修改")}</ConfirmButton>}
      <Button type="submit" loading={saving}><Icon name="save" />{tr("保存配置")}</Button>
      <ConfirmButton title={tr("应用已保存配置？")} description={tr("这会重启接收服务，仅在队列空闲时执行。已有配置和历史数据会保留。")} action={tr("确认应用")}
        disabled={dirty || saving || !recoveryAvailable} onConfirm={async () => { const result = await api.apply(revision); notify(result.message, !result.ready); await refresh(); }}><Icon name="play" />{tr("应用已保存配置")}</ConfirmButton>
    </div>
  </form>;
}
