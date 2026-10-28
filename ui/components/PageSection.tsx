import { useId, type ReactNode } from 'react';
import { Heading, Text } from '@radix-ui/themes';
import { Icon, type IconName } from '../Icon';

export function SectionHeading({ icon, title, description, action, id }: {
  icon: IconName; title: string; description?: string; action?: ReactNode; id?: string;
}) {
  return <div className="panel-heading"><span className="panel-icon"><Icon name={icon} size={20} /></span>
    <div className="panel-heading-copy"><Heading as="h2" size="4" id={id}>{title}</Heading>
      {description && <Text as="p" size="2" color="gray">{description}</Text>}</div>
    {action && <div className="panel-heading-action">{action}</div>}
  </div>;
}
export function PageSection({ children, className = '', ...heading }: {
  icon: IconName; title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  const id = useId();
  return <section className={`page-panel ${className}`} aria-labelledby={id}>
    <SectionHeading {...heading} id={id} />{children}
  </section>;
}
export function EmptyState({ icon, title, description }: { icon: IconName; title: string; description?: string }) {
  return <div className="list-empty"><span className="empty-icon"><Icon name={icon} size={24} /></span>
    <Heading as="h3" size="3">{title}</Heading>{description && <Text as="p" size="2" color="gray">{description}</Text>}
  </div>;
}
