import {useState,type ReactNode} from 'react';
import {Button,Dialog} from '@radix-ui/themes';
import {SectionHeading} from './components/PageSection';
import type {IconName} from './Icon';
import {EditorCloseButton} from './components';
import {useEditorExit} from './useEditorExit';
import {t as tr} from './i18n';

/** Independent configuration panels share discard protection and local actions. */
export function SettingsPanelDialog({title,summary,disabled,children,icon='settings'}:{icon?:IconName;title:string;summary:string;disabled:boolean;children:(controls:{onStateChange:(dirty:boolean,busy:boolean)=>void;cancelControl:ReactNode})=>ReactNode}) {
 const [open,setOpen]=useState(false),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false);
 const close=()=>{setOpen(false);setDirty(false);};
 const exit=useEditorExit({open,dirty:open&&dirty,busy:open&&busy,onClose:close});
 const cancelControl=<Button type="button" variant="soft" color="gray" disabled={exit.blocked} onClick={exit.requestClose}>{tr('mcp.cancelEdit')}</Button>;
 return <section className="page-panel connection-setting"><SectionHeading icon={icon} title={title} description={summary} action={<Button type="button" variant="soft" disabled={disabled} onClick={()=>{setDirty(false);setBusy(false);setOpen(true);}}>{tr('mcp.edit')}</Button>}/>

 <Dialog.Root open={open} onOpenChange={next=>{if(!next)exit.requestClose();}}><Dialog.Content maxWidth="760px" className="settings-panel-editor" onEscapeKeyDown={e=>{if(exit.blocked)e.preventDefault();}} onPointerDownOutside={e=>{if(exit.blocked)e.preventDefault();}}><div className="editor-dialog-header"><Dialog.Title>{title}</Dialog.Title><EditorCloseButton busy={exit.blocked} onClose={exit.requestClose}/></div><Dialog.Description size="2" color="gray">{summary}</Dialog.Description>{exit.confirmation}{open&&children({onStateChange:(nextDirty,nextBusy)=>{setDirty(nextDirty);setBusy(nextBusy);},cancelControl})}</Dialog.Content></Dialog.Root></section>;
}
