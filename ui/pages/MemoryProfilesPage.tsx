import { useEffect, useState } from 'react';
import { Tabs } from '@radix-ui/themes';
import type { ProfileState } from '../../src/ui-contract';
import { Icon } from '../Icon';
import { t as tr } from '../i18n';
import { MemoryPage } from './MemoryPage';
import { ProfilesPage } from './ProfilesPage';

type MemoryTab = 'memory' | 'profiles';

export function MemoryProfilesPage({ active, tab, onTabChange, profiles, expired, recoveryAvailable, refresh }: {
  active: boolean;
  tab: MemoryTab;
  onTabChange: (tab: MemoryTab) => void;
  profiles: ProfileState;
  expired: boolean;
  recoveryAvailable: boolean;
  refresh: () => Promise<unknown>;
}) {
  const memoryActive = active && tab === 'memory';
  const [memoryVisited, setMemoryVisited] = useState(memoryActive);
  useEffect(() => { if (memoryActive) setMemoryVisited(true); }, [memoryActive]);

  return <Tabs.Root className="memory-profiles-page" value={tab} onValueChange={value => onTabChange(value as MemoryTab)}>
    <Tabs.List aria-label={tr("nav.memoryProfiles")}>
      <Tabs.Trigger value="memory"><Icon name="memory" />{tr("nav.longTermMemory")}</Tabs.Trigger>
      <Tabs.Trigger value="profiles"><Icon name="profiles" />{tr("nav.profiles")}</Tabs.Trigger>
    </Tabs.List>
    {/* Keep drafts mounted across tabs; load memories only after their first visit. */}
    <Tabs.Content value="memory" forceMount hidden={tab !== 'memory'} className="memory-profiles-panel">
      {(memoryVisited || memoryActive) && <MemoryPage active={memoryActive} editable={!expired && recoveryAvailable}
        unavailableReason={!recoveryAvailable ? tr("memory.initializeDatabase") : undefined} />}
    </Tabs.Content>
    <Tabs.Content value="profiles" forceMount hidden={tab !== 'profiles'} className="memory-profiles-panel">
      <ProfilesPage profiles={profiles} expired={expired} refresh={refresh} />
    </Tabs.Content>
  </Tabs.Root>;
}
