import type { ApiReply, Plan, Run, RunStatus, SessionView } from '../contracts.js';
import type { ExecutionProof } from '../runtime/proof.js';
import './styles.css';
import { mountRetainedHistory } from './retained-history.js';

type Action = 'approve' | 'execute' | 'reconcile' | 'cancel' | 'report' | 'revise';
interface PlanEditor { text: string; revision: number; planHash: string; }
interface ProofSnapshot { proof: ExecutionProof; epoch: number; revision: number; planHash: string; }
const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('OfficeFlow mount is missing');
const app = root;
const icons: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3a7 7 0 0 0 11.6-1"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1)"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3Z"/><path d="m13 6 5 5"/>',
};
const icon = (name: string, extra = '') => `<svg class="icon ${extra}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.file}</svg>`;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const statusLabels: Record<RunStatus, string> = { draft: '待确认', approved: '已确认 · 待执行', executing: '执行中', unknown: '结果待核对', verified: '已核对并登记', blocked: '已停止', cancelled: '已取消' };
const sourceLabels = { 'bounded-rule': '有界规则', ollama: 'Ollama 本地模型', 'workers-ai': 'Cloudflare Workers AI' };
const executionErrors: Record<string, string> = {
  DOM_DRIFT: '旧后台表单与预期结构不一致，浏览器已停止。',
  NAVIGATION_DENIED: '页面跳转超出本次允许范围，浏览器已停止。',
  SUBMISSION_REJECTED: '旧后台拒绝了提交，请先核对原需求结果。',
  BROWSER_TIMEOUT: '浏览器等待超时，登记结果需要核对。',
  RESULT_DRIFT: '提交后的页面结构与预期不一致，请核对原需求结果。',
  BROWSER_INTERRUPTED: '浏览器连接中断，登记结果需要核对。',
};
const state = {
  session: null as SessionView | null,
  archiveCount: 0,
  sessionVersion: 0,
  runs: new Map<string, Run>(),
  selectedId: null as string | null,
  selectionVersion: 0,
  loading: true,
  loadError: '',
  syncError: '',
  proposing: false,
  refreshing: false,
  actions: new Map<string, Set<Action>>(),
  technical: new Map<string, boolean>(),
  editors: new Map<string, PlanEditor>(),
  proofs: new Map<string, ProofSnapshot>(),
  proofLoading: new Set<string>(),
  proofErrors: new Map<string, string>(),
  proofTechnical: new Map<string, boolean>(),
};
const signatures = new Map<string, string>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus: number) { super(message); }
}

async function api<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; timeout?: number } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const requestSessionVersion = state.sessionVersion;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 20000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (path !== '/api/session' && state.session) headers['X-OfficeFlow-Context'] = state.session.csrf;
    if (method === 'POST') {
      if (!state.session) throw new ApiError('工作区会话尚未建立，请先重新连接。', 'SESSION_REQUIRED', 401);
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = state.session.csrf;
    }
    const response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    const payload = await response.json().catch(() => null) as ApiReply<T> | null;
    if (!payload || typeof payload !== 'object' || !('ok' in payload)) throw new ApiError(`服务暂不可用（HTTP ${response.status}）。请稍后重新连接。`, 'INVALID_RESPONSE', response.status);
    if (!payload.ok) {
      if (payload.error.code === 'SESSION_CHANGED' && requestSessionVersion === state.sessionVersion) invalidateSession('工作区会话已切换。请重新连接，读取当前隔离工作区；旧请求不会自动重新发送。');
      throw new ApiError(payload.error.message, payload.error.code, response.status);
    }
    if (!response.ok) throw new ApiError(`请求未完成（HTTP ${response.status}）。`, 'HTTP_ERROR', response.status);
    return payload.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ApiError('请求等待超时。写入结果需要读取记录核对，请勿重复提交。', 'REQUEST_TIMEOUT', 0);
    throw new ApiError('连接中断。请检查网络后重新读取执行记录。', 'NETWORK_ERROR', 0);
  } finally { clearTimeout(timeout); }
}

