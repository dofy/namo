import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { THEME_COOKIE, parseThemePreference, resolveThemePreference, type Appearance, type ThemePreference } from '../src/theme-contract';

export type { ThemePreference } from '../src/theme-contract';
function read():ThemePreference {
  try {const value=document.cookie.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${THEME_COOKIE}=`))?.slice(THEME_COOKIE.length+1);return parseThemePreference(value);}
  catch {return 'auto';}
}
const systemDark=window.matchMedia('(prefers-color-scheme: dark)');
let preference=read();
let appearance:Appearance=resolveThemePreference(preference,systemDark.matches);
const listeners=new Set<()=>void>();
const apply=()=>{appearance=resolveThemePreference(preference,systemDark.matches);document.documentElement.dataset.theme=appearance;for(const listener of listeners)listener();};
apply();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);};
export const useAppearance=()=>useSyncExternalStore(subscribe,()=>appearance,()=> 'light' as Appearance);
export const useThemePreference=()=>useSyncExternalStore(subscribe,()=>preference,()=> 'auto' as ThemePreference);
systemDark.addEventListener('change',()=>{if(preference==='auto')apply();});
window.addEventListener('focus',()=>{const next=read();if(next!==preference){preference=next;apply();}});
let transitioning=false;
export function setThemePreference(next:ThemePreference,origin?:{x:number;y:number}) {
  if(next===preference||transitioning)return;
  const nextAppearance=resolveThemePreference(next,systemDark.matches);
  const update=()=>{preference=next;try{document.cookie=`${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;}catch{/* Session-only preference. */}apply();};
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(nextAppearance===appearance||reduced||typeof document.startViewTransition!=='function'){update();return;}
  const x=origin?.x??innerWidth/2,y=origin?.y??innerHeight/2;
  const radius=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y));
  transitioning=true;
  try {
    const transition=document.startViewTransition(()=>flushSync(update));
    void transition.ready.then(()=>{document.documentElement.animate({clipPath:[`circle(0px at ${x}px ${y}px)`,`circle(${radius}px at ${x}px ${y}px)`]}, {duration:520,easing:'cubic-bezier(0.76, 0, 0.24, 1)',pseudoElement:'::view-transition-new(root)'});}).catch(()=>{});
    void transition.finished.finally(()=>{transitioning=false;}).catch(()=>{});
  } catch {transitioning=false;update();}
}
