import { t as tr } from './i18n';
import { useState, type ReactNode } from 'react';
import { AlertDialog, Badge, Button, Callout, Flex, Select, Text } from '@radix-ui/themes';
import { message } from './api';
import { Icon } from './Icon';

const labels = (): Record<string, string> => ({
  queued: tr("common.queued"), running: tr("status.running"), waiting: tr("common.waitingInput"), succeeded: tr("status.completed"), failed: tr("common.failed"), cancelled: tr("common.cancelled"),
  interrupted: tr("common.interrupted"), needs_attention: tr("common.needsReview"), unknown: tr("components.deliveryUnknown"), sent: tr("components.acceptedPlatform"),
  confirmed: tr("components.receiptConfirmedManually"), dismissed: tr("components.deliveryDismissed"), pending: tr("components.pendingDelivery"), sending: tr("components.sending"),
  deferred: tr("components.noticePending"), suppressed: tr("components.outdatedNoticeOmitted"), idle: tr("common.idle"),
});
export const statusLabel = (state: string) => labels()[state] ?? state;
export function StatusBadge({ state }: { state: string }) {
  const color = state === 'succeeded' || state === 'sent' || state === 'confirmed' ? 'green'
    : state === 'running' || state === 'sending' ? 'blue'
      : ['failed', 'interrupted', 'needs_attention', 'unknown'].includes(state) ? 'orange' : 'gray';
  return <Badge color={color} variant="soft">{statusLabel(state)}</Badge>;
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <Callout.Root color={error ? 'red' : 'orange'} role={error ? 'alert' : 'status'} className="notice">
    <Callout.Text>{children}</Callout.Text>
  </Callout.Root>;
}
export function Field({ label, htmlFor, children, className = '' }: { label: string; htmlFor: string; children: ReactNode; className?: string }) {
  return <div className={`field ${className}`}><Text as="label" htmlFor={htmlFor} size="2" weight="medium">{label}</Text>{children}</div>;
}
export function Choice({ id, value, onChange, options, disabled }: {
  id: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; disabled?: boolean;
}) {
  // Empty values mean "all" in filters; Radix reserves the empty item value.
  // Encode every value so real IDs cannot collide with an ad-hoc sentinel.
  const encode = (option: string) => `option:${option}`;
  return <Select.Root value={encode(value)} onValueChange={next => onChange(next.slice(7))} disabled={disabled}>
    <Select.Trigger id={id} className="choice" />
    <Select.Content position="popper">{options.map(option => <Select.Item key={option.value} value={encode(option.value)}>{option.label}</Select.Item>)}</Select.Content>
  </Select.Root>;
}
export function ConfirmButton({ children, title, description, action = tr("components.confirm"), onConfirm, disabled = false, danger = false, variant = 'soft', className }: {
  children: ReactNode; title: string; description: string; action?: string; onConfirm: () => Promise<void>;
  disabled?: boolean; danger?: boolean; variant?: 'solid' | 'soft' | 'outline'; className?:string;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <AlertDialog.Root open={open} onOpenChange={next => { if (!busy) { setOpen(next); setError(''); } }}>
    <AlertDialog.Trigger><Button type="button" className={className} variant={variant} color={danger ? 'red' : undefined} disabled={disabled}>{children}</Button></AlertDialog.Trigger>
    <AlertDialog.Content maxWidth="460px" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      <AlertDialog.Description size="2">{description}</AlertDialog.Description>
      {error && <Notice error>{error}</Notice>}
      <Flex gap="3" justify="end" mt="5">
        <AlertDialog.Cancel><Button variant="soft" color="gray" disabled={busy}>{tr("components.back")}</Button></AlertDialog.Cancel>
        <Button color={danger ? 'red' : undefined} loading={busy} onClick={async () => {
          if (busy) return;
          setBusy(true); setError('');
          try { await onConfirm(); setOpen(false); } catch (e) { setError(message(e)); } finally { setBusy(false); }
        }}>{action}</Button>
      </Flex>
    </AlertDialog.Content>
  </AlertDialog.Root>;
}

export function EditorCloseButton({dirty,busy,onClose}:{dirty:boolean;busy:boolean;onClose:()=>void|Promise<void>}) {
  const label=<><Icon name="close" />{tr('common.close')}</>;
  return dirty?<ConfirmButton className="editor-close" disabled={busy} title={tr('editor.discardTitle')} description={tr('editor.discardHelp')} action={tr('editor.discard')} onConfirm={async()=>{await onClose();}}>{label}</ConfirmButton>
    :<Button type="button" className="editor-close" variant="soft" color="gray" disabled={busy} onClick={()=>{void onClose();}}>{label}</Button>;
}
