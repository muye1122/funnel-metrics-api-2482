import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataset, resolveViewer, startRefreshTicker } from './mock-server/index.js';
import {
  computeFunnel,
  createDataset,
  ValidationError,
  HAND_CALC_EXAMPLES,
} from './mock-server/metrics.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(currentDir, 'dist');

export const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    leads: dataset.leads.length,
    logs: dataset.logs.length,
    viewRefreshedAt: dataset.view.refreshedAt,
  });
});

app.get('/api/sales/stats/funnel', (req, res) => {
  try {
    const viewer = resolveViewer(req.header('x-user-id'));
    if (!viewer) {
      return res.status(403).json({ error: 'unknown viewer' });
    }

    const result = computeFunnel(dataset, {
      from: req.query.from,
      to: req.query.to,
      siteId: req.query.site_id || null,
      ownerId: req.query.owner_id || null,
      sourceChannel: req.query.source_channel || null,
      permittedOwnerId: viewer.role === 'consultant' ? viewer.id : null,
      permittedTeamId: viewer.role === 'team_lead' ? viewer.teamId : null,
    });

    return res.json({
      ...result,
      meta: {
        ...result.meta,
        viewer: { id: viewer.id, role: viewer.role },
      },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/sales/stats/funnel/examples', (req, res) => {
  const results = HAND_CALC_EXAMPLES.map((example) => ({
    name: example.name,
    result: computeFunnel(createDataset(example.leads, example.logs), example.filters),
  }));
  return res.json({ results });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '0.0.0.0';
  app.listen(port, host, () => {
    startRefreshTicker();
    console.log(`funnel-metrics-api listening on http://${host}:${port}`);
  });
}
