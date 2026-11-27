export const STAGES = [
  'new',
  'contacted',
  'qualified',
  'proposal',
  'negotiation',
  'signed',
];

export const DAY_SECONDS = 86_400;

const LOST_REASONS = ['budget', 'timing', 'no_response', 'competitor'];
const CHANNELS = ['referral', 'event', 'webinar', 'outbound'];
const OWNERS = ['u-consultant-a', 'u-consultant-b', 'u-consultant-c'];
const TEAM_BY_OWNER = {
  'u-consultant-a': 'team-north',
  'u-consultant-b': 'team-north',
  'u-consultant-c': 'team-south',
};

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function makeLead(id, overrides = {}) {
  return {
    id,
    orgId: 'org-fictional',
    siteId: 'site-main',
    ownerId: 'u-consultant-a',
    teamId: TEAM_BY_OWNER['u-consultant-a'],
    sourceChannel: 'referral',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeLog(id, leadId, stage, overrides = {}) {
  return {
    id,
    leadId,
    siteId: 'site-main',
    stage,
    enteredAt: '2026-01-01T00:00:00.000Z',
    leftAt: null,
    dwellSeconds: null,
    outcome: 'advanced',
    lostReason: null,
    ...overrides,
  };
}

export function parseBoundary(value, isEnd) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('from and to must be non-empty date strings');
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const text = dateOnly.test(value)
    ? `${value}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z`
    : value;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw new ValidationError(`invalid date: ${value}`);
  }
  return ms;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function mean(values) {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return round1(total / values.length);
}

function selectValue(values, target) {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const pivot = values[(left + right) >> 1];
    let i = left;
    let j = right;
    while (i <= j) {
      while (values[i] < pivot) i += 1;
      while (values[j] > pivot) j -= 1;
      if (i <= j) {
        const temporary = values[i];
        values[i] = values[j];
        values[j] = temporary;
        i += 1;
        j -= 1;
      }
    }
    if (target <= j) right = j;
    else if (target >= i) left = i;
    else return values[target];
  }
  return values[left];
}

function median(values) {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  const result = values.length % 2 === 0
    ? (selectValue(values, middle - 1) + selectValue(values, middle)) / 2
    : selectValue(values, middle);
  return round1(result);
}

/**
 * In-memory equivalent of the SQL materialized view
 * mv_sales_lead_stage_reach: one first-reach timestamp per lead and stage,
 * stored as a flat typed array, plus dwell samples grouped by stage and the
 * latest lost event per lead. Columnar layout keeps repeat queries fast.
 */
export function buildReachView(leads, logs) {
  const leadCount = leads.length;
  const width = STAGES.length;
  const indexById = new Map();
  const registeredMs = new Float64Array(leadCount);
  const ownerIds = new Array(leadCount);
  const teamIds = new Array(leadCount);
  const siteIds = new Array(leadCount);
  const channels = new Array(leadCount);
  const firstReachMs = new Float64Array(leadCount * width).fill(Infinity);
  const reachMask = new Uint8Array(leadCount);
  const dwellByStage = STAGES.map(() => ({ leadIndex: [], days: [] }));
  const lostByLead = new Map();
  const stageIndex = new Map(STAGES.map((stage, index) => [stage, index]));

  for (let index = 0; index < leadCount; index += 1) {
    const lead = leads[index];
    indexById.set(lead.id, index);
    registeredMs[index] = Date.parse(lead.registeredAt);
    ownerIds[index] = lead.ownerId;
    teamIds[index] = lead.teamId;
    siteIds[index] = lead.siteId;
    channels[index] = lead.sourceChannel;
  }

  for (const log of logs) {
    const index = indexById.get(log.leadId);
    if (index === undefined) continue;
    const stageIdx = stageIndex.get(log.stage);
    if (stageIdx === undefined) continue;
    const enteredMs = Date.parse(log.enteredAt);
    if (!Number.isFinite(enteredMs)) continue;

    const cell = index * width + stageIdx;
    if (enteredMs < firstReachMs[cell]) firstReachMs[cell] = enteredMs;
    reachMask[index] |= 1 << stageIdx;

    if (log.leftAt !== null && log.leftAt !== undefined && Number.isFinite(log.dwellSeconds)) {
      dwellByStage[stageIdx].leadIndex.push(index);
      dwellByStage[stageIdx].days.push(log.dwellSeconds / DAY_SECONDS);
    }

    if (log.outcome === 'lost') {
      const existing = lostByLead.get(index);
      if (!existing || enteredMs >= Date.parse(existing.enteredAt)) {
        lostByLead.set(index, log);
      }
    }
  }

  return {
    indexById,
    registeredMs,
    ownerIds,
    teamIds,
    siteIds,
    channels,
    firstReachMs,
    reachMask,
    dwellByStage,
    lostByLead,
    leadCount,
    logCount: logs.length,
    refreshedAt: new Date().toISOString(),
  };
}

