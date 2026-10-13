import type { RunResult, Runner } from '../../src/secrets'

export interface PowerShellCall {
  file: string
  args: string[]
  input?: string
  opts?: { timeoutMs?: number; hideWindow?: boolean }
  script: string
  op: string
  target?: string
}

const fromB64 = (s: string) => Buffer.from(s.trim(), 'base64').toString('utf8')
const toB64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

/** In-process fake for powershell.exe: decodes -EncodedCommand, dispatches on the `# nortia <op>` line and keeps credentials in a Map keyed by target. */
export function fakePowerShell(
  opts: {
    creds?: Record<string, string>
    dialog?: RunResult
    device?: RunResult | Error
    writeFails?: boolean
    silentNoop?: boolean
    deleteFails?: boolean
    /** The delete answers success but the credential stays. */
    deleteNoop?: boolean
  } = {}
) {
  const calls: PowerShellCall[] = []
  const creds = new Map(Object.entries(opts.creds ?? {}))
  const runner: Runner = async (file, args, input, runOpts) => {
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le')
    const op = /^# nortia (\S+)\n/.exec(script)?.[1] ?? ''
    const target = /^\$target = '((?:[^']|'')*)'/m.exec(script)?.[1].replace(/''/g, "'")
    calls.push({ file, args, input, opts: runOpts, script, op, target })
    const firstLine = (input ?? '').split('\n')[0]
    switch (op) {
      case 'cred-read':
        return creds.has(target!) ? { code: 0, stdout: toB64(creds.get(target!)!), stderr: '' } : { code: 10, stdout: '', stderr: '' }
      case 'cred-write':
        if (opts.writeFails) return { code: 1, stdout: '', stderr: 'Access is denied' }
        if (!opts.silentNoop) creds.set(target!, fromB64(firstLine))
        return { code: 0, stdout: '', stderr: '' }
      case 'cred-delete':
        if (opts.deleteFails) return { code: 1, stdout: '', stderr: 'Access is denied' }
        if (!creds.has(target!)) return { code: 10, stdout: '', stderr: '' }
        if (!opts.deleteNoop) creds.delete(target!)
        return { code: 0, stdout: '', stderr: '' }
      case 'dialog':
        return opts.dialog ?? { code: 0, stdout: '', stderr: '' }
      case 'device':
        if (opts.device instanceof Error) throw opts.device
        return opts.device ?? { code: 0, stdout: toB64('PF3ABCDE\r\n'), stderr: '' }
      default:
        return { code: 127, stdout: '', stderr: 'unexpected' }
    }
  }
  return { runner, calls, creds }
}

export const dialogConfig = (call: PowerShellCall) => JSON.parse(fromB64((call.input ?? '').split('\n')[0]))
export { fromB64, toB64 }
