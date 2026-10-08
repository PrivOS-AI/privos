# Body of tests/test-install-ps1.sh (run by it through pwsh): exercises the pure and
# fixture-driven parts of install.ps1 on any OS. Prints "ok - ..." / "not ok - ..." lines
# and exits non-zero when any assertion failed. Never prints secret values.
param(
    [Parameter(Mandatory = $true)][string]$InstallPs1,
    [Parameter(Mandatory = $true)][string]$KeysFile,
    [Parameter(Mandatory = $true)][string]$FixtureDir,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [string]$ShEnvDefault = '',
    [string]$ShEnvFlags = '',
    [string]$ShConstsFile = '',
    [string]$BundleDir = '',
    [string]$PubKey = '',
    [string]$MinisignExe = '',
    [string]$KeyfilePassword = '',
    [string]$ExpectedKeyfile = '',
    [string]$FakeBinDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Run = 0
$script:Failed = 0
function Assert-True {
    param($Condition, [string]$Message)
    $script:Run++
    if ($Condition) { Write-Output "ok - $Message" }
    else { $script:Failed++; Write-Output "not ok - $Message" }
}
function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    $script:Run++
    if ("$Expected" -ceq "$Actual") { Write-Output "ok - $Message" }
    else { $script:Failed++; Write-Output "not ok - $Message (expected [$Expected] got [$Actual])" }
}
function Assert-Throws {
    param([scriptblock]$Block, [string]$Pattern, [string]$Message)
    $script:Run++
    $msg = $null
    try { & $Block | Out-Null } catch { $msg = $_.Exception.Message }
    if ($null -ne $msg -and $msg -match $Pattern) { Write-Output "ok - $Message" }
    else { $script:Failed++; Write-Output "not ok - $Message (threw: [$msg])" }
}
function Assert-NoThrow {
    param([scriptblock]$Block, [string]$Message)
    $script:Run++
    $msg = $null
    try { & $Block | Out-Null } catch { $msg = $_.Exception.Message }
    if ($null -eq $msg) { Write-Output "ok - $Message" }
    else { $script:Failed++; Write-Output "not ok - $Message (threw: [$msg])" }
}
function ConvertFrom-Base64UrlText {
    param([string]$Text)
    $b = $Text.Replace('-', '+').Replace('_', '/')
    while ($b.Length % 4 -ne 0) { $b += '=' }
    return , [Convert]::FromBase64String($b)
}
function Get-EnvKeyList {
    param([string]$Path)
    $keys = @()
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=') { $keys += $Matches[1] }
    }
    return , $keys
}
# .env text without comment lines; used to compare two renderings.
function Get-EnvBody {
    param([string]$Path)
    return (([IO.File]::ReadAllLines($Path) | Where-Object { $_ -notmatch '^#' }) -join "`n")
}
function Get-EnvKeyDiff {
    param([string]$PathA, [string]$PathB)
    $a = @{}; $b = @{}
    foreach ($l in [IO.File]::ReadAllLines($PathA)) { if ($l -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $a[$Matches[1]] = $Matches[2] } }
    foreach ($l in [IO.File]::ReadAllLines($PathB)) { if ($l -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $b[$Matches[1]] = $Matches[2] } }
    return @($a.Keys | Where-Object { $a[$_] -cne $b[$_] }) -join ','
}

# --- load install.ps1 without running main ---------------------------------

$bytes = [IO.File]::ReadAllBytes($InstallPs1)
Assert-True (-not ($bytes | Where-Object { $_ -gt 127 })) 'install.ps1 is ASCII only (irm without a charset decodes as ISO-8859-1)'
Assert-True (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB)) 'install.ps1 has no BOM'