export function createDataset(leads, logs) {
  return { leads, logs, view: buildReachView(leads, logs) };
}

/** Equivalent of REFRESH MATERIALIZED VIEW CONCURRENTLY, applied to memory. */
export function refreshMaterializedView(dataset) {
  const next = buildReachView(dataset.leads, dataset.logs);
  dataset.view = next;
  return next;
}

/**
 * Aggregate the funnel for one cohort.
 * options: from, to, siteId, ownerId, sourceChannel,
 *          permittedOwnerId (consultant), permittedTeamId (team lead).
 */
export function computeFunnel(dataset, options = {}) {
  const { from, to } = options;
  const fromMs = parseBoundary(from, false);
  const toMs = parseBoundary(to, true);
  if (fromMs > toMs) {
    throw new ValidationError('from must not be after to');
  }

  let effectiveOwnerId = options.ownerId ?? null;
  if (options.permittedOwnerId) effectiveOwnerId = options.permittedOwnerId;

  const view = dataset.view;
  const leads = dataset.leads;
  const flags = new Uint8Array(leads.length);
  let cohortSize = 0;

  for (let index = 0; index < leads.length; index += 1) {
    const registered = view.registeredMs[index];
    if (!(registered >= fromMs && registered <= toMs)) continue;
    if (options.siteId && view.siteIds[index] !== options.siteId) continue;
    if (effectiveOwnerId && view.ownerIds[index] !== effectiveOwnerId) continue;
    if (options.permittedTeamId && view.teamIds[index] !== options.permittedTeamId) continue;
    if (options.sourceChannel && view.channels[index] !== options.sourceChannel) continue;
    flags[index] = 1;
    cohortSize += 1;
  }

  const reachedCounts = new Array(STAGES.length).fill(0);
  for (let index = 0; index < leads.length; index += 1) {
    if (!flags[index]) continue;
    const mask = view.reachMask[index];
    for (let stageIdx = 0; stageIdx < STAGES.length; stageIdx += 1) {
      if (mask & (1 << stageIdx)) reachedCounts[stageIdx] += 1;
    }
  }

  const stages = STAGES.map((stage, stageIdx) => {
    const samples = [];
    const bucket = view.dwellByStage[stageIdx];
    for (let sampleIdx = 0; sampleIdx < bucket.leadIndex.length; sampleIdx += 1) {
      if (flags[bucket.leadIndex[sampleIdx]]) samples.push(bucket.days[sampleIdx]);
    }
    return {
      stage,
      reached: reachedCounts[stageIdx],
      dwellDays: { mean: mean(samples), median: median(samples) },
    };
  });

  const stageConversionRates = [];
  for (let index = 0; index < STAGES.length - 1; index += 1) {
    const current = reachedCounts[index];
    const next = reachedCounts[index + 1];
    stageConversionRates.push({
      from: STAGES[index],
      to: STAGES[index + 1],
      rate: current === 0 ? null : next / current,
    });
  }

  const overallConversionRate = cohortSize === 0
    ? null
    : reachedCounts[STAGES.length - 1] / cohortSize;

  const lostReasonDistribution = {};
  const lostStageDistribution = {};
  for (const [index, log] of view.lostByLead) {
    if (!flags[index]) continue;
    const reason = log.lostReason ?? 'unspecified';
    lostReasonDistribution[reason] = (lostReasonDistribution[reason] ?? 0) + 1;
    lostStageDistribution[log.stage] = (lostStageDistribution[log.stage] ?? 0) + 1;
  }

  const channelMap = new Map();
  const signedBit = 1 << (STAGES.length - 1);
  for (let index = 0; index < leads.length; index += 1) {
    if (!flags[index]) continue;
    const channel = view.channels[index];
    let group = channelMap.get(channel);
    if (!group) {
      group = { leadCount: 0, signed: 0 };
      channelMap.set(channel, group);
    }
    group.leadCount += 1;
    if (view.reachMask[index] & signedBit) group.signed += 1;
  }
  const bySourceChannel = [...channelMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sourceChannel, group]) => ({
      sourceChannel,
      leadCount: group.leadCount,
      overallConversionRate: group.signed / group.leadCount,
    }));

  return {
    meta: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      siteId: options.siteId ?? null,
      ownerId: effectiveOwnerId,
      sourceChannel: options.sourceChannel ?? null,
      cohortSize,
      viewRefreshedAt: view.refreshedAt,
      viewLogCount: view.logCount,
    },
    stages,
    stageConversionRates,
    overallConversionRate,
    churn: { lostReasonDistribution, lostStageDistribution },
    bySourceChannel,
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isoFromStart(startMs, dayOffset) {
  return new Date(startMs + dayOffset * DAY_SECONDS * 1000).toISOString();
}

