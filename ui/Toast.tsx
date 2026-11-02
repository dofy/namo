import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@radix-ui/themes';
import { Icon } from './Icon';
import { t as tr } from './i18n';

type ToastMessage = { id: number; text: string; error: boolean };
type Notify = (text: string, error?: boolean) => void;
const ToastContext = createContext<Notify>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);
  const notify = useCallback<Notify>((text, error = false) => {
    setMessages(current => [...current.slice(-3), { id: ++nextId.current, text, error }]);
  }, []);
  const dismiss = useCallback((id: number) => setMessages(current => current.filter(item => item.id !== id)), []);
  return <ToastContext.Provider value={notify}>{children}
    <div className="toast-viewport" aria-label={tr('toast.notifications')}>
      {messages.map(item => <ToastItem key={item.id} item={item} dismiss={dismiss} />)}
    </div>
  </ToastContext.Provider>;
}
function ToastItem({ item, dismiss }: { item: ToastMessage; dismiss: (id: number) => void }) {
  useEffect(() => {
    if (item.error) return;
    const timer = window.setTimeout(() => dismiss(item.id), 5000);
    return () => window.clearTimeout(timer);
  }, [item, dismiss]);
  return <div className="toast-message" data-error={item.error} role={item.error ? 'alert' : 'status'}>
    <Icon name={item.error ? 'info' : 'check'} size={18} /><span>{item.text}</span>
    <Button type="button" variant="ghost" color="gray" aria-label={tr('common.close')} onClick={() => dismiss(item.id)}><Icon name="close" /></Button>
  </div>;
}
export const useToast = () => useContext(ToastContext);
