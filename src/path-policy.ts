import { relative, isAbsolute, sep } from 'node:path';

export function pathsOverlap(a: string, b: string): boolean {
  const contains = (x: string, y: string) => { const r = relative(x, y); return !r || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
  return contains(a, b) || contains(b, a);
}
