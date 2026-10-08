import {quantityLabel,units} from '../procurement-fields.js';
import {departments,items} from '../catalog.js';
import {extractDemand,demandText,newRequestId,demandKey} from '../demand-input.js';
import type { Plan, Run } from '../contracts.js';
import { boundedRulePlan } from '../planner.js';
import { escapeText as esc } from './html.js';

interface IntakeRow { line: number; text: string; normalized?:string; plan?: Plan; issue?: string; run?: Run; outcome?: 'created' | 'uncertain' | 'rejected'; }
interface IntakePorts {
  runs: () => Run[];
  sessionKey: () => number | null;
  available: () => boolean;
  setBusy: (busy: boolean) => void;
  list: () => Promise<Run[]>;
  create: (text: string) => Promise<Run>;
  select: (id: string) => void;
  uncertainFailure: (error: unknown) => boolean;
}
function sameFields(plan: Plan, run: Run): boolean {
  return ['requestId', 'department', 'item', 'quantity', 'unit', 'reason'].every(key => plan[key as keyof Plan] === run.plan[key as keyof Plan]);
}
export function mountIntake(container: HTMLElement, ports: IntakePorts) {
  let rows: IntakeRow[] = [];
  let busy = false;
  let generation = 0;
  // A missing response must not turn into an automatic repeat after rechecking the text.
  const uncertainIds = new Set<string>();
  const generatedIds=new Map<string,string>();
  container.innerHTML = `<details class="intake-details" open><summary><strong>批量准备需求</strong><span>逐行校验 → 未批准草稿 → 逐条登记</span></summary><div class="intake-body"><p>每行一个自然语言需求，最多 10 条。自动整理中文数量和别名，缺少编号时生成稳定编号。准备内容仅保留在此页；已生成的草稿保存在当前工作区。</p><details class="intake-template"><summary>用字段模板追加一条</summary><form id="intake-template"><div class="template-fields"><label>部门<select name="department">${departments.map(v=>`<option>${v}</option>`).join('')}</select></label><label>品类<input name="item" required minlength="1" maxlength="64" placeholder="A4纸" value="显示器"></label><label>数量<input name="quantity" type="number" min="1" max="100" step="1" required value="1"></label><label>计量单位<select name="unit">${units.map(v=>`<option>${v}</option>`).join('')}</select></label><label>需求编号<input name="requestId" pattern="REQ-[A-Z0-9\\-]{3,48}" maxlength="52" required placeholder="REQ-TEAM-001"></label></div><button type="submit" class="button ghost small">追加到清单</button></form></details><label for="batch-text">多条采购需求</label><textarea id="batch-text" rows="5" maxlength="12000" placeholder="为研发部登记12台显示器，需求编号REQ-BATCH-001&#10;为行政部登记6把办公椅，需求编号REQ-BATCH-002"></textarea><div class="intake-actions"><button type="button" class="button secondary" id="intake-check">校验清单</button><button type="button" class="button primary" id="intake-create" disabled>生成通过校验的草稿</button><button type="button" class="button ghost" id="intake-recover" hidden>查询已有草稿</button></div><p id="intake-notice" aria-live="polite"></p><div id="intake-rows"></div><p class="intake-footnote">草稿逐条确认与执行。前一条登记后，后续草稿需「刷新目标并重新预览」，再人工确认；本清单不会自动批准或登记。</p></div></details>`;
  const input = container.querySelector<HTMLTextAreaElement>('#batch-text')!;
  const notice = container.querySelector<HTMLElement>('#intake-notice')!;
  const result = container.querySelector<HTMLElement>('#intake-rows')!;
  const createButton = container.querySelector<HTMLButtonElement>('#intake-create')!;
  const checkButton = container.querySelector<HTMLButtonElement>('#intake-check')!;
  const recoverButton = container.querySelector<HTMLButtonElement>('#intake-recover')!;
  const template = container.querySelector<HTMLFormElement>('#intake-template')!;
  const eligible = (row: IntakeRow) => !!row.plan && !row.issue && !row.outcome && !row.run;
  function availability() {
    createButton.disabled = busy || !ports.available() || !rows.some(eligible);
    checkButton.disabled = busy;
    input.disabled = busy;
    template.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = busy; });
    recoverButton.hidden = !rows.some(row => row.outcome === 'uncertain');
    recoverButton.disabled = busy || !ports.available();
  }
  function render() {
    result.innerHTML = rows.map(row => `<article class="intake-row" data-intake-row="${row.line}"><strong>第 ${row.line} 行${row.plan ? ` · ${esc(row.plan.requestId)}` : ''}</strong>${row.plan ? `<p>${esc(row.plan.department)} · ${esc(row.plan.item)} · ${esc(quantityLabel(row.plan))}</p><small>${esc(row.plan.reason)} · 有界规则预检</small>` : ''}<p class="${row.issue ? 'intake-warning' : 'intake-ready'}">${esc(row.issue ?? (row.outcome === 'created' ? '已生成未批准草稿' : '字段完整 · 可以准备草稿'))}</p>${row.run ? `<button type="button" class="button ghost small" data-intake-select="${esc(row.run.id)}">查看原记录 · ${esc(row.run.plan.requestId)}</button>` : ''}</article>`).join('');
    availability();
  }
  function duplicateCheck(runs: Run[]) {
    const mentions: string[][] = rows.map(row => (row.normalized??row.text).match(/(?<![A-Za-z0-9_-])REQ-[^\s，。；、,:：;!?！？()（）]+/g) ?? []);
    for (const row of rows) {
      if (!row.plan || row.outcome) continue;
      if (mentions.filter(ids => ids.includes(row.plan!.requestId)).length > 1) row.issue = /REQ-/.test(row.text)?'清单内编号重复；请为每条需求使用不同编号。':'清单内有相同的无编号需求；若是独立采购，请填写不同的需求编号。';
      else if (uncertainIds.has(row.plan.requestId)) { row.outcome = 'uncertain'; row.issue = '提案结果待确认；先查询已有草稿，不会自动重发。'; }
      else {
        const existing = runs.find(run => run.plan.requestId === row.plan!.requestId);
        if (existing) { row.run = existing; row.issue = '当前工作区已有这个编号；请查看原记录。'; }
      }
    }
  }
  function check() {
    if (busy) return;
    const lines = input.value.split(/\r?\n/).map((text, index) => ({text: text.trim(), line: index + 1})).filter(row => row.text);
    rows = [];
    if (!lines.length || lines.length > 10) { notice.textContent = '请提供 1–10 条需求；超出上限时整份清单不会创建。'; render(); return; }
    rows = lines.map(row => {
      try {
        const extraction=extractDemand(row.text);if(extraction.issues.length)throw new Error(extraction.issues.map(i=>i.message).join(' '));
        const {department,item,quantity,unit}=extraction.fields;if(!department||!item||quantity===undefined)throw new Error('请补全部门、品类和数量。');
        const key=demandKey(extraction.fields);const requestId=extraction.fields.requestId||generatedIds.get(key)||newRequestId();if(!extraction.fields.requestId)generatedIds.set(key,requestId);
        const normalized=demandText({department,item,quantity,...(unit?{unit}:{}),requestId});return {...row,normalized,plan:boundedRulePlan(normalized)};
      }
      catch (error) { return {...row, issue: error instanceof Error ? error.message : '字段无法识别。'}; }
    });
    duplicateCheck(ports.runs());
    notice.textContent = `${rows.length} 条需求 · ${rows.filter(eligible).length} 条通过字段校验。预检没有创建草稿或登记。`;
    render();
  }
  function live(key: number | null, started: number) { return key !== null && ports.sessionKey() === key && generation === started; }
  function setBusy(value: boolean) { busy = value; ports.setBusy(value); availability(); }
  async function create() {
    if (busy || !ports.available() || !rows.some(eligible)) return;
    const key = ports.sessionKey(), started = generation;
    setBusy(true);
    try {
      const runs = await ports.list();
      if (!live(key, started)) return;
      duplicateCheck(runs); render();
      for (const row of rows) {
        if (!live(key, started)) return;
        if (!eligible(row)) continue;
        notice.textContent = `正在准备第 ${row.line} 行；仅创建未批准草稿。`;
        try {
          const run = await ports.create(row.normalized??row.text);
          if (!live(key, started)) return;
          if (!sameFields(row.plan!, run) || run.status !== 'draft' || run.effectStatus !== 'none') throw new Error('提案响应不符合清单，请先查询原记录。');
          row.run = run; row.outcome = 'created'; render();
        } catch (error) {
          if (!live(key, started)) return;
          row.outcome = ports.uncertainFailure(error) ? 'uncertain' : 'rejected';
          if (row.outcome === 'uncertain') uncertainIds.add(row.plan!.requestId);
          row.issue = row.outcome === 'uncertain' ? '提案结果待确认；先查询已有草稿，不会自动重发。' : `创建被拒绝：${error instanceof Error ? error.message : '请求未完成'}`;
          notice.textContent = `第 ${row.line} 行未确认完成，已暂停后续行。已生成草稿保留；剩余行需要再次手动发起。`;
          render(); return;
        }
      }
      notice.textContent = `${rows.filter(row => row.outcome === 'created').length} 条已生成草稿 · ${rows.filter(row => row.issue).length} 条未创建。请逐条打开原记录确认。`;
    } catch (error) { if (live(key, started)) notice.textContent = `无法读取当前工作区，未发起新的提案：${error instanceof Error ? error.message : '读取失败'}`; }
    finally { if (live(key, started)) { setBusy(false); render(); } }
  }
  async function recover() {
    if (busy || !ports.available()) return;
    const key = ports.sessionKey(), started = generation;
    setBusy(true);
    try {
      const runs = await ports.list();
      if (!live(key, started)) return;
      for (const row of rows.filter(row => row.outcome === 'uncertain')) {
        const matches = runs.filter(run => run.plan.requestId === row.plan?.requestId);
        if (matches.length === 1 && sameFields(row.plan!, matches[0]!)) {
          row.run = matches[0]; row.outcome = 'created'; row.issue = '查询找到字段一致的原记录；未重新发送提案。'; uncertainIds.delete(row.plan!.requestId);
        } else if (matches.length) row.issue = '已有记录字段冲突或存在多个同编号草稿；请在执行记录核查，不重发。';
        else row.issue = '暂未查到原记录；仍保留待确认状态，不自动重发。';
      }
      notice.textContent = '已读取当前工作区；查询没有发起新的提案或登记。';
    } catch (error) { if (live(key, started)) notice.textContent = `查询未完成：${error instanceof Error ? error.message : '读取失败'}`; }
    finally { if (live(key, started)) { setBusy(false); render(); } }
  }
  checkButton.addEventListener('click', check);
  createButton.addEventListener('click', () => { void create(); });
  recoverButton.addEventListener('click', () => { void recover(); });
  result.addEventListener('click', event => { const button = (event.target as Element).closest<HTMLElement>('[data-intake-select]'); if (button?.dataset.intakeSelect) ports.select(button.dataset.intakeSelect); });
  input.addEventListener('input', () => { rows = []; result.replaceChildren(); notice.textContent = '输入已修改，请重新校验。'; availability(); });
  template.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !template.reportValidity()) return;
    const data = new FormData(template);
    const text = `为${data.get('department')}登记${data.get('quantity')}${data.get('unit')}${data.get('item')}，需求编号${data.get('requestId')}`;
    try { boundedRulePlan(text); } catch { notice.textContent = '请使用支持的完整字段和整数数量。'; return; }
    if (input.value.split(/\r?\n/).filter(line => line.trim()).length >= 10 || input.value.length + text.length + 1 > 12000) { notice.textContent = '清单已达上限，请先处理已有需求。'; return; }
    input.value = [input.value.trim(), text].filter(Boolean).join('\n'); input.dispatchEvent(new Event('input')); input.focus();
  });
  availability();
  return { sync: availability, reset() { generation++; busy = false; rows = []; uncertainIds.clear();generatedIds.clear(); input.value = ''; template.reset(); result.replaceChildren(); notice.textContent = ''; ports.setBusy(false); availability(); } };
}
