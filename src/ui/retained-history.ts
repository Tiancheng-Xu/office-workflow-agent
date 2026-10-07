import { z } from 'zod';

const text = z.string().max(2000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({
  recordId: z.string().regex(/^case-(0[1-9]|10)$/), title: text,
  actualEndStage: z.string().regex(/^[A-Z_]+$/),
  runStatus: z.enum(['draft','approved','executing','unknown','verified','blocked','cancelled']).nullable(),
  effectStatus: z.enum(['none','unknown','applied']).nullable(),
  startedAt: z.string().datetime(), endedAt: z.string().datetime(),
  assertionsPassed: z.number().int().nonnegative(), assertionsFailed: z.literal(0),
  url: z.string(), publishedSHA256: digest,
}).refine(r => r.url === `/evidence/flows/${r.recordId}.json`);
const indexSchema = z.object({
  schema: z.literal('officeflow-public-retained-flows-v1'), syntheticOnly: z.literal(true),
  scope: z.literal('local HTTP + SQLite + real headless Chromium only; no cloud acceptance'),
  recordCount: z.literal(10), uniqueActualEndStages: z.literal(10), records: z.array(recordSchema).length(10),
}).refine(i => new Set(i.records.map(r => r.recordId)).size === 10 && new Set(i.records.map(r => r.actualEndStage)).size === 10);
const detailSchema = z.object({
  schema: z.literal('officeflow-retained-local-flow-v1'), syntheticOnly: z.literal(true),
  recordId: text, actualEndStage: text, startedAt: text, endedAt: text,
  runStatus: recordSchema.innerType().shape.runStatus, effectStatus: recordSchema.innerType().shape.effectStatus,
  steps: z.array(z.object({ sequence: z.number().int().positive(), name: text, kind: text,
    method: text.optional(), completedAt: text.optional(), response: z.object({status:z.number().int()}).optional(),
  })).max(100),
  endEvidence: z.object({observation:text}),
  proofObservation: z.object({proof:z.object({api:z.object({status:text})})}).nullable(),
});
const esc = (value: unknown) => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const date = (value: string) => new Date(value).toLocaleString('zh-CN', {hour12:false});

export async function mountRetainedHistory(container: HTMLElement, onCount: (count: number) => void): Promise<void> {
  container.innerHTML = '<p role="status">正在读取本地测试历史…</p>';
  try {
    const response = await fetch('/evidence/retained-flows.json', {credentials:'omit', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('历史索引暂不可用');
    const index = indexSchema.parse(await response.json());
    onCount(index.recordCount);
    container.innerHTML = `<div class="archive-heading"><h3>本地全流程历史 <span>${index.recordCount}</span></h3><p>本地测试历史 · 10 个不同结束节点 · 只读归档</p><p>保留原执行时间与结果；不计入当前会话登记数，也不会重放操作。</p></div><div class="archive-list">${index.records.map(r => `<details class="archive-record" data-record="${esc(r.recordId)}"><summary><span><strong>${esc(r.recordId)} · ${esc(r.title)}</strong><small>${esc(date(r.startedAt))} · ${r.assertionsPassed} 项断言通过</small></span><span class="archive-stage">${esc(r.actualEndStage)}</span></summary><div class="archive-detail" role="status">展开后读取完整过程。</div></details>`).join('')}</div>`;
    for (const element of Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-record]'))) {
      const record = index.records.find(r => r.recordId === element.dataset.record)!;
      const panel = element.querySelector<HTMLElement>('.archive-detail')!;
      let loaded = false, loading = false;
      element.addEventListener('toggle', async () => {
        if (!element.open || loaded || loading) return;
        loading = true; panel.textContent = '正在校验历史报告…';
        try {
          const reply = await fetch(record.url, {credentials:'omit', signal:AbortSignal.timeout(10000)});
          if (!reply.ok) throw new Error('历史报告暂不可用');
          const bytes = await reply.arrayBuffer();
          const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
          if (actual !== record.publishedSHA256) throw new Error('报告校验失败');
          const detail = detailSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
          if (detail.recordId !== record.recordId || detail.actualEndStage !== record.actualEndStage || detail.startedAt !== record.startedAt || detail.endedAt !== record.endedAt || detail.runStatus !== record.runStatus || detail.effectStatus !== record.effectStatus) throw new Error('报告与索引不一致');
          panel.innerHTML = `<p>本地历史快照 · 内容校验通过</p><dl><div><dt>实际结束节点</dt><dd>${esc(detail.actualEndStage)}</dd></div><div><dt>当时运行 / 持久效果</dt><dd>${esc(detail.runStatus)} / ${esc(detail.effectStatus)}</dd></div><div><dt>原始结束时间</dt><dd>${esc(date(detail.endedAt))}</dd></div></dl><p>历史 API 核对：${esc(detail.proofObservation?.proof.api.status ?? '未到达核对阶段')}</p><ol class="archive-steps">${detail.steps.map(s => `<li><strong>${esc(s.name)}</strong><small>${esc(s.kind)}${s.method ? ` · ${esc(s.method)}` : ''}${s.response ? ` · HTTP ${s.response.status}` : ''}</small></li>`).join('')}</ol><p>${esc(detail.endEvidence.observation)}</p><a href="${esc(record.url)}" target="_blank" rel="noopener">查看原始历史报告 JSON</a>`;
          loaded = true;
        } catch { panel.innerHTML = '<p role="alert">历史报告读取或校验失败。请收起后重新展开；当前工作区不受影响。</p>'; }
        finally { loading = false; }
      });
    }
  } catch {
    onCount(0);
    container.innerHTML = '<p role="alert">本地历史暂不可用。<button type="button" data-retry-archive>重新读取历史</button></p>';
    container.querySelector('[data-retry-archive]')?.addEventListener('click', () => { void mountRetainedHistory(container, onCount); });
  }
}
