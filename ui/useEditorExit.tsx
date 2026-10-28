import {useEffect,useRef,useState} from 'react';
import {AlertDialog,Button,Flex} from '@radix-ui/themes';
import {EditorCloseButton,Notice} from './components';
import {message} from './api';
import {t as tr} from './i18n';

/** One exit path for close, cancel, Escape and outside clicks. */
export function useEditorExit({open,dirty,busy,onClose,description}:{open:boolean;dirty:boolean;busy:boolean;onClose:()=>void|Promise<void>;description?:string}) {
 const [confirm,setConfirm]=useState(false),[closing,setClosing]=useState(false),[error,setError]=useState('');
 const pending=useRef(false);
 const blocked=busy||closing;
 useEffect(()=>{if(!open){setConfirm(false);setError('');}},[open]);
 useEffect(()=>{
  if(!open||!dirty&&!blocked)return;
  const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};
  window.addEventListener('beforeunload',warn);
  return()=>window.removeEventListener('beforeunload',warn);
 },[open,dirty,blocked]);
 const finish=async()=>{
  if(busy||pending.current)return;
  pending.current=true;setClosing(true);setError('');
  try{await onClose();setConfirm(false);}catch(e){setError(message(e));setConfirm(true);}
  finally{pending.current=false;setClosing(false);}
 };
 const requestClose=()=>{if(!open||blocked||pending.current)return;if(dirty){setError('');setConfirm(true);}else void finish();};
 const confirmation=<AlertDialog.Root open={open&&confirm} onOpenChange={value=>{if(!blocked)setConfirm(value);}}>
  <AlertDialog.Content maxWidth="460px" onEscapeKeyDown={e=>{if(blocked)e.preventDefault();}}>
   <div className="editor-dialog-header"><AlertDialog.Title>{tr('editor.discardTitle')}</AlertDialog.Title><EditorCloseButton busy={blocked} onClose={()=>setConfirm(false)}/></div>
   <AlertDialog.Description size="2">{description??tr('editor.discardHelp')}</AlertDialog.Description>
   {error&&<Notice error>{error}</Notice>}
   <Flex gap="3" justify="end" mt="5" wrap="wrap">
    <AlertDialog.Cancel><Button type="button" variant="soft" color="gray" disabled={blocked}>{tr('editor.continueEditing')}</Button></AlertDialog.Cancel>
    <Button type="button" color="red" disabled={busy} loading={closing} onClick={()=>void finish()}>{tr('editor.discard')}</Button>
   </Flex>
  </AlertDialog.Content>
 </AlertDialog.Root>;
 return {requestClose,confirmation,blocked};
}