# Environment values the bash wrapper pinned for the byte comparison; later tests clear some of them.
$presetNames = @('MONGO_ROOT_PASSWORD', 'ADMIN_PASS', 'REG_TOKEN', 'SANDBOX_API_KEY', 'CATALOG_SECRET_KEY', 'RUSTFS_ROOT_PASSWORD', 'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'WEAVIATE_ROOT_KEY', 'PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN', 'PRIVOS_SECRET_STORE_KEY', 'PRIVOS_DEPLOYMENT_ID', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'ADMIN_EMAIL', 'PRIVOS_DIR', 'PRIVOS_DOCKER_SOCKET_GID')
$presetSnapshot = @{}
foreach ($n in $presetNames) { $presetSnapshot[$n] = [Environment]::GetEnvironmentVariable($n) }
function Restore-Presets {
    foreach ($n in $presetNames) { [Environment]::SetEnvironmentVariable($n, $presetSnapshot[$n]) }
}

$env:PRIVOS_INSTALL_PS1_NO_MAIN = '1'
. $InstallPs1
Assert-True ($null -ne (Get-Command Invoke-Main -ErrorAction SilentlyContinue)) 'dot-sourcing with PRIVOS_INSTALL_PS1_NO_MAIN=1 defines functions without running main'
foreach ($fn in 'Invoke-Preflight', 'Confirm-LicenseAcceptance', 'Get-Bundle', 'Test-BundleIntegrity', 'New-Secrets', 'Write-EnvFile', 'Initialize-Networks', 'Start-Stack', 'Initialize-ReplicaSet', 'Wait-StackReady', 'Invoke-InteractiveActivation', 'Show-Summary', 'Remove-Install') {
    Assert-True ($null -ne (Get-Command $fn -ErrorAction SilentlyContinue)) "function $fn exists"
}

# --- constants that must match install.sh -----------------------------------

if ($ShConstsFile -and (Test-Path -LiteralPath $ShConstsFile)) {
    $map = @{
        DEFAULT_HUB_PORT = 'DefaultHubPort'; DEFAULT_BOARD_PORT = 'DefaultBoardPort'; DEFAULT_PROXY_PORT = 'DefaultProxyPort'
        DEFAULT_RUSTFS_PORT = 'DefaultRustfsPort'; DEFAULT_VM_PORT_RANGE = 'DefaultVmPortRange'; MIN_RAM_MB = 'MinRamMb'
        STACK_READY_TIMEOUT_SEC = 'StackReadyTimeoutSec'; NETWORK_NAME = 'NetworkName'; AGENT_NETWORK_NAME = 'AgentNetworkName'
        AGENT_NETWORK_BRIDGE_IFACE = 'AgentNetworkBridgeIface'; PROJECT_NAME = 'ProjectName'; LICENSE_VERSION = 'LicenseVersion'
        MAX_PORT_RANGE_SPAN = 'MaxPortRangeSpan'; LICENSE_MARKER_FILE = 'LicenseMarkerFile'; MINISIGN_PUBLIC_KEY = 'MinisignPublicKey'
        MINISIGN_PUBLIC_KEY_IS_DEV_ONLY = 'MinisignPublicKeyIsDevOnly'
    }
    foreach ($line in [IO.File]::ReadAllLines($ShConstsFile)) {
        $i = $line.IndexOf('=')
        if ($i -lt 1) { continue }
        $name = $line.Substring(0, $i)
        $val = $line.Substring($i + 1)
        if ($map.ContainsKey($name)) { Assert-Equal $val $script:PxConst[$map[$name]] "constant $name matches install.sh" }
        elseif ($name -eq 'BUNDLE_FILES') {
            $shFiles = @($val.Split(',') | Where-Object { $_ } | Sort-Object)
            $psFiles = @($script:PxConst.BundleFiles | Where-Object { $_ -ne 'compose.desktop.yml' } | Sort-Object)
            Assert-Equal ($shFiles -join ',') ($psFiles -join ',') 'bundle file list matches install.sh (plus compose.desktop.yml)'
        }
        elseif ($name -eq 'UNSIGNED_HASHED_FILES') {
            Assert-Equal (@($val.Split(',') | Sort-Object) -join ',') (@($script:PxConst.UnsignedHashedFiles | Sort-Object) -join ',') 'hashed bundle files match install.sh'
        }
    }
}

# --- pure helpers -------------------------------------------------------------

Assert-True (Test-VersionAtLeast '2.40.3-desktop.1' '2.27.0') 'Test-VersionAtLeast: 2.40.3-desktop.1 >= 2.27.0'
Assert-True (Test-VersionAtLeast 'v2.27.0' '2.27.0') 'Test-VersionAtLeast: v2.27.0 >= 2.27.0'
Assert-True (-not (Test-VersionAtLeast '2.26.9' '2.27.0')) 'Test-VersionAtLeast: 2.26.9 < 2.27.0'
Assert-True (Test-VersionAtLeast '1.45' '1.45') 'Test-VersionAtLeast: API 1.45 >= 1.45'
Assert-True (Test-VersionAtLeast '1.51' '1.45') 'Test-VersionAtLeast: API 1.51 >= 1.45'
Assert-True (-not (Test-VersionAtLeast '1.44' '1.45')) 'Test-VersionAtLeast: API 1.44 < 1.45'
Assert-True (-not (Test-VersionAtLeast 'garbage' '1.45')) 'Test-VersionAtLeast: unparseable is false'
Assert-True (Test-WindowsBuildSupported 19045) 'Windows 10 22H2 (19045) is supported'
Assert-True (-not (Test-WindowsBuildSupported 19044)) 'Windows 10 21H2 (19044) is not supported'
Assert-Equal 'x64' (Resolve-HostArch 'AMD64') 'arch AMD64 -> x64'
Assert-Equal 'x64' (Resolve-HostArch 'x86' 'AMD64') 'arch 32-bit PowerShell on 64-bit Windows -> x64'
Assert-Equal 'arm64' (Resolve-HostArch 'ARM64') 'arch ARM64 -> arm64'
Assert-Equal 'privos.example' (Get-UrlHostname 'https://user:pw@privos.example:8443/path') 'Get-UrlHostname strips userinfo, port and path'
Assert-Equal '' (Get-UrlHostname 'not-a-url') 'Get-UrlHostname: no scheme -> empty'
Assert-Equal "'plain'" (ConvertTo-EnvQuoted 'plain') 'ConvertTo-EnvQuoted: plain value'
Assert-Equal "'a'\''b'" (ConvertTo-EnvQuoted "a'b") 'ConvertTo-EnvQuoted: escapes an embedded single quote'
Assert-Equal "o'brien 'x'" (ConvertFrom-EnvQuoted (ConvertTo-EnvQuoted "o'brien 'x'")) 'ConvertFrom-EnvQuoted reverses ConvertTo-EnvQuoted'
Assert-Equal 'bare' (ConvertFrom-EnvQuoted 'bare') 'ConvertFrom-EnvQuoted leaves an unquoted value alone'
Assert-Equal 3 @(Expand-PortRange '30000-30002').Count 'Expand-PortRange: 30000-30002 has 3 ports'
Assert-Throws { Expand-PortRange '30010-30000' } 'start must be <= end' 'Expand-PortRange rejects an inverted range'
Assert-Throws { Expand-PortRange '1-6000' } 'refusing' 'Expand-PortRange rejects a span over the maximum'
Assert-Throws { Expand-PortRange 'abc' } 'invalid port range' 'Expand-PortRange rejects garbage'
Assert-NoThrow { Test-ValidPort '3000' 'p' } 'Test-ValidPort accepts 3000'
Assert-Throws { Test-ValidPort '0' 'p' } 'between 1 and 65535' 'Test-ValidPort rejects 0'
Assert-Throws { Test-ValidPort '65536' 'p' } 'between 1 and 65535' 'Test-ValidPort rejects 65536'
Assert-Throws { Test-ValidPort 'abc' 'p' } 'positive integer' 'Test-ValidPort rejects text'
Assert-Throws { Test-ValidPort '-1' 'p' } 'positive integer' 'Test-ValidPort rejects a negative number'

# --- install directory validation ------------------------------------------

$prot = @('C:\Windows', 'C:\Users', 'C:\Users\me', 'C:\Users\me\AppData\Local')
Assert-Equal 'C:\PrivOS' (Get-ValidatedPrivosDir 'C:\PrivOS' $prot) 'Get-ValidatedPrivosDir accepts C:\PrivOS'
Assert-Equal 'C:\Users\me\AppData\Local\PrivOS' (Get-ValidatedPrivosDir 'C:/Users/me/AppData/Local/PrivOS/' $prot) 'Get-ValidatedPrivosDir normalizes slashes and a trailing slash'
Assert-Equal 'D:\My Data\PrivOS (2)' (Get-ValidatedPrivosDir 'D:\My Data\PrivOS (2)' $prot) 'Get-ValidatedPrivosDir accepts spaces and parentheses'
Assert-Throws { Get-ValidatedPrivosDir 'C:\' $prot } 'drive root' 'Get-ValidatedPrivosDir rejects a drive root'
Assert-Throws { Get-ValidatedPrivosDir 'C:\Windows' $prot } 'protected' 'Get-ValidatedPrivosDir rejects C:\Windows'
Assert-Throws { Get-ValidatedPrivosDir 'c:/users/ME/' $prot } 'protected' 'Get-ValidatedPrivosDir rejects the profile directory (case-insensitive)'
Assert-Throws { Get-ValidatedPrivosDir 'privos' $prot } 'absolute' 'Get-ValidatedPrivosDir rejects a relative path'
Assert-Throws { Get-ValidatedPrivosDir '\\server\share\privos' $prot } 'absolute' 'Get-ValidatedPrivosDir rejects a UNC path'
Assert-Throws { Get-ValidatedPrivosDir 'C:\a\..\b' $prot } "'..'" 'Get-ValidatedPrivosDir rejects a .. segment'
Assert-Throws { Get-ValidatedPrivosDir 'C:\a\.\b' $prot } "'.'" 'Get-ValidatedPrivosDir rejects a . segment'
Assert-Throws { Get-ValidatedPrivosDir 'C:\a;b' $prot } 'unsupported characters' 'Get-ValidatedPrivosDir rejects a semicolon'
Assert-Throws { Get-ValidatedPrivosDir 'C:\a$b' $prot } 'unsupported characters' 'Get-ValidatedPrivosDir rejects a dollar sign'
Assert-Throws { Get-ValidatedPrivosDir "C:\a'b" $prot } 'unsupported characters' 'Get-ValidatedPrivosDir rejects a single quote'

# --- parsing of Windows command output -----------------------------------------

$netstat = ConvertFrom-NetstatOutput ([IO.File]::ReadAllLines((Join-Path $FixtureDir 'ps1-netstat.txt')))
Assert-True ($netstat.ContainsKey(3000) -and $netstat[3000].Pid -eq '9876') 'netstat: port 3000 listener and PID parsed'
Assert-True ($netstat.ContainsKey(135) -and $netstat.ContainsKey(445)) 'netstat: IPv4 and IPv6 listeners parsed'
Assert-True (-not $netstat.ContainsKey(50123)) 'netstat: ESTABLISHED connections are ignored'
Assert-Equal 5 $netstat.Count 'netstat: five distinct listening ports'
$excluded = @(ConvertFrom-ExcludedPortRangeOutput ([IO.File]::ReadAllLines((Join-Path $FixtureDir 'ps1-excluded-ports.txt'))))
Assert-Equal 3 $excluded.Count 'excluded ranges: three ranges parsed (including the administered one)'
Assert-True ($excluded[1].Start -eq 2913 -and $excluded[1].End -eq 3012) 'excluded ranges: 2913-3012 parsed'
Assert-Equal '3000,8080' ((Get-HostPortsFromInspectJson '{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"3000"}],"8080/tcp":[{"HostIp":"::","HostPort":"8080"}],"9/tcp":null}') -join ',') 'inspect JSON: host ports extracted'
$info = ConvertFrom-DockerInfoLine 'linux|Docker Desktop|8228864000|8'
Assert-True ($info.OSType -eq 'linux' -and $info.OperatingSystem -eq 'Docker Desktop' -and $info.MemTotal -eq 8228864000 -and $info.NCPU -eq 8) 'docker info line parsed'
Assert-True ($null -eq (ConvertFrom-DockerInfoLine 'garbage')) 'docker info line: garbage -> null'

# --- port selection (listeners injected) -----------------------------------------

function Get-PortListeners { return @{} }
function Get-ExcludedPortRanges { return @(ConvertFrom-ExcludedPortRangeOutput ([IO.File]::ReadAllLines((Join-Path $FixtureDir 'ps1-excluded-ports.txt')))) }
function Get-ContainerPortsJson { param([string]$Container) if ($Container -eq 'privos-hub') { return '{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"3000"}]}' } return '' }

Initialize-State @{}
$script:PxState.Listeners = @{ 8556 = @{ Pid = '77'; Cmd = 'foreign' }; 3000 = @{ Pid = '78'; Cmd = 'com.docker.backend' } }
$script:PxState.Excluded = $null
$script:PxState.OurPorts = $null
Assert-True (-not (Test-PortFree 8556)) 'Test-PortFree: a foreign listener is busy'
Assert-True (-not (Test-PortFree 3000)) 'Test-PortFree: a port inside a Windows excluded range is busy even when our container holds it'
Assert-True (Test-PortFree 8557) 'Test-PortFree: an idle port is free'
$script:PxState.Excluded = @()
Assert-True (Test-PortFree 3000) 'Test-PortFree: our own container publishing the port counts as free'
$script:PxState.Excluded = $null
Assert-Equal 3013 (Find-FreePort -Start 2913) 'Find-FreePort skips the excluded range'
Assert-Equal 8557 (Find-FreePort -Start 8556) 'Find-FreePort skips a foreign listener'
Assert-Equal 8558 (Find-FreePort -Start 8556 -Avoid @(8557)) 'Find-FreePort honours the avoid list'

# default ports move on a fresh install; explicit ports do not
Initialize-State @{}
function Get-PortListeners { return @{ 8556 = @{ Pid = '77'; Cmd = 'foreign' } } }
function Get-ContainerPortsJson { param([string]$Container) return '' }
function Get-ExcludedPortRanges { return @() }
$script:PxState.AssumeYes = $true
Resolve-Config
Assert-Equal '8557' (Get-EnvValue 'PRIVOS_BOARD_PORT') 'Resolve-Config moves a busy default board port'
Assert-Equal '3000' (Get-EnvValue 'PRIVOS_HUB_PORT') 'Resolve-Config keeps a free default hub port'
Assert-Equal 'http://localhost:3000' (Get-EnvValue 'PRIVOS_ROOT_URL') 'Resolve-Config derives ROOT_URL from the hub port'
$env:PRIVOS_BOARD_PORT = '8556'
Initialize-State @{}
Resolve-Config
Assert-Equal '8556' (Get-EnvValue 'PRIVOS_BOARD_PORT') 'Resolve-Config never moves an explicit port'
Assert-True (-not (Test-Ports @(8556))) 'Test-Ports: an explicit busy port is a conflict'
Assert-True (Test-Ports @(3000, 8558)) 'Test-Ports: free ports pass'
Remove-Item Env:\PRIVOS_BOARD_PORT

# --- env precedence + dev key ----------------------------------------------------

$dev = Join-Path $WorkDir 'precedence'
New-Item -ItemType Directory -Force -Path $dev | Out-Null
[IO.File]::WriteAllText((Join-Path $dev '.env'), "# c`nADMIN_PASS='from-file'`nPRIVOS_HUB_PORT='3456'`nUNKNOWN_KEY='x'`nPRIVOS_ROOT_URL='http://h/o'\''x'`n")
$env:ADMIN_PASS = 'from-invocation'
Initialize-State @{}
$script:PxState.Dir = $dev
Import-ExistingEnv
Assert-Equal 'from-invocation' (Get-EnvValue 'ADMIN_PASS') 'Import-ExistingEnv: an already-set value wins over the persisted .env'
Assert-Equal '3456' (Get-EnvValue 'PRIVOS_HUB_PORT') 'Import-ExistingEnv: persisted value fills a missing key'
Assert-Equal "http://h/o'x" (Get-EnvValue 'PRIVOS_ROOT_URL') 'Import-ExistingEnv: unquotes an embedded single quote'
Assert-True (-not $script:PxEnv.Contains('UNKNOWN_KEY')) 'Import-ExistingEnv: keys outside the .env key set are ignored'
Remove-Item Env:\ADMIN_PASS

[IO.File]::WriteAllText((Join-Path $dev '.env'), "ADMIN_PASS='x'`nMINIO_ROOT_USER='old'`n")
Assert-Throws { Test-UpgradeAcrossRename } 'MinIO -> RustFS rename' 'Test-UpgradeAcrossRename refuses a MinIO-era .env'
[IO.File]::WriteAllText((Join-Path $dev '.env'), "ADMIN_PASS='x'`n")
Assert-NoThrow { Test-UpgradeAcrossRename } 'Test-UpgradeAcrossRename accepts a current .env'

Initialize-State @{}
$script:PxConst.MinisignPublicKeyIsDevOnly = 'true'
Assert-Throws { Test-DevSigningKey } 'DEV-ONLY' 'Test-DevSigningKey: refuses a dev key by default'
$script:PxState.AllowDevKey = $true
Assert-NoThrow { Test-DevSigningKey } 'Test-DevSigningKey: -AllowDevSigningKey proceeds'
$script:PxConst.MinisignPublicKeyIsDevOnly = 'false'
$script:PxState.AllowDevKey = $false
Assert-NoThrow { Test-DevSigningKey } 'Test-DevSigningKey: a production key passes'

# bundle URL
Remove-Item Env:\PRIVOS_BUNDLE_BASE_URL -ErrorAction SilentlyContinue
Initialize-State @{}
$script:BundleReleaseTag = 'self-hosted-7.15.41'
Assert-Equal 'https://github.com/PrivOS-AI/privos/releases/download/self-hosted-7.15.41' (Resolve-BundleBaseUrl) 'Resolve-BundleBaseUrl: baked tag'
Initialize-State @{ Version = 'self-hosted-9.9.9' }
Assert-Equal 'https://github.com/PrivOS-AI/privos/releases/download/self-hosted-9.9.9' (Resolve-BundleBaseUrl) 'Resolve-BundleBaseUrl: -Version overrides the baked tag'
$env:PRIVOS_BUNDLE_BASE_URL = 'https://mirror.example.test/bundle'
Assert-Equal 'https://mirror.example.test/bundle' (Resolve-BundleBaseUrl) 'Resolve-BundleBaseUrl: PRIVOS_BUNDLE_BASE_URL overrides everything'
Remove-Item Env:\PRIVOS_BUNDLE_BASE_URL

# --- native command wrapper ------------------------------------------------------

$ErrorActionPreference = 'Stop'
$r = Invoke-Native -File 'sh' -ArgList @('-c', 'echo out; echo err >&2; exit 3')
Assert-Equal 3 $r.Code 'Invoke-Native: exit code returned'
Assert-True (($r.Lines -contains 'out') -and ($r.Lines -contains 'err')) 'Invoke-Native: stderr is folded in without raising under ErrorActionPreference=Stop'
$r = Invoke-Native -File 'sh' -ArgList @('-c', 'echo out; echo err >&2') -StdoutOnly
Assert-Equal 'out' $r.Text 'Invoke-Native -StdoutOnly drops stderr'
$r = Invoke-Native -File 'definitely-not-a-command-xyz' -ArgList @()
Assert-True ($r.Code -ne 0) 'Invoke-Native: a missing command is a non-zero result, not an exception'

# --- secrets + .env rendering ----------------------------------------------------

# no listeners, no excluded ranges, no containers: the renderings below must not move any port
function Get-PortListeners { return @{} }
function Get-ExcludedPortRanges { return @() }
function Get-ContainerPortsJson { param([string]$Container) return '' }

function Write-Rendering {
    param([hashtable]$Flags, [string]$Target)
    Initialize-State $Flags
    $script:PxState.AssumeYes = $true
    $script:PxState.Dir = Join-Path $WorkDir 'inst'
    New-Item -ItemType Directory -Force -Path (Join-Path $script:PxState.Dir 'secrets') | Out-Null
    if (-not (Test-EnvSet 'PRIVOS_DIR')) { $script:PxEnv['PRIVOS_DIR'] = $script:PxState.Dir }
    Resolve-Config
    Read-SidecarChoices
    Complete-SidecarConfig
    New-Secrets
    Write-EnvFile -Path $Target
}

$rendered = Join-Path $WorkDir 'rendered.env'
Restore-Presets
$envBackup = @{}
$presets = @{
    ADMIN_EMAIL = "o'brien@example.test"; PRIVOS_DIR = 'C:/test/PrivOS'; PRIVOS_DOCKER_SOCKET_GID = '0'
}
if ($ShEnvDefault) {
    # the same fixed values the bash side used, so the two renderings can be byte-compared
    foreach ($k in 'MONGO_ROOT_PASSWORD', 'ADMIN_PASS', 'REG_TOKEN', 'SANDBOX_API_KEY', 'CATALOG_SECRET_KEY', 'RUSTFS_ROOT_PASSWORD', 'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'WEAVIATE_ROOT_KEY', 'PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN', 'PRIVOS_SECRET_STORE_KEY', 'PRIVOS_DEPLOYMENT_ID', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY') {
        if (-not [Environment]::GetEnvironmentVariable($k)) { Write-Output "not ok - preset $k missing from the environment"; $script:Failed++; $script:Run++ }
    }
}
else {
    # standalone run: only the keyfile password is pinned
    $env:MONGO_ROOT_PASSWORD = $KeyfilePassword
    foreach ($k in $presets.Keys) { [Environment]::SetEnvironmentVariable($k, $presets[$k]) }
}

Write-Rendering @{} $rendered
$envBytes = [IO.File]::ReadAllBytes($rendered)
Assert-True (-not ($envBytes[0] -eq 0xEF -and $envBytes[1] -eq 0xBB -and $envBytes[2] -eq 0xBF)) '.env has no UTF-8 BOM'
Assert-True (-not ($envBytes -contains 13)) '.env uses LF line endings only'
Assert-True ($envBytes[$envBytes.Length - 1] -eq 10) '.env ends with a newline'
$psKeys = Get-EnvKeyList $rendered
$shKeys = @([IO.File]::ReadAllLines($KeysFile) | Where-Object { $_ })
Assert-Equal (($shKeys | Sort-Object) -join ',') (($psKeys | Sort-Object) -join ',') '.env key set matches install.sh write_env_file (sorted)'
Assert-Equal ($shKeys -join ',') ($psKeys -join ',') '.env key order matches install.sh write_env_file'
Assert-Equal ($script:PxConst.EnvKeys -join ',') ($psKeys -join ',') 'rendered keys follow the EnvKeys list'
Assert-Equal 0 ($psKeys | Group-Object | Where-Object { $_.Count -gt 1 } | Measure-Object).Count 'no duplicate .env keys'

# byte-for-byte against install.sh with identical inputs
if ($ShEnvDefault -and (Test-Path -LiteralPath $ShEnvDefault)) {
    Assert-Equal '' (Get-EnvKeyDiff $rendered $ShEnvDefault) 'default scenario: every .env value equals install.sh (differing keys listed)'
    Assert-Equal (Get-EnvBody $ShEnvDefault) (Get-EnvBody $rendered) 'default scenario: .env body is byte-identical to install.sh output'
}
if ($ShEnvFlags -and (Test-Path -LiteralPath $ShEnvFlags)) {
    $flagsOut = Join-Path $WorkDir 'rendered-flags.env'
    Write-Rendering @{ HubPort = '3100'; Url = 'https://hub.example.test'; VmPortRange = '31000-31010'; EgressAllowlist = '10.20.0.0/16'; Version = 'self-hosted-9.9.9'; WithKnowledgeVector = $true; WithoutAppCluster = $true } $flagsOut
    Assert-Equal '' (Get-EnvKeyDiff $flagsOut $ShEnvFlags) 'flags scenario: every .env value equals install.sh (differing keys listed)'
    Assert-Equal (Get-EnvBody $ShEnvFlags) (Get-EnvBody $flagsOut) 'flags scenario: .env body is byte-identical to install.sh output'
}

# generated formats (a clean state so every secret is generated by New-Secrets)
foreach ($k in 'ADMIN_PASS', 'REG_TOKEN', 'SANDBOX_API_KEY', 'CATALOG_SECRET_KEY', 'RUSTFS_ROOT_PASSWORD', 'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'WEAVIATE_ROOT_KEY', 'PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN', 'PRIVOS_SECRET_STORE_KEY', 'PRIVOS_DEPLOYMENT_ID', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'MONGO_ROOT_PASSWORD') {
    Remove-Item "Env:\$k" -ErrorAction SilentlyContinue
}
$env:MONGO_ROOT_PASSWORD = $KeyfilePassword
$fresh = Join-Path $WorkDir 'fresh.env'
Write-Rendering @{} $fresh
Assert-True ((Get-EnvValue 'ADMIN_PASS') -cmatch '^[0-9a-f]{48}$') 'ADMIN_PASS is 24 random bytes as hex'
Assert-True ((Get-EnvValue 'REG_TOKEN') -cmatch '^[0-9a-f]{64}$') 'REG_TOKEN is 32 random bytes as hex'
Assert-True ((Get-EnvValue 'RUSTFS_ACCESS_KEY') -cmatch '^privos-[0-9a-f]{12}$') 'RUSTFS_ACCESS_KEY is privos- plus 12 hex'
Assert-True ((Get-EnvValue 'RUSTFS_SECRET_KEY') -cmatch '^[0-9a-f]{32}$') 'RUSTFS_SECRET_KEY is 32 hex chars (RustFS caps it at 40)'
Assert-True ((Get-EnvValue 'PRIVOS_DEPLOYMENT_ID') -cmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') 'PRIVOS_DEPLOYMENT_ID is a lowercase UUID'
Assert-Equal 32 ([Convert]::FromBase64String((Get-EnvValue 'PRIVOS_SECRET_STORE_KEY'))).Length 'PRIVOS_SECRET_STORE_KEY is 32 raw bytes, base64'
Assert-Equal 'mailto:o''brien@example.test' (Get-EnvValue 'VAPID_SUBJECT') 'VAPID_SUBJECT follows ADMIN_EMAIL'
$vp = ConvertFrom-Base64UrlText (Get-EnvValue 'VAPID_PUBLIC_KEY')
$vd = ConvertFrom-Base64UrlText (Get-EnvValue 'VAPID_PRIVATE_KEY')
Assert-Equal 65 $vp.Length 'VAPID public key decodes to 65 bytes'
Assert-Equal 4 $vp[0] 'VAPID public key is an uncompressed point (0x04 prefix)'
Assert-Equal 32 $vd.Length 'VAPID private key decodes to 32 bytes'
Assert-Equal 87 (Get-EnvValue 'VAPID_PUBLIC_KEY').Length 'VAPID public key is 87 chars (same as install.sh)'
Assert-Equal 43 (Get-EnvValue 'VAPID_PRIVATE_KEY').Length 'VAPID private key is 43 chars (same as install.sh)'
Assert-True ((Get-EnvValue 'VAPID_PUBLIC_KEY') -cnotmatch '[=+/]') 'VAPID public key is unpadded base64url'
$mu = Get-EnvValue 'MONGO_URL'
Assert-True ($mu.StartsWith('mongodb://privos:') -and $mu.EndsWith('@mongo:27017/privos?replicaSet=rs0&authSource=admin&w=1')) 'MONGO_URL shape matches install.sh'
Assert-True ((Get-EnvValue 'MONGODB_URL').EndsWith('@mongo:27017/?replicaSet=rs0&authSource=admin&w=1')) 'MONGODB_URL shape matches install.sh'
# a second New-Secrets keeps what exists (re-run safety)
$before = Get-EnvValue 'ADMIN_PASS'
New-Secrets
Assert-Equal $before (Get-EnvValue 'ADMIN_PASS') 'New-Secrets keeps an existing ADMIN_PASS'

# mongo keyfile
$keyfile = Write-MongoKeyfile
$kb = [IO.File]::ReadAllBytes($keyfile)
Assert-Equal 88 $kb.Length 'mongo keyfile is 88 bytes (base64 of a SHA-512 digest, like install.sh)'
Assert-True (-not ($kb -contains 10) -and -not ($kb -contains 13)) 'mongo keyfile has no line ending'
if ($ExpectedKeyfile) { Assert-Equal $ExpectedKeyfile ([Text.Encoding]::ASCII.GetString($kb)) 'mongo keyfile content equals install.sh mongo_keyfile_content for the same password' }

# --- bundle trust chain (real minisign signatures made by the bash wrapper) ---------

if ($BundleDir -and $MinisignExe) {
    function New-BundleCopy {
        param([string]$Name)
        $d = Join-Path $WorkDir "bundle-$Name"
        Copy-Item -LiteralPath $BundleDir -Destination $d -Recurse
        return $d
    }
    Initialize-State @{}
    $script:PxConst.MinisignPublicKey = $PubKey
    $script:PxState.MinisignExe = $MinisignExe

    $ok = New-BundleCopy 'ok'
    Assert-NoThrow { Test-BundleIntegrity -Dir $ok } 'Test-BundleIntegrity accepts a correctly signed and hashed bundle'

    $t = New-BundleCopy 'compose'
    Add-Content -LiteralPath (Join-Path $t 'compose.yml') -Value '# tampered'
    Assert-Throws { Test-BundleIntegrity -Dir $t } 'signature verification FAILED' 'Test-BundleIntegrity rejects a tampered compose.yml'

    $t = New-BundleCopy 'overlay'
    Add-Content -LiteralPath (Join-Path $t 'compose.desktop.yml') -Value '# tampered'
    Assert-Throws { Test-BundleIntegrity -Dir $t } 'signature verification FAILED' 'Test-BundleIntegrity rejects a tampered compose.desktop.yml'

    $t = New-BundleCopy 'versions'
    Add-Content -LiteralPath (Join-Path $t 'versions.json') -Value ' '
    Assert-Throws { Test-BundleIntegrity -Dir $t } 'signature verification FAILED' 'Test-BundleIntegrity rejects a tampered versions.json'

    $t = New-BundleCopy 'license'
    Add-Content -LiteralPath (Join-Path $t 'LICENSE') -Value 'tampered'
    Assert-Throws { Test-BundleIntegrity -Dir $t } 'sha256 mismatch for LICENSE' 'Test-BundleIntegrity rejects a LICENSE that no longer matches versions.json'

    $t = New-BundleCopy 'rustfs'
    Add-Content -LiteralPath (Join-Path $t 'rustfs-init.sh') -Value 'tampered'
    Assert-Throws { Test-BundleIntegrity -Dir $t } 'sha256 mismatch for rustfs-init.sh' 'Test-BundleIntegrity rejects a tampered rustfs-init.sh'

    $t = New-BundleCopy 'nosig'
    Remove-Item -LiteralPath (Join-Path $t 'compose.desktop.yml.minisig')
    Assert-Throws { Test-BundleIntegrity -Dir $t } 'missing signature' 'Test-BundleIntegrity requires compose.desktop.yml.minisig'

    $t = New-BundleCopy 'wrongkey'
    $script:PxConst.MinisignPublicKey = 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3'
    Assert-Throws { Test-BundleIntegrity -Dir $t } 'signature verification FAILED' 'Test-BundleIntegrity rejects signatures made by another key'
    $script:PxConst.MinisignPublicKey = $PubKey

    Initialize-State @{}
    Update-StackVersionFromBundle -Dir $ok
    Assert-Equal '9.9.9-test' (Get-EnvValue 'PRIVOS_STACK_VERSION') 'Update-StackVersionFromBundle adopts stackVersion from the verified versions.json'
}

# --- mongo shell scripts through a fake docker + mongosh ---------------------------------

if ($FakeBinDir) {
    $env:PATH = $FakeBinDir + [IO.Path]::PathSeparator + $env:PATH
    $log = Join-Path $WorkDir 'mongosh.log'
    $env:FAKE_MONGOSH_LOG = $log
    Initialize-State @{}
    $script:PxState.ComposeBase = @('compose', '-f', 'x.yml')

    $env:FAKE_MONGOSH_OUT = 'ok'
    Assert-NoThrow { Initialize-ReplicaSet } 'Initialize-ReplicaSet runs the mongosh script'
    $logText = [IO.File]::ReadAllText($log)
    Assert-True ($logText -match 'rs\.initiate') 'Initialize-ReplicaSet: the eval script reaches mongosh intact (quotes and braces)'
    Assert-True ($logText -match '(?m)^--authenticationDatabase$') 'Initialize-ReplicaSet: authenticates as root'
    Assert-True ($logText -match '(?m)^fake-root-user$') 'Initialize-ReplicaSet: credentials expand inside the container shell'

    $script:PxState.HadExistingEnv = $false
    Assert-NoThrow { Test-LocalRuntimeInstallations } 'Test-LocalRuntimeInstallations: skipped on a fresh install'
    $script:PxState.HadExistingEnv = $true
    $env:FAKE_MONGOSH_OUT = "banner line`n[]"
    Assert-NoThrow { Test-LocalRuntimeInstallations } 'Test-LocalRuntimeInstallations: empty array passes'
    $logText = [IO.File]::ReadAllText($log)
    Assert-True ($logText.Contains('$lookup') -and $logText.Contains('"c.0.connection"')) 'Test-LocalRuntimeInstallations: the aggregation reaches mongosh with $ operators intact'
    $env:FAKE_MONGOSH_OUT = '[{"_id":"a1","name":"legacy-app"}]'
    Assert-Throws { Test-LocalRuntimeInstallations } 'still bound|uninstall the app' 'Test-LocalRuntimeInstallations: a bound installation blocks the upgrade'
    $env:FAKE_MONGOSH_OUT = 'not json at all'
    Assert-Throws { Test-LocalRuntimeInstallations } 'could not parse' 'Test-LocalRuntimeInstallations: unparseable output fails closed'
    $env:FAKE_MONGOSH_OUT = '[]'
    $env:FAKE_MONGOSH_RC = '1'
    Assert-Throws { Test-LocalRuntimeInstallations } 'refusing to proceed blind' 'Test-LocalRuntimeInstallations: a query error fails closed'
    Remove-Item Env:\FAKE_MONGOSH_RC
}

# --- docker socket group probe (fake docker answers `docker run`) -------------------------------

if ($FakeBinDir) {
    Remove-Item Env:\PRIVOS_DOCKER_SOCKET_GID -ErrorAction SilentlyContinue
    $dlog = Join-Path $WorkDir 'docker-run.log'
    $env:FAKE_DOCKER_LOG = $dlog
    $dir = Join-Path $WorkDir 'probe'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $digest = ('ab' * 32)
    $published = '{"images":{"netguard":{"repository":"ghcr.io/privos-ai/privos-netguard","tag":"7.15.42","digest":"sha256:' + $digest + '"}}}'
    $unpublished = '{"images":{"netguard":{"repository":"ghcr.io/privos-ai/privos-netguard","tag":"PLACEHOLDER_STACK_VERSION","digest":"__NETGUARD_DIGEST__"}}}'
    $noimage = '{"images":{}}'

    [IO.File]::WriteAllText((Join-Path $dir 'versions.json'), $published)
    Assert-Equal "ghcr.io/privos-ai/privos-netguard:7.15.42@sha256:$digest" (Get-NetguardImageRef -Dir $dir) 'Get-NetguardImageRef builds repository:tag@digest from the verified versions.json'
    [IO.File]::WriteAllText((Join-Path $dir 'versions.json'), $published.Replace("sha256:$digest", $digest))
    Assert-Equal "ghcr.io/privos-ai/privos-netguard:7.15.42@sha256:$digest" (Get-NetguardImageRef -Dir $dir) 'Get-NetguardImageRef accepts a digest without the sha256: prefix'
    [IO.File]::WriteAllText((Join-Path $dir 'versions.json'), $unpublished)
    Assert-True ($null -eq (Get-NetguardImageRef -Dir $dir)) 'Get-NetguardImageRef: unpublished placeholders give no reference'
    [IO.File]::WriteAllText((Join-Path $dir 'versions.json'), $noimage)
    Assert-True ($null -eq (Get-NetguardImageRef -Dir $dir)) 'Get-NetguardImageRef: no netguard entry gives no reference'

    # probe succeeds
    [IO.File]::WriteAllText((Join-Path $dir 'versions.json'), $published)
    Initialize-State @{}
    $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'true'
    $env:FAKE_SOCKET_GID = '2375'
    Resolve-DockerSocketGid -Dir $dir
    Assert-Equal '2375' (Get-EnvValue 'PRIVOS_DOCKER_SOCKET_GID') 'Resolve-DockerSocketGid: the probed group is written (not a fixed 0)'
    $call = [IO.File]::ReadAllText($dlog)
    Assert-True ($call.Contains("ghcr.io/privos-ai/privos-netguard:7.15.42@sha256:$digest")) 'probe runs the netguard image from the verified versions.json'
    Assert-True ($call.Contains('--entrypoint stat') -and $call.Contains('/var/run/docker.sock:/s') -and $call.Contains('-c %g /s')) 'probe mounts the socket and runs stat -c %g'

    # fallback image when the bundle has no usable reference
    Remove-Item -LiteralPath $dlog
    [IO.File]::WriteAllText((Join-Path $dir 'versions.json'), $unpublished)
    Initialize-State @{}
    $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'true'
    Resolve-DockerSocketGid -Dir $dir
    Assert-True ([IO.File]::ReadAllText($dlog).Contains('alpine:3.20@sha256:')) 'probe falls back to the pinned alpine digest when the bundle has no netguard reference'

    # probe fails or answers garbage: 0 with a warning
    Initialize-State @{}
    $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'true'
    $env:FAKE_RUN_RC = '1'
    Resolve-DockerSocketGid -Dir $dir
    Assert-Equal '0' (Get-EnvValue 'PRIVOS_DOCKER_SOCKET_GID') 'Resolve-DockerSocketGid: a failed probe falls back to 0'
    Remove-Item Env:\FAKE_RUN_RC
    Initialize-State @{}
    $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'true'
    $env:FAKE_SOCKET_GID = 'not-a-number'
    Resolve-DockerSocketGid -Dir $dir
    Assert-Equal '0' (Get-EnvValue 'PRIVOS_DOCKER_SOCKET_GID') 'Resolve-DockerSocketGid: a non-numeric answer falls back to 0'

    # an existing value wins; no app cluster means no probe
    Remove-Item -LiteralPath $dlog -ErrorAction SilentlyContinue
    $env:FAKE_SOCKET_GID = '2375'
    Initialize-State @{}
    $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'true'
    $script:PxEnv['PRIVOS_DOCKER_SOCKET_GID'] = '999'
    Resolve-DockerSocketGid -Dir $dir
    Assert-Equal '999' (Get-EnvValue 'PRIVOS_DOCKER_SOCKET_GID') 'Resolve-DockerSocketGid: a preset or persisted value wins'
    Initialize-State @{}
    $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'false'
    Resolve-DockerSocketGid -Dir $dir
    Assert-True (-not (Test-EnvSet 'PRIVOS_DOCKER_SOCKET_GID')) 'Resolve-DockerSocketGid: nothing to resolve without the App Cluster'
    Assert-True (-not (Test-Path -LiteralPath $dlog)) 'no docker run happened for a preset value or without the App Cluster'
}

Write-Output ''
Write-Output "# $script:Run run, $($script:Run - $script:Failed) passed, $script:Failed failed - ps1-parity-test.ps1"
if ($script:Failed -gt 0) { exit 1 }
exit 0
