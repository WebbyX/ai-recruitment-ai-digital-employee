import { SERVICE, type Account, type DeleteResult, type SecretDeps, type SetResult } from '../secrets'
import { b64, runPowerShell, unb64, type PowerShellOp } from './powershell'

const CRED_TYPE = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.ComponentModel;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class NortiaCred {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  private struct CREDENTIAL {',
  '    public int Flags; public int Type; public string TargetName; public string Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;',
  '    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
  '  }',
  '  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern bool CredRead(string target, int type, int flags, out IntPtr cred);',
  '  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern bool CredWrite(ref CREDENTIAL cred, int flags);',
  '  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  private static extern bool CredDelete(string target, int type, int flags);',
  '  [DllImport("advapi32.dll")]',
  '  private static extern void CredFree(IntPtr buffer);',
  '  public static string Read(string target) {',
  '    IntPtr p;',
  '    if (!CredRead(target, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return null; throw new Win32Exception(e); }',
  '    try {',
  '      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));',
  '      if (c.CredentialBlobSize == 0) return "";',
  '      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);',
  '    } finally { CredFree(p); }',
  '  }',
  '  public static void Write(string target, string user, string value) {',
  '    byte[] b = Encoding.Unicode.GetBytes(value);',
  '    CREDENTIAL c = new CREDENTIAL();',
  '    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2; c.CredentialBlobSize = b.Length;',
  '    c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(b.Length, 1));',
  '    try {',
  '      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);',
  '      if (!CredWrite(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }',
  '  }',
  '  public static bool Delete(string target) {',
  '    if (CredDelete(target, 1, 0)) return true;',
  '    int e = Marshal.GetLastWin32Error(); if (e == 1168) return false; throw new Win32Exception(e);',
  '  }',
  '}',
  "'@"
]

const OPS = {
  'cred-read': ['$v = [NortiaCred]::Read($target)', 'if ($null -eq $v) { exit 10 }', '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))'],
  'cred-write': ['$v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))', '[NortiaCred]::Write($target, $account, $v)'],
  'cred-delete': ['if (-not [NortiaCred]::Delete($target)) { exit 10 }']
} satisfies Partial<Record<PowerShellOp, string[]>>

const LIMIT = { timeoutMs: 30000, hideWindow: true }
const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'"

/** Runs one Credential Manager operation: exit 0 is success (a read prints the value as base64), 10 is not found, anything else is an error. */
function cred(op: keyof typeof OPS, account: Account, deps: SecretDeps, lines: string[] = []) {
  const target = `${deps.targetPrefix ?? SERVICE}:${account}`
  const body = [
    `$target = ${quote(target)}; $account = ${quote(account)}`,
    'try {',
    ...CRED_TYPE,
    ...OPS[op],
    '} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }',
    'exit 0'
  ].join('\n')
  return runPowerShell(deps, op, body, lines, LIMIT)
}

export async function getSecret(account: Account, deps: SecretDeps): Promise<string | null> {
  const res = await cred('cred-read', account, deps)
  if (res.code !== 0) return null
  const value = unb64(res.stdout)
  return value ? value : null
}

export async function setSecret(account: Account, value: string, deps: SecretDeps): Promise<SetResult> {
  const res = await cred('cred-write', account, deps, [b64(value)])
  if (res.code !== 0) return 'failed'
  return (await getSecret(account, deps)) === value ? 'ok' : 'failed'
}

export async function deleteSecret(account: Account, deps: SecretDeps): Promise<DeleteResult> {
  const res = await cred('cred-delete', account, deps)
  if (res.code === 10) return 'not_found'
  if (res.code !== 0) return 'failed'
  return (await cred('cred-read', account, deps)).code === 10 ? 'deleted' : 'failed'
}

export async function hasSecret(account: Account, deps: SecretDeps): Promise<boolean> {
  return (await cred('cred-read', account, deps)).code === 0
}
