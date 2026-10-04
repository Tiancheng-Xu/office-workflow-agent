import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { createHandler } from '../../src/runtime/handler.ts';
import { SqliteRepository } from '../../src/runtime/sqlite.ts';
import { createBrowserExecutor } from '../../src/browser/executor.ts';
import { proposePlan } from '../../src/planner.ts';
import type { ApiReply, Run, SessionView } from '../../src/contracts.ts';
import { qaBudgets } from './qa-metadata.ts';

export type Fault = 'none' | 'dom-label' | 'duplicate-input' | 'duplicate-button' | 'same-origin-redirect' | 'cross-origin-redirect' | 'action-drift' | 'lose-receipt' | 'drop-before-effect' | 'gate-before-effect' | 'gate-after-effect' | 'delayed-receipt';
export interface Client { cookie: string; csrf: string; }
export interface Reply<T> { status: number; body: ApiReply<T>; }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export class TestApp {
  readonly secret = 'synthetic-qa-secret-never-used-in-production-2026';
  server!: Server;
  private trapServer!: Server;
  private trapOrigin = '';
  repository!: SqliteRepository;
  origin = '';
  directory = '';
  dbPath = '';
  private clockOffset = 0;
  get clock() { return Date.now() + this.clockOffset; }
  set clock(value: number) { this.clockOffset = value - Date.now(); }
  fault: Fault = 'none';
  browserLaunches = 0;
  formGets = 0;
  formPosts = 0;
  observedBrowserVersion = '';
  externalHits = 0;
  requests: { method: string; path: string; status: number }[] = [];
  private gateArrived = deferred();
  private gateReleased = deferred();
  async start(databasePath?: string) {
    process.env.PLANNER_MODE = 'rules';
    this.directory = await mkdtemp(join(tmpdir(), 'office-qa-'));
    this.dbPath = databasePath ?? join(this.directory, 'office.sqlite');
    this.repository = new SqliteRepository(this.dbPath);
    await this.repository.recoverExecuting(this.clock);
    let handler: (request: Request) => Promise<Response>;
    this.server = createServer(async (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url ?? '/', this.origin);
        if (url.pathname === '/redirect-trap') { this.externalHits++; outgoing.writeHead(200); outgoing.end('synthetic redirect trap'); return; }
        if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/legacy/')) {
          const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
          const absolute = resolve('dist', path);
          if (!absolute.startsWith(resolve('dist') + '/')) { outgoing.writeHead(403); outgoing.end(); return; }
          const content = await readFile(absolute);
          const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] ?? 'application/octet-stream';
          outgoing.writeHead(200, { 'Content-Type': type }); outgoing.end(content); return;
        }
        const bytes: Buffer[] = [];
        for await (const chunk of incoming) bytes.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
        const method = incoming.method ?? 'GET';
        const request = new Request(url, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(bytes) }) });
        if (url.pathname === '/legacy/form') {
          this.formGets++;
          if (this.fault === 'same-origin-redirect' || this.fault === 'cross-origin-redirect') {
            outgoing.writeHead(302, { Location: this.fault === 'same-origin-redirect' ? `${this.origin}/redirect-trap` : `${this.trapOrigin}/redirect-trap` }); outgoing.end(); return;
          }
        }
        if (url.pathname === '/legacy/submit') {
          this.formPosts++;
          if (this.fault === 'drop-before-effect') { outgoing.destroy(); return; }
          if (this.fault === 'gate-before-effect') { this.gateArrived.resolve(); await this.gateReleased.promise; }
        }
        const response = await handler(request);
        if (url.pathname === '/legacy/submit') {
          if (this.fault === 'lose-receipt') { outgoing.destroy(); return; }
          if (this.fault === 'gate-after-effect') { this.gateArrived.resolve(); await this.gateReleased.promise; }
          if (this.fault === 'delayed-receipt') await new Promise(resolve => setTimeout(resolve, 150));
        }
        let content = await response.text();
        if (url.pathname === '/legacy/form') {
          if (this.fault === 'dom-label') content = content.replace('需求编号</label>', '需求序号</label>');
          if (this.fault === 'duplicate-input') content = content.replace('</form>', '<label for="duplicate">需求编号</label><input id="duplicate" name="requestId"></form>');
          if (this.fault === 'duplicate-button') content = content.replace('</form>', '<button type="submit">登记合成需求</button></form>');
          if (this.fault === 'action-drift') content = content.replace('action="/legacy/submit"', 'action="http://127.0.0.1:1/evil"');
        }
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => { responseHeaders[key] = value; });
        this.requests.push({ method, path: url.pathname, status: response.status });
        outgoing.writeHead(response.status, responseHeaders); outgoing.end(content);
      } catch { if (!outgoing.destroyed) { outgoing.writeHead(500); outgoing.end('test harness failed'); } }
    });
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    this.origin = `http://127.0.0.1:${address.port}`;
    this.trapServer = createServer((_, response) => { this.externalHits++; response.writeHead(200); response.end('synthetic cross-origin redirect trap'); });
    await new Promise<void>((resolve, reject) => { this.trapServer.once('error', reject); this.trapServer.listen(0, '127.0.0.1', resolve); });
    const trapAddress = this.trapServer.address();
    if (!trapAddress || typeof trapAddress === 'string') throw new Error('missing trap address');
    this.trapOrigin = `http://127.0.0.1:${trapAddress.port}`;
    handler = createHandler({
      repository: this.repository,
      sessionSecret: this.secret,
      publicOrigin: this.origin,
      now: () => this.clock,
      plannerLabel: 'bounded-rule',
      proposePlan,
      executor: createBrowserExecutor({ timeoutMs: qaBudgets.browserExecutorMs, browserFactory: async () => {
        this.browserLaunches++;
        const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? chromium.executablePath() });
        this.observedBrowserVersion = browser.version();
        return browser;
      } }),
    });
    return this;
  }
  async stop() {
    this.gateReleased.resolve();
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.trapServer.closeAllConnections();
    await new Promise<void>(resolve => this.trapServer.close(() => resolve()));
    this.repository.close();
  }
  async session(): Promise<Client> {
    const response = await fetch(`${this.origin}/api/session`);
    const reply = await response.json() as ApiReply<SessionView>;
    if (!reply.ok) throw new Error('session denied');
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: reply.data.csrf };
  }
  async api<T>(client: Client | undefined, path: string, body?: unknown, overrides: Record<string, string> = {}): Promise<Reply<T>> {
    const response = await fetch(this.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(client ? { Cookie: client.cookie } : {}),
        ...(body === undefined ? {} : { Origin: this.origin, 'X-CSRF-Token': client?.csrf ?? '', 'Content-Type': 'application/json' }),
        ...overrides,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as ApiReply<T> };
  }
  async propose(client: Client, requestId = 'REQ-2026-001', quantity = 12): Promise<Run> {
    const response = await this.api<Run>(client, '/api/propose', { text: `为研发部登记${quantity}台显示器，需求编号${requestId}。` });
    if (!response.body.ok) throw new Error(`proposal rejected ${response.status}`);
    return response.body.data;
  }
  async approve(client: Client, run: Run): Promise<Run> {
    const response = await this.api<Run>(client, `/api/runs/${run.id}/approve`, { revision: run.revision, planHash: run.planHash, targetRevision: run.targetRevision });
    if (!response.body.ok) throw new Error(`approval rejected ${response.status}`);
    return response.body.data;
  }
  async run(client: Client, run: Run, action: 'execute' | 'cancel' | 'reconcile'): Promise<Run> {
    const response = await this.api<Run>(client, `/api/runs/${run.id}/${action}`, {});
    if (!response.body.ok) throw new Error(`${action} rejected ${response.status}`);
    return response.body.data;
  }
  async getRun(client: Client, id: string): Promise<Run> {
    const response = await this.api<Run[]>(client, '/api/runs');
    if (!response.body.ok) throw new Error('list rejected');
    const run = response.body.data.find(run => run.id === id);
    if (!run) throw new Error('run missing');
    return run;
  }
  countDemands() { return Number(this.repository.db.prepare('SELECT COUNT(*) AS count FROM demands').get()!.count); }
  setFault(fault: Fault) { this.fault = fault; this.gateArrived = deferred(); this.gateReleased = deferred(); }
  async waitForGate() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.gateArrived.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fault gate never reached')), qaBudgets.faultGateMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  releaseGate() { this.gateReleased.resolve(); }
  async evidence(name: string, value: unknown) { await mkdir('docs/qa', { recursive: true }); await import('node:fs/promises').then(fs => fs.writeFile(`docs/qa/${name}.json`, JSON.stringify(value, null, 2) + '\n')); }
}
