import { useId } from 'react';
import { Icon, type IconName } from '../Icon';
import { t as tr } from '../i18n';

/** One focusable control: the whole card toggles, with a named and described state. */
export function SettingToggle({ icon, title, description, checked, disabled, onChange }: {
  icon: IconName; title: string; description: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return <button type="button" role="switch" className="setting-option" aria-checked={checked}
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="setting-option-icon"><Icon name={icon} size={22} /></span>
    <span className="setting-option-status" aria-hidden="true">
      <span>{tr(checked ? 'settings.messageOptionEnabled' : 'settings.messageOptionDisabled')}</span>
      <span className="setting-option-switch" />
    </span>
    <span className="setting-option-title" id={`${id}-title`}>{title}</span>
    <span className="setting-option-description" id={`${id}-description`}>{description}</span>
  </button>;
}
