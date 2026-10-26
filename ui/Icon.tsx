import type { ReactNode } from 'react';

// Small shared vector set; follows the theme's current text color.
const shapes = {
  external: <><path d="M14 3h7v7M21 3 10 14" /><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  tasks: <><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="8" y="2" width="8" height="6" rx="2" /><path d="m8 14 2 2 5-5M8 19h8" /></>,
  sessions: <><path d="M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 14h7" /></>,
  settings: <><path d="M3 7h3m4 0h11M3 17h11m4 0h3" /><circle cx="8" cy="7" r="2" /><circle cx="16" cy="17" r="2" /></>,
  profiles: <><circle cx="12" cy="7" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  connections: <><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v5" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3" /></>,
  filter: <path d="M3 4h18l-7 8v7l-4 2v-9L3 4Z" />,
  reset: <><path d="M3 4v6h6" /><path d="M4 10a8 8 0 1 1 1 8" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  left: <path d="m14 6-6 6 6 6" />,
  right: <path d="m10 6 6 6-6 6" />,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M7 3v6h9V3M7 21v-7h10v7" /></>,
  plus: <path d="M12 4v16M4 12h16" />,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof shapes;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}
