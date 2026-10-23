$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($payload.mode -cnotin @('valid', 'kind', 'unprotected', 'missing', 'broad', 'deny', 'rights', 'inherited', 'flags')) { throw 'invalid_mock_mode' }
$script = $payload.script.Replace('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', "'S-1-5-21-1'")
if ($script -ceq $payload.script) { throw 'missing_mock_sid_boundary' }
$script:mode = $payload.mode
# Only fake descriptors. No native ACL, DPAPI, registry, product or installer.
function Get-Item {
    param([string]$LiteralPath, [switch]$Force)
    $directory = $LiteralPath.EndsWith('0') -or $LiteralPath.EndsWith('2')
    if ($script:mode -ceq 'kind') { $directory = -not $directory }
    return [pscustomobject]@{ PSIsContainer = $directory }
}
function Get-Acl {
    param([string]$LiteralPath)
    $directory = $LiteralPath.EndsWith('0') -or $LiteralPath.EndsWith('2')
    $identities = @('S-1-5-21-1', 'S-1-5-18', 'S-1-5-32-544')
    if ($script:mode -ceq 'missing') { $identities = $identities[0..1] }
    if ($script:mode -ceq 'broad') { $identities[0] = 'S-1-1-0' }
    $rules = @($identities | ForEach-Object {
        $identity = [pscustomobject]@{ Value = $_ }
        $identity | Add-Member -MemberType ScriptMethod -Name Translate -Value { param($type) return $this }
        [pscustomobject]@{
            IdentityReference = $identity
            AccessControlType = $(if ($script:mode -ceq 'deny') { 'Deny' } else { 'Allow' })
            FileSystemRights = $(if ($script:mode -ceq 'rights') { 1 } else { 2032127 })
            IsInherited = $script:mode -ceq 'inherited'
            InheritanceFlags = $(if ($script:mode -ceq 'flags') { 1 } elseif ($directory) { 3 } else { 0 })
        }
    })
    $acl = [pscustomobject]@{ AreAccessRulesProtected = $script:mode -cne 'unprotected'; Rules = $rules }
    $acl | Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value { param($explicit, $inherited, $type) return $this.Rules }
    return $acl
}
$inputLiteral = "'" + (($payload.items | ConvertTo-Json -Depth 5 -Compress).Replace("'", "''")) + "'"
$replay = $script.Replace('[Console]::In.ReadToEnd()', $inputLiteral)
if ($replay -ceq $script) { throw 'missing_mock_input_boundary' }
$script = $replay
& ([scriptblock]::Create($script))
if ($LASTEXITCODE -eq 1) { exit 1 }
