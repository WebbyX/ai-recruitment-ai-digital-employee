import type { ConfirmResult, PromptResult, SecretDeps } from '../secrets'
import { b64, runPowerShell, unb64 } from './powershell'

const DIALOG = [
  'try {',
  '$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$f = New-Object System.Windows.Forms.Form',
  "$f.Text = 'Nortia'",
  '$f.TopMost = $true',
  "$f.StartPosition = 'CenterScreen'",
  "$f.FormBorderStyle = 'FixedDialog'",
  '$f.MaximizeBox = $false',
  '$f.MinimizeBox = $false',
  '$f.ClientSize = New-Object System.Drawing.Size(440, 162)',
  '$l = New-Object System.Windows.Forms.Label',
  '$l.UseMnemonic = $false',
  '$l.Text = [string]$cfg.text',
  '$l.SetBounds(12, 12, 416, 60)',
  '$f.Controls.Add($l)',
  '$t = $null',
  "if ($cfg.mode -eq 'password') {",
  '  $t = New-Object System.Windows.Forms.TextBox',
  '  $t.UseSystemPasswordChar = $true',
  '  $t.SetBounds(12, 78, 416, 24)',
  '  $f.Controls.Add($t)',
  '}',
  '$ok = New-Object System.Windows.Forms.Button',
  '$ok.Text = [string]$cfg.ok',
  '$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK',
  '$ok.SetBounds(244, 120, 90, 28)',
  '$cancel = New-Object System.Windows.Forms.Button',
  "$cancel.Text = 'Cancel'",
  '$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel',
  '$cancel.SetBounds(338, 120, 90, 28)',
  '$f.Controls.Add($ok)',
  '$f.Controls.Add($cancel)',
  '$f.CancelButton = $cancel',
  "if ($cfg.mode -eq 'password') { $f.AcceptButton = $ok } else { $f.AcceptButton = $cancel; $f.ActiveControl = $cancel }",
  '$script:gaveUp = $false',
  'if ([int]$cfg.timeoutSeconds -gt 0) {',
  '  $timer = New-Object System.Windows.Forms.Timer',
  '  $timer.Interval = [int]$cfg.timeoutSeconds * 1000',
  '  $timer.add_Tick({ $script:gaveUp = $true; $timer.Stop(); $f.Close() })',
  '  $timer.Start()',
  '}',
  '$f.add_Shown({ $f.Activate() })',
  '$r = $f.ShowDialog()',
  'if ($script:gaveUp) { exit 12 }',
  'if ($r -ne [System.Windows.Forms.DialogResult]::OK) { exit 11 }',
  "if ($cfg.mode -eq 'password') { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t.Text))) }",
  'exit 0',
  '} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }'
].join('\n')

// why: no hideWindow and no time limit: a powershell started with windowsHide never shows its form, and the user may take a while to type.
function showDialog(config: { mode: 'password' | 'confirm'; text: string; ok: string; timeoutSeconds: number }, deps: SecretDeps) {
  return runPowerShell(deps, 'dialog', DIALOG, [b64(JSON.stringify(config))])
}

export async function confirmDialog(message: string, deps: SecretDeps): Promise<ConfirmResult> {
  const res = await showDialog({ mode: 'confirm', text: message, ok: 'Disconnect', timeoutSeconds: 120 }, deps)
  if (res.code === 0) return 'confirmed'
  if (res.code === 11 || res.code === 12) return 'cancelled'
  return 'error'
}

export async function promptSecret(label: string, deps: SecretDeps): Promise<PromptResult> {
  const res = await showDialog({ mode: 'password', text: label, ok: 'Save', timeoutSeconds: 0 }, deps)
  if (res.code === 0) return { value: unb64(res.stdout) }
  if (res.code === 11) return { cancelled: true }
  return { error: true }
}
