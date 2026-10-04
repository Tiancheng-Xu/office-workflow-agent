import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export const qaBudgets = { browserExecutorMs: 10_000, faultGateMs: 15_000, expectationMs: 20_000, testMs: 45_000 };
export const implementationHashMethod = 'sha256 ordered source manifest path+bytes; recursive src (including origin/cloud worker/proof), migrations, package/lock/index, frozen contract and runtime config; includes untracked implementation';
export function implementationSnapshot() {
  const hash = createHash('sha256');
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path); else files.push(path);
    }
  };
  for (const directory of ['src', 'migrations']) visit(directory);
  files.push('package.json', 'pnpm-lock.yaml', 'index.html', 'specs/office-agent/contract.json', 'tsconfig.json', 'tsconfig.cloud.json', 'wrangler.jsonc', 'wrangler.runtime.jsonc', 'wrangler.runtime-preview.jsonc');
  files.sort();
  for (const file of files) { hash.update(file + '\n'); hash.update(readFileSync(file)); }
  return { hash: hash.digest('hex'), files };
}
export function implementationHash() { return implementationSnapshot().hash; }
export function qaHarnessSnapshot() {
  const files: string[] = [];
  const visit = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) visit(path); else files.push(path); } };
  visit('tests/e2e'); files.push('playwright.config.ts', 'scripts/qa-load.ts', 'scripts/qa-crash.ts'); files.sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file + '\n'); hash.update(readFileSync(file)); }
  return { hash: hash.digest('hex'), files };
}
export function publicEvidenceText(value: string) {
  return value.replaceAll(process.cwd() + '/', '').replace(/\/Users\/[^/\s]+/g, '[user-home]');
}