/** Deterministic 100% fictional dataset; no real person or organisation data. */
export function generateSyntheticDataset({
  seed = 20_261_127,
  leadCount = 240,
  start = '2026-01-01T00:00:00.000Z',
  daySpan = 90,
  dense = false,
} = {}) {
  const random = mulberry32(seed);
  const startMs = Date.parse(start);
  const leads = [];
  const logs = [];
  let logSequence = 0;

  for (let index = 0; index < leadCount; index += 1) {
    const ownerId = OWNERS[Math.floor(random() * OWNERS.length)];
    const leadId = `lead-synthetic-${String(index + 1).padStart(5, '0')}`;
    const registeredDay = Math.floor(random() * daySpan);
    const siteId = random() < 0.85 ? 'site-main' : 'site-annex';
    leads.push(
      makeLead(leadId, {
        ownerId,
        teamId: TEAM_BY_OWNER[ownerId],
        siteId,
        sourceChannel: CHANNELS[Math.floor(random() * CHANNELS.length)],
        registeredAt: isoFromStart(startMs, registeredDay),
      }),
    );

    const isLost = random() < 0.28;
    const depth = dense
      ? 5 + Math.floor(random() * 2)
      : isLost
        ? 1 + Math.floor(random() * 4)
        : 1 + Math.floor(random() * STAGES.length);
    let cursorDay = registeredDay;

    const appendLog = (stage, extra = {}) => {
      logSequence += 1;
      const dwellDays = 0.2 + random() * 4.8;
      cursorDay += dwellDays;
      const leftAt = isoFromStart(startMs, cursorDay);
      logs.push(
        makeLog(`log-synthetic-${String(logSequence).padStart(6, '0')}`, leadId, stage, {
          siteId,
          enteredAt: isoFromStart(startMs, cursorDay - dwellDays),
          leftAt,
          dwellSeconds: Math.round(dwellDays * DAY_SECONDS),
          ...extra,
        }),
      );
    };

    const hasRegression = index % 17 === 0 && depth >= 2;
    if (hasRegression) {
      appendLog('new');
      appendLog('contacted');
      appendLog('new');
      appendLog('contacted');
    }

    for (let stageIndex = 0; stageIndex < depth; stageIndex += 1) {
      const isFinal = stageIndex === depth - 1;
      if (isFinal && !isLost && STAGES[stageIndex] === 'signed') {
        logSequence += 1;
        const enteredAt = isoFromStart(startMs, cursorDay);
        logs.push(
          makeLog(`log-synthetic-${String(logSequence).padStart(6, '0')}`, leadId, 'signed', {
            siteId,
            enteredAt,
          }),
        );
        continue;
      }
      appendLog(STAGES[stageIndex], {
        outcome: isFinal && isLost ? 'lost' : 'advanced',
        lostReason: isFinal && isLost
          ? LOST_REASONS[Math.floor(random() * LOST_REASONS.length)]
          : null,
      });
    }
  }

  return createDataset(leads, logs);
}

const days = (count) => count * DAY_SECONDS;

