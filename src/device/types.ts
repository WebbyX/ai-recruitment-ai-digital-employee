import type { Runner } from '../secrets'

export interface DeviceInfo {
  name?: string
  user?: string
  serial?: string
}

export interface DeviceDeps {
  runner: Runner
  platform: NodeJS.Platform
  username?: () => string
}

export type DeviceReader = (deps: DeviceDeps) => Promise<DeviceInfo>
