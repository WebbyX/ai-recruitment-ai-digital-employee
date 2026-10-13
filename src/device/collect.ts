import { readDarwin } from './darwin'
import type { DeviceDeps, DeviceInfo, DeviceReader } from './types'
import { readWin32 } from './win32'

const READERS: Partial<Record<NodeJS.Platform, DeviceReader>> = { darwin: readDarwin, win32: readWin32 }

function clean(value: string | undefined, max: number): string | undefined {
  const s = value?.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return s ? Array.from(s).slice(0, max).join('') : undefined
}

/** Which computer this is, for the key it connects with: each value is left out when it cannot be read, never guessed. One reader per OS; clean-up is shared. */
export async function collectDevice(deps: DeviceDeps): Promise<DeviceInfo> {
  const reader = READERS[deps.platform]
  if (!reader) return {}
  let raw: DeviceInfo
  try {
    raw = await reader(deps)
  } catch {
    return {}
  }
  const device: DeviceInfo = {}
  const name = clean(raw.name, 255)
  const user = clean(raw.user, 255)
  const serial = clean(raw.serial, 64)
  if (name) device.name = name
  if (user) device.user = user
  if (serial) device.serial = serial
  return device
}
