import { win32 } from 'node:path'
import type { RunResult, Runner } from '../secrets'

export type PowerShellOp = 'cred-read' | 'cred-write' | 'cred-delete' | 'dialog' | 'device'

export function powershellPath(env: NodeJS.ProcessEnv): string {
  return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export const encodeCommand = (script: string) => Buffer.from(script, 'utf16le').toString('base64')
export const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
export const unb64 = (value: string) => Buffer.from(value.trim(), 'base64').toString('utf8')

// why: secrets, labels and emails travel only as base64 lines on stdin; ScriptBlock logging and AMSI see the script text, and the console codepage would mangle non-ASCII.
export function runPowerShell(
  deps: { runner: Runner; env: NodeJS.ProcessEnv },
  op: PowerShellOp,
  body: string,
  lines: string[],
  opts?: { timeoutMs?: number; hideWindow?: boolean }
): Promise<RunResult> {
  const script = `# nortia ${op}\n$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'\n${body}`
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)]
  return deps.runner(powershellPath(deps.env), args, lines.join('\n') + '\n', opts)
}