export const HAND_CALC_EXAMPLES = [
  {
    name: 'regression is counted once and a zero denominator yields null',
    filters: { from: '2026-01-01', to: '2026-01-31' },
    leads: [
      makeLead('hand-a', { registeredAt: '2026-01-01T00:00:00.000Z' }),
      makeLead('hand-b', { registeredAt: '2026-01-02T00:00:00.000Z' }),
    ],
    logs: [
      makeLog('hand-l1', 'hand-a', 'new', {
        enteredAt: '2026-01-01T00:00:00.000Z',
        leftAt: '2026-01-02T00:00:00.000Z',
        dwellSeconds: days(1),
      }),
      makeLog('hand-l2', 'hand-a', 'contacted', {
        enteredAt: '2026-01-02T00:00:00.000Z',
        leftAt: '2026-01-04T00:00:00.000Z',
        dwellSeconds: days(2),
      }),
      makeLog('hand-l3', 'hand-a', 'new', {
        enteredAt: '2026-01-04T00:00:00.000Z',
        leftAt: '2026-01-05T00:00:00.000Z',
        dwellSeconds: days(1),
      }),
      makeLog('hand-l4', 'hand-a', 'contacted', {
        enteredAt: '2026-01-05T00:00:00.000Z',
        leftAt: '2026-01-06T00:00:00.000Z',
        dwellSeconds: days(1),
      }),
      makeLog('hand-l5', 'hand-a', 'qualified', {
        enteredAt: '2026-01-06T00:00:00.000Z',
        leftAt: '2026-01-09T00:00:00.000Z',
        dwellSeconds: days(3),
      }),
      makeLog('hand-l6', 'hand-a', 'signed', {
        enteredAt: '2026-01-09T00:00:00.000Z',
      }),
      makeLog('hand-l7', 'hand-b', 'new', {
        enteredAt: '2026-01-02T00:00:00.000Z',
        leftAt: '2026-01-04T00:00:00.000Z',
        dwellSeconds: days(2),
      }),
      makeLog('hand-l8', 'hand-b', 'contacted', {
        enteredAt: '2026-01-04T00:00:00.000Z',
        leftAt: '2026-01-05T00:00:00.000Z',
        dwellSeconds: days(1),
        outcome: 'lost',
        lostReason: 'timing',
      }),
    ],
    expected: {
      cohortSize: 2,
      reached: { new: 2, contacted: 2, qualified: 1, proposal: 0, negotiation: 0, signed: 1 },
      rates: [1, 0.5, 0, null, null],
      overallConversionRate: 0.5,
      dwell: {
        new: { mean: 1.3, median: 1 },
        contacted: { mean: 1.3, median: 1 },
        qualified: { mean: 3, median: 3 },
        proposal: { mean: null, median: null },
        negotiation: { mean: null, median: null },
        signed: { mean: null, median: null },
      },
      lostReasonDistribution: { timing: 1 },
      lostStageDistribution: { contacted: 1 },
      bySourceChannel: [{ sourceChannel: 'referral', leadCount: 2, overallConversionRate: 0.5 }],
    },
  },
  {
    name: 'single new lead leaves every later denominator empty',
    filters: { from: '2026-02-01', to: '2026-02-28' },
    leads: [makeLead('hand-c', { registeredAt: '2026-02-01T00:00:00.000Z' })],
    logs: [
      makeLog('hand-l9', 'hand-c', 'new', { enteredAt: '2026-02-01T00:00:00.000Z' }),
    ],
    expected: {
      cohortSize: 1,
      reached: { new: 1, contacted: 0, qualified: 0, proposal: 0, negotiation: 0, signed: 0 },
      rates: [0, null, null, null, null],
      overallConversionRate: 0,
      dwell: {
        new: { mean: null, median: null },
        contacted: { mean: null, median: null },
        qualified: { mean: null, median: null },
        proposal: { mean: null, median: null },
        negotiation: { mean: null, median: null },
        signed: { mean: null, median: null },
      },
      lostReasonDistribution: {},
      lostStageDistribution: {},
      bySourceChannel: [{ sourceChannel: 'referral', leadCount: 1, overallConversionRate: 0 }],
    },
  },
  {
    name: 'channel split with an even sample size for median',
    filters: { from: '2026-03-01', to: '2026-03-31' },
    leads: [
      makeLead('hand-d', { registeredAt: '2026-03-01T00:00:00.000Z' }),
      makeLead('hand-e', { registeredAt: '2026-03-02T00:00:00.000Z' }),
      makeLead('hand-f', {
        registeredAt: '2026-03-03T00:00:00.000Z',
        sourceChannel: 'event',
      }),
    ],
    logs: [
      makeLog('hand-l10', 'hand-d', 'new', {
        enteredAt: '2026-03-01T00:00:00.000Z',
        leftAt: '2026-03-02T00:00:00.000Z',
        dwellSeconds: days(1),
      }),
      makeLog('hand-l11', 'hand-d', 'contacted', {
        enteredAt: '2026-03-02T00:00:00.000Z',
        leftAt: '2026-03-04T00:00:00.000Z',
        dwellSeconds: days(2),
      }),
      makeLog('hand-l12', 'hand-d', 'qualified', {
        enteredAt: '2026-03-04T00:00:00.000Z',
        leftAt: '2026-03-07T00:00:00.000Z',
        dwellSeconds: days(3),
      }),
      makeLog('hand-l13', 'hand-d', 'proposal', {
        enteredAt: '2026-03-07T00:00:00.000Z',
        leftAt: '2026-03-08T00:00:00.000Z',
        dwellSeconds: days(1),
      }),
      makeLog('hand-l14', 'hand-d', 'negotiation', {
        enteredAt: '2026-03-08T00:00:00.000Z',
        leftAt: '2026-03-10T00:00:00.000Z',
        dwellSeconds: days(2),
      }),
      makeLog('hand-l15', 'hand-d', 'signed', { enteredAt: '2026-03-10T00:00:00.000Z' }),
      makeLog('hand-l16', 'hand-e', 'new', {
        enteredAt: '2026-03-02T00:00:00.000Z',
        leftAt: '2026-03-04T00:00:00.000Z',
        dwellSeconds: days(2),
      }),
      makeLog('hand-l17', 'hand-e', 'contacted', {
        enteredAt: '2026-03-04T00:00:00.000Z',
        leftAt: '2026-03-07T00:00:00.000Z',
        dwellSeconds: days(3),
      }),
      makeLog('hand-l18', 'hand-e', 'qualified', {
        enteredAt: '2026-03-07T00:00:00.000Z',
        leftAt: '2026-03-08T00:00:00.000Z',
        dwellSeconds: days(1),
      }),
      makeLog('hand-l19', 'hand-e', 'proposal', {
        enteredAt: '2026-03-08T00:00:00.000Z',
        leftAt: '2026-03-10T00:00:00.000Z',
        dwellSeconds: days(2),
      }),
      makeLog('hand-l20', 'hand-e', 'negotiation', {
        enteredAt: '2026-03-10T00:00:00.000Z',
        leftAt: '2026-03-11T00:00:00.000Z',
        dwellSeconds: days(1),
      }),
      makeLog('hand-l21', 'hand-e', 'signed', { enteredAt: '2026-03-11T00:00:00.000Z' }),
      makeLog('hand-l22', 'hand-f', 'new', {
        enteredAt: '2026-03-03T00:00:00.000Z',
        leftAt: '2026-03-06T00:00:00.000Z',
        dwellSeconds: days(3),
      }),
      makeLog('hand-l23', 'hand-f', 'contacted', {
        enteredAt: '2026-03-06T00:00:00.000Z',
        leftAt: '2026-03-07T00:00:00.000Z',
        dwellSeconds: days(1),
      }),
      makeLog('hand-l24', 'hand-f', 'qualified', {
        enteredAt: '2026-03-07T00:00:00.000Z',
        leftAt: '2026-03-09T00:00:00.000Z',
        dwellSeconds: days(2),
        outcome: 'lost',
        lostReason: 'budget',
      }),
    ],
    expected: {
      cohortSize: 3,
      reached: { new: 3, contacted: 3, qualified: 3, proposal: 2, negotiation: 2, signed: 2 },
      rates: [1, 1, 2 / 3, 1, 1],
      overallConversionRate: 2 / 3,
      dwell: {
        new: { mean: 2, median: 2 },
        contacted: { mean: 2, median: 2 },
        qualified: { mean: 2, median: 2 },
        proposal: { mean: 1.5, median: 1.5 },
        negotiation: { mean: 1.5, median: 1.5 },
        signed: { mean: null, median: null },
      },
      lostReasonDistribution: { budget: 1 },
      lostStageDistribution: { qualified: 1 },
      bySourceChannel: [
        { sourceChannel: 'event', leadCount: 1, overallConversionRate: 0 },
        { sourceChannel: 'referral', leadCount: 2, overallConversionRate: 1 },
      ],
    },
  },
];
