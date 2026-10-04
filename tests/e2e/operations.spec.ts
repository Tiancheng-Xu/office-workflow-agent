import { test, expect } from '@playwright/test';
import { runCrashQA } from '../../scripts/qa-crash.ts';
import { runLoadQA } from '../../scripts/qa-load.ts';
test('real child process SIGKILL recovers before and after an actual form effect without reissuing a browser', async () => {
  test.setTimeout(70_000);
  const report = await runCrashQA();
  expect(report.denominator).toBe(2); expect(report.passed).toBe(2);
});
test('bounded load measures real HTTP API denominator and five real Chromium business registrations', async () => {
  test.setTimeout(90_000);
  const report = await runLoadQA();
  expect(report.measuredRequestDenominator).toBe(165);
  expect(report.groups.every(group => group.errors === 0)).toBe(true);
});
