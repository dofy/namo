import { t as tr } from '../i18n';
import { Icon } from '../Icon';
import { useState } from 'react';
import { Button, Code, Heading, Link, Text } from '@radix-ui/themes';
import type { ConfigView, Diagnostic, ProfileState } from '../../src/ui-contract';
import { api, message } from '../api';
import { Notice } from '../components';
import { GitHubSettings } from '../GitHubSettings';
import { AgentRegistrySettings } from '../components/AgentRegistrySettings';

const quote = (value: string) => "'" + value.split("'").join("'\"'\"'") + "'";
export function ConnectionsPage({ config, profiles, refresh, expired }: {
  config: ConfigView; profiles: ProfileState; refresh: () => Promise<unknown>; expired: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [checks, setChecks] = useState<Diagnostic[]>([]);
  return <>
    <div className="connection"><div><Heading as="h2" size="5">Codex</Heading><Text as="p" size="2" color="gray">{tr("官方 app-server · 独立登录环境")}</Text></div>
      <Button variant="soft" loading={busy} onClick={async () => {
        setBusy(true); setError('');
        try { setChecks(await api.diagnose()); } catch (e) { setError(message(e)); } finally { setBusy(false); }
      }}><Icon name="activity" />{tr("运行连接诊断")}</Button>
    </div>
    {error && <Notice error>{error}</Notice>}
    <div className="diagnostics" aria-live="polite">{checks.map(check => <div key={check.id}>
      <Text as="p" size="2">{check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×'} {check.message}</Text>
      {check.next && <Text as="p" size="2" color="gray">{check.next}</Text>}
    </div>)}</div>
    <div className="guide"><Heading as="h3" size="3">{tr("登录或重新授权")}</Heading>
      <Text as="p" size="2" color="gray">{tr("在本机终端运行以下命令，完成官方登录。工作台不会读取登录凭据。")}</Text>
      <Code variant="ghost">namo login --config {quote(config.file)}</Code>
      <Text as="p" size="2" color="gray">{tr("诊断只检查环境和连接，不调用模型。")}</Text>
    </div>
    <AgentRegistrySettings config={config} refresh={refresh} expired={expired} />
    <div className="connection"><div><Heading as="h2" size="5">{tr("飞书机器人")}</Heading>
      <Text as="p" size="2" color="gray">{config.feishu.appId}  {tr("· 已配对")} {config.feishu.pairedUsers}  {tr("位用户 ·")} {config.feishu.secretConfigured ? tr("凭据已配置") : tr("凭据未配置")}</Text></div>
      <Link href={config.feishu.domain === 'lark' ? 'https://open.larksuite.com/app' : 'https://open.feishu.cn/app'} target="_blank" rel="noopener noreferrer">{tr("打开飞书后台")}</Link>
    </div>
    <ol className="steps"><li>{tr("开启机器人能力，设置应用可用范围。")}</li><li>{tr("使用长连接接收消息，订阅 im.message.receive_v1。")}</li>
      <li>{tr("申请私聊接收、群 @ 接收与机器人发送消息权限，发布应用。")}</li><li>{tr("卡片按钮需额外订阅 card.action.trigger 回调。")}</li></ol>
    <div className="guide"><Heading as="h3" size="3">{tr("新增配对用户")}</Heading>
      <Text as="p" size="2" color="gray">{tr("在维护窗口停止接收服务后运行初始化向导；已有配置、授权用户和历史数据会保留。")}</Text>
      <Code variant="ghost">{'namo service stop --config ' + quote(config.file) + '\nnamo init --config ' + quote(config.file)}</Code>
      <Text as="p" size="2" color="gray">{tr("初始化不能与同一应用的在线接收端同时连接。")}</Text>
    </div>
    <GitHubSettings config={config} profiles={profiles} refresh={refresh} expired={expired} />
  </>;
}
