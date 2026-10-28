import {useState,type ReactNode} from 'react';
import {Button,Dialog,Flex,Heading,Text} from '@radix-ui/themes';
import {EditorCloseButton} from './components';
import {useEditorExit} from './useEditorExit';
import {t as tr} from './i18n';

/** Independent configuration panels share discard protection and local actions. */
export function SettingsPanelDialog({title,summary,disabled,children}:{title:string;summary:string;disabled:boolean;children:(controls:{onStateChange:(dirty:boolean,busy:boolean)=>void;cancelControl:ReactNode})=>ReactNode}) {
 const [open,setOpen]=useState(false),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false);
 const close=()=>{setOpen(false);setDirty(false);};
 const exit=useEditorExit({open,dirty:open&&dirty,busy:open&&busy,onClose:close});
 const cancelControl=<Button type="button" variant="soft" color="gray" disabled={exit.blocked} onClick={exit.requestClose}>{tr('mcp.cancelEdit')}</Button>;
 return <section className="form-section"><Flex justify="between" align="center" gap="3" wrap="wrap"><div><Heading as="h2" size="5">{title}</Heading><Text as="p" size="2" color="gray">{summary}</Text></div><Button type="button" variant="soft" disabled={disabled} onClick={()=>{setDirty(false);setBusy(false);setOpen(true);}}>{tr('mcp.edit')}</Button></Flex>
 <Dialog.Root open={open} onOpenChange={next=>{if(!next)exit.requestClose();}}><Dialog.Content maxWidth="760px" className="settings-panel-editor" onEscapeKeyDown={e=>{if(exit.blocked)e.preventDefault();}} onPointerDownOutside={e=>{if(exit.blocked)e.preventDefault();}}><div className="editor-dialog-header"><Dialog.Title>{title}</Dialog.Title><EditorCloseButton busy={exit.blocked} onClose={exit.requestClose}/></div><Dialog.Description size="2" color="gray">{summary}</Dialog.Description>{exit.confirmation}{open&&children({onStateChange:(nextDirty,nextBusy)=>{setDirty(nextDirty);setBusy(nextBusy);},cancelControl})}</Dialog.Content></Dialog.Root></section>;
}
