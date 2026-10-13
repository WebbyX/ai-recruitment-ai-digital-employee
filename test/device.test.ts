import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectDevice } from '../src/device/collect'
import { readDarwin } from '../src/device/darwin'
import { execRunner, type RunResult, type Runner } from '../src/secrets'
import { startFakeApi } from './helpers/fake-api'
import { app, fakeHiredly, job } from './helpers/fake-hiredly'
import { fakeRunner, runCli, VALID_KEY } from './helpers/harness'

const SCUTIL = '/usr/sbin/scutil'
const IOREG = '/usr/sbin/ioreg'
const NAME = 'Aisyah’s MacBook Air'
const SERIAL = 'C02TEST0001'
const IOREG_OUT = `+-o Mac14,2  <class IOPlatformExpertDevice>
    {
      "IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"
      "IOPlatformSerialNumber" = "${SERIAL}"
    }
`

interface DeviceCall {
  file: string
  args: string[]
  opts?: { timeoutMs?: number }
}

function deviceRunner(answers: { scutil?: RunResult | Error; ioreg?: RunResult | Error } = {}) {
  const calls: DeviceCall[] = []
  const runner: Runner = async (file, args, _input, opts) => {
    calls.push({ file, args, opts })
    const answer =
      file === SCUTIL
        ? answers.scutil ?? { code: 0, stdout: NAME + '\n', stderr: '' }
        : file === IOREG
          ? answers.ioreg ?? { code: 0, stdout: IOREG_OUT, stderr: '' }
          : { code: 127, stdout: '', stderr: 'unexpected' }
    if (answer instanceof Error) throw answer
    return answer
  }
  return { runner, calls }
}

const darwin = (runner: Runner, username: () => string = () => 'aisyah') => ({ runner, platform: 'darwin' as const, username })

test('a Mac reports its name, user and serial, with the trailing newline gone', async () => {
  const fake = deviceRunner()
  assert.deepEqual(await collectDevice(darwin(fake.runner)), { name: NAME, user: 'aisyah', serial: SERIAL })
})

test('only scutil and ioreg run, each with a 2 second limit', async () => {
  const fake = deviceRunner()
  await collectDevice(darwin(fake.runner))
  assert.deepEqual(fake.calls.map((c) => c.file).sort(), [SCUTIL, IOREG].sort())
  assert.deepEqual(fake.calls.find((c) => c.file === SCUTIL)?.args, ['--get', 'ComputerName'])
  assert.deepEqual(fake.calls.find((c) => c.file === IOREG)?.args, ['-rd1', '-c', 'IOPlatformExpertDevice'])
  assert.ok(fake.calls.every((c) => c.opts?.timeoutMs === 2000))
  assert.ok(fake.calls.every((c) => !c.file.includes('system_profiler')))
})

test('a failing scutil leaves out only the name', async () => {
  const fake = deviceRunner({ scutil: { code: 1, stdout: NAME, stderr: 'failed' } })
  assert.deepEqual(await collectDevice(darwin(fake.runner)), { user: 'aisyah', serial: SERIAL })
})

test('ioreg output without a serial line leaves out only the serial', async () => {
  const fake = deviceRunner({ ioreg: { code: 0, stdout: '+-o Mac14,2  <class IOPlatformExpertDevice>\n', stderr: '' } })
  assert.deepEqual(await collectDevice(darwin(fake.runner)), { name: NAME, user: 'aisyah' })
})

test('a runner that throws leaves out that value and nothing throws', async () => {
  const fake = deviceRunner({ ioreg: new Error('spawn failed') })
  assert.deepEqual(await collectDevice(darwin(fake.runner)), { name: NAME, user: 'aisyah' })
  const both = deviceRunner({ scutil: new Error('x'), ioreg: new Error('y') })
  assert.deepEqual(await readDarwin(darwin(both.runner)), { name: undefined, user: 'aisyah', serial: undefined })
})

test('a username lookup that throws leaves out the user', async () => {
  const fake = deviceRunner()
  const device = await collectDevice(
    darwin(fake.runner, () => {
      throw new Error('no passwd entry')
    })
  )
  assert.deepEqual(device, { name: NAME, serial: SERIAL })
})

