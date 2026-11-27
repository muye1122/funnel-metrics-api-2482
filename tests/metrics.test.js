import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_SECONDS,
  HAND_CALC_EXAMPLES,
  ValidationError,
  computeFunnel,
  createDataset,
  generateSyntheticDataset,
  makeLead,
  makeLog,
  parseBoundary,
} from '../mock-server/metrics.js';

const JANUARY = { from: '2026-01-01', to: '2026-01-31' };

function shape(result) {
  return {
    cohortSize: result.meta.cohortSize,
    reached: Object.fromEntries(result.stages.map((stage) => [stage.stage, stage.reached])),
    rates: result.stageConversionRates.map((item) => item.rate),
    overallConversionRate: result.overallConversionRate,
    dwell: Object.fromEntries(result.stages.map((stage) => [stage.stage, stage.dwellDays])),
    lostReasonDistribution: result.churn.lostReasonDistribution,
    lostStageDistribution: result.churn.lostStageDistribution,
    bySourceChannel: result.bySourceChannel,
  };
}

function regressionDataset() {
  const lead = makeLead('regression-lead', { registeredAt: '2026-01-01T00:00:00.000Z' });
  const logs = [
    makeLog('r1', lead.id, 'new', {
      enteredAt: '2026-01-01T00:00:00.000Z',
      leftAt: '2026-01-02T00:00:00.000Z',
      dwellSeconds: DAY_SECONDS,
    }),
    makeLog('r2', lead.id, 'contacted', {
      enteredAt: '2026-01-02T00:00:00.000Z',
      leftAt: '2026-01-03T00:00:00.000Z',
      dwellSeconds: DAY_SECONDS,
    }),
    makeLog('r3', lead.id, 'new', {
      enteredAt: '2026-01-03T00:00:00.000Z',
      leftAt: '2026-01-04T00:00:00.000Z',
      dwellSeconds: DAY_SECONDS,
    }),
    makeLog('r4', lead.id, 'contacted', {
      enteredAt: '2026-01-04T00:00:00.000Z',
      leftAt: '2026-01-05T00:00:00.000Z',
      dwellSeconds: DAY_SECONDS,
    }),
  ];
  return createDataset([lead], logs);
}

test('acceptance 1: new -> contacted -> new -> contacted counts contacted once', () => {
  const result = computeFunnel(regressionDataset(), JANUARY);
  const reached = Object.fromEntries(result.stages.map((stage) => [stage.stage, stage.reached]));
  assert.equal(reached.new, 1);
  assert.equal(reached.contacted, 1);
  assert.equal(result.meta.cohortSize, 1);
  assert.equal(result.stages.find((stage) => stage.stage === 'contacted').dwellDays.mean, 1);
});

test('acceptance 2: adjacent conversion is null when the denominator is zero', () => {
  const result = computeFunnel(regressionDataset(), JANUARY);
  const rates = result.stageConversionRates;
  assert.equal(rates[0].rate, 1);
  assert.equal(rates[1].rate, 0);
  assert.equal(rates[2].rate, null);
  assert.equal(rates[3].rate, null);
  assert.equal(rates[4].rate, null);
});

test('acceptance 3: three hand-calculated examples match the API output exactly', () => {
  assert.equal(HAND_CALC_EXAMPLES.length, 3);
  for (const example of HAND_CALC_EXAMPLES) {
    const dataset = createDataset(example.leads, example.logs);
    const result = computeFunnel(dataset, example.filters);
    assert.deepStrictEqual(shape(result), example.expected, example.name);
  }
});

test('cohort boundaries are inclusive and accept an ISO datetime', () => {
  assert.equal(parseBoundary('2026-01-01', false), Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(parseBoundary('2026-01-01', true), Date.parse('2026-01-01T23:59:59.999Z'));
  assert.throws(() => parseBoundary('not-a-date', false), ValidationError);
  assert.throws(
    () => computeFunnel(createDataset([], []), { from: '2026-02-02', to: '2026-02-01' }),
    ValidationError,
  );
});

test('permissions: consultant, team lead and venue manager scopes', () => {
  const dataset = createDataset(
    [
      makeLead('scope-a', {
        ownerId: 'u-consultant-a',
        teamId: 'team-north',
        registeredAt: '2026-01-05T00:00:00.000Z',
      }),
      makeLead('scope-c', {
        ownerId: 'u-consultant-c',
        teamId: 'team-south',
        registeredAt: '2026-01-06T00:00:00.000Z',
      }),
    ],
    [
      makeLog('s1', 'scope-a', 'new', { enteredAt: '2026-01-05T00:00:00.000Z' }),
      makeLog('s2', 'scope-c', 'new', { enteredAt: '2026-01-06T00:00:00.000Z' }),
    ],
  );

  const consultant = computeFunnel(dataset, {
    ...JANUARY,
    ownerId: 'u-consultant-c',
    permittedOwnerId: 'u-consultant-a',
  });
  assert.equal(consultant.meta.cohortSize, 1);
  assert.equal(consultant.meta.ownerId, 'u-consultant-a');

  const teamLead = computeFunnel(dataset, { ...JANUARY, permittedTeamId: 'team-north' });
  assert.equal(teamLead.meta.cohortSize, 1);

  const manager = computeFunnel(dataset, JANUARY);
  assert.equal(manager.meta.cohortSize, 2);
});

test('churn and dwell values use days rounded to one decimal', () => {
  const example = HAND_CALC_EXAMPLES[0];
  const result = computeFunnel(createDataset(example.leads, example.logs), example.filters);
  assert.deepStrictEqual(result.churn, {
    lostReasonDistribution: { timing: 1 },
    lostStageDistribution: { contacted: 1 },
  });
  assert.deepStrictEqual(
    result.stages.find((stage) => stage.stage === 'qualified').dwellDays,
    { mean: 3, median: 3 },
  );
});

test('performance: P95 below 800ms with 100000 synthetic leads and 500000 stage logs', () => {
  const dataset = generateSyntheticDataset({
    seed: 77_001,
    leadCount: 100_000,
    daySpan: 90,
    dense: true,
  });
  assert.ok(dataset.leads.length >= 100_000);
  assert.ok(dataset.logs.length >= 500_000, `log count: ${dataset.logs.length}`);

  const window = { from: '2026-01-01', to: '2026-03-31' };
  for (let index = 0; index < 20; index += 1) computeFunnel(dataset, window);

  const samples = [];
  for (let index = 0; index < 200; index += 1) {
    const startedAt = performance.now();
    computeFunnel(dataset, window);
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95) - 1];

  console.log(JSON.stringify({
    leads: dataset.leads.length,
    logs: dataset.logs.length,
    requests: samples.length,
    p95Ms: Math.round(p95 * 100) / 100,
    limitMs: 800,
  }));
  assert.ok(p95 < 800, `P95 ${p95.toFixed(2)}ms exceeded 800ms`);
});
