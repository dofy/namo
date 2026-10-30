import { t as tr } from './i18n';
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@radix-ui/themes';
import '@radix-ui/themes/tokens/base.css';
import '@radix-ui/themes/tokens/colors/orange.css';
import '@radix-ui/themes/tokens/colors/slate.css';
import '@radix-ui/themes/tokens/colors/red.css';
import '@radix-ui/themes/tokens/colors/green.css';
import '@radix-ui/themes/tokens/colors/blue.css';
import '@radix-ui/themes/components.css';
import '@radix-ui/themes/utilities.css';
import './styles.css';
import { App } from './App';
import { api, message } from './api';
import { Notice } from './components';
import { useAppearance } from './theme';

// Radix's scroll-lock stylesheet reads get-nonce's standard global. Authorize
// that stylesheet without enabling arbitrary inline scripts or styles.
(window as Window & { __webpack_nonce__?: string }).__webpack_nonce__ = document.querySelector<HTMLMetaElement>('meta[name="namo-style-nonce"]')?.content;

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="startup-error"><Notice error>{tr("app.pageCouldNotLoadRefreshCloseWorkbench")}</Notice></main> : this.props.children; }
}
function AppTheme({children}:{children:ReactNode}) {
  const appearance=useAppearance();
  return <Theme accentColor="orange" grayColor="slate" radius="medium" appearance={appearance}>{children}</Theme>;
}
// Exchange the single-use bootstrap before React mounts, including StrictMode's
// extra development effect cycle. Never persist the token or put it in logs.
async function boot() {
  let code = location.hash.slice(1); history.replaceState(null, '', location.pathname + location.search);
  let initial, startupError;
  try { if (code) await api.session(code); initial = await api.state(); } catch (e) { startupError = message(e); } finally { code = ''; }
  createRoot(document.getElementById('root')!).render(<StrictMode><AppTheme>
    <ErrorBoundary><App initial={initial} startupError={startupError} /></ErrorBoundary>
  </AppTheme></StrictMode>);
}
void boot();
