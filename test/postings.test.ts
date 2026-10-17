import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { loadConfig } from '../src/config'
import { HiredlyRun, type SyncDeps } from '../src/run-state'
import type { ScrapedJob } from '../src/platforms/hiredly/types'
import { startFakeApi, type Override } from './helpers/fake-api'
import { app, fakeHiredly, job } from './helpers/fake-hiredly'
import { VALID_KEY } from './helpers/harness'

let api: Awaited<ReturnType<typeof startFakeApi>>
before(async () => {
  api = await startFakeApi()
})
beforeEach(() => {
  api.requests.length = 0
  api.known.clear()
  api.setOverride(undefined)
})
after(() => api.close())

function newRun(adapter: ReturnType<typeof fakeHiredly>['adapter'], lines: string[] = []): HiredlyRun {
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

const sentIds = () => api.requests.filter((r) => r.path === '/api/v1/resumes').map((r) => r.form?.external_application_id)
const postingRequests = () => api.requests.filter((r) => r.path === '/api/v1/postings')

test('a run reports the job list once, however many batches it takes', async () => {
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('n1'), app('n2'), app('n3')] } })
  const res = await runToEnd(newRun(h.adapter), 1)
  assert.equal(res.status, 'ok')
  assert.deepEqual(sentIds(), ['n1', 'n2', 'n3'])
  assert.ok(h.stats.listJobs >= 3)
  assert.equal(api.count('/api/v1/postings'), 1)
})

test('the report carries every job, open, closed or unknown, before the first lookup', async () => {
  const jobs: ScrapedJob[] = [
    { jobExternalId: 'job-1', jobTitle: 'Chef', applicantCount: 12, active: true },
    { jobExternalId: 'job-2', jobTitle: 'Waiter', applicantCount: 0, active: false },
    { jobExternalId: 'job-3', jobTitle: 'Cashier', applicantCount: null, active: null },
    { jobExternalId: 'job-4', jobTitle: 'Driver', applicantCount: -1, active: true },
    { jobExternalId: 'job-5', jobTitle: 'Cleaner', applicantCount: 2.5, active: true },
    { jobExternalId: '', jobTitle: 'No id', applicantCount: 3, active: true }
  ]
  const h = fakeHiredly({ jobs, apps: { 'job-1': [app('n1')] } })
  const res = await runToEnd(newRun(h.adapter))
  assert.equal(res.status, 'ok')

  const [report] = postingRequests()
  assert.deepEqual(report.json, {
    platform: 'hiredly',
    postings: [
      { external_job_id: 'job-1', title: 'Chef', active: true, applicant_count: 12 },
      { external_job_id: 'job-2', title: 'Waiter', active: false, applicant_count: 0 },
      { external_job_id: 'job-3', title: 'Cashier', active: null, applicant_count: null },
      { external_job_id: 'job-4', title: 'Driver', active: true, applicant_count: null },
      { external_job_id: 'job-5', title: 'Cleaner', active: true, applicant_count: null }
    ]
  })
  const paths = api.requests.map((r) => r.path)
  assert.ok(paths.indexOf('/api/v1/postings') < paths.indexOf('/api/v1/resumes/lookup'))
})

const failures: [string, Override][] = [
  ['a 500', (r) => (r.path === '/api/v1/postings' ? { status: 500 } : undefined)],
  ['a 404 from an older server', (r) => (r.path === '/api/v1/postings' ? { status: 404 } : undefined)],
  ['a dropped connection', (r) => (r.path === '/api/v1/postings' ? { status: 0, destroy: true } : undefined)],
  ['a 403', (r) => (r.path === '/api/v1/postings' ? { status: 403 } : undefined)]
]
for (const [name, override] of failures) {
  test(`${name} on the job list is logged and the run goes on`, async () => {
    api.setOverride(override)
    const lines: string[] = []
    const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('n1'), app('n2')] } })
    const res = await runToEnd(newRun(h.adapter, lines))
    assert.equal(res.status, 'ok')
    assert.equal(res.submitted, 2)
    assert.deepEqual(sentIds(), ['n1', 'n2'])
    assert.ok(lines.some((l) => l.startsWith('job list not recorded')), lines.join('\n'))
  })
}

test('a dry run never reports the job list', async () => {
  const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('n1')] } })
  const res = await newRun(h.adapter).call({ maxNew: 25, dryRun: true })
  assert.equal(res.would_submit, 1)
  assert.equal(api.count('/api/v1/postings'), 0)
})

test('titles are cut to 255 characters and at most 2000 jobs are sent', async () => {
  const jobs = Array.from({ length: 2100 }, (_, i) => job(`job-${i}`, i === 0 ? 'x'.repeat(300) : `Job ${i}`, false))
  const h = fakeHiredly({ jobs, apps: {} })
  const res = await runToEnd(newRun(h.adapter))
  assert.equal(res.status, 'ok')
  const postings = postingRequests()[0].json.postings
  assert.equal(postings.length, 2000)
  assert.equal(postings[0].title, 'x'.repeat(255))
  assert.equal(postings[1999].external_job_id, 'job-1999')
})

test('a title is cut by character, never through an emoji', async () => {
  const title = 'a'.repeat(254) + '😀' + 'b'.repeat(45)
  assert.equal(Array.from(title).length, 300)
  const h = fakeHiredly({ jobs: [job('job-1', title, false)], apps: {} })
  const res = await runToEnd(newRun(h.adapter))
  assert.equal(res.status, 'ok')
  const sent: string = postingRequests()[0].json.postings[0].title
  assert.doesNotMatch(sent, /\p{Surrogate}/u)
  assert.equal(Array.from(sent).length, 255)
  assert.equal(sent, 'a'.repeat(254) + '😀')
})

test('a job without a title is left out and the rest are still sent', async () => {
  const jobs = [
    { jobExternalId: 'job-1', jobTitle: 'Chef', applicantCount: null, active: true },
    { jobExternalId: 'job-2', jobTitle: null, applicantCount: null, active: true },
    { jobExternalId: 'job-3', jobTitle: '  ', applicantCount: null, active: true }
  ] as unknown as ScrapedJob[]
  const h = fakeHiredly({ jobs, apps: {} })
  const lines: string[] = []
  const res = await runToEnd(newRun(h.adapter, lines))
  assert.equal(res.status, 'ok')
  assert.deepEqual(postingRequests()[0].json.postings.map((p: { external_job_id: string }) => p.external_job_id), ['job-1'])
  assert.ok(!lines.some((l) => l.startsWith('job list report failed')), lines.join('\n'))
})
