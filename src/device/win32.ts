import { hostname, userInfo } from 'node:os'
import { runPowerShell, unb64 } from '../windows/powershell'
import type { DeviceReader } from './types'

const SERIAL =
  'try { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](Get-CimInstance -ClassName Win32_BIOS).SerialNumber))) } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }'
const PLACEHOLDERS = new Set([
  'to be filled by o.e.m.',
  'default string',
  'system serial number',
  'chassis serial number',
  'not specified',
  'not applicable',
  'none',
  'o.e.m.',
  '0',
  '00000000',
  '123456789'
])

/** Windows: the device name, the signed-in account and the BIOS serial; a placeholder serial is left out, never kept. */
export const readWin32: DeviceReader = async (deps) => {
  let name: string | undefined
  try {
    name = (deps.hostname ?? hostname)()
  } catch {
    name = undefined
  }
  let user: string | undefined
  try {
    user = (deps.username ?? (() => userInfo().username))()
  } catch {
    user = undefined
  }
  let serial: string | undefined
  try {
    const res = await runPowerShell({ runner: deps.runner, env: deps.env ?? {} }, 'device', SERIAL, [], { timeoutMs: 5000, hideWindow: true })
    const value = res.code === 0 ? unb64(res.stdout).trim() : ''
    serial = value && !PLACEHOLDERS.has(value.toLowerCase()) ? value : undefined
  } catch {
    serial = undefined
  }
  return { name, user, serial }
}
