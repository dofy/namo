import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { currentLocale, t as tr } from './locale.js';
import { uiRoutes } from './ui-contract.js';

const assetsRoot = new URL('../../remote-ui/', import.meta.url);
const assetPrefix = '/_namo-remote/';
const cookieName = '__Host-namo_remote';
const sessionSeconds = 12 * 60 * 60;
const attemptWindow = 60_000;
const maxAttempts = 10;
const maxLoginBody = 4096;
const pages = new Set<string>(Object.values(uiRoutes));
const localOnly = new Set(['/api/mcp-oauth-start', '/api/mcp-oauth-cancel', '/api/mcp-oauth/callback', '/oauth-preparing', '/oauth-complete']);

export type RemoteUiOptions = { origin: URL; port: number; passwordDigest: Buffer };

function passwordDigest(password: string): Buffer {
  return createHash('sha256').update(password).digest();
}

export function remoteUiOptions(address: string, passwordFile: string, port = '18789'): RemoteUiOptions {
  let origin: URL;
  try { origin = new URL(address); }
  catch { throw new Error(tr('remoteUi.invalidOrigin')); }
  if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/') throw new Error(tr('remoteUi.invalidOrigin'));
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error(tr('remoteUi.invalidPort'));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(passwordFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error();
    const bytes = Buffer.alloc(259);
    const size = readSync(descriptor, bytes);
    const password = bytes.subarray(0,size).toString('utf8').replace(/\r?\n$/, '');
    bytes.fill(0);
    if (!/^[\x21-\x7e]{32,256}$/.test(password)) throw new Error();
    return { origin, port: Number(port), passwordDigest: passwordDigest(password) };
  } catch { throw new Error(tr('remoteUi.invalidPasswordFile')); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function remoteUiGuide(): string {
  return readFileSync(new URL('../../skills/namo-remote-workbench/SKILL.md', import.meta.url), 'utf8');
}

export function createRemoteUi(options: RemoteUiOptions, uiHtml: string, uiAssets: URL) {
  const template = readFileSync(new URL('login.html', assetsRoot), 'utf8');
  const font = uiHtml.match(/href="\/assets\/(caveat-latin-500-[A-Za-z0-9_-]+\.woff2)"/);
  if (!font?.[1]) throw new Error(tr('remoteUi.assetsMissing'));
  const assets = new Map<string, [string, Buffer]>([
    [assetPrefix + 'style.css', ['text/css; charset=utf-8', readFileSync(new URL('login.css', assetsRoot))]],
    [assetPrefix + 'form.js', ['text/javascript; charset=utf-8', readFileSync(new URL('login.js', assetsRoot))]],
    [assetPrefix + 'caveat-latin-500.woff2', ['font/woff2', readFileSync(new URL('assets/' + font[1], uiAssets))]],
    [assetPrefix + 'logo.png', ['image/png', readFileSync(new URL('../../assets/namo-logo.png', import.meta.url))]],
  ]);
  const sessions = new Map<string, number>();
  let failures = 0, retryAt = 0;

  function redirect(res: ServerResponse, path: string): void {
    res.writeHead(303, { Location: path }).end();
  }

  function destination(value: string | null): string {
    if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
    const target = new URL(value, options.origin);
    return target.origin === options.origin.origin && pages.has(target.pathname) ? target.pathname + target.search : '/';
  }

  function loginPage(res: ServerResponse, next: string, status = 200, error = ''): void {
    // Placeholder values are bundled translations or URL-encoded paths.
    const values: Record<string, string> = {
      LANG: currentLocale(), TITLE: tr('remoteUi.loginTitle'), HELP: tr('remoteUi.loginHelp'),
      PASSWORD: tr('remoteUi.password'), SHOW_PASSWORD: tr('remoteUi.showPassword'), HIDE_PASSWORD: tr('remoteUi.hidePassword'),
      SUBMIT: tr('remoteUi.signIn'), NEXT_QUERY: next === '/' ? '' : '?next=' + encodeURIComponent(next),
      ERROR_NOTICE: error ? `<p id="login-error" class="notice" role="alert">${error}</p>` : '',
      PASSWORD_ERROR: status === 401 ? ' aria-invalid="true" aria-describedby="login-error"' : '',
    };
    const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => values[key]);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  }

  function cookie(res: ServerResponse, token: string, maxAge: number): void {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`);
  }

  async function form(req: IncomingMessage): Promise<URLSearchParams | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxLoginBody) { req.resume(); return; }
        chunks.push(chunk);
      }
    } catch { return; }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  // Return true only when the authenticated request may reach shared workbench routing.
  async function authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    if ((req.method === 'POST' || req.headers.origin) && req.headers.origin !== options.origin.origin ||
        req.headers['sec-fetch-site'] === 'cross-site' && (req.method !== 'GET' || req.headers['sec-fetch-mode'] !== 'navigate')) {
      send(403, { error: tr('ui.invalidRequestOrigin') });
      return false;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      send(405, { error: tr('ui.operationNotSupported') });
      return false;
    }

    if (req.method === 'GET' && path.startsWith(assetPrefix)) {
      const asset = assets.get(path);
      if (asset) res.writeHead(200, { 'Content-Type': asset[0] }).end(asset[1]);
      else send(404, { error: tr('ui.resourceNotFound') });
      return false;
    }

    const token = req.headers.cookie?.split(';').map(value => value.trim())
      .find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
    if (path === '/login') {
      const next = destination(url.searchParams.get('next'));
      if (req.method === 'GET') { loginPage(res, next); return false; }
      if (req.headers['content-type']?.split(';', 1)[0] !== 'application/x-www-form-urlencoded') {
        send(415, { error: tr('remoteUi.invalidForm') });
        return false;
      }
      const password = (await form(req))?.get('password');
      if (req.socket.destroyed) return false;
      const now = Date.now();
      if (now >= retryAt) { failures = 0; retryAt = now + attemptWindow; }
      if (failures >= maxAttempts) {
        res.setHeader('Retry-After', Math.ceil((retryAt - now) / 1000));
        loginPage(res, next, 429, tr('remoteUi.retryLater'));
      } else if (!password || !timingSafeEqual(passwordDigest(password), options.passwordDigest)) {
        failures++;
        loginPage(res, next, 401, tr('remoteUi.wrongPassword'));
      } else {
        failures = 0;
        for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
        if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
        const session = randomBytes(32).toString('hex');
        sessions.set(session, now + sessionSeconds * 1000);
        cookie(res, session, sessionSeconds);
        redirect(res, next);
      }
      return false;
    }

    if (path === '/logout') {
      if (req.method === 'POST') {
        sessions.delete(token);
        cookie(res, '', 0);
        redirect(res, '/login');
      } else send(405, { error: tr('ui.operationNotSupported') });
      return false;
    }

    const expires = sessions.get(token);
    if (!expires || expires <= Date.now()) {
      sessions.delete(token);
      if (req.method === 'GET' && pages.has(path)) {
        const next = destination(path + url.search);
        redirect(res, next === '/' ? '/login' : '/login?next=' + encodeURIComponent(next));
      } else send(401, { error: tr('remoteUi.signInRequired') });
      return false;
    }
    if (path === '/api/session') {
      send(404, { error: tr('ui.pageNotFound') });
      return false;
    }
    if (path === '/api/choose-directory') {
      send(200, { status: 'unavailable' });
      return false;
    }
    if (localOnly.has(path)) {
      send(403, { error: tr('remoteUi.localOnly') });
      return false;
    }
    return true;
  }
  return { authorize, clear: () => sessions.clear() };
}
