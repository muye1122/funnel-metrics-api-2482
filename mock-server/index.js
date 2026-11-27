import { generateSyntheticDataset, refreshMaterializedView } from './metrics.js';

export const USERS = {
  'u-consultant-a': {
    id: 'u-consultant-a',
    role: 'consultant',
    teamId: 'team-north',
    siteId: 'site-main',
  },
  'u-consultant-b': {
    id: 'u-consultant-b',
    role: 'consultant',
    teamId: 'team-north',
    siteId: 'site-main',
  },
  'u-consultant-c': {
    id: 'u-consultant-c',
    role: 'consultant',
    teamId: 'team-south',
    siteId: 'site-annex',
  },
  'u-lead-north': {
    id: 'u-lead-north',
    role: 'team_lead',
    teamId: 'team-north',
    siteId: 'site-main',
  },
  'u-manager': {
    id: 'u-manager',
    role: 'venue_manager',
    teamId: null,
    siteId: 'site-main',
  },
};

export const DEFAULT_VIEWER_ID = 'u-manager';

export function resolveViewer(userId) {
  if (!userId) return USERS[DEFAULT_VIEWER_ID];
  return USERS[userId] ?? null;
}

export const dataset = generateSyntheticDataset();

export function refreshNow() {
  return refreshMaterializedView(dataset);
}

const refreshInterval = Number(process.env.VIEW_REFRESH_INTERVAL_MS ?? 3_600_000);
let refreshTimer = null;

export function startRefreshTicker() {
  if (refreshTimer) return refreshTimer;
  refreshTimer = setInterval(refreshNow, refreshInterval);
  refreshTimer.unref?.();
  return refreshTimer;
}

export function stopRefreshTicker() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}
