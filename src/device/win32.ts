import type { DeviceReader } from './types'

/** Windows has no reader yet (WP-K5): every value is left out, so a key used from Windows stays unbound. */
export const readWin32: DeviceReader = async () => ({})