const isPending = (id: string, action?: Action) => action ? state.actions.get(id)?.has(action) ?? false : (state.actions.get(id)?.size ?? 0) > 0;
const orderedRuns = () => [...state.runs.values()].sort((a, b) => (b.events[0]?.at ?? '').localeCompare(a.events[0]?.at ?? '') || b.id.localeCompare(a.id));
const selectedRun = () => state.selectedId ? state.runs.get(state.selectedId) : undefined;
function upsert(run: Run) {
  const current = state.runs.get(run.id);
  // Polls and long-running mutations may complete out of order. Never restore an older CAS snapshot.
  if (current && (run.revision < current.revision || (run.revision === current.revision && (run.epoch < current.epoch || (run.epoch === current.epoch && run.events.length < current.events.length))))) return;
  if (!current || run.epoch !== current.epoch || run.revision !== current.revision) state.proofErrors.delete(run.id);
  state.runs.set(run.id, run);
}
function toast(message: string, tone: 'success' | 'error' | 'info' = 'info') {
  clearTimeout(toastTimer);
  const node = document.querySelector<HTMLDivElement>('#toast')!;
  node.className = `toast visible ${tone}`;
  node.textContent = message;
  toastTimer = setTimeout(() => { node.className = 'toast'; node.textContent = ''; }, 6500);
}
function time(value: string, full = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未提供' : new Intl.DateTimeFormat('zh-CN', { ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
function patch(id: string, html: string) {
  if (signatures.get(id) === html) return;
  const node = document.getElementById(id);
  if (node) {
    const active = document.activeElement;
    const focusedId = active instanceof HTMLElement && node.contains(active) ? active.id : '';
    const selection = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;
    node.innerHTML = html; signatures.set(id, html);
    if (focusedId) {
      const next = document.getElementById(focusedId);
      if (next && node.contains(next)) {
        next.focus({ preventScroll: true });
        if (next instanceof HTMLTextAreaElement && selection) next.setSelectionRange(...selection);
      }
    }
  }
}
function invalidateSession(message: string) {
  state.sessionVersion++;
  state.session = null;
  state.runs.clear();
  state.selectedId = null;
  state.selectionVersion++;
  state.technical.clear();
  state.editors.clear();
  state.proofs.clear();
  state.proofLoading.clear();
  state.proofErrors.clear();
  state.proofTechnical.clear();
  state.actions.clear();
  state.proposing = false;
  state.refreshing = false;
  state.syncError = '';
  state.loadError = message;
  state.loading = false;
  render();
}
function setSelected(id: string, focus = false) {
  const existing = selectedRun();
  if (existing) state.technical.set(existing.id, !!document.querySelector<HTMLDetailsElement>('#plan-technical')?.open);
  if (existing) state.proofTechnical.set(existing.id, !!document.querySelector<HTMLDetailsElement>('#proof-technical')?.open);
  state.selectedId = id;
  state.selectionVersion++;
  render();
  if (focus) document.getElementById('plan-heading')?.focus({ preventScroll: true });
  void refreshProof(id);
}

app.innerHTML = `
  <a class="skip-link" href="#main-content">跳到工作区</a>
  <aside class="sidebar" aria-label="工作区导航">
    <a class="brand" href="/" aria-label="OfficeFlow 项目主页"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>Office<span class="brand-flow">Flow</span><small>办公流程 Agent</small></span></a>
    <div class="workspace-card"><span class="workspace-avatar">OF</span><div><span class="eyebrow">当前工作区</span><strong id="workspace-label">连接中…</strong></div><span class="workspace-dot" aria-hidden="true"></span></div>
    <div class="nav-label">工作空间</div>
    <nav class="side-nav"><a href="#main-content" class="active" aria-current="page">${icon('grid')}<span>需求工作台</span><span class="nav-active-dot"></span></a><a href="#history">${icon('clock')}<span>执行记录</span><span id="nav-count" class="nav-count">0</span></a><a href="/evidence/">${icon('shield')}<span>工作证明</span>${icon('chevron', 'nav-chevron')}</a></nav>
    <div class="sidebar-bottom"><div class="scope-label"><span class="tiny-dot"></span>合成客户 · 隔离工作区</div><p>仅登记合成采购需求。<br>无需真实企业账号或客户数据。</p><a href="https://baby2b.online/">${icon('link')}<span>返回作品集</span>${icon('arrow')}</a></div>
  </aside>
  <div class="shell">
    <header class="topbar"><div class="breadcrumb">工作空间 ${icon('chevron')} <strong>采购需求登记</strong></div><nav class="top-links" aria-label="项目导航"><a href="https://baby2b.online/">作品集</a><a href="/" aria-current="page">项目主页</a><a href="/evidence/">工作证明 ${icon('arrow')}</a></nav></header>
    <main id="main-content" tabindex="-1">
      <div class="page-heading"><div><div class="page-kicker"><span></span>从需求到登记，每一步可核对</div><h1>采购需求工作台</h1><p>描述需求，确认动作，再由受控浏览器登记到旧后台。</p></div><div id="connection-state" class="connection-state"></div></div>
      <div id="load-notice" class="load-notice" aria-live="polite"></div>
      <section class="summary-grid" id="summary" aria-label="当前工作区记录概况"></section>
      <div class="workbench-grid">
        <section class="card input-card" aria-labelledby="input-heading">
          <div class="card-heading"><span class="section-number">01</span><div><h2 id="input-heading">描述你的需求</h2><p>自然语言输入，生成范围明确的动作。</p></div></div>
          <form id="proposal-form"><label for="request-text">采购需求描述 <span>必填</span></label><textarea id="request-text" name="text" rows="6" maxlength="1000" minlength="8" required placeholder="例如：为研发部登记12台显示器，需求编号REQ-2026-001，原因是新员工入职。" aria-describedby="request-help"></textarea><div class="textarea-meta"><span>请包含部门、品类、数量和需求编号</span><span id="char-count">0 / 1000</span></div>
            <div class="example-row"><span>试着开始</span><button type="button" data-example="研发部">研发部 · 显示器 ${icon('plus')}</button><button type="button" data-example="行政部">行政部 · 办公椅 ${icon('plus')}</button></div>
            <div class="scope-box" id="request-help"><div class="scope-title">${icon('shield')}<strong>本次可用范围</strong><span class="small-tag">合成后台</span></div><dl><div><dt>部门</dt><dd>研发部 / 运营部 / 行政部</dd></div><div><dt>品类</dt><dd>显示器 / 键盘 / 办公椅</dd></div><div><dt>数量</dt><dd>1–100 件，每次登记一个品类</dd></div></dl><p>缺少字段或超出范围时，请补充描述；系统不会猜测或扩大操作。</p></div>
            <button id="propose-button" class="button primary full-width" type="submit" disabled>${icon('spark')}<span>生成动作预览</span>${icon('arrow')}</button>
            <p class="form-note">生成预览不会写入后台。登记前需要你的明确确认。</p>
          </form>
          <div class="planner-info" id="planner-info"></div>
        </section>
        <section class="card plan-card" id="plan-panel" aria-label="动作预览与执行结果"></section>
      </div>
      <section class="card history-card" id="history" aria-labelledby="history-heading"><div class="history-header"><div><h2 id="history-heading">执行记录 <span id="history-total">0</span></h2><p>当前会话与本地测试历史分别展示；历史记录可展开查看完整过程。</p></div><button type="button" class="button ghost small" data-refresh>${icon('refresh')}<span>刷新记录</span></button></div><h3 class="live-history-heading">当前会话</h3><div id="history-list"></div><section id="retained-history" aria-label="本地全流程历史"></section></section>
      <div class="trust-strip"><div>${icon('shield')}<span><strong>人工确认</strong>后才允许写入</span></div><div>${icon('monitor')}<span>隔离浏览器执行固定表单</span></div><div>${icon('check')}<span>API 独立核对登记结果</span></div></div>
      <footer><div><strong>OfficeFlow</strong><span>语言提案 · 受控执行 · 结果核对</span></div><nav aria-label="页脚导航"><a href="https://baby2b.online/">作品集首页</a><a href="/">项目主页</a><a href="/evidence/">工作证明 ${icon('arrow')}</a></nav></footer>
    </main>
  </div><div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true"></div>`;

function renderSummary() {
  const runs = orderedRuns();
  const pending = runs.filter(run => ['draft', 'approved'].includes(run.status)).length;
  const verified = runs.filter(run => run.status === 'verified').length;
  const uncertain = runs.filter(run => run.status === 'unknown' || (run.effectStatus === 'unknown' && run.status !== 'verified')).length;
  const value = (n: number) => state.loading ? '—' : String(n).padStart(2, '0');
  patch('summary', `<div class="summary-card"><div class="summary-icon teal">${icon('file')}</div><div><span>等待人工处理</span><strong>${value(pending)}</strong></div><small>计划待确认 / 已确认待执行</small></div><div class="summary-card"><div class="summary-icon blue">${icon('check')}</div><div><span>已核对并登记</span><strong>${value(verified)}</strong></div><small>后台结果与 API 记录一致</small></div><div class="summary-card"><div class="summary-icon amber">${icon('refresh')}</div><div><span>需要核对结果</span><strong>${value(uncertain)}</strong></div><small>仅查询原需求，不重复提交</small></div>`);
}

function currentProof(run: Run): ExecutionProof | undefined {
  const snapshot = state.proofs.get(run.id);
  return snapshot && snapshot.epoch === run.epoch && snapshot.revision === run.revision && snapshot.planHash === run.planHash ? snapshot.proof : undefined;
}

function canRevise(run: Run) {
  return ['draft', 'approved', 'blocked'].includes(run.status) && run.effectStatus === 'none' && !run.result && !isPending(run.id, 'execute') && currentProof(run)?.allowedNextAction !== 'query-only';
}

function describePlan(plan: Plan) {
  return `为${plan.department}登记${plan.quantity}件${plan.item}，需求编号${plan.requestId}，原因是${plan.reason}。`;
}

function revisionView(run: Run): string {
  const editor = state.editors.get(run.id);
  const busy = isPending(run.id, 'revise');
  const stale = editor && (editor.revision !== run.revision || editor.planHash !== run.planHash);
  const disabled = busy || !canRevise(run) || stale;
  const editorHtml = editor ? `<section class="revision-editor" aria-labelledby="revision-heading"><div class="revision-editor-heading">${icon('edit')}<h3 id="revision-heading">修订这条计划</h3><span>基于 v${esc(editor.revision)}</span></div><p>保留需求编号 <strong class="mono">${esc(run.plan.requestId)}</strong>，完整描述新的部门、品类、数量和原因。保存修订后，需要重新确认。</p><form id="revision-form"><label for="revision-text">修订后的完整需求描述</label><textarea id="revision-text" name="revisionText" rows="4" maxlength="1000" minlength="8" required ${busy ? 'disabled' : ''} aria-describedby="revision-help">${esc(editor.text)}</textarea>${stale ? '<div class="revision-stale" role="status">当前计划版本已经变化。请先加载当前计划，再继续编辑。<button type="button" class="button secondary small" data-reset-edit>加载当前计划</button></div>' : !canRevise(run) ? '<p class="revision-stale" role="status">当前执行状态已改变，不能再修订。请结束编辑并核对原需求。</p>' : ''}<div class="revision-editor-actions"><button id="revise-button" type="submit" class="button primary" ${disabled ? 'disabled' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span>' : icon('spark')}<span>${busy ? '正在生成修订预览…' : '生成修订预览'}</span></button><button type="button" class="button ghost" data-cancel-edit ${busy ? 'disabled' : ''}>取消编辑</button></div><p id="revision-help" class="revision-help">生成修订预览会保存新版本并清除旧批准。取消编辑不会修改现有计划。</p></form></section>` : '';
  if (!run.previousPlan || !run.previousRevision) return editorHtml;
  const fields: Array<{ key: keyof Plan; label: string; format?: (value: unknown) => string }> = [
    { key: 'department', label: '部门' }, { key: 'item', label: '采购品类' },
    { key: 'quantity', label: '数量', format: value => `${value} 件` }, { key: 'reason', label: '采购原因' },
  ];
  const changed = fields.filter(field => run.previousPlan![field.key] !== run.plan[field.key]);
  const cleared = run.status === 'draft' && !run.approvedHash;
  return `${editorHtml}<section id="plan-diff" class="plan-diff" aria-label="计划修订差异"><div class="diff-heading"><h3>计划修订差异</h3><span>v${esc(run.previousRevision)} ${icon('arrow')} v${esc(run.revision)}</span></div><div id="revision-notice" class="revision-notice">${icon('shield')}<span>${cleared ? `已保存为 v${esc(run.revision)} · 旧批准已清除` : `v${esc(run.revision)} 修订已生效 · 旧版本批准不再适用`}</span></div>${changed.length ? `<table><thead><tr><th scope="col">字段</th><th scope="col">修订前 · v${esc(run.previousRevision)}</th><th scope="col">本版本 · v${esc(run.revision)}</th></tr></thead><tbody>${changed.map(field => `<tr data-diff-field="${esc(field.key)}"><th scope="row">${esc(field.label)}</th><td class="diff-before">${esc(field.format ? field.format(run.previousPlan![field.key]) : run.previousPlan![field.key])}</td><td class="diff-after">${esc(field.format ? field.format(run.plan[field.key]) : run.plan[field.key])}</td></tr>`).join('')}</tbody></table>` : '<p class="diff-no-change">业务字段未变化；当前版本仍需要独立确认。</p>'}<p class="diff-footer">同一需求编号 <span class="mono">${esc(run.plan.requestId)}</span>，没有发起新的后台登记。</p></section>`;
}

function proofView(run: Run): string {
  const proof = currentProof(run);
  const loading = state.proofLoading.has(run.id);
  const error = state.proofErrors.get(run.id);
  type LayerState = 'verified' | 'pending' | 'warning';
  const layer = (key: string, label: string, value: string, detail: string, tone: LayerState) => `<div class="proof-layer ${tone}" data-proof-layer="${key}" data-proof-state="${tone}"><div class="proof-layer-label"><span>${label}</span>${icon(tone === 'verified' ? 'check' : tone === 'warning' ? 'alert' : 'clock')}</div><strong>${esc(value)}</strong><p>${esc(detail)}</p></div>`;
  let approval = layer('approval', '01 人工确认', '尚未读取证据', '确认须绑定当前版本与内容。', 'pending');
  let browser = layer('browser', '02 浏览器 POST', '尚未读取证据', '浏览器观察与业务效果分别记录。', 'pending');
  let database = layer('database', '03 后台持久记录', run.effectStatus === 'applied' ? '持久记录显示已写入' : '尚未读取核对报告', run.effectStatus === 'applied' ? '保留已写入效果，等待报告核对。' : '不会从浏览器回执推断写入。', run.effectStatus === 'applied' ? 'warning' : 'pending');
  let apiLayer = layer('api', '04 API 字段验收', '尚未读取证据', '独立读取需求并核对全部字段。', 'pending');
  if (proof) {
    const matched = proof.approval.status === 'matched' && proof.approval.hashMatches && proof.approval.validAtObservation;
    approval = layer('approval', '01 人工确认', matched ? `v${run.revision} 已确认` : proof.approval.status === 'expired' ? '确认已过期' : proof.approval.status === 'mismatch' ? '确认内容不匹配' : '尚未确认', matched ? '批准内容与本版本计划相符。' : proof.approval.status === 'expired' ? '保留历史记录，不允许新写入。' : '当前版本没有有效的确认记录。', matched ? 'verified' : ['expired', 'mismatch'].includes(proof.approval.status) ? 'warning' : 'pending');
    const evidence = proof.browser.evidence;
    const observed = proof.browser.status === 'observed' && proof.browser.sameAttempt && evidence?.domMatched === true && evidence.payloadMatched === true && evidence.postObserved === true;
    browser = layer('browser', '02 浏览器 POST', observed ? '已观察到本次 POST' : proof.browser.status === 'invalid' ? '观察证据不匹配' : !evidence ? '无本次浏览器证据' : '未观察到本次 POST', observed ? '表单、字段和计划版本已匹配。' : !evidence ? '不能把已有后台记录算作浏览器动作。' : '没有完整提交观察，不推断登记成功。', observed ? 'verified' : proof.browser.status === 'invalid' || evidence?.stopCode ? 'warning' : 'pending');
    const durableMatch = proof.database.effectStatus === 'applied' && proof.database.hasPersistedResult && proof.database.persistedResultMatchesPlan === true;
    database = layer('database', '03 后台持久记录', durableMatch ? '已保存本次需求' : proof.database.effectStatus === 'applied' ? '已写入，记录待补核' : proof.database.effectStatus === 'unknown' ? '持久结果待核对' : '暂无已记录写入效果', durableMatch ? '持久字段与当前计划相符。' : proof.database.effectStatus === 'applied' ? '已知登记效果不会因查询失败被清除。' : proof.database.effectStatus === 'unknown' ? '结果不确定，不允许重复提交。' : '仅说明当前持久记录，不推断未发生效果。', durableMatch ? 'verified' : proof.database.effectStatus !== 'none' ? 'warning' : 'pending');
    const apiVerified = proof.api.status === 'verified' && proof.api.queryStatus === 'found' && Object.values(proof.api.checks).every(value => value === true);
    const unsafe = run.effectStatus !== 'none' || ['executing', 'unknown', 'verified'].includes(run.status);
    const apiValue = apiVerified ? '全部字段已验收' : proof.api.status === 'mismatch' ? '字段核对不一致' : proof.api.status === 'not-found' ? unsafe ? '当前查询未确认' : '尚无登记结果' : '当前查询待确认';
    apiLayer = layer('api', '04 API 字段验收', apiValue, apiVerified ? '需求编号、字段、hash 与执行编号一致。' : unsafe ? '只核对原需求，查不到也不会重发。' : proof.api.queryStatus === 'unavailable' ? '核对服务暂不可用，请稍后查询。' : '未完成字段验收，不显示成功。', apiVerified ? 'verified' : unsafe || ['mismatch', 'unknown'].includes(proof.api.status) ? 'warning' : 'pending');
  }
  const deduplicated = run.events.some(event => event.type === 'deduplicated');
  const noBrowser = proof?.browser.evidence === null;
  const browserNote = noBrowser && (proof?.api.status === 'verified' || deduplicated) ? `<p class="proof-observation-note">${icon('monitor')}${deduplicated ? '已读取已有结果完成去重；' : ''}本次运行没有浏览器动作证据。后台记录与 API 结果分别核对。</p>` : '';
  return `<section id="execution-proof" class="execution-proof" aria-label="分层执行核对"><div class="proof-heading"><div><h3>分层执行核对</h3><p>每一层都有独立记录；观察到 POST 不等于业务已完成。</p></div><button type="button" class="button ghost small" data-proof-refresh ${loading ? 'disabled' : ''}>${loading ? '<span class="spinner" aria-hidden="true"></span>' : icon('refresh')}<span>刷新核对报告</span></button></div><div class="proof-grid">${approval}${browser}${database}${apiLayer}</div>${browserNote}${error ? `<p class="proof-error" role="status">${icon('alert')}核对报告读取未完成：${esc(error)}</p>` : ''}<div class="proof-checked">${loading ? '<span class="spinner" aria-hidden="true"></span>正在读取实际核对报告' : proof ? `最近 API 查询：<time datetime="${esc(proof.api.checkedAt)}">${esc(time(proof.api.checkedAt, true))}</time>` : '尚无本版本的独立核对报告'}</div>${proof ? `<details class="proof-technical" id="proof-technical" data-run="${esc(run.id)}" ${state.proofTechnical.get(run.id) ? 'open' : ''}><summary>查看报告内容校验值 ${icon('chevron')}</summary><p>SHA-256 摘要用于发现导出内容是否改变。这是内容校验值，不代表签名或外部认证。</p><code>${esc(proof.digest.value)}</code>${proof.browser.evidence ? `<dl><div><dt>固定执行来源</dt><dd>${esc(proof.browser.evidence.origin ?? '未提供')}</dd></div><div><dt>浏览器观察耗时</dt><dd>${proof.browser.evidence.elapsedMs === null ? '未提供' : `${esc(proof.browser.evidence.elapsedMs)} ms`}</dd></div><div><dt>提交后页面标记</dt><dd>${proof.browser.evidence.registeredMarker === true ? '已观察到登记标记；仍需 API 验收' : '未观察到登记标记'}</dd></div></dl>` : ''}</details>` : ''}</section>`;
}

function recoveryView(run: Run): string {
  const proof = currentProof(run);
  const queryOnly = run.effectStatus !== 'none' || ['executing', 'unknown', 'verified'].includes(run.status) || proof?.allowedNextAction === 'query-only';
  if (!queryOnly && !['blocked', 'cancelled'].includes(run.status)) return '';
  const confirmed = [...run.events].reverse().find(event => ['execution-query', 'reconciled', 'reconcile', 'deduplicated', 'cancel-after-effect'].includes(event.type) && event.message.includes('确认登记'));
  const confirmedAt = proof?.api.status === 'verified' ? proof.api.checkedAt : confirmed?.at;
  const effect = run.effectStatus === 'applied' ? '已发生登记 · 保留持久效果' : run.effectStatus === 'unknown' ? '结果不确定 · 仍需核对' : '暂无已记录写入效果';
  return `<section id="recovery-panel" class="recovery-panel" aria-label="恢复与下一步"><div class="recovery-heading">${icon('shield')}<h3>恢复与下一步</h3><span>${queryOnly ? '只查询，不重发' : '已停止操作'}</span></div><dl><div><dt>持久效果</dt><dd>${effect}</dd></div><div><dt>最近确认</dt><dd>${confirmedAt ? `<time datetime="${esc(confirmedAt)}">${esc(time(confirmedAt, true))}</time> · API 已确认登记` : '尚无 API 验收确认'}</dd></div><div><dt>当前可用动作</dt><dd data-allowed-action="${queryOnly ? 'query-only' : 'none'}">${queryOnly ? '仅核对原需求结果 / 导出报告' : canRevise(run) ? '修改计划后重新确认 / 导出报告' : '查看记录 / 导出报告'}</dd></div></dl><p>${queryOnly ? `只查询原需求 ${esc(run.plan.requestId)}。查询未找到也不会自动重新提交；取消不会撤销已经发生的登记。` : '已经停止后续提交；需要继续时，先检查当前计划与实际记录。'}</p></section>`;
}

function renderPlan() {
  const run = selectedRun();
  if (!run) {
    patch('plan-panel', `<div class="card-heading"><span class="section-number">02</span><div><h2>动作预览</h2><p>先看清要做什么，再决定是否执行。</p></div><span class="tag neutral">等待需求</span></div><div class="plan-empty"><div class="empty-illustration" aria-hidden="true"><div class="illustration-line"></div><span class="illustration-file">${icon('file')}</span><span class="illustration-check">${icon('check')}</span></div><h3>${state.loading ? '正在读取工作区' : '把一句需求变成可确认的动作'}</h3><p>${state.loading ? '读取会话与已有记录后，就可以开始。' : '左侧输入采购需求，这里会展示目标、字段、真实提案来源和执行步骤。'}</p><div class="empty-steps"><span>读取目标</span>${icon('chevron')}<span>人工确认</span>${icon('chevron')}<span>登记与核对</span></div></div><div class="empty-assurance">${icon('shield')}<div><strong>每次登记，都由你作最后确认</strong><p>模型只提出有限计划。执行权限由服务端与批准记录共同校验。</p></div></div>`);
    return;
  }
  const currentTechnical = document.querySelector<HTMLDetailsElement>('#plan-technical');
  if (currentTechnical && currentTechnical.dataset.run === run.id) state.technical.set(run.id, currentTechnical.open);
  const proofTechnical = document.querySelector<HTMLDetailsElement>('#proof-technical');
  if (proofTechnical && proofTechnical.dataset.run === run.id) state.proofTechnical.set(run.id, proofTechnical.open);
  const proof = currentProof(run);
  const editing = state.editors.has(run.id);
  const queryOnly = run.effectStatus !== 'none' || proof?.allowedNextAction === 'query-only';
  const pendingExecute = isPending(run.id, 'execute');
  const pendingCancel = isPending(run.id, 'cancel');
  const otherPending = [...(state.actions.get(run.id) ?? [])].some(action => action !== 'report');
  const expired = !!run.approvalExpiresAt && Date.parse(run.approvalExpiresAt) <= Date.now();
  const recoveryAvailable = run.status === 'unknown' || run.status === 'executing' || queryOnly;
  const canCancel = ['draft', 'approved', 'executing', 'unknown'].includes(run.status);
  const displayedStatus = pendingExecute ? '执行请求处理中' : isPending(run.id, 'revise') ? '修订请求处理中' : statusLabels[run.status];
  const callout: Record<RunStatus, [string, string, string]> = {
    draft: ['info', '检查字段后，确认本次登记', '确认绑定当前计划、目标和版本。确认完成后，你仍需点击“执行已确认计划”才会启动浏览器。'],
    approved: ['info', expired ? '本次确认已过期' : '你的确认已记录', expired ? '当前批准不能继续执行。请取消此计划，重新生成并确认。' : '点击执行后，隔离浏览器会填写并提交合成后台的固定表单，再由 API 核对结果。'],
    executing: ['info', '受控浏览器正在处理', '浏览器在服务端的隔离环境中运行。这里展示真实记录，执行结束后会自动刷新。'],
    unknown: ['warning', '提交结果暂不确定', '请核对原需求编号的登记结果。系统不会重新提交；查询未找到也不会自动再次写入。'],
    verified: ['success', '已通过 API 核对登记结果', '下方显示后台实际保存的记录。相同需求的重复请求由服务端唯一键约束处理。'],
    blocked: ['warning', '操作已停止', run.effectStatus === 'none' ? '当前记录没有已确认的写入效果。检查停止原因后，可修改描述并生成新计划。' : '写入效果需要核对。请先查询原需求，避免重复提交。'],
    cancelled: ['neutral', '已停止后续操作', run.effectStatus === 'none' ? '当前记录未显示写入效果。需要继续时，请生成并确认新计划。' : '取消不会撤销已经发生的登记。请核对原需求的实际结果。'],
  };
  let [tone, title, description] = callout[run.status];
  if (proof && ['draft', 'approved'].includes(run.status) && proof.allowedNextAction === 'query-only') {
    tone = 'warning'; title = '先核对原需求结果'; description = '独立报告提示当前只能查询原需求。核对完成前，不能批准或提交新的写入。';
  }
  if (proof && run.status === 'verified' && proof.api.status !== 'verified') {
    tone = 'warning'; title = '保留已登记效果，当前查询待确认'; description = '历史登记与持久效果仍保留。本次 API 查询尚未完成字段验收，只能继续核对原需求。';
  }
  const source = sourceLabels[run.plan.source] ?? run.plan.source;
  const result = run.result;
  const disabled = (condition: boolean) => condition ? 'disabled' : '';
  let actions = '';
  if (run.status === 'draft' && !queryOnly && !editing) actions += `<button type="button" class="button primary" data-action="approve" ${disabled(otherPending)}>${isPending(run.id, 'approve') ? '<span class="spinner" aria-hidden="true"></span>' : icon('check')}<span>${isPending(run.id, 'approve') ? '正在记录确认…' : '确认本次登记'}</span></button>`;
  if (run.status === 'approved' && !queryOnly && !editing) actions += `<button type="button" class="button primary" data-action="execute" ${disabled(otherPending || expired)}>${pendingExecute ? '<span class="spinner" aria-hidden="true"></span>' : icon('arrow')}<span>${pendingExecute ? '正在执行…' : '执行已确认计划'}</span></button>`;
  if (canRevise(run) && !editing) actions += `<button type="button" class="button secondary" data-edit-plan ${disabled(otherPending)}>${icon('edit')}<span>修改计划</span></button>`;
  if (recoveryAvailable) actions += `<button type="button" class="button ${run.status === 'executing' ? 'secondary' : 'primary'}" data-action="reconcile" ${disabled(otherPending)}>${isPending(run.id, 'reconcile') ? '<span class="spinner" aria-hidden="true"></span>' : icon('refresh')}<span>${isPending(run.id, 'reconcile') ? '正在核对…' : '核对原需求结果'}</span></button>`;
  if (canCancel && !editing) actions += `<button type="button" class="button ghost" data-action="cancel" ${disabled(pendingCancel || (otherPending && !pendingExecute))}>${pendingCancel ? '<span class="spinner" aria-hidden="true"></span>' : icon('stop')}<span>${pendingCancel ? '正在停止…' : run.effectStatus === 'none' && !pendingExecute && run.status !== 'executing' ? '取消当前计划' : '停止后续操作'}</span></button>`;
  actions += `<button type="button" class="button ghost report-button" data-action="report" ${disabled(isPending(run.id, 'report'))}>${icon('download')}<span>${isPending(run.id, 'report') ? '导出中…' : '导出报告'}</span></button>`;
  patch('plan-panel', `<div class="card-heading"><span class="section-number">02</span><div><h2 id="plan-heading" tabindex="-1">${run.status === 'verified' ? '登记结果' : '动作预览'}</h2><p>当前需求 <span class="mono">${esc(run.plan.requestId)}</span></p></div><span class="tag status-${esc(run.status)}">${run.status === 'executing' || pendingExecute ? '<span class="spinner" aria-hidden="true"></span>' : '<span class="status-dot"></span>'}${esc(displayedStatus)}</span></div>
    <div class="plan-body"><div class="plan-context"><span class="context-label">固定动作</span><strong>新增一条合成采购需求</strong><span class="revision-label" id="revision-label">v${esc(run.revision)}</span><span class="context-target">合成采购后台</span></div>${revisionView(run)}<dl class="plan-fields"><div><dt>部门</dt><dd>${esc(run.plan.department)}</dd></div><div><dt>采购品类</dt><dd>${esc(run.plan.item)}</dd></div><div><dt>数量</dt><dd><span class="quantity-value">${esc(run.plan.quantity)}</span><span class="unit">件</span></dd></div><div><dt>需求编号</dt><dd class="mono request-id">${esc(run.plan.requestId)}</dd></div><div class="wide"><dt>采购原因</dt><dd>${esc(run.plan.reason || '未提供')}</dd></div></dl>
      <div class="source-line">${icon('spark')}<span>实际提案来源</span><strong>${esc(source)}</strong>${run.plan.source === 'bounded-rule' ? '<span class="source-note">固定范围字段抽取</span>' : ''}</div>
      <div class="execution-steps"><h3>这次会做的事</h3><ol><li><span>1</span><div><strong>校验固定目标与本次批准</strong><p>检查计划内容、后台版本及执行权限。</p></div></li><li><span>2</span><div><strong>浏览器填写并提交旧后台表单</strong><p>只允许本次需求的固定字段，不接受任意网页或脚本。</p></div></li><li><span>3</span><div><strong>API 读取并核对实际登记结果</strong><p>提交结果不确定时，仅查询原需求，不重新发送。</p></div></li></ol></div>
      <div class="state-callout ${tone}" role="note">${icon(run.status === 'verified' ? 'check' : tone === 'warning' ? 'alert' : 'shield')}<div><strong>${esc(title)}</strong><p>${esc(description)}</p>${run.error ? `<p class="error-detail">停止原因：${esc(executionErrors[run.error] ?? run.error)}</p>` : ''}${run.approvalExpiresAt && run.status === 'approved' ? `<p class="approval-expiry">确认有效至 ${esc(time(run.approvalExpiresAt, true))}</p>` : ''}</div></div>
      ${proofView(run)}
      ${result ? `<section class="verified-result" aria-label="后台实际记录"><div class="result-heading">${icon('check')}<strong>后台实际记录</strong><time datetime="${esc(result.createdAt)}">${esc(time(result.createdAt, true))}</time></div><dl><div><dt>需求编号</dt><dd class="mono">${esc(result.requestId)}</dd></div><div><dt>登记字段</dt><dd>${esc(result.department)} · ${esc(result.item)} · ${esc(result.quantity)} 件</dd></div><div><dt>采购原因</dt><dd>${esc(result.reason)}</dd></div></dl></section>` : ''}
      ${recoveryView(run)}
      <div class="plan-actions">${actions}</div><p class="effect-note">${icon('alert')}登记会新增后台记录；取消只停止后续动作，不撤销已经发生的写入。</p>
      <details class="technical-details" id="plan-technical" data-run="${esc(run.id)}" ${state.technical.get(run.id) ? 'open' : ''}><summary>${icon('shield')}<span>计划与目标校验信息</span><span class="technical-hint">用于防止过期批准和目标变化</span>${icon('chevron')}</summary><p>人工确认绑定这些信息。计划内容或目标版本变化后，旧确认不能用于新的写入。</p><dl><div><dt>计划版本</dt><dd>v${esc(run.revision)}</dd></div><div><dt>目标版本</dt><dd>${esc(run.targetRevision)}</dd></div><div><dt>表单适配器</dt><dd>${esc(run.adapterVersion)}</dd></div><div><dt>计划内容 hash</dt><dd class="mono hash">${esc(run.planHash)}</dd></div><div><dt>执行记录 ID</dt><dd class="mono hash">${esc(run.id)}</dd></div><div><dt>持久效果状态</dt><dd>${{ none: '尚无写入效果', unknown: '待核对', applied: '已发生登记' }[run.effectStatus]}</dd></div></dl></details>
      <section class="timeline-section" aria-labelledby="timeline-heading"><div class="timeline-heading"><h3 id="timeline-heading">实际事件时间线</h3><span>${run.events.length} 条事件</span></div>${run.events.length ? `<ol class="timeline">${run.events.map((event, index) => `<li class="${index === run.events.length - 1 ? 'latest' : ''}"><span class="timeline-dot" aria-hidden="true"></span><div><p>${esc(event.message)}</p><span class="event-type">${esc(event.type)}</span></div><time datetime="${esc(event.at)}">${esc(time(event.at, true))}</time></li>`).join('')}</ol>` : '<p class="muted">服务端尚未提供事件。</p>'}</section>
    </div>`);
}

function renderHistory() {
  const runs = orderedRuns();
  patch('nav-count', String(runs.length + state.archiveCount));
  patch('history-total', `${runs.length} 会话 · ${state.archiveCount} 历史`);
  if (state.loading) { patch('history-list', '<div class="history-empty"><span class="spinner" aria-hidden="true"></span><p>正在读取执行记录…</p></div>'); return; }
  if (!runs.length) { patch('history-list', `<div class="history-empty">${icon('clock')}<div><strong>当前会话还没有执行记录</strong><p>下方可查看已保留的本地全流程历史；新需求会记录在当前会话。</p></div></div>`); return; }
  patch('history-list', `<div class="history-table-labels" aria-hidden="true"><span>采购需求</span><span>部门 / 品类</span><span>状态</span><span>建立时间</span><span></span></div><div class="history-rows">${runs.map(run => `<button type="button" class="history-row ${run.id === state.selectedId ? 'selected' : ''}" data-select="${esc(run.id)}" aria-label="查看需求 ${esc(run.plan.requestId)}，${esc(statusLabels[run.status])}" aria-pressed="${run.id === state.selectedId}"><span class="history-request"><span class="record-icon">${icon('file')}</span><span><strong class="mono">${esc(run.plan.requestId)}</strong><small>${esc(run.plan.quantity)} 件 · ${esc(sourceLabels[run.plan.source] ?? run.plan.source)}</small></span></span><span class="history-target">${esc(run.plan.department)}<small>${esc(run.plan.item)}</small></span><span class="tag status-${run.status}"><span class="status-dot"></span>${esc(statusLabels[run.status])}</span><time datetime="${esc(run.events[0]?.at ?? '')}">${run.events[0]?.at ? esc(time(run.events[0].at, true)) : '—'}</time>${icon('chevron')}</button>`).join('')}</div>`);
}

function render() {
  const ready = !!state.session && !state.loadError;
  const connection = state.loading ? '<span class="spinner" aria-hidden="true"></span>连接工作区中' : state.loadError ? '<span class="tiny-dot disconnected"></span>连接未完成' : state.syncError ? '<span class="tiny-dot caution"></span>记录同步暂中断' : '<span class="tiny-dot"></span>工作区已连接';
  patch('connection-state', connection);
  patch('workspace-label', esc(state.session?.tenantLabel ?? (state.loadError ? '连接未完成' : '连接中…')));
  patch('load-notice', state.loadError ? `<div class="notice error">${icon('alert')}<div><strong>工作区连接未完成</strong><p>${esc(state.loadError)}</p></div><button type="button" class="button secondary small" data-reconnect>重新连接</button></div>` : state.syncError ? `<div class="notice warning">${icon('alert')}<div><strong>执行记录暂未同步</strong><p>${esc(state.syncError)} 当前页面保留最后一次读取结果。</p></div><button type="button" class="button secondary small" data-refresh>重新读取</button></div>` : '');
  const propose = document.querySelector<HTMLButtonElement>('#propose-button')!;
  propose.disabled = !ready || state.proposing;
  propose.innerHTML = state.proposing ? '<span class="spinner" aria-hidden="true"></span><span>正在读取目标并生成计划…</span>' : `${icon('spark')}<span>生成动作预览</span>${icon('arrow')}`;
  patch('planner-info', `${icon('spark')}<div><span>当前提案方式</span><strong>${state.session ? esc(sourceLabels[state.session.planner as keyof typeof sourceLabels] ?? state.session.planner) : '连接后读取实际配置'}</strong></div><span class="planner-caption">${state.session ? '每条计划分别记录实际来源' : '来源由服务端提供'}</span>`);
  document.querySelectorAll<HTMLButtonElement>('[data-refresh]').forEach(button => { button.disabled = state.refreshing || state.loading; });
  renderSummary(); renderPlan(); renderHistory();
}

async function refreshProof(id: string, force = false) {
  const run = state.runs.get(id);
  if (!run || !state.session || state.loadError || stopped || state.proofLoading.has(id)) return;
  if (!force && (currentProof(run) || state.proofErrors.has(id) || run.status === 'executing')) return;
  const sessionVersion = state.sessionVersion;
  state.proofLoading.add(id); state.proofErrors.delete(id); renderPlan();
  try {
    const proof = await api<ExecutionProof>(`/api/runs/${encodeURIComponent(id)}/report`);
    if (sessionVersion !== state.sessionVersion) return;
    const current = state.runs.get(id);
    if (!current || current.revision !== run.revision || current.epoch !== run.epoch || current.planHash !== run.planHash) return;
    if (proof.schema !== 'office-agent-execution-proof-v1' || proof.run.id !== id || proof.run.revision !== current.revision || proof.run.planHash !== current.planHash) throw new Error('报告与当前计划版本不一致，请刷新记录后核对。');
    if (proof.run.status !== current.status || proof.run.effectStatus !== current.effectStatus) {
      await refreshRuns(true);
      return;
    }
    state.proofs.set(id, { proof, epoch: current.epoch, revision: current.revision, planHash: current.planHash });
  } catch (error) {
    if (sessionVersion !== state.sessionVersion) return;
    state.proofErrors.set(id, error instanceof Error ? error.message : '核对报告暂不可用。');
  } finally {
    if (sessionVersion === state.sessionVersion) {
      state.proofLoading.delete(id); renderPlan();
      const current = state.runs.get(id);
      if (current && current.epoch !== run.epoch && state.selectedId === id) void refreshProof(id);
    }
  }
}

async function refreshRuns(silent = false) {
  if (state.refreshing || !state.session || stopped) return;
  const sessionVersion = state.sessionVersion;
  state.refreshing = true;
  if (!silent) render();
  try {
    const runs = await api<Run[]>('/api/runs');
    if (sessionVersion !== state.sessionVersion) return;
    runs.forEach(upsert);
    state.syncError = '';
    if (!state.selectedId && runs.length) setSelected(orderedRuns()[0].id);
  } catch (error) {
    if (sessionVersion !== state.sessionVersion) return;
    state.syncError = error instanceof Error ? error.message : '读取失败。';
    if (error instanceof ApiError && error.code === 'SESSION_REQUIRED') state.loadError = '体验会话已失效，请重新连接以读取当前隔离工作区。';
    if (!silent) toast(state.syncError, 'error');
  } finally {
    if (sessionVersion === state.sessionVersion) state.refreshing = false;
    render();
    if (state.selectedId) void refreshProof(state.selectedId);
  }
}

async function connect() {
  if (state.loading && state.session) return;
  state.loading = true; state.loadError = ''; render();
  try {
    const session = await api<SessionView>('/api/session');
    if (state.session?.csrf !== session.csrf) {
      state.sessionVersion++;
      state.runs.clear();
      state.selectedId = null;
      state.selectionVersion++;
      state.technical.clear();
      state.editors.clear();
      state.proofs.clear();
      state.proofLoading.clear();
      state.proofErrors.clear();
      state.proofTechnical.clear();
      state.actions.clear();
      state.proposing = false;
      state.refreshing = false;
    }
    state.session = session;
    const runs = await api<Run[]>('/api/runs');
    runs.forEach(upsert);
    state.syncError = '';
    if (!state.selectedId && runs.length) setSelected(orderedRuns()[0].id);
  } catch (error) { state.loadError = error instanceof Error ? error.message : '连接失败。'; }
  finally { state.loading = false; render(); if (state.selectedId) void refreshProof(state.selectedId); }
}

async function propose(event: SubmitEvent) {
  event.preventDefault();
  if (state.proposing || !state.session || state.loadError) return;
  const input = document.querySelector<HTMLTextAreaElement>('#request-text')!;
  if (!input.reportValidity()) return;
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const selectionVersion = state.selectionVersion;
  const sessionVersion = state.sessionVersion;
  state.proposing = true; render();
  try {
    const run = await api<Run>('/api/propose', { method: 'POST', body: { text }, timeout: 40000 });
    if (sessionVersion !== state.sessionVersion) return;
    upsert(run);
    if (selectionVersion === state.selectionVersion) setSelected(run.id, true);
    toast('动作预览已生成。请逐项检查后确认本次登记。', 'success');
  } catch (error) {
    if (sessionVersion !== state.sessionVersion) return;
    if (error instanceof ApiError && ['SESSION_REQUIRED', 'CSRF_DENIED'].includes(error.code)) state.loadError = '体验会话需要重新连接；本次请求不会自动重新发送。';
    toast(error instanceof Error ? error.message : '生成计划失败。', 'error');
  }
  finally { if (sessionVersion === state.sessionVersion) state.proposing = false; render(); }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/csrf|cookie|token|capability|authorization|password|secret|email|phone|^(cap|tenantId)$/i.test(key)).map(([key, item]) => [key, sanitize(item)]));
  return value;
}

