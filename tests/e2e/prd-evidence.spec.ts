import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('Evidence keeps its main heading before the complete PRD callout', async ({ page }) => {
  await page.setContent(await readFile(new URL('../../public/evidence/index.html', import.meta.url), 'utf8'));
  await expect(page.locator('main').getByRole('heading').first()).toHaveJSProperty('tagName', 'H1');
  await expect(page.getByRole('link', { name: '查看完整项目 PRD', exact: true })).toHaveAttribute('href', '/evidence/prd.html');
});
