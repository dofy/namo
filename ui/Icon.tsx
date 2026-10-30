import {
  AtSign, PanelsTopLeft, Smile, Activity, BookUser, Bot, CalendarClock, ChevronLeft, ChevronRight, CircleCheck, Info,
  ClipboardCheck, ExternalLink, Funnel, LayoutDashboard, MessageSquare, ScrollText,
  Play, Plug, Plus, RotateCcw, RotateCw, Save, SlidersHorizontal, Square,
  Trash2, UserRound, X, Search, type LucideIcon,
} from 'lucide-react';

// Keep UI intent separate from library names, and import only the icons we use.
const icons = {
  mention: AtSign,
  cards: PanelsTopLeft,
  reaction: Smile,
  info: Info,
  external: ExternalLink,
  dashboard: LayoutDashboard,
  tasks: ClipboardCheck,
  schedules: CalendarClock,
  sessions: MessageSquare,
  settings: SlidersHorizontal,
  profiles: UserRound,
  assistant: Bot,
  memory: BookUser,
  connections: Plug,
  changelog: ScrollText,
  refresh: RotateCw,
  filter: Funnel,
  reset: RotateCcw,
  search: Search,
  left: ChevronLeft,
  right: ChevronRight,
  save: Save,
  plus: Plus,
  check: CircleCheck,
  close: X,
  stop: Square,
  play: Play,
  activity: Activity,
  trash: Trash2,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Glyph = icons[name];
  return <Glyph className="ui-icon" size={size} strokeWidth={1.7} aria-hidden="true" focusable="false" />;
}
