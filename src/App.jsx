import { useEffect, useState } from 'react';

const VIEWERS = [
  { id: 'u-manager', label: 'Venue manager' },
  { id: 'u-lead-north', label: 'Team lead - north' },
  { id: 'u-consultant-a', label: 'Consultant A' },
];

const CHANNELS = ['', 'referral', 'event', 'webinar', 'outbound'];

function formatRate(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatDays(value) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(1);
}

export default function App() {
  const [form, setForm] = useState({
    from: '2026-01-01',
    to: '2026-04-30',
    siteId: '',
    ownerId: '',
    channel: '',
    viewerId: 'u-manager',
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load(event) {
    if (event) event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ from: form.from, to: form.to });
      if (form.siteId) params.set('site_id', form.siteId);
      if (form.ownerId) params.set('owner_id', form.ownerId);
      if (form.channel) params.set('source_channel', form.channel);
      const response = await fetch(`/api/sales/stats/funnel?${params.toString()}`, {
        headers: { 'x-user-id': form.viewerId },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'request failed');
      setData(body);
    } catch (failure) {
      setError(failure.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  const rateByTarget = new Map(
    (data?.stageConversionRates ?? []).map((item) => [item.to, item.rate]),
  );

  return (
    <main className="shell">
      <header className="hero">
        <h1 data-testid="title">Funnel Metrics Console</h1>
        <p>
          Cohort funnel, stage dwell time, churn and channel split over a fully fictional
          dataset served from the in-memory data layer.
        </p>
      </header>

      <form className="filters" onSubmit={load}>
        <label>
          From
          <input
            type="date"
            value={form.from}
            onChange={(event) => update('from', event.target.value)}
            data-testid="filter-from"
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={form.to}
            onChange={(event) => update('to', event.target.value)}
            data-testid="filter-to"
          />
        </label>
        <label>
          Site
          <input
            value={form.siteId}
            title="Example: site-main"
            onChange={(event) => update('siteId', event.target.value)}
            data-testid="filter-site"
          />
        </label>
        <label>
          Owner
          <input
            value={form.ownerId}
            title="Example: u-consultant-a"
            onChange={(event) => update('ownerId', event.target.value)}
            data-testid="filter-owner"
          />
        </label>
        <label>
          Channel
          <select
            value={form.channel}
            onChange={(event) => update('channel', event.target.value)}
            data-testid="filter-channel"
          >
            {CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {channel === '' ? 'all channels' : channel}
              </option>
            ))}
          </select>
        </label>
        <label>
          Viewer
          <select
            value={form.viewerId}
            onChange={(event) => update('viewerId', event.target.value)}
            data-testid="filter-viewer"
          >
            {VIEWERS.map((viewer) => (
              <option key={viewer.id} value={viewer.id}>
                {viewer.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" data-testid="load-button" disabled={loading}>
          {loading ? 'Loading' : 'Load metrics'}
        </button>
      </form>

      {error && <p className="error" data-testid="error">{error}</p>}

      {data && (
        <section className="results" data-testid="results">
          <div className="cards">
            <article>
              <span className="caption">Cohort size</span>
              <strong data-testid="cohort-size">{data.meta.cohortSize}</strong>
            </article>
            <article>
              <span className="caption">Overall conversion</span>
              <strong data-testid="overall-rate">{formatRate(data.overallConversionRate)}</strong>
            </article>
            <article>
              <span className="caption">Viewer role</span>
              <strong data-testid="viewer-role">{data.meta.viewer.role}</strong>
            </article>
            <article>
              <span className="caption">Reach view refreshed</span>
              <strong className="stamp" data-testid="view-refreshed">
                {data.meta.viewRefreshedAt}
              </strong>
            </article>
          </div>

          {data.meta.cohortSize === 0 ? (
            <p className="notice" data-testid="empty-state">
              empty state: no lead registered in the selected window
            </p>
          ) : (
            <>
              <h2>Stage funnel</h2>
              <table data-testid="funnel-table">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Ever reached</th>
                    <th>From previous</th>
                    <th>Mean dwell (days)</th>
                    <th>Median dwell (days)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stages.map((stage) => (
                    <tr key={stage.stage} data-testid={`row-${stage.stage}`}>
                      <td>{stage.stage}</td>
                      <td data-testid={`reached-${stage.stage}`}>{stage.reached}</td>
                      <td data-testid={`rate-${stage.stage}`}>
                        {formatRate(rateByTarget.get(stage.stage))}
                      </td>
                      <td>{formatDays(stage.dwellDays.mean)}</td>
                      <td>{formatDays(stage.dwellDays.median)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="panels">
                <section>
                  <h2>Churn reasons</h2>
                  <ul data-testid="churn-reasons">
                    {Object.entries(data.churn.lostReasonDistribution).length === 0 ? (
                      <li>empty state: no lost lead</li>
                    ) : (
                      Object.entries(data.churn.lostReasonDistribution).map(([reason, count]) => (
                        <li key={reason}>{`${reason}: ${count}`}</li>
                      ))
                    )}
                  </ul>
                  <h2>Lost at stage</h2>
                  <ul data-testid="churn-stages">
                    {Object.entries(data.churn.lostStageDistribution).length === 0 ? (
                      <li>empty state: no lost lead</li>
                    ) : (
                      Object.entries(data.churn.lostStageDistribution).map(([stage, count]) => (
                        <li key={stage}>{`${stage}: ${count}`}</li>
                      ))
                    )}
                  </ul>
                </section>
                <section>
                  <h2>Source channel split</h2>
                  <table data-testid="channel-table">
                    <thead>
                      <tr>
                        <th>Channel</th>
                        <th>Leads</th>
                        <th>Overall conversion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bySourceChannel.map((item) => (
                        <tr key={item.sourceChannel}>
                          <td>{item.sourceChannel}</td>
                          <td>{item.leadCount}</td>
                          <td>{formatRate(item.overallConversionRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
