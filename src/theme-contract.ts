/** Non-sensitive workbench preference shared by the UI and OAuth pages. */
export type ThemePreference = 'auto' | 'light' | 'dark';
export type Appearance = 'light' | 'dark';
export const THEME_COOKIE = 'namo_ui_theme';
export function parseThemePreference(value:string|undefined):ThemePreference {
  return value==='light'||value==='dark'||value==='auto'?value:'auto';
}
export function resolveThemePreference(value:ThemePreference,systemDark:boolean):Appearance {
  return value==='auto'?(systemDark?'dark':'light'):value;
}
