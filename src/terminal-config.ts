import { createServer } from 'node:http';
import { Management } from './management.js';
import { McpOAuthFlow } from './mcp-oauth-flow.js';
import { beginMcpOAuth } from './mcp-oauth.js';
import type { Prompter } from './prompts.js';
import type { ConfigView, McpConnectionPatch } from './ui-contract.js';
import { editExecution, editDirectories, editFeishu, editGitHub, editAccess, editAssistantMenu, editProfiles, manageUpdates } from './terminal-settings.js';
import { t } from './locale.js';
import { Back, type ConfigPrompter } from './config-prompts.js';

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
        {value:'7',label:t('terminal.menuAccess')}, {value:'8',label:t('terminal.menuAssistant')},
        {value:'9',label:t('terminal.menuProfiles')}, {value:'10',label:t('terminal.menuUpdate')},
        {value:'0',label:t('terminal.exit')}
      ]);
      if (choice === '0') return;
      inMenu = false;
      ui.screen?.();
      if (choice === '1') {
        notice=t(await editExecution(manager,ui,view)?'terminal.saved':'terminal.cancelled');
      } else if (choice === '2') {
        notice=t(await editDirectories(manager,ui,view)?'terminal.saved':'terminal.cancelled');
      } else if (choice === '3') {
        notice=t(await editFeishu(manager,ui,view)?'terminal.saved':'terminal.cancelled');
      } else if (choice === '4') {
        notice=t(await editGitHub(manager,ui,view)?'terminal.saved':'terminal.cancelled');
      } else if (choice === '5') {
        notice=await (await import('./terminal-mcp.js')).manageMcp(manager,ui);
      } else if (choice === '6') {
        notice = t('terminal.loginHelp');
      } else if (choice === '7') {
        if(await editAccess(manager,ui,view))notice=t('terminal.saved');
      } else if (choice === '8') {
        notice=await editAssistantMenu(manager,ui);
      } else if (choice === '9') {
        if(await editProfiles(manager,ui))notice=t('terminal.saved');
      } else if (choice === '10') {
        notice=await manageUpdates(manager,ui,view);
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
