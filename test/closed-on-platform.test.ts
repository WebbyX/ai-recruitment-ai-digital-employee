import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NortiaClient } from '../src/api/client'
import { loadConfig } from '../src/config'
import { syncBatch } from '../src/platforms/hiredly/sync'
import { HiredlyRun, type SyncDeps } from '../src/run-state'
import { startFakeApi, type Override } from './helpers/fake-api'
import { app, fakeHiredly, job } from './helpers/fake-hiredly'
import { VALID_KEY } from './helpers/harness'

type FakeApi = Awaited<ReturnType<typeof startFakeApi>>

const CLOSURES = '/api/v1/resumes/closed-on-platform'
const ids = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)
const sentIds = (api: FakeApi) => api.requests.filter((r) => r.path === '/api/v1/resumes').map((r) => r.form?.external_application_id)
const closureRequests = (api: FakeApi) => api.requests.filter((r) => r.path === CLOSURES)

function newRun(api: FakeApi, adapter: ReturnType<typeof fakeHiredly>['adapter'], lines: string[] = []): HiredlyRun {
  const deps: SyncDeps = {
    config: loadConfig({ NORTIA_API_URL: api.url, HIREDLY_EMAIL: 'hr@acme.com' }),
    getSecret: async (account) => ({ nortia_api_key: VALID_KEY, hiredly_password: 'pw' })[account],
    newAdapter: () => adapter,
    throttle: async () => {},
    now: () => new Date(),
    log: (line) => lines.push(line)
  }
  return new HiredlyRun(deps)
}

async function runToEnd(run: HiredlyRun, maxNew = 25) {
  let res
  let calls = 0
  do {
    res = await run.call({ maxNew, dryRun: false })
    calls++
  } while (!res.done && calls < 10)
  return res
}

async function withApi(opts: Parameters<typeof startFakeApi>[0], fn: (api: FakeApi) => Promise<void>) {
  const api = await startFakeApi(opts)
  try {
    await fn(api)
  } finally {
    await api.close()
  }
}

test('known applications the employer closed are reported before the run report', () =>
  withApi({}, async (api) => {
    for (const id of ['k-rej', 'k-off', 'k-kiv']) api.known.add(id)
    const h = fakeHiredly({
      jobs: [job('job-1', 'Chef')],
      apps: {
        'job-1': [
          app('k-rej', { state: 'rejected' }),
          app('u-rej', { state: 'rejected' }),
          app('k-off', { state: 'offered' }),
          app('k-kiv', { state: 'kiv' }),
          app('n1')
        ]
      }
    })
    const res = await newRun(api, h.adapter).call({ maxNew: 25, dryRun: false })
    assert.equal(res.status, 'ok')
    assert.deepEqual(sentIds(api), ['n1'])
    const reports = closureRequests(api)
    assert.equal(reports.length, 1)
    assert.deepEqual(reports[0].json, {
      platform: 'hiredly',
      applications: [
        { external_application_id: 'k-rej', state: 'rejected' },
        { external_application_id: 'k-off', state: 'offered' }
      ]
    })
    const paths = api.requests.map((r) => r.path)
    assert.ok(paths.indexOf(CLOSURES) < paths.indexOf('/api/v1/runs'))
  }))

test('a later batch does not report again what an earlier batch reported', () =>
  withApi({}, async (api) => {
    for (const id of ['k-rej1', 'k-rej2']) api.known.add(id)
    const h = fakeHiredly({
      jobs: [job('job-1', 'Chef')],
      apps: { 'job-1': [app('k-rej1', { state: 'rejected' }), app('n1'), app('n2'), app('k-rej2', { state: 'blacklisted' })] }
    })
    const res = await runToEnd(newRun(api, h.adapter), 1)
    assert.equal(res.status, 'ok')
    assert.deepEqual(sentIds(api), ['n1', 'n2'])
    assert.deepEqual(
      closureRequests(api).map((r) => r.json.applications.map((a: { external_application_id: string }) => a.external_application_id)),
      [['k-rej1'], ['k-rej2']]
    )
  }))

test('closures go out in requests of at most 200', () =>
  withApi({}, async (api) => {
    const closed = ids('k', 1, 450)
    for (const id of closed) api.known.add(id)
    const h = fakeHiredly({
      jobs: [job('job-1', 'Chef')],
      apps: { 'job-1': closed.map((id) => app(id, { state: 'rejected' })) },
      pageSize: 100
    })
    const res = await runToEnd(newRun(api, h.adapter))
    assert.equal(res.status, 'ok')
    assert.deepEqual(
      closureRequests(api).map((r) => r.json.applications.length),
      [200, 200, 50]
    )
  }))

