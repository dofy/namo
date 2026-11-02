import { useId } from 'react';
import { Book, BookUser, Calendar, CalendarClock, Circle, NotebookText } from 'lucide-react';
import { Icon, type IconName } from '../Icon';

/** Lucide's open strokes cannot be filled directly. Use its closed silhouettes
 * and original strokes as a mask, so details remain transparent on any surface. */
export function PageWatermark({ name }: { name: IconName }) {
  const id = `page-watermark-${useId().replaceAll(':', '')}`;
  if (name !== 'schedules' && name !== 'memory' && name !== 'changelog') return <Icon name={name} size={24} />;
  const mask = { size: 24, stroke: 'black', fill: 'none', strokeWidth: 1.7 };
  const solid = { size: 24, stroke: 'currentColor', fill: 'currentColor', strokeWidth: 1.7 };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
      <rect x="0" y="0" width="24" height="24" fill="white" stroke="none" />
      {name === 'schedules' ? <CalendarClock {...mask} /> : name === 'memory' ? <BookUser {...mask} /> : <NotebookText {...mask} />}
    </mask>
    <g mask={`url(#${id})`}>
      {name === 'schedules' ? <><Calendar {...solid} /><Circle x={10} y={10} size={12} stroke="currentColor" fill="currentColor" strokeWidth={1.7} /></>
        : name === 'memory' ? <Book {...solid} /> : <NotebookText {...solid} />}
    </g>
  </svg>;
}
