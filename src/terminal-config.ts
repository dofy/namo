import { createServer } from 'node:http';
import { Management } from './management.js';
import { McpOAuthFlow } from './mcp-oauth-flow.js';
import { beginMcpOAuth } from './mcp-oauth.js';
import type { Prompter } from './prompts.js';
import type { ConfigView, McpConnectionPatch } from './ui-contract.js';
import { editExecution, editDirectories, editFeishu, editGitHub, editAccess, editAssistantMenu, editProfiles, manageUpdates } from './terminal-settings.js';
import { t } from './locale.js';
import { Back, Home, parseSelectedAction, type ConfigPrompter } from './config-prompts.js';

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
  let notice = '', active:string|undefined;
  for (;;) {
    ui.screen?.();
    const view: ConfigView = manager.config();
    const values=[{applied:t('terminal.statusApplied'),pending:t('terminal.statusPending'),stopped:t('terminal.statusStopped'),unknown:t('terminal.statusUnknown')}[view.application],view.valid?t('terminal.valid'):t('terminal.invalid'),view.values.model||t('terminal.defaultModel'),String(view.values.concurrency),String((view.values.directories??[]).length),String(view.mcpConnections.length)];
    if(ui.summary)ui.summary(([['terminal.summaryService','terminal.summaryConfig'],['terminal.summaryModel','terminal.summaryConcurrency'],['terminal.summaryDirectories','terminal.summaryMcp']] as const).map((labels,index)=>labels.map((label,column)=>[t(label),values[index*2+column]] as [string,string])));
    else ui.info(t('terminal.summary',...values));
    if (notice) { ui.info(notice); notice = ''; }
    let inMenu = true;
    try {
      const selected = await ui.select(t('terminal.heading'), [
        {value:'1',label:t('terminal.menuModel')}, {value:'2',label:t('terminal.menuDirectories')},
        {value:'3',label:t('terminal.menuFeishu')}, {value:'4',label:t('terminal.menuGithub')},
        {value:'5',label:t('terminal.menuMcp')}, {value:'6',label:t('terminal.menuLogin')},
        {value:'7',label:`${t('terminal.menuAccess')}  ${t('terminal.accessShortcuts')}`,availableActions:['detect']}, {value:'8',label:`${t('terminal.menuAssistant')}  ${t('terminal.assistantShortcuts')}`,availableActions:['preview','reset']},
        {value:'9',label:t('terminal.menuProfiles')}, {value:'10',label:`${t('terminal.menuUpdate')}  ${t('terminal.updateShortcuts')}`,availableActions:['automatic','upgrade','rollback']},
        {value:'detect',label:t('terminal.detectOrg'),action:true,shortcut:'D',targeted:true,hidden:true},
        {value:'preview',label:t('terminal.assistantPreview'),action:true,shortcut:'P',targeted:true,hidden:true},
        {value:'reset',label:t('terminal.assistantReset'),action:true,shortcut:'R',targeted:true,hidden:true},
        {value:'automatic',label:t('terminal.updateAuto'),action:true,shortcut:'O',targeted:true,hidden:true},
        {value:'upgrade',label:t('terminal.updateUpgrade'),action:true,shortcut:'U',targeted:true,hidden:true},
        {value:'rollback',label:t('terminal.updateRollback'),action:true,shortcut:'B',targeted:true,hidden:true}
      ],active,'root');
      const target=parseSelectedAction(selected),choice=target?.[1]??selected;
      active=choice;
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
        if(await editAccess(manager,ui,view,target?.[0]==='detect'?'detect':'edit'))notice=t('terminal.saved');
      } else if (choice === '8') {
        notice=await editAssistantMenu(manager,ui,target?.[0]==='preview'?'preview':target?.[0]==='reset'?'reset':'edit');
      } else if (choice === '9') {
        if(await editProfiles(manager,ui))notice=t('terminal.saved');
      } else if (choice === '10') {
        notice=await manageUpdates(manager,ui,view,target?.[0]==='automatic'?'automatic':target?.[0]==='upgrade'?'upgrade':target?.[0]==='rollback'?'rollback':'check');
      } else notice = t('terminal.invalidChoice');
    } catch (error) {
      if (error instanceof Home) { notice = t('terminal.cancelled'); continue; }
      if (error instanceof Back) { if (inMenu) return; notice = t('terminal.cancelled'); continue; }
      if (ui.signal?.aborted) throw error;
      // Errors can contain provider or credential data; expose only trusted management errors.
      const {ManagementError} = await import('./management.js');
      notice = error instanceof ManagementError ? error.message : t('terminal.failed');
    }
  }
}
