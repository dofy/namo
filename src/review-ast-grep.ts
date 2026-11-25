import { extname } from 'node:path';

export const REVIEW_AST_MAX_BYTES = 64_000;
const maxMatches = 30;
const languages = new Map<string, 'JavaScript' | 'TypeScript' | 'Tsx'>([
  ['.js', 'JavaScript'], ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'], ['.jsx', 'JavaScript'],
  ['.ts', 'TypeScript'], ['.mts', 'TypeScript'], ['.cts', 'TypeScript'], ['.tsx', 'Tsx'],
]);

export function reviewAstPattern(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || value.includes('\0'))
    throw Error('github_review_ast_pattern_invalid');
  if (!languages.has(extname(path).toLowerCase())) throw Error('github_review_ast_language_unsupported');
  return value;
}

export async function scanReviewSource(path: string, source: string, pattern: string) {
  const checkedPattern = reviewAstPattern(pattern, path);
  if (Buffer.byteLength(source) > REVIEW_AST_MAX_BYTES) throw Error('github_review_ast_source_too_large');
  const language = languages.get(extname(path).toLowerCase())!;
  const { Lang, parse } = await import('@ast-grep/napi');
  const root = parse(Lang[language], source).root();
  try {
    const matches = root.findAll(checkedPattern);
    return { pattern: checkedPattern, totalMatches: matches.length, truncated: matches.length > maxMatches,
      matches: matches.slice(0, maxMatches).map(node => {
        const { start, end } = node.range();
        return { line: start.line + 1, column: start.column + 1,
          endLine: Math.max(start.line, end.line - (end.column === 0 ? 1 : 0)) + 1 };
      }) };
  } catch { throw Error('github_review_ast_pattern_invalid'); }
}