async function runAction(action: Action) {
  if (action === 'revise') return;
  const run = selectedRun();
  if (!run || isPending(run.id, action)) return;
  const sessionVersion = state.sessionVersion;
  // These client guards make the UI explicit; the API independently enforces every authorization.
  if (action === 'approve' && (run.status !== 'draft' || run.effectStatus !== 'none' || state.editors.has(run.id) || currentProof(run)?.allowedNextAction === 'query-only')) return;
  if (action === 'execute' && (run.status !== 'approved' || run.effectStatus !== 'none' || state.editors.has(run.id) || currentProof(run)?.allowedNextAction === 'query-only' || (run.approvalExpiresAt && Date.parse(run.approvalExpiresAt) <= Date.now()))) return;
  if (action !== 'cancel' && action !== 'report' && isPending(run.id)) return;
  const pending = state.actions.get(run.id) ?? new Set<Action>();
  pending.add(action); state.actions.set(run.id, pending); render();
  try {
    const path = `/api/runs/${encodeURIComponent(run.id)}/${action}`;
    if (action === 'report') {
      const report = await api<unknown>(path);
      if (sessionVersion !== state.sessionVersion) return;
      const blob = new Blob([JSON.stringify(sanitize(report), null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `officeflow-${run.plan.requestId.replace(/[^a-zA-Z0-9_-]/g, '_')}-report.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出去除敏感字段的执行报告。', 'success');
    } else {
      const body = action === 'approve' ? { revision: run.revision, planHash: run.planHash, targetRevision: run.targetRevision } : {};
      const updated = await api<Run>(path, { method: 'POST', body, timeout: action === 'execute' ? 45000 : 20000 });
      if (sessionVersion !== state.sessionVersion) return;
      upsert(updated);
      const messages: Record<Exclude<Action, 'report' | 'revise'>, string> = {
        approve: '本次确认已记录。现在可以执行已确认计划。',
        execute: updated.status === 'verified' ? '需求已登记，API 核对完成。' : updated.status === 'unknown' ? '结果暂不确定，请核对原需求。' : '执行请求已返回，请查看实际事件与状态。',
        reconcile: updated.status === 'verified' ? '已找到后台登记记录，核对完成。' : '核对结果已更新。未找到记录也不会自动重发。',
        cancel: updated.effectStatus === 'none' ? '计划已取消。' : '后续操作已停止；已经发生的登记不会被撤销。',
      };
      toast(messages[action], updated.status === 'verified' || action === 'approve' ? 'success' : 'info');
    }
  } catch (error) {
    if (sessionVersion !== state.sessionVersion) return;
    if (error instanceof ApiError && ['SESSION_REQUIRED', 'CSRF_DENIED'].includes(error.code)) state.loadError = '体验会话需要重新连接；本次操作不会自动重新发送。';
    toast(error instanceof Error ? error.message : '操作未完成。', 'error');
    if (action !== 'report') await refreshRuns(true);
  } finally {
    state.actions.get(run.id)?.delete(action);
    if (!state.actions.get(run.id)?.size) state.actions.delete(run.id);
    render();
    if (action !== 'report') void refreshRuns(true);
    if (state.selectedId) void refreshProof(state.selectedId);
  }
}

async function revisePlan(event: SubmitEvent) {
  event.preventDefault();
  const run = selectedRun();
  if (!run || !state.session || state.loadError || !canRevise(run) || isPending(run.id)) return;
  const editor = state.editors.get(run.id);
  if (!editor || editor.revision !== run.revision || editor.planHash !== run.planHash) return;
  const input = document.querySelector<HTMLTextAreaElement>('#revision-text');
  if (!input || !input.reportValidity()) return;
  const text = input.value.trim();
  if (!text) return;
  const sessionVersion = state.sessionVersion;
  const selectionVersion = state.selectionVersion;
  const pending = state.actions.get(run.id) ?? new Set<Action>();
  pending.add('revise'); state.actions.set(run.id, pending); render();
  try {
    const updated = await api<Run>(`/api/runs/${encodeURIComponent(run.id)}/revise`, { method: 'POST', body: { revision: editor.revision, planHash: editor.planHash, text }, timeout: 40000 });
    if (sessionVersion !== state.sessionVersion) return;
    upsert(updated);
    if (state.editors.get(run.id) === editor) state.editors.delete(run.id);
    render();
    if (selectionVersion === state.selectionVersion && state.selectedId === run.id) document.getElementById('plan-heading')?.focus({ preventScroll: true });
    toast(`修订预览已保存为 v${updated.revision}。旧批准已清除，请重新确认。`, 'success');
  } catch (error) {
    if (sessionVersion !== state.sessionVersion) return;
    if (error instanceof ApiError && ['SESSION_REQUIRED', 'CSRF_DENIED'].includes(error.code)) state.loadError = '体验会话需要重新连接；本次修订不会自动重新发送。';
    toast(error instanceof Error ? error.message : '修订未完成。', 'error');
    await refreshRuns(true);
  } finally {
    if (sessionVersion === state.sessionVersion) {
      state.actions.get(run.id)?.delete('revise');
      if (!state.actions.get(run.id)?.size) state.actions.delete(run.id);
      render();
      if (state.selectedId) void refreshProof(state.selectedId);
    }
  }
}

document.querySelector<HTMLFormElement>('#proposal-form')!.addEventListener('submit', event => { void propose(event); });
document.querySelector<HTMLTextAreaElement>('#request-text')!.addEventListener('input', event => {
  document.querySelector('#char-count')!.textContent = `${(event.target as HTMLTextAreaElement).value.length} / 1000`;
});
app.addEventListener('submit', event => {
  if (event.target instanceof HTMLFormElement && event.target.id === 'revision-form') void revisePlan(event as SubmitEvent);
});
app.addEventListener('input', event => {
  if (event.target instanceof HTMLTextAreaElement && event.target.id === 'revision-text' && state.selectedId) {
    const editor = state.editors.get(state.selectedId);
    if (editor) editor.text = event.target.value;
  }
});
app.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('button');
  if (!target || (target as HTMLButtonElement).disabled) return;
  if (target.dataset.example) {
    const input = document.querySelector<HTMLTextAreaElement>('#request-text')!;
    const department = target.dataset.example;
    const suffix = Date.now().toString(36).toUpperCase();
    input.value = department === '研发部' ? `为研发部登记12台显示器，需求编号REQ-${suffix}，原因是新员工入职。` : `为行政部登记6把办公椅，需求编号REQ-${suffix}，原因是办公区更新。`;
    input.dispatchEvent(new Event('input')); input.focus();
  } else if (target.dataset.select) setSelected(target.dataset.select, true);
  else if (target.hasAttribute('data-edit-plan') || target.hasAttribute('data-reset-edit')) {
    const run = selectedRun();
    if (!run || !canRevise(run) || isPending(run.id)) return;
    state.editors.set(run.id, { text: describePlan(run.plan), revision: run.revision, planHash: run.planHash });
    render(); document.getElementById('revision-text')?.focus({ preventScroll: true });
  }
  else if (target.hasAttribute('data-cancel-edit')) {
    const run = selectedRun();
    if (!run || isPending(run.id, 'revise')) return;
    state.editors.delete(run.id); render();
    document.querySelector<HTMLButtonElement>('[data-edit-plan]')?.focus({ preventScroll: true });
  }
  else if (target.hasAttribute('data-proof-refresh')) { if (state.selectedId) void refreshProof(state.selectedId, true); }
  else if (target.dataset.action) void runAction(target.dataset.action as Action);
  else if (target.hasAttribute('data-refresh')) void refreshRuns();
  else if (target.hasAttribute('data-reconnect')) void connect();
});
const poll = setInterval(() => {
  if (orderedRuns().some(run => run.status === 'executing') || [...state.actions.values()].some(actions => actions.has('execute'))) void refreshRuns(true);
  const run = selectedRun();
  if (run?.status === 'approved' && run.approvalExpiresAt && Date.parse(run.approvalExpiresAt) <= Date.now() && !state.editors.has(run.id)) renderPlan();
}, 2500);
window.addEventListener('pagehide', () => { stopped = true; clearInterval(poll); clearTimeout(toastTimer); });
render();
void mountRetainedHistory(document.querySelector<HTMLElement>('#retained-history')!, count => { state.archiveCount = count; renderHistory(); });
void connect();
