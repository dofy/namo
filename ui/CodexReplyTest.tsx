import { useRef, useState } from 'react';
import { AlertDialog, Button, Callout, Flex, Text } from '@radix-ui/themes';
import type { Diagnostic } from '../src/ui-contract';
import { api, message } from './api';
import { EditorCloseButton, Notice } from './components';
import { t as tr } from './i18n';

export function CodexReplyTest({ disabled, onBusyChange, onResult }: {
  disabled: boolean; onBusyChange: (busy: boolean) => void; onResult: (checks: Diagnostic[]) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Diagnostic[] | null>(null), [error, setError] = useState('');
  const pending = useRef(false);
  const result = checks?.find(check => check.id === 'agent.inference') ?? checks?.find(check => check.status === 'fail');
  const passed = result?.status === 'ok';
  async function run() {
    if (pending.current) return;
    pending.current = true; setBusy(true); onBusyChange(true); setChecks(null); setError('');
    try { const next = await api.diagnose(true); setChecks(next); onResult(next); }
    catch (failure) { setError(message(failure)); }
    finally { pending.current = false; setBusy(false); onBusyChange(false); }
  }
  return <AlertDialog.Root open={open} onOpenChange={next => {
    if (pending.current) return;
    setOpen(next);
    if (next) { setChecks(null); setError(''); }
  }}>
    <AlertDialog.Trigger><Button type="button" disabled={disabled} variant="soft">{tr('operations.liveTest')}</Button></AlertDialog.Trigger>
    <AlertDialog.Content maxWidth="480px" onEscapeKeyDown={event => { if (pending.current) event.preventDefault(); }}>
      <div className="editor-dialog-header"><AlertDialog.Title>{tr('operations.liveTest')}</AlertDialog.Title><EditorCloseButton busy={busy} onClose={()=>setOpen(false)}/></div>
      <AlertDialog.Description size="2">{tr('operations.liveTestHelp')}</AlertDialog.Description>
      {busy && <Text as="p" size="2" mt="4" role="status" aria-live="polite">{tr('operations.liveTestRunning')}</Text>}
      {error && <Notice error>{error}</Notice>}
      {checks && <>
        <Callout.Root color={passed ? 'green' : 'red'} mt="4" role={passed ? 'status' : 'alert'}>
          <Callout.Text>{result?.message ?? tr('operations.liveTestNoResult')}</Callout.Text>
        </Callout.Root>
        {result?.next && <Text as="p" size="2" mt="2" color="gray">{result.next}</Text>}
        <details className="reply-test-details"><summary>{tr('operations.liveTestDetails')}</summary>
          <div className="diagnostics">{checks.map(check => <div key={check.id}>
            <Text as="p" size="2">{check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×'} {check.message}</Text>
            {check.next && <Text as="p" size="2" color="gray">{check.next}</Text>}
          </div>)}</div>
        </details>
      </>}
      <Flex gap="3" justify="end" mt="5">
        <AlertDialog.Cancel><Button type="button" variant="soft" color="gray" disabled={busy}>{tr(checks || error ? 'common.close' : 'components.back')}</Button></AlertDialog.Cancel>
        {!passed && <Button type="button" disabled={disabled || busy} loading={busy} onClick={() => void run()}>{tr('operations.liveTest')}</Button>}
      </Flex>
    </AlertDialog.Content>
  </AlertDialog.Root>;
}
