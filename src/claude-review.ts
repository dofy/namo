import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { evidenceItem } from './evidence.js';
import { parseReviewArguments, PR_REVIEW_INSTRUCTIONS, PR_REVIEW_TOOL } from './github-review.js';
import type { RunRequest } from './runtime-contract.js';

const serverName = 'namo_review';
export const CLAUDE_REVIEW_TOOL = `mcp__${serverName}__${PR_REVIEW_TOOL.name}`;

export function explicitReviewUrl(text: string): string | undefined {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+(?=$|[\s/<>()[\]`.,!?;，。；、：！？])/g)) {
    const url = match[0];
    try { parseReviewArguments({ url }); urls.add(url); } catch { /* Ignore invalid targets. */ }
  }
  if (urls.size !== 1) return;
  const url = urls.values().next().value!;
  if (/\breview\b|审查|评审|审阅|审一下|看看|看一下|分析/iu.test(text.replaceAll(url, ''))) return url;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw Error('github_review_request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function openClaudeReview(dataDir: string, url: string, run: RunRequest) {
  const review = run.onReview;
  if (!review) throw Error('github_review_unavailable');
  parseReviewArguments({ url });
  const [{ Server }, { StreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'), import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const directory = await mkdtemp(join(dataDir, '.claude-pr-'));
  const configFile = join(directory, 'mcp.json');
  const token = randomBytes(32).toString('hex'), authorization = Buffer.from(`Bearer ${token}`);
  const lifetime = new AbortController(), signal = AbortSignal.any([run.signal, lifetime.signal]);
  let active = false, count = 0, successes = 0, port: number;

  const call = async (name: string, args: Record<string, unknown> | undefined) => {
    let evidence: ReturnType<typeof evidenceItem>;
    try {
      if (name !== PR_REVIEW_TOOL.name || args?.url !== url) throw Error('github_review_target_mismatch');
      if (signal.aborted || active || ++count > 300) throw Error('github_review_unavailable');
      active = true;
      try {
        evidence = evidenceItem({ id: randomUUID(), type: 'dynamicToolCall', tool: 'read_pull_request', status: 'inProgress' });
        if (evidence) run.onEvidence?.(evidence);
        const result = await review(args, signal);
        if (signal.aborted) throw Error('github_review_unavailable');
        if (evidence) run.onEvidence?.({ ...evidence, status: 'completed' });
        successes++;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } finally { active = false; }
    } catch (error) {
      if (evidence && !signal.aborted) run.onEvidence?.({ ...evidence, status: 'failed' });
      const code = error instanceof Error && /^github_[a-z_]+$/.test(error.message) ? error.message : 'github_review_unavailable';
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] };
    }
  };

  const listener = createServer({ requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 }, (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (signal.aborted || request.url !== '/review' || request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${port}`
      || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    void (async () => {
      const body = await readBody(request);
      if (signal.aborted || Array.isArray(body)) { response.writeHead(400).end(); return; }
      const server = new Server({ name: serverName, version: '1' }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: PR_REVIEW_TOOL.name,
        description: PR_REVIEW_TOOL.description, inputSchema: PR_REVIEW_TOOL.inputSchema }] }));
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => call(params.name, params.arguments));
      response.on('close', () => { void server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    })().catch(() => { if (!response.headersSent && !response.destroyed) response.writeHead(400).end(); });
  });
  const close = async () => {
    lifetime.abort();
    listener.closeAllConnections();
    if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve(); });
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw Error('github_review_unavailable');
    port = address.port;
    await writeFile(configFile, JSON.stringify({ mcpServers: { [serverName]: { type: 'http',
      url: `http://127.0.0.1:${port}/review`, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600, flag: 'wx' });
    const instructions = `${PR_REVIEW_INSTRUCTIONS.replaceAll(PR_REVIEW_TOOL.name, CLAUDE_REVIEW_TOOL)}\n本轮允许读取的 PR 是 ${url}。本轮只在飞书提供审查结果。`;
    return { configFile, instructions, close, ready: () => successes > 0 };
  } catch (error) { await close(); throw error; }
}