const failures: [string, Override][] = [
  ['a 500', (r) => (r.path === CLOSURES ? { status: 500 } : undefined)],
  ['a 404 from an older server', (r) => (r.path === CLOSURES ? { status: 404 } : undefined)],
  ['a 403', (r) => (r.path === CLOSURES ? { status: 403 } : undefined)],
  ['a 429', (r) => (r.path === CLOSURES ? { status: 429, headers: { 'retry-after': '60' } } : undefined)],
  ['a dropped connection', (r) => (r.path === CLOSURES ? { status: 0, destroy: true } : undefined)]
]
for (const [name, override] of failures) {
  test(`${name} on the closures is logged, stops the rest of them and the run goes on`, () =>
    withApi({}, async (api) => {
      api.setOverride(override)
      const closed = ids('k', 1, 250)
      for (const id of closed) api.known.add(id)
      const lines: string[] = []
      const h = fakeHiredly({
        jobs: [job('job-1', 'Chef')],
        apps: { 'job-1': [app('n1'), ...closed.map((id) => app(id, { state: 'rejected' })), app('n2')] },
        pageSize: 100
      })
      const res = await runToEnd(newRun(api, h.adapter, lines))
      assert.equal(res.status, 'ok')
      assert.deepEqual(sentIds(api), ['n1', 'n2'])
      assert.equal(closureRequests(api).length, 1)
      assert.ok(lines.some((l) => l.startsWith('closed-on-platform report')), lines.join('\n'))
    }))
}

test('a dry run reports no closures and does not ask for the daily check', () =>
  withApi({ sync: { status_sweep: true } }, async (api) => {
    api.known.add('k-rej')
    const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('k-rej', { state: 'rejected' }), app('n1')] } })
    const res = await newRun(api, h.adapter).call({ maxNew: 25, dryRun: true })
    assert.equal(res.would_submit, 1)
    assert.equal(api.count(CLOSURES), 0)
    const me = api.requests.find((r) => r.path === '/api/v1/me')
    assert.equal(me?.headers['x-nortia-purpose'], undefined)

    const memory = { handled: new Set<string>(), finishedJobs: new Set<string>(), postingsReported: false, closedOnPlatform: new Map<string, string>() }
    await syncBatch(h.adapter, new NortiaClient(api.url, VALID_KEY), memory, {
      maxNew: 25,
      dryRun: true,
      cutoff: new Date(Date.now() - 30 * 86_400_000),
      fullWindow: false,
      throttle: async () => {},
      log: () => {}
    })
    assert.equal(memory.closedOnPlatform.size, 0)
  }))

test('only a sync asks Nortia with the sync purpose', () =>
  withApi({}, async (api) => {
    const client = new NortiaClient(api.url, VALID_KEY)
    await client.me()
    await client.me(true)
    assert.deepEqual(
      api.requests.map((r) => r.headers['x-nortia-purpose']),
      [undefined, 'sync']
    )
  }))

test('when the daily check is due, a sync walks past known rows; a dry run still stops early', () =>
  withApi({ sync: { status_sweep: true } }, async (api) => {
    for (const id of ids('k', 1, 6)) api.known.add(id)
    const apps = { 'job-1': ['n1', ...ids('k', 1, 6), 'n2'].map((id) => app(id)) }

    const dry = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps })
    const preview = await newRun(api, dry.adapter).call({ maxNew: 25, dryRun: true })
    assert.equal(preview.would_submit, 1)

    api.requests.length = 0
    const lines: string[] = []
    const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps })
    const res = await runToEnd(newRun(api, h.adapter, lines))
    assert.equal(res.status, 'ok')
    assert.deepEqual(sentIds(api), ['n1', 'n2'])
    const me = api.requests.find((r) => r.path === '/api/v1/me')
    assert.equal(me?.headers['x-nortia-purpose'], 'sync')
    assert.ok(lines.includes('daily check of decided applications; this run walks the whole fetch window'), lines.join('\n'))
  }))

test('anything but a literal status_sweep true keeps the early stop', async () => {
  for (const sync of [undefined, { status_sweep: false }, { status_sweep: 'true' }, {}, null]) {
    await withApi({ sync }, async (api) => {
      for (const id of ids('k', 1, 5)) api.known.add(id)
      const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': ['n1', ...ids('k', 1, 5), 'n2'].map((id) => app(id)) } })
      const res = await newRun(api, h.adapter).call({ maxNew: 25, dryRun: false })
      assert.equal(res.done, true, JSON.stringify(sync))
      assert.deepEqual(sentIds(api), ['n1'], JSON.stringify(sync))
    })
  }
})
