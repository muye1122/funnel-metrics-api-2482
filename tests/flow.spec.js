import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:3001';

test('demo renders a six-stage funnel from the API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('title')).toBeVisible();
  await expect(page.getByTestId('results')).toBeVisible();
  await expect(page.locator('[data-testid="funnel-table"] tbody tr')).toHaveCount(6);
  const cohortSize = Number(await page.getByTestId('cohort-size').textContent());
  expect(cohortSize).toBeGreaterThan(0);
  await expect(page.getByTestId('reached-new')).toHaveText(String(cohortSize));
});

test('hand-calculated examples are reproducible over HTTP', async ({ request }) => {
  const response = await request.get(`${API}/api/sales/stats/funnel/examples`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.results).toHaveLength(3);

  const first = body.results[0].result;
  expect(first.meta.cohortSize).toBe(2);
  expect(first.stageConversionRates[1].rate).toBe(0.5);
  expect(first.stageConversionRates[3].rate).toBeNull();
  expect(first.overallConversionRate).toBe(0.5);
  expect(first.churn.lostReasonDistribution).toEqual({ timing: 1 });
});

test('consultant owner_id is forced to the current viewer', async ({ request }) => {
  const url = `${API}/api/sales/stats/funnel?from=2026-01-01&to=2026-04-30&owner_id=u-consultant-c`;
  const response = await request.get(url, { headers: { 'x-user-id': 'u-consultant-a' } });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.meta.viewer.role).toBe('consultant');
  expect(body.meta.ownerId).toBe('u-consultant-a');
  expect(body.bySourceChannel.every((item) => item.leadCount > 0)).toBeTruthy();
});

test('date window without leads renders an empty state', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('filter-from').fill('2029-01-01');
  await page.getByTestId('filter-to').fill('2029-01-31');
  await page.getByTestId('load-button').click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('channel filter narrows the cohort', async ({ request }) => {
  const base = `${API}/api/sales/stats/funnel?from=2026-01-01&to=2026-04-30`;
  const all = await (await request.get(base)).json();
  const referral = await (await request.get(`${base}&source_channel=referral`)).json();
  expect(referral.meta.cohortSize).toBeLessThan(all.meta.cohortSize);
  expect(referral.bySourceChannel).toHaveLength(1);
  expect(referral.bySourceChannel[0].sourceChannel).toBe('referral');
});
