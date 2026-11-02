import { createServer } from 'node:http';
import { Management } from './management.js';
import { McpOAuthFlow } from './mcp-oauth-flow.js';
import { beginMcpOAuth } from './mcp-oauth.js';
import type { Prompter } from './prompts.js';
import type { ConfigView, McpConnectionPatch } from './ui-contract.js';
import { t } from './locale.js';
import { Back, type ConfigPrompter } from './config-prompts.js';

const safeConnections = (view: ConfigView): McpConnectionPatch[] => view.mcpConnections.map(({id,type,url,oauthScope,ownerUserId}) => ({id,type,url,...(oauthScope?{oauthScope}:{}),...(ownerUserId?{ownerUserId}:{})}));

/** The callback URL contains a one-time code: read it as a secret and never print it. */
export async function terminalOAuth(manager: Management, ui: Prompter, revision: string, id: string, draft: McpConnectionPatch, begin = beginMcpOAuth, notify: (message: string) => void = message => ui.info(message)): Promise<boolean> {
  const server = createServer((_req, res) => { res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}); res.end('Return to Namo and paste this page URL into the terminal.'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw Error('oauth_listen_failed'); }
  const origin = `http://127.0.0.1:${address.port}`;
  const flow = new McpOAuthFlow(manager, () => origin, begin);
  try {
    const {url} = await flow.begin(revision,id,draft);
    ui.info(t('terminal.oauthInstructions', url));
    const answer = await ui.text(t('terminal.callback'), '', true);
    if (!answer) return false;
    let callback: URL;
    try { callback = new URL(answer); } catch { notify(t('terminal.invalidCallback')); return false; }
    if (callback.origin !== origin || callback.pathname !== '/api/mcp-oauth/callback' || callback.hash || callback.username || callback.password) { notify(t('terminal.invalidCallback')); return false; }
    const result = await flow.finish(callback.searchParams);
    notify(result ? t('terminal.saved') : t('terminal.oauthFailed', flow.failure));
    return result;
  } finally { flow.clear(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

export async function terminalConfig(manager: Management, ui: ConfigPrompter): Promise<void> {
  let notice = '';
  for (;;) {
    ui.screen?.();
    const view: ConfigView = manager.config();
    ui.info(t('terminal.summary', {applied:t('terminal.statusApplied'),pending:t('terminal.statusPending'),stopped:t('terminal.statusStopped'),unknown:t('terminal.statusUnknown')}[view.application], view.valid ? t('terminal.valid') : t('terminal.invalid'), view.values.model || t('terminal.defaultModel'), view.values.concurrency, (view.values.directories ?? []).length, view.mcpConnections.length));
    if (notice) { ui.info(notice); notice = ''; }
    let inMenu = true;
    try {
      const choice = await ui.select(t('terminal.heading'), [
        {value:'1',label:t('terminal.menuModel')}, {value:'2',label:t('terminal.menuDirectories')},
        {value:'3',label:t('terminal.menuFeishu')}, {value:'4',label:t('terminal.menuGithub')},
        {value:'5',label:t('terminal.menuMcp')}, {value:'6',label:t('terminal.menuLogin')},
        {value:'0',label:t('terminal.exit')}
      ]);
      if (choice === '0') return;
      inMenu = false;
      ui.screen?.();
      if (choice === '1') {
        const model = await ui.text(t('terminal.model'), view.values.model);
        const concurrency = Number(await ui.text(t('terminal.concurrency'), String(view.values.concurrency)));
        const timeoutMs = Number(await ui.text(t('terminal.timeout'), String(view.values.timeoutMs)));
        const networkAccess = await ui.confirm(t('terminal.network'), view.values.networkAccess);
        if (await ui.confirm(t('terminal.confirm'))) { manager.save(view.revision,{model,concurrency,timeoutMs,networkAccess}); notice = t('terminal.saved'); }
      } else if (choice === '2') {
        const paths = await ui.text(t('terminal.directories'), (view.values.directories ?? []).join(';'));
        const directories = paths.split(';').map(x=>x.trim()).filter(Boolean);
        if (await ui.confirm(t('terminal.confirm'))) { manager.save(view.revision,{directories}); notice = t('terminal.saved'); }
      } else if (choice === '3') {
        ui.info(t('terminal.feishuInfo', view.feishu.appId, view.feishu.domain, view.feishu.pairedUsers));
        const newSecret = await ui.text(t('terminal.secret'), '', true);
        const cards = await ui.confirm(t('terminal.cards'), view.values.cards);
        const requireMention = await ui.confirm(t('terminal.mention'), view.values.requireMention);
        if (await ui.confirm(t('terminal.confirm'))) { manager.save(view.revision,{...(newSecret?{newSecret}:{}),cards,requireMention}); notice = t('terminal.saved'); }
      } else if (choice === '4') {
        ui.info(t('terminal.githubInfo', view.github?.credentialSource ?? 'anonymous'));
        const source = await ui.select(t('terminal.githubSource'),[{value:'anonymous',label:t('terminal.anonymous')},{value:'gh',label:t('terminal.gh')},{value:'token',label:t('terminal.token')}]);
        if (!['anonymous','gh','token'].includes(source)) { notice = t('terminal.invalidChoice'); continue; }
        const token = source === 'token' ? await ui.text(t('terminal.githubToken'),'',true) : '';
        if (source === 'token' && !token && (!view.github?.credentialConfigured || view.github.credentialSource === 'gh')) { notice = t('terminal.tokenRequired'); continue; }
        if (source !== 'anonymous') ui.info(t('terminal.githubSharing'));
        if (await ui.confirm(t('terminal.confirm'))) {
          await manager.saveGitHub(view.revision,{github:{source,repositories:[],allowedUserIds:[],...(source==='anonymous'?{}:{mode:'shared'})},...(token?{newGithubToken:token}:{})}); notice = t('terminal.saved');
        }
      } else if (choice === '5') {
        for (const c of view.mcpConnections) ui.info(`${c.id}: ${c.url} (${c.credentialSource ?? (c.credentialConfigured?'token':'anonymous')})`);
        const id = await ui.text(t('terminal.mcpId')); if (!id) continue;
        const previous = view.mcpConnections.find(c=>c.id===id);
        const url = await ui.text(t('terminal.mcpUrl'),previous?.url ?? '');
        const oauthScope = await ui.text(t('terminal.scope'),previous?.oauthScope ?? '');
        const draft: McpConnectionPatch = {id,type:'remote',url,...(oauthScope?{oauthScope}:{})};
        const method = await ui.select(t('terminal.mcpMethod'),[{value:'oauth',label:t('terminal.oauth')},{value:'token',label:t('terminal.token')},{value:'anonymous',label:t('terminal.anonymous')}]);
        if (method === 'oauth') {
          let resultNotice = '';
          await terminalOAuth(manager,ui,view.revision,previous?.id ?? '',draft,beginMcpOAuth,message => { resultNotice = message; });
          notice = resultNotice || t('terminal.oauthIncomplete');
        }
        else if (method === 'token' || method === 'anonymous') {
          const token = method === 'token' ? await ui.text(t('terminal.mcpToken'),'',true) : '';
          if (method === 'token' && !token) { notice = t('terminal.tokenRequired'); continue; }
          if (await ui.confirm(t('terminal.confirm'))) {
            const connections = safeConnections(view).filter(c=>c.id!==id);
            connections.push({...draft,...(token?{newToken:token}:{clearToken:true})});
            manager.save(view.revision,{mcpConnections:connections}); notice = t('terminal.saved');
          }
        } else notice = t('terminal.invalidChoice');
      } else if (choice === '6') {
        notice = t('terminal.loginHelp');
      } else notice = t('terminal.invalidChoice');
    } catch (error) {
      if (error instanceof Back) { if (inMenu) return; notice = t('terminal.cancelled'); continue; }
      if (ui.signal?.aborted) throw error;
      // Errors can contain provider or credential data; expose only trusted management errors.
      const {ManagementError} = await import('./management.js');
      notice = error instanceof ManagementError ? error.message : t('terminal.failed');
    }
  }
}
