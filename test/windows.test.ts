import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { collectDevice } from '../src/device/collect'
import { readWin32 } from '../src/device/win32'
import { inspectDisconnect, runDisconnect, type DisconnectDeps } from '../src/disconnect'
import { DISCONNECT_CONFIRM_TEXT } from '../src/messages'
import { confirmDialog, deleteSecret, execRunner, getSecret, hasSecret, promptSecret, setSecret, type SecretDeps } from '../src/secrets'
import { startFakeApi } from './helpers/fake-api'
import { dialogConfig, fakePowerShell, toB64 } from './helpers/fake-powershell'
import { runCli, VALID_KEY } from './helpers/harness'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const HEADER = "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'"
const CATCH = '} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }'
const target = (account: string) => `nortia-ai-digital-employee:${account}`
const win = (runner: SecretDeps['runner'], over: Partial<SecretDeps> = {}): SecretDeps => ({ runner, platform: 'win32', env: {}, ...over })
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })

let api: Awaited<ReturnType<typeof startFakeApi>>
before(async () => {
  api = await startFakeApi()
})
after(() => api.close())

test('PowerShell 5.1 runs from SystemRoot with the five fixed arguments and a two-line header', async () => {
  for (const [env, file] of [
    [{}, PS],
    [{ SystemRoot: 'D:\\Win' }, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    [{ SYSTEMROOT: 'E:\\W' }, 'E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']
  ] as const) {
    const fake = fakePowerShell()
    await getSecret('nortia_api_key', { allowEnv: false }, win(fake.runner, { env }))
    const call = fake.calls[0]
    assert.equal(call.file, file)
    assert.equal(call.args.length, 5)
    assert.deepEqual(call.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    assert.ok(call.script.startsWith(`# nortia cred-read\n${HEADER}\n`))
  }
})

test('set then get round-trips ASCII, non-ASCII and exactly 512 bytes', async () => {
  for (const value of ['plain-pw 123', 'pässwörd中', 'x'.repeat(512), '中'.repeat(170), "it's $(id) `id` ; \"q\""]) {
    const fake = fakePowerShell()
    const deps = win(fake.runner)
    assert.equal(await setSecret('hiredly_password', value, deps), 'ok', value)
    assert.equal(fake.creds.get(target('hiredly_password')), value)
    assert.equal(await getSecret('hiredly_password', { allowEnv: false }, deps), value)
    assert.equal(await hasSecret('hiredly_password', deps), true)
  }
})

test('the secret is never in argv or the script, only base64 on stdin', async () => {
  const value = 'S3cret-pässwörd中'
  const fake = fakePowerShell()
  assert.equal(await setSecret('hiredly_password', value, win(fake.runner)), 'ok')
  for (const call of fake.calls) {
    assert.ok(!call.args.join(' ').includes(value) && !call.args.join(' ').includes(toB64(value)))
    assert.ok(!call.script.includes(value) && !call.script.includes(toB64(value)))
  }
  const write = fake.calls.find((c) => c.op === 'cred-write')!
  assert.equal(write.input, toB64(value) + '\n')

  const cli = fakePowerShell()
  const res = await runCli(['set-secret', 'nortia_api_key', '--stdin'], { deps: { runner: cli.runner, platform: 'win32' }, stdin: VALID_KEY + '\n' })
  assert.equal(res.stdout, '{"status":"ok","account":"nortia_api_key"}\n')
  assert.equal(cli.creds.get(target('nortia_api_key')), VALID_KEY)
  assert.ok(cli.calls.every((c) => !c.args.join(' ').includes('nrt_') && !c.script.includes('nrt_')))
})

test('Linux stays unsupported in every secret and dialog function, and nothing runs', async () => {
  const fake = fakePowerShell()
  const deps: SecretDeps = { runner: fake.runner, platform: 'linux', env: {} }
  for (const call of [
    () => getSecret('nortia_api_key', { allowEnv: false }, deps),
    () => setSecret('hiredly_password', 'pw', deps),
    () => deleteSecret('hiredly_password', deps),
    () => hasSecret('hiredly_password', deps),
    () => confirmDialog(DISCONNECT_CONFIRM_TEXT, deps),
    () => promptSecret('Enter your Hiredly password.', deps)
  ]) {
    await assert.rejects(call(), /not_supported_yet/)
  }
  assert.equal(fake.calls.length, 0)
})

test('control characters or more than 512 bytes are refused before PowerShell runs', async () => {
  for (const value of ['a\u0000b', 'a\tb', 'a\nb', 'a\rb', 'a\u001bb', 'a\u007fb', 'a'.repeat(513), '中'.repeat(171)]) {
    const fake = fakePowerShell()
    assert.equal(await setSecret('hiredly_password', value, win(fake.runner)), 'invalid_value', JSON.stringify(value))
    assert.equal(fake.calls.length, 0)
  }
})

test('a write that fails, does nothing or reads back different is reported as failed', async () => {
  for (const fake of [
    fakePowerShell({ writeFails: true }),
    fakePowerShell({ silentNoop: true }),
    fakePowerShell({ silentNoop: true, creds: { [target('hiredly_password')]: 'old' } })
  ]) {
    assert.equal(await setSecret('hiredly_password', 'new-pw', win(fake.runner)), 'failed')
  }
})

test('delete: gone after a confirming lookup, not found, or failed', async () => {
  const present = { [target('hiredly_password')]: 'pw' }
  const deleted = fakePowerShell({ creds: present })
  assert.equal(await deleteSecret('hiredly_password', win(deleted.runner)), 'deleted')
  assert.deepEqual(deleted.calls.map((c) => c.op), ['cred-delete', 'cred-read'])
  assert.equal(deleted.creds.size, 0)
  assert.equal(await deleteSecret('hiredly_password', win(fakePowerShell().runner)), 'not_found')
  assert.equal(await deleteSecret('hiredly_password', win(fakePowerShell({ creds: present, deleteFails: true }).runner)), 'failed')
  assert.equal(await deleteSecret('hiredly_password', win(fakePowerShell({ creds: present, deleteNoop: true }).runner)), 'failed')
})

test('credential calls are hidden, time-limited and name only SERVICE:<account>, or the test prefix', async () => {
  const fake = fakePowerShell()
  const deps = win(fake.runner)
  await setSecret('nortia_api_key', VALID_KEY, deps)
  await hasSecret('hiredly_password', deps)
  await deleteSecret('nortia_api_key', deps)
  assert.deepEqual(new Set(fake.calls.map((c) => c.op)), new Set(['cred-write', 'cred-read', 'cred-delete']))
  assert.deepEqual(new Set(fake.calls.map((c) => c.target)), new Set([target('nortia_api_key'), target('hiredly_password')]))
  for (const call of fake.calls) {
    assert.deepEqual(call.opts, { timeoutMs: 30000, hideWindow: true })
    assert.ok(call.script.includes('c.Type = 1;') && call.script.includes('c.Persist = 2;'))
    assert.ok(call.script.includes(CATCH))
  }
  const prefixed = fakePowerShell()
  await setSecret('hiredly_password', 'pw', win(prefixed.runner, { targetPrefix: 'nortia-test-1234' }))
  assert.ok(prefixed.calls.every((c) => c.target === 'nortia-test-1234:hiredly_password'))
})

test('the password box gets the label only as base64 on stdin, and Cancel is cancelled', async () => {
  const label = 'Enter the Hiredly password for o\'neil@acme.com.my. It is saved to Windows Credential Manager on this computer and never shown to the AI.'
  const fake = fakePowerShell({ dialog: ok(toB64('S3cret pw中')) })
  assert.deepEqual(await promptSecret(label, win(fake.runner)), { value: 'S3cret pw中' })
  const call = fake.calls[0]
  assert.equal(call.op, 'dialog')
  assert.ok(!call.args.join(' ').includes('acme.com.my') && !call.script.includes('acme.com.my'))
  assert.deepEqual(dialogConfig(call), { mode: 'password', text: label, ok: 'Save', timeoutSeconds: 0 })
  assert.equal(call.opts, undefined, 'a hidden powershell never shows its form, and typing has no time limit')
  assert.ok(call.script.includes('UseSystemPasswordChar') && call.script.includes(CATCH))

  assert.deepEqual(await promptSecret(label, win(fakePowerShell({ dialog: { code: 11, stdout: '', stderr: '' } }).runner)), { cancelled: true })
  assert.deepEqual(await promptSecret(label, win(fakePowerShell({ dialog: { code: 1, stdout: '', stderr: 'x' } }).runner)), { error: true })
})

test('the confirm box: Disconnect confirms, Cancel or the 120 second timer cancels, anything else is an error', async () => {
  for (const [code, answer] of [
    [0, 'confirmed'],
    [11, 'cancelled'],
    [12, 'cancelled'],
    [1, 'error'],
    [2, 'error']
  ] as const) {
    const fake = fakePowerShell({ dialog: { code, stdout: '', stderr: '' } })
    assert.equal(await confirmDialog(DISCONNECT_CONFIRM_TEXT, win(fake.runner)), answer, String(code))
    assert.deepEqual(dialogConfig(fake.calls[0]), { mode: 'confirm', text: DISCONNECT_CONFIRM_TEXT, ok: 'Disconnect', timeoutSeconds: 120 })
    assert.equal(fake.calls[0].opts, undefined)
    assert.ok(!fake.calls[0].script.includes('Nortia from this computer'))
    assert.ok(
      fake.calls[0].script.includes("if ($cfg.mode -eq 'password') { $f.AcceptButton = $ok } else { $f.AcceptButton = $cancel; $f.ActiveControl = $cancel }"),
      'on the confirm box Cancel has the focus and Enter means Cancel; the password box keeps focus in the text box'
    )
    assert.equal(fake.calls[0].script.split('$f.ActiveControl').length - 1, 1, 'only the confirm branch moves the focus')
    assert.ok(fake.calls[0].script.includes('$f.CancelButton = $cancel'))
  }
})

test('CLI set-secret --for on Windows asks in the box and prints only the ok line', async () => {
  const fake = fakePowerShell({ dialog: ok(toB64('S3cret-pw')) })
  const res = await runCli(['set-secret', 'hiredly_password', '--for', 'a@b.co'], { deps: { runner: fake.runner, platform: 'win32' } })
  assert.equal(res.code, 0)
  assert.equal(res.stdout, '{"status":"ok","account":"hiredly_password"}\n')
  assert.equal(res.stderr, '')
  assert.equal(
    dialogConfig(fake.calls[0]).text,
    'Enter the Hiredly password for a@b.co. It is saved to Windows Credential Manager on this computer and never shown to the AI.'
  )
  assert.equal(fake.creds.get(target('hiredly_password')), 'S3cret-pw')
})

/** A throwaway home; never the real one. */
function makeHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-windows-')))
  const home = join(root, 'home')
  const claudeDir = join(home, '.claude')
  assert.ok(!homedir().startsWith(root))
  mkdirSync(join(home, '.nortia', 'node'), { recursive: true })
  writeFileSync(join(home, '.nortia', 'node', 'node.exe'), 'MZ')
  const task = join(claudeDir, 'scheduled-tasks', 'nortia-hiredly')
  mkdirSync(task, { recursive: true })
  writeFileSync(join(task, 'SKILL.md'), 'Run the nortia hiredly_sync tool again and again until it returns done: true.\n')
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__nortia__hiredly_sync', 'Bash(ls)'] } }, null, 2))
  return { root, home, claudeDir, task, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const both = () => ({ [target('nortia_api_key')]: VALID_KEY, [target('hiredly_password')]: 'pw' })
const disconnectDeps = (t: ReturnType<typeof makeHome>, runner: SecretDeps['runner']): DisconnectDeps => ({
  runner,
  platform: 'win32',
  env: {},
  apiUrl: api.url,
  home: t.home,
  claudeDir: t.claudeDir
})

test('Windows disconnect: the box first, then both credentials, the folders and the rules are removed', async () => {
  const t = makeHome()
  try {
    const preview = fakePowerShell({ creds: both() })
    const listed = await inspectDisconnect(disconnectDeps(t, preview.runner))
    assert.equal(listed.status, 'preview')
    assert.ok(preview.calls.every((c) => c.op === 'cred-read'))

    const fake = fakePowerShell({ creds: both() })
    api.requests.length = 0
    const out = await runDisconnect(disconnectDeps(t, fake.runner))
    assert.equal(fake.calls[0].op, 'dialog')
    assert.equal(dialogConfig(fake.calls[0]).text, DISCONNECT_CONFIRM_TEXT)
    assert.equal(out.status, 'disconnected')
    const done = out as Extract<typeof out, { status: 'disconnected' }>
    assert.equal(api.requests[0].headers.authorization, `Bearer ${VALID_KEY}`)
    assert.deepEqual(done.removed, ['keychain:nortia_api_key', 'keychain:hiredly_password', '~/.nortia', '~/.claude/scheduled-tasks/nortia-hiredly'])
    assert.deepEqual(done.issues, [])
    assert.equal(fake.creds.size, 0)
    assert.ok(!existsSync(join(t.home, '.nortia')))
    assert.deepEqual(JSON.parse(readFileSync(join(t.claudeDir, 'settings.json'), 'utf8')).permissions.allow, ['Bash(ls)'])
  } finally {
    t.cleanup()
  }
})

test('Windows disconnect: a credential that will not delete points to Credential Manager, a busy ~/.nortia says quit Claude Desktop first', async () => {
  const t = makeHome()
  chmodSync(t.home, 0o555)
  try {
    const fake = fakePowerShell({ creds: both(), deleteFails: true })
    const out = await runDisconnect(disconnectDeps(t, fake.runner))
    const done = out as Extract<typeof out, { status: 'disconnected' }>
    assert.deepEqual(done.issues, [
      'Remove the saved Nortia key: open Credential Manager → Windows Credentials, find nortia-ai-digital-employee:nortia_api_key and remove it.',
      'Remove the saved Hiredly password: open Credential Manager → Windows Credentials, find nortia-ai-digital-employee:hiredly_password and remove it.',
      'Delete the folder ~/.nortia after quitting Claude Desktop (Windows keeps the Node.js inside it in use until then).'
    ])
    assert.ok(done.removed.includes('~/.claude/scheduled-tasks/nortia-hiredly'))
  } finally {
    chmodSync(t.home, 0o755)
    t.cleanup()
  }
})

test('every PowerShell script stays well under the command-line limit once encoded', async () => {
  const fake = fakePowerShell({ creds: both() })
  const deps = win(fake.runner)
  await setSecret('hiredly_password', 'x'.repeat(512), deps)
  await deleteSecret('hiredly_password', deps)
  await confirmDialog(DISCONNECT_CONFIRM_TEXT, deps)
  await promptSecret('Enter your Hiredly password.', deps)
  await readWin32({ runner: fake.runner, platform: 'win32' })
  assert.deepEqual(new Set(fake.calls.map((c) => c.op)), new Set(['cred-write', 'cred-read', 'cred-delete', 'dialog', 'device']))
  for (const call of fake.calls) assert.ok(call.args[4].length < 16000, `${call.op}: ${call.args[4].length}`)
})

test('a Windows computer reports its name, user and BIOS serial from one hidden PowerShell call', async () => {
  const fake = fakePowerShell()
  const deps = { runner: fake.runner, platform: 'win32' as const, username: () => 'Aisyah Binti', hostname: () => 'DESKTOP-7Q2' }
  assert.deepEqual(await collectDevice(deps), { name: 'DESKTOP-7Q2', user: 'Aisyah Binti', serial: 'PF3ABCDE' })
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].op, 'device')
  assert.deepEqual(fake.calls[0].opts, { timeoutMs: 5000, hideWindow: true })
  assert.ok(fake.calls[0].script.includes('Get-CimInstance -ClassName Win32_BIOS') && fake.calls[0].script.includes(CATCH))
})

test('a placeholder serial is left out; a failing PowerShell leaves out only the serial', async () => {
  const base = { platform: 'win32' as const, username: () => 'aisyah', hostname: () => 'DESKTOP-7Q2' }
  for (const placeholder of [
    'To Be Filled By O.E.M.',
    ' Default string ',
    'System Serial Number',
    'Chassis Serial Number',
    'Not Specified',
    'NOT APPLICABLE',
    'None',
    'O.E.M.',
    '0',
    '00000000',
    '123456789'
  ]) {
    const fake = fakePowerShell({ device: ok(toB64(placeholder + '\r\n')) })
    assert.deepEqual(await collectDevice({ ...base, runner: fake.runner }), { name: 'DESKTOP-7Q2', user: 'aisyah' }, placeholder)
  }
  for (const device of [{ code: 1, stdout: '', stderr: 'Invalid class' }, ok(''), new Error('spawn EINVAL')]) {
    const fake = fakePowerShell({ device })
    assert.deepEqual(await collectDevice({ ...base, runner: fake.runner }), { name: 'DESKTOP-7Q2', user: 'aisyah' })
  }
  const noName = fakePowerShell()
  const device = await collectDevice({
    ...base,
    runner: noName.runner,
    hostname: () => {
      throw new Error('no hostname')
    }
  })
  assert.deepEqual(device, { user: 'aisyah', serial: 'PF3ABCDE' })
})

test('CLI check on Windows sends this computer to /api/v1/me, with PowerShell from SystemRoot', async () => {
  const fake = fakePowerShell()
  api.requests.length = 0
  const res = await runCli(['check'], {
    deps: {
      runner: fake.runner,
      platform: 'win32',
      username: () => 'aisyah',
      hostname: () => 'DESKTOP-7Q2',
      env: { NORTIA_API_URL: api.url, NORTIA_API_KEY: VALID_KEY, SystemRoot: 'D:\\Win', COMPUTERNAME: 'NETBIOS15' }
    }
  })
  assert.equal(res.code, 0, res.stdout)
  const me = api.requests.find((r) => r.path === '/api/v1/me')!
  assert.equal(decodeURIComponent(String(me.headers['x-nortia-device-name'])), 'DESKTOP-7Q2', 'the device name, not COMPUTERNAME')
  assert.equal(decodeURIComponent(String(me.headers['x-nortia-device-user'])), 'aisyah')
  assert.equal(decodeURIComponent(String(me.headers['x-nortia-device-serial'])), 'PF3ABCDE')
  assert.equal(fake.calls.find((c) => c.op === 'device')!.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
})

test('a command that exits before reading its input resolves instead of crashing the process', async () => {
  const res = await execRunner('/bin/sh', ['-c', 'exit 3'], 'x'.repeat(4 * 1024 * 1024))
  assert.equal(res.code, 3)
})
