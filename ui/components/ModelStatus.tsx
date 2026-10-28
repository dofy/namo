import { Text } from '@radix-ui/themes';
import type { ConfigView } from '../../src/ui-contract';
import { t as tr } from '../i18n';

/** Report saved choices, never the draft or a recommendation from model/list. */
export function ModelStatus({config,personal}:{config:ConfigView;personal:string}) {
  const active=config.application==='applied'?config.activeModelDefault:undefined;
  const known=!!active;
  const model=known?(personal||active.model||tr('model.codexDefault')):tr('model.unconfirmed');
  const source=known?(personal?tr('model.sourcePersonal'):active.profile!=='codex'?tr('model.sourceProfile',active.profile):active.model?tr('model.serviceDefault'):tr('model.codexDefault')):tr('model.unconfirmed');
  const explanation=config.application==='pending'?tr('model.pending')
    :config.application==='stopped'?tr('model.stopped')
    :!known?tr('model.unknown')
    :!personal&&!active.model?tr('model.resolvedAtStart'):tr('model.appliesToNewTasks');
  return <div className="model-status" aria-label={tr('model.effective')}>
    <dl><div><dt>{tr('model.effective')}</dt><dd>{model}</dd></div>
      <div><dt>{tr('model.source')}</dt><dd>{source}</dd></div></dl>
    <Text as="p" size="1" color="gray">{explanation}</Text>
  </div>;
}
