import { Button } from '@radix-ui/themes';
import { Monitor, Moon, Sun } from 'lucide-react';
import { t as tr } from './i18n';
import { setThemePreference, useThemePreference, type ThemePreference } from './theme';

export function ThemeSwitch() {
  const selected=useThemePreference();
  const options:{value:ThemePreference;label:string;icon:typeof Sun}[]=[
    {value:'auto',label:tr('theme.auto'),icon:Monitor},
    {value:'light',label:tr('theme.light'),icon:Sun},
    {value:'dark',label:tr('theme.dark'),icon:Moon},
  ];
  return <div className="theme-switch" role="group" aria-label={tr('theme.title')}>
    {options.map(({value,label,icon:Icon})=><Button key={value} type="button" variant="ghost" className="theme-switch-option" aria-pressed={selected===value} aria-label={label} title={label} onClick={event=>{const bounds=event.currentTarget.getBoundingClientRect();setThemePreference(value,{x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2});}}><Icon size={16} aria-hidden="true"/><span>{label}</span></Button>)}
  </div>;
}