test('control characters are removed, a value left empty is left out, and long values are cut', async () => {
  const fake = deviceRunner({ scutil: { code: 0, stdout: 'Desk\u0007 \u001bMac\u007f\n', stderr: '' } })
  assert.deepEqual(await collectDevice(darwin(fake.runner, () => '\u0000\t \u001f')), { name: 'Desk Mac', serial: SERIAL })
  const long = deviceRunner({ scutil: { code: 0, stdout: '中'.repeat(300), stderr: '' } })
  const device = await collectDevice(darwin(long.runner))
  assert.equal(device.name, '中'.repeat(255))
})

test('Windows and Linux report nothing and run nothing', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const fake = deviceRunner()
    let usernameCalls = 0
    const device = await collectDevice({
      runner: fake.runner,
      platform,
      username: () => {
        usernameCalls++
        return 'aisyah'
      }
    })
    assert.deepEqual(device, {}, platform)
    assert.equal(fake.calls.length, 0, platform)
    assert.equal(usernameCalls, 0, platform)
  }
})

test('execRunner kills a command that outlives its limit', async () => {
  const started = Date.now()
  const res = await execRunner('/bin/sleep', ['5'], undefined, { timeoutMs: 200 })
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`)
  assert.notEqual(res.code, 0)
})

test('CLI check sends this computer to /api/v1/me', async () => {
  const api = await startFakeApi()
  try {
    const fake = deviceRunner()
    const res = await runCli(['check'], {
      deps: { runner: fake.runner, username: () => 'aisyah', env: { NORTIA_API_URL: api.url, NORTIA_API_KEY: VALID_KEY } }
    })
    assert.equal(res.code, 0, res.stdout)
    const me = api.requests.find((r) => r.path === '/api/v1/me')!
    assert.equal(decodeURIComponent(String(me.headers['x-nortia-device-name'])), NAME)
    assert.equal(decodeURIComponent(String(me.headers['x-nortia-device-user'])), 'aisyah')
    assert.equal(decodeURIComponent(String(me.headers['x-nortia-device-serial'])), SERIAL)
  } finally {
    await api.close()
  }
})

test('CLI hiredly-sync sends this computer on every Nortia request and reads it once', async () => {
  const api = await startFakeApi()
  try {
    const fake = deviceRunner()
    const h = fakeHiredly({ jobs: [job('job-1', 'Chef')], apps: { 'job-1': [app('app-1')] } })
    const env = { NORTIA_API_URL: api.url, NORTIA_API_KEY: VALID_KEY, HIREDLY_EMAIL: 'hr@acme.com', HIREDLY_PASSWORD: 'pw' }
    const res = await runCli(['hiredly-sync', '--max-new', '1'], {
      deps: { runner: fake.runner, username: () => 'aisyah', env, newAdapter: () => h.adapter }
    })
    assert.equal(res.code, 0, res.stdout + res.stderr)
    const paths = new Set(api.requests.map((r) => r.path))
    for (const path of ['/api/v1/me', '/api/v1/resumes/lookup', '/api/v1/resumes', '/api/v1/runs']) assert.ok(paths.has(path), path)
    for (const r of api.requests) {
      assert.equal(decodeURIComponent(String(r.headers['x-nortia-device-name'])), NAME, r.path)
      assert.equal(decodeURIComponent(String(r.headers['x-nortia-device-user'])), 'aisyah', r.path)
      assert.equal(decodeURIComponent(String(r.headers['x-nortia-device-serial'])), SERIAL, r.path)
    }
    assert.equal(fake.calls.filter((c) => c.file === SCUTIL).length, 1)
    assert.equal(fake.calls.filter((c) => c.file === IOREG).length, 1)
  } finally {
    await api.close()
  }
})

test('set-secret never reads the computer', async () => {
  const fake = fakeRunner()
  const res = await runCli(['set-secret', 'hiredly_password', '--stdin'], { deps: { runner: fake.runner }, stdin: 'pw' })
  assert.equal(res.code, 0)
  assert.ok(fake.calls.length > 0)
  assert.ok(fake.calls.every((c) => c.file === '/usr/bin/security'))
})
