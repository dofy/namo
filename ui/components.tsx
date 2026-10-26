import { t as tr } from './i18n';
import { useState, type ReactNode } from 'react';
import { AlertDialog, Badge, Button, Callout, Flex, Select, Text } from '@radix-ui/themes';
import { message } from './api';

const labels = (): Record<string, string> => ({
  queued: tr("排队中"), running: tr("执行中"), waiting: tr("等待补充"), succeeded: tr("已完成"), failed: tr("未完成"), cancelled: tr("已取消"),
  interrupted: tr("已中断"), needs_attention: tr("需要核对"), unknown: tr("发送结果不明"), sent: tr("平台已接收"),
  confirmed: tr("人工确认收到"), dismissed: tr("已放弃发送"), pending: tr("等待发送"), sending: tr("正在发送"),
  deferred: tr("等待提示"), suppressed: tr("已省略过时提示"), idle: tr("空闲"),
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
export function ConfirmButton({ children, title, description, action = tr("确认"), onConfirm, disabled = false, danger = false, variant = 'soft' }: {
  children: ReactNode; title: string; description: string; action?: string; onConfirm: () => Promise<void>;
  disabled?: boolean; danger?: boolean; variant?: 'solid' | 'soft' | 'outline';
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <AlertDialog.Root open={open} onOpenChange={next => { if (!busy) { setOpen(next); setError(''); } }}>
    <AlertDialog.Trigger><Button type="button" variant={variant} color={danger ? 'red' : undefined} disabled={disabled}>{children}</Button></AlertDialog.Trigger>
    <AlertDialog.Content maxWidth="460px" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      <AlertDialog.Description size="2">{description}</AlertDialog.Description>
      {error && <Notice error>{error}</Notice>}
      <Flex gap="3" justify="end" mt="5">
        <AlertDialog.Cancel><Button variant="soft" color="gray" disabled={busy}>{tr("返回")}</Button></AlertDialog.Cancel>
        <Button color={danger ? 'red' : undefined} loading={busy} onClick={async () => {
          if (busy) return;
          setBusy(true); setError('');
          try { await onConfirm(); setOpen(false); } catch (e) { setError(message(e)); } finally { setBusy(false); }
        }}>{action}</Button>
      </Flex>
    </AlertDialog.Content>
  </AlertDialog.Root>;
}
