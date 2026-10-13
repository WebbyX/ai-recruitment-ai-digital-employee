import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { collectDevice } from '../src/device/collect'
import { deleteSecret, execRunner, getSecret, hasSecret, setSecret, type SecretDeps } from '../src/secrets'

const skip =
  process.env.KIT_WINDOWS_TEST !== '1' || process.platform !== 'win32'
    ? 'opt-in: KIT_WINDOWS_TEST=1 on Windows (uses a throwaway nortia-test-<uuid> credential, never the real ones)'
    : false

test('real Credential Manager round-trip and device read on Windows', { skip }, async () => {
  const deps: SecretDeps = { runner: execRunner, platform: 'win32', env: process.env, targetPrefix: `nortia-test-${randomUUID()}` }
  try {
    for (const value of ['plain-pw', 'pässwörd中', "it's $(id) `id`", 'x'.repeat(512)]) {
      assert.equal(await setSecret('hiredly_password', value, deps), 'ok', value)
      assert.equal(await getSecret('hiredly_password', { allowEnv: false }, deps), value)
    }
    assert.equal(await setSecret('hiredly_password', 'a\nb', deps), 'invalid_value')
    assert.equal(await hasSecret('hiredly_password', deps), true)
    assert.equal(await deleteSecret('hiredly_password', deps), 'deleted')
    assert.equal(await deleteSecret('hiredly_password', deps), 'not_found')
    assert.equal(await hasSecret('hiredly_password', deps), false)
  } finally {
    await deleteSecret('hiredly_password', deps)
  }

  const started = Date.now()
  const device = await collectDevice({ runner: execRunner, platform: 'win32', env: process.env })
  const took = Date.now() - started
  console.log(`device keys: ${Object.keys(device).join(', ')} (${took} ms)`)
  assert.ok(took < 5000, `took ${took} ms`)
  assert.ok(device.name && device.user)
})
