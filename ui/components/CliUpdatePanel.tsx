import type { ReactNode } from 'react';
import { Button, Flex, Text } from '@radix-ui/themes';
import type { CodexUpdateStatus } from '../../src/ui-contract';
import { ConfirmButton } from '../components';
import { Icon } from '../Icon';
import { getLocale, t as tr } from '../i18n';
import { SectionHeading } from './PageSection';

export function CliUpdatePanel({ id, title, description, children }: {
  id: string; title: string; description: string; children: ReactNode;
}) {
  return <section className="page-panel" aria-labelledby={id}>
    <div className="section-title">
      <SectionHeading icon="refresh" id={id} title={title} />
    </div>
    <Text as="p" size="2" color="gray">{description}</Text>
    {children}
  </section>;
}

export function CliUpdateDetails({ version, latestLabel, statusText, check, upgrade, children }: {
  version?: Pick<CodexUpdateStatus, 'currentVersion' | 'latestVersion' | 'checkedAt'> | null;
  latestLabel: string; statusText?: string;
  check?: { loading: boolean; disabled: boolean; run: () => void };
  upgrade?: { title: string; description: string; disabled: boolean; run: () => Promise<void> };
  children?: ReactNode;
}) {
  return <>
    <div className="form-grid">
      <Text as="p" size="2">{tr('codexUpdate.current')}: <Text weight="medium">{version?.currentVersion ?? tr('codexUpdate.unknown')}</Text></Text>
      <Text as="p" size="2">{latestLabel}: <Text weight="medium">{version?.latestVersion ?? tr('codexUpdate.notChecked')}</Text></Text>
    </div>
    <Text as="p" size="1" color="gray">{tr('codexUpdate.checked')}: {version?.checkedAt ? new Date(version.checkedAt).toLocaleString(getLocale()) : tr('codexUpdate.notChecked')}</Text>
    {(statusText || check || upgrade || children) && <div className="inline-action-row cli-update-actions">
      <div>{statusText && <Text as="p" size="2" role="status">{statusText}</Text>}</div>
      {(check || upgrade || children) && <Flex gap="3" wrap="wrap">
        {check && <Button type="button" variant="soft" loading={check.loading} disabled={check.disabled} onClick={check.run}>
          <Icon name="refresh" />{tr('codexUpdate.check')}
        </Button>}
        {upgrade && <ConfirmButton title={upgrade.title} description={upgrade.description} action={tr('codexUpdate.upgrade')}
          disabled={upgrade.disabled} onConfirm={upgrade.run}><Icon name="play" />{tr('codexUpdate.upgrade')}</ConfirmButton>}
        {children}
      </Flex>}
    </div>}
  </>;
}
