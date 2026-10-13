import { userInfo } from 'node:os'
import type { DeviceReader } from './types'

const SCUTIL = '/usr/sbin/scutil'
const IOREG = '/usr/sbin/ioreg'
const LIMIT = { timeoutMs: 2000 }
const SERIAL = /"IOPlatformSerialNumber" = "([^"]*)"/

export const readDarwin: DeviceReader = async (deps) => {
  const run = async (file: string, args: string[]) => {
    try {
      const res = await deps.runner(file, args, undefined, LIMIT)
      return res.code === 0 ? res.stdout : undefined
    } catch {
      return undefined
    }
  }
  const [name, ioreg] = await Promise.all([run(SCUTIL, ['--get', 'ComputerName']), run(IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice'])])
  let user: string | undefined
  try {
    user = (deps.username ?? (() => userInfo().username))()
  } catch {
    user = undefined
  }
  return { name, user, serial: ioreg === undefined ? undefined : SERIAL.exec(ioreg)?.[1] }
}
