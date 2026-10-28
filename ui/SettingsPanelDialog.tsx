import {useState,type ReactNode} from 'react';
import {Button,Dialog,Flex,Heading,Text} from '@radix-ui/themes';
import {ConfirmButton,EditorCloseButton} from './components';
import {t as tr} from './i18n';

/** Independent configuration panels share discard protection and local actions. */
export function SettingsPanelDialog({title,summary,disabled,children}:{title:string;summary:string;disabled:boolean;children:(controls:{onStateChange:(dirty:boolean,busy:boolean)=>void;cancelControl:ReactNode})=>ReactNode}) {
 const [open,setOpen]=useState(false),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false);
 const close=()=>{setOpen(false);setDirty(false);};
 const cancelControl=dirty?<ConfirmButton disabled={busy} title={tr('editor.discardTitle')} description={tr('editor.discardHelp')} action={tr('editor.discard')} onConfirm={async()=>close()}>{tr('mcp.cancelEdit')}</ConfirmButton>:<Button type="button" variant="soft" color="gray" disabled={busy} onClick={close}>{tr('common.close')}</Button>;
 return <section className="form-section"><Flex justify="between" align="center" gap="3" wrap="wrap"><div><Heading as="h2" size="5">{title}</Heading><Text as="p" size="2" color="gray">{summary}</Text></div><Button type="button" variant="soft" disabled={disabled} onClick={()=>{setDirty(false);setBusy(false);setOpen(true);}}>{tr('mcp.edit')}</Button></Flex>
 <Dialog.Root open={open} onOpenChange={next=>{if(!next&&!busy&&!dirty)close();}}><Dialog.Content maxWidth="760px" className="settings-panel-editor" onEscapeKeyDown={e=>{if(busy||dirty)e.preventDefault();}} onPointerDownOutside={e=>{if(busy||dirty)e.preventDefault();}}><div className="editor-dialog-header"><Dialog.Title>{title}</Dialog.Title><EditorCloseButton dirty={dirty} busy={busy} onClose={close}/></div><Dialog.Description size="2" color="gray">{summary}</Dialog.Description>{open&&children({onStateChange:(nextDirty,nextBusy)=>{setDirty(nextDirty);setBusy(nextBusy);},cancelControl})}</Dialog.Content></Dialog.Root></section>;
}
