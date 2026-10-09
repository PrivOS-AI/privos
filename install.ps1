#Requires -Version 5.1
<#
.SYNOPSIS
  PrivOS self-hosted installer for Windows 10 22H2 / Windows 11 (x64) with Docker Desktop.

.DESCRIPTION
  PowerShell port of install.sh. Installs hub + sandbox (mongo, redis, rustfs, board,
  proxy, VM pool, app cluster) as a Docker Compose stack on Docker Desktop (WSL2
  backend). Idempotent: safe to re-run. See docs/self-hosted-install.md.

    irm https://github.com/PrivOS-AI/privos/releases/latest/download/install.ps1 | iex

  `irm | iex` cannot pass parameters. Set environment variables first instead:
    $env:PRIVOS_UPGRADE='1'; irm https://github.com/PrivOS-AI/privos/releases/latest/download/install.ps1 | iex
  Variables read: PRIVOS_VERSION PRIVOS_DIR PRIVOS_ROOT_URL PRIVOS_HUB_PORT
  PRIVOS_VM_PORT_RANGE PRIVOS_EGRESS_ALLOWLIST PRIVOS_WITH_KNOWLEDGE_VECTOR
  PRIVOS_WITH_APP_CLUSTER PRIVOS_YES PRIVOS_ACCEPT_LICENSE PRIVOS_UPGRADE
  PRIVOS_UNINSTALL PRIVOS_PURGE PRIVOS_ALLOW_DEV_KEY PRIVOS_BUNDLE_BASE_URL, plus every
  .env key (an already-set value wins over the persisted .env, as in install.sh).

  From a saved file (needs the execution policy bypass, the file is not Authenticode
  signed; its sha256 is recorded in the signed versions.json of the release):
    powershell -ExecutionPolicy Bypass -File install.ps1 -Yes -HubPort 3100

  Distributed under the PrivOS Community License 1.0 (LICENSE, PCL-1.0). -Yes implies
  license acceptance; -AcceptLicense accepts it without -Yes's other non-interactive
  effects.

  Stage list - the L/D/S list of install.sh main() (Phase 2 stage-list-lds.md);
  L = Linux only (omitted here), D = Docker Desktop, S = shared. Function in [].
     1  parse_args                                      S  param() block + $env:PRIVOS_* [Initialize-State]
     2  resolving --dir                                 S  default %LOCALAPPDATA%\PrivOS, Windows path rules [Get-ValidatedPrivosDir]
     3  uninstall                                       S  no elevation needed (3/4 root guard is L); compose down, -Purge adds
                                                           --volumes, leftover project volumes, both networks, the dir [Remove-Install]
     5  warn_if_dev_signing_key                         S  [Test-DevSigningKey]
     6  detect_platform                                 D  Windows 10 22H2+/11 x64, Windows 11 ARM64 [Test-PlatformSupported]
     7  require_host_tools                              D  curl/jq/openssl are replaced by the .NET runtime; the pinned
                                                           minisign.exe is installed after license acceptance [Install-Minisign]
     8  check_network_environment (IPv6 sysctl)         L
     9  check_registry_reachability                     S  [Test-RegistryReachability]
    10  check_clock_skew                                S  (same function)
    11  check_selinux                                   L
    12  ensure_docker                                   D  start Docker Desktop, WSL2 backend, Linux containers,
                                                           compose >= 2.27, API >= 1.45 [Confirm-DockerDesktop]
    13  check_resources                                 D  VM memory from docker info, free disk [Test-Resources]
    14  resolve_bundle_source, HAD_EXISTING_ENV,
        refuse_upgrade_across_rename, load_existing_env S  [Resolve-BundleSource, Test-UpgradeAcrossRename, Import-ExistingEnv]
    15  resolve_config + auto_resolve_port_conflicts    S  Get-NetTCPConnection + Windows excluded port ranges [Resolve-Config]
    16  prompt_sidecars, finalize_sidecar_config        S  [Read-SidecarChoices, Complete-SidecarConfig]; the docker socket group is
                                                           probed from the daemon side once the bundle is verified (stage 21)
    17  publisher url check                             S
    18  port conflict check                             S  [Test-Ports]
    19  license acceptance                              S  [Confirm-LicenseAcceptance]
    20  creating directories                            D  secrets + bin only: data lives in named volumes
    21  fetching and verifying the bundle               S  + compose.desktop.yml, signed [Get-Bundle, Test-BundleIntegrity];
                                                           then PRIVOS_DOCKER_SOCKET_GID [Resolve-DockerSocketGid]
    21b arm64 daemon image-platform check               S  every image must list linux/arm64 [Test-ImagePlatforms]
    22  generating secrets, mongo keyfile, .env         S  [New-Secrets, Write-MongoKeyfile, Write-EnvFile]
    23  ensure_network / ensure_agent_network           S  [Initialize-Networks]
    24  chown data dirs, install_docker_user_rules      L  (privos-init / privos-netguard in compose.desktop.yml)
    25  firewall-prompt note + autostart hint           D  [Show-FirewallNotice, Show-AutostartNote]
    26  check_stale_stack, bring_up_stack               S  compose.yml + compose.desktop.yml [Test-StaleStack, Start-Stack]
    27  wait_for_stack_ready                            S  [Wait-StackReady]
    28  interactive_activation / print_summary          S  Set-Clipboard offer [Invoke-InteractiveActivation, Show-Summary]

  Text is ASCII only on purpose: Windows PowerShell 5.1 decodes `irm` output without a
  charset as ISO-8859-1, which would corrupt any other character.
#>
param(
    [string]$Version = '',
    [string]$Dir = '',
    [string]$Url = '',
    [string]$HubPort = '',
    [string]$VmPortRange = '',
    [string]$EgressAllowlist = '',
    [switch]$Yes,
    [switch]$AcceptLicense,
    [switch]$Upgrade,
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$WithKnowledgeVector,
    [switch]$WithoutAppCluster,
    [switch]$AllowDevSigningKey,
    [switch]$Help
)

# ---------------------------------------------------------------------------
# Constants (one hashtable: under `irm | iex` script-scope variables land in the
# caller's session, so the footprint is kept to three variables)
# ---------------------------------------------------------------------------

# Baked by publish-self-hosted-bundle.sh at publish time (replaces the text
# 'unreleased' on the next line with the release tag, like install.sh).
$script:BundleReleaseTag = 'unreleased'

$script:PxConst = [ordered]@{
    GithubReleasesOwnerRepo      = 'PrivOS-AI/privos'
    GithubReleasesBase           = 'https://github.com/PrivOS-AI/privos/releases/download'
    # Same production trust root as install.sh (the publisher reads and checks it there).
    MinisignPublicKeyIsDevOnly   = 'false'
    MinisignPublicKey            = 'RWQVDoIkZD9NNKyCJhKYcl7tGiAAys+Pp+PvLH1DJ5Ai1Ze7nTzm3cK2'
    # Pinned jedisct1/minisign Windows build; the zip is verified by sha256 before use.
    # Fallback image for the docker-socket group probe when the verified versions.json carries no
    # usable netguard reference (alpine 3.20 multi-arch index).
    OpensslFallbackImage         = 'docker.io/alpine/openssl@sha256:59c5cb51e536d40587667229468b007a2a6cae1705397e59e5f7774c08b74029'
    SocketProbeFallbackImage     = 'docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc'
    MinisignVersion              = '0.12'
    MinisignZipSha256            = '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479'
    DefaultHubPort               = 3000
    DefaultBoardPort             = 8556
    DefaultProxyPort             = 8557
    DefaultRustfsPort            = 9000
    DefaultPublisherPort         = 8558
    DefaultVmPortRange           = '30000-30999'
    # Docker Desktop VM memory, as docker info reports it: the settings "6 GB" (refuse
    # below) and "8 GB" (warn below). Same values as install.sh DESKTOP_*_RAM_MB.
    MinRamMb                     = 5800
    RecommendedRamMb             = 7600
    AppClusterAppsNetwork        = 'mcp-apps-network'
    MinDiskGb                    = 20
    MinDockerMajor               = 24
    MinComposeVersion            = '2.27.0'
    MinApiVersion                = '1.45'
    MinWindowsBuild              = 19045
    MinWindowsArmBuild           = 22000
    ProjectName                  = 'privos'
    NetworkName                  = 'privos-sandbox-net'
    AgentNetworkName             = 'privos-agent-net'
    AgentNetworkBridgeIface      = 'privos-agent0'
    StackReadyTimeoutSec         = 600
    MaxPortRangeSpan             = 5000
    LicenseMarkerFile            = '.license-accepted'
    LicenseVersion               = 'PCL-1.0'
    DockerDesktopUrl             = 'https://www.docker.com/products/docker-desktop/'
    BundleFiles                  = @('compose.yml', 'compose.desktop.yml', 'versions.json', 'rustfs-init.sh', 'docker-user-rules.sh', 'LICENSE', 'NOTICE', 'OPEN-SOURCE-NOTICES', 'rocketchat-upstream-files.txt', 'TRADEMARK.md')
    SignedFiles                  = @('compose.yml', 'compose.desktop.yml', 'versions.json')
    # Hashed inside the signed versions.json (files{}); compose.yml and
    # compose.desktop.yml are covered by their own signatures.
    UnsignedHashedFiles          = @('rustfs-init.sh', 'docker-user-rules.sh', 'LICENSE', 'NOTICE', 'OPEN-SOURCE-NOTICES', 'rocketchat-upstream-files.txt', 'TRADEMARK.md')
    # .env keys, in the order they are written - must match install.sh ENV_KEYS
    # (tests/test-install-ps1.sh compares both against the rendered key list).
    EnvKeys                      = @(
        'PRIVOS_DIR', 'PRIVOS_PROJECT', 'PRIVOS_NETWORK', 'PRIVOS_AGENT_NETWORK', 'PRIVOS_STACK_VERSION', 'PRIVOS_ROOT_URL', 'PRIVOS_DEPLOYMENT_ID',
        'PRIVOS_HUB_TRUSTED_PROXIES',
        'PRIVOS_HUB_PORT', 'PRIVOS_BOARD_PORT', 'PRIVOS_PROXY_PORT', 'PRIVOS_RUSTFS_PORT', 'PRIVOS_VM_PORT_RANGE',
        'PRIVOS_EGRESS_ALLOWLIST', 'VM_EGRESS_MODE', 'VM_EGRESS_FORWARD_PORT', 'VAULT_V2_ENABLED',
        'MONGO_ROOT_USER', 'MONGO_ROOT_PASSWORD', 'MONGO_URL', 'MONGO_OPLOG_URL', 'MONGODB_URL',
        'PRIVOS_MONGO_CACHE_GB', 'PRIVOS_MONGO_MEM', 'PRIVOS_MONGO_CPUS',
        'RUSTFS_ROOT_USER', 'RUSTFS_ROOT_PASSWORD', 'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'RUSTFS_BUCKET',
        'PRIVOS_RUSTFS_MEM', 'PRIVOS_RUSTFS_CPUS',
        'ADMIN_PASS', 'ADMIN_EMAIL', 'REG_TOKEN', 'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'SANDBOX_API_KEY', 'CATALOG_SECRET_KEY',
        'SERVICE_USAGE_AUTHORIZATION_FAIL_CLOSED', 'PRIVOS_SECRET_STORE_KEY',
        'PRIVOS_HUB_MEM', 'PRIVOS_HUB_CPUS', 'PRIVOS_BOARD_MEM', 'PRIVOS_BOARD_CPUS', 'PRIVOS_PROXY_MEM', 'PRIVOS_PROXY_CPUS',
        'PRIVOS_LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PRIVOS_LLM_BASE_URL', 'PRIVOS_LLM_MODEL', 'PRIVOS_LLM_SMALL_MODEL',
        'PRIVOS_WITH_KNOWLEDGE_VECTOR', 'PRIVOS_WEAVIATE_URL', 'WEAVIATE_ROOT_KEY', 'PRIVOS_WEAVIATE_MEM', 'PRIVOS_WEAVIATE_CPUS',
        'PRIVOS_WITH_APP_CLUSTER', 'PRIVOS_DOCKER_SOCKET_GID', 'PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN', 'PRIVOS_APP_CLUSTER_MEM', 'PRIVOS_APP_CLUSTER_CPUS',
        'PRIVOS_PUBLISHER_URL', 'PRIVOS_PUBLISHER_BIND', 'PRIVOS_PUBLISHER_PORT', 'PRIVOS_PUBLISHER_MEM',
        'COMPOSE_PROFILES'
    )
}

# Mutable run state and the .env values (key -> string). Re-created by Initialize-State.
$script:PxState = @{}
$script:PxEnv = [ordered]@{}

# ---------------------------------------------------------------------------
# Logging and failure - never print secret values.
# ---------------------------------------------------------------------------

function Write-InstallLog {
    param([string]$Message)
    Write-Host "[privos-install] $Message"
}

# Raises an install failure (install.sh die()). `exit` is never used inside the
# script: under `irm | iex` it would close the user's PowerShell window.
function Stop-Install {
    param([string]$Message)
    throw (New-Object System.InvalidOperationException($Message))
}

function Set-Stage {
    param([string]$Name)
    $script:PxState.Stage = $Name
}

function Test-IsWindows {
    return ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
}

# Runs a native command with stderr folded into the output WITHOUT tripping
# $ErrorActionPreference='Stop' (Windows PowerShell 5.1 turns any stderr line of a
# `2>&1` native call into a terminating error). Returns @{ Code; Lines; Text }.
# -StdoutOnly drops stderr; -Stream prints output live (pull/up) instead of capturing it.
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [string[]]$ArgList = @(),
        [switch]$StdoutOnly,
        [switch]$Stream
    )
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    $lines = @()
    try {
        if ($Stream) {
            & $File @ArgList 2>&1 | ForEach-Object { "$_" } | Out-Host
        }
        elseif ($StdoutOnly) {
            $lines = @(& $File @ArgList 2>$null | ForEach-Object { "$_" })
        }
        else {
            $lines = @(& $File @ArgList 2>&1 | ForEach-Object { "$_" })
        }
        $code = $global:LASTEXITCODE
    }
    catch {
        $code = 127
        $lines = @("$($_.Exception.Message)")
    }
    return [pscustomobject]@{ Code = [int]$code; Lines = $lines; Text = ($lines -join "`n") }
}

function Invoke-Compose {
    param([string[]]$ComposeArgs, [switch]$StdoutOnly, [switch]$Stream)
    $all = @($script:PxState.ComposeBase) + @($ComposeArgs)
    return Invoke-Native -File 'docker' -ArgList $all -StdoutOnly:$StdoutOnly -Stream:$Stream
}

# Runs a POSIX shell script inside a compose service. The script travels base64
# encoded so no quote or dollar sign reaches the Windows command line (PowerShell
# 5.1 mangles embedded double quotes in native arguments); credentials expand
# inside the container and never appear on the host command line.
function Invoke-ComposeShell {
    param([string]$Service, [string]$ShellScript)
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ShellScript))
    return Invoke-Compose -ComposeArgs @('exec', '-T', $Service, 'sh', '-c', "echo $b64 | base64 -d | sh")
}

# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------

function Get-Flag {
    param([hashtable]$Flags, [string]$Name, $Default = '')
    if ($Flags -and $Flags.ContainsKey($Name) -and $null -ne $Flags[$Name]) { return $Flags[$Name] }
    return $Default
}

function Get-EnvVar {
    param([string]$Name)
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $v) { return '' }
    return $v
}

function Test-EnvTruthy {
    param([string]$Name)
    $v = (Get-EnvVar $Name).ToLowerInvariant()
    return ($v -eq '1' -or $v -eq 'true' -or $v -eq 'yes')
}

# `: "${VAR:=default}"` - assigns when unset OR empty.
function Set-EnvDefault {
    param([string]$Key, [string]$Value)
    if (-not $script:PxEnv.Contains($Key) -or [string]::IsNullOrEmpty([string]$script:PxEnv[$Key])) {
        $script:PxEnv[$Key] = $Value
    }
}

function Test-EnvSet {
    param([string]$Key)
    return ($script:PxEnv.Contains($Key) -and -not [string]::IsNullOrEmpty([string]$script:PxEnv[$Key]))
}

function Get-EnvValue {
    param([string]$Key)
    if ($script:PxEnv.Contains($Key)) { return [string]$script:PxEnv[$Key] }
    return ''
}

function ConvertTo-VersionParts {
    param([string]$Text)
    if ($Text -match '^\s*v?(\d+)\.(\d+)(?:\.(\d+))?') {
        $patch = 0
        if ($Matches.ContainsKey(3) -and $Matches[3]) { $patch = [int]$Matches[3] }
        return @([int]$Matches[1], [int]$Matches[2], $patch)
    }
    return $null
}

# True when Actual >= Minimum ("2.40.3-desktop.1" >= "2.27.0"). Unparseable -> false.
function Test-VersionAtLeast {
    param([string]$Actual, [string]$Minimum)
    $a = ConvertTo-VersionParts $Actual
    $m = ConvertTo-VersionParts $Minimum
    if ($null -eq $a -or $null -eq $m) { return $false }
    for ($i = 0; $i -lt 3; $i++) {
        if ($a[$i] -gt $m[$i]) { return $true }
        if ($a[$i] -lt $m[$i]) { return $false }
    }
    return $true
}

function Test-WindowsBuildSupported {
    param([int]$Build)
    return ($Build -ge $script:PxConst.MinWindowsBuild)
}

# 'AMD64' (also a 32-bit PowerShell on 64-bit Windows, via PROCESSOR_ARCHITEW6432) -> 'x64'.
function Resolve-HostArch {
    param([string]$Arch, [string]$Wow64Arch = '')
    $a = $Arch
    if ($Wow64Arch) { $a = $Wow64Arch }
    switch ($a.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'X86_64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { return $a.ToLowerInvariant() }
    }
}

function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-HexString {
    param([string]$Hex)
    $bytes = New-Object byte[] ($Hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($Hex.Substring(2 * $i, 2), 16) }
    return , $bytes
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# Writes text as UTF-8 WITHOUT a BOM and with the line endings given (LF). Windows
# PowerShell 5.1 `Set-Content -Encoding UTF8` prepends a BOM, which would corrupt
# .env keys and shell scripts that containers read.
function Write-TextFile {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), $enc)
}

function Get-UrlHostname {
    param([string]$Value)
    if ($Value -notmatch '://') { return '' }
    $u = $Value.Substring($Value.IndexOf('://') + 3)
    $u = ($u -split '/')[0]
    if ($u.Contains('@')) { $u = $u.Substring($u.LastIndexOf('@') + 1) }
    return ($u -split ':')[0]
}

function Test-ValidPort {
    param([string]$Value, [string]$Label)
    if ($Value -notmatch '^[0-9]+$') { Stop-Install "$Label must be a positive integer (got: $Value)" }
    $n = [int64]$Value
    if ($n -lt 1 -or $n -gt 65535) { Stop-Install "$Label must be between 1 and 65535 (got: $Value)" }
}

function Expand-PortRange {
    param([string]$Range)
    if ($Range -notmatch '^([0-9]+)-([0-9]+)$') { Stop-Install "invalid port range: $Range" }
    $start = [int64]$Matches[1]
    $end = [int64]$Matches[2]
    if ($start -lt 1 -or $start -gt 65535) { Stop-Install "invalid port range: $Range (start must be 1-65535)" }
    if ($end -lt 1 -or $end -gt 65535) { Stop-Install "invalid port range: $Range (end must be 1-65535)" }
    if ($start -gt $end) { Stop-Install "invalid port range: $Range (start must be <= end)" }
    $span = $end - $start + 1
    if ($span -gt $script:PxConst.MaxPortRangeSpan) { Stop-Install "invalid port range: $Range spans $span ports - refusing (max $($script:PxConst.MaxPortRangeSpan))" }
    return @([int]$start..[int]$end)
}

# ---------------------------------------------------------------------------
# State and config
# ---------------------------------------------------------------------------

function Initialize-State {
    param([hashtable]$Flags = @{})
    $c = $script:PxConst
    $mode = 'install'
    if ((Get-Flag $Flags 'Upgrade' $false) -or (Test-EnvTruthy 'PRIVOS_UPGRADE')) { $mode = 'upgrade' }
    if ((Get-Flag $Flags 'Uninstall' $false) -or (Test-EnvTruthy 'PRIVOS_UNINSTALL')) { $mode = 'uninstall' }
    $versionFlag = [string](Get-Flag $Flags 'Version' '')
    if (-not $versionFlag) { $versionFlag = Get-EnvVar 'PRIVOS_VERSION' }
    $script:PxState = @{
        Mode               = $mode
        Purge              = [bool]((Get-Flag $Flags 'Purge' $false) -or (Test-EnvTruthy 'PRIVOS_PURGE'))
        AssumeYes          = [bool]((Get-Flag $Flags 'Yes' $false) -or (Test-EnvTruthy 'PRIVOS_YES'))
        AcceptLicenseFlag  = [bool]((Get-Flag $Flags 'AcceptLicense' $false) -or (Test-EnvTruthy 'PRIVOS_ACCEPT_LICENSE'))
        AllowDevKey        = [bool]((Get-Flag $Flags 'AllowDevSigningKey' $false) -or (Test-EnvTruthy 'PRIVOS_ALLOW_DEV_KEY'))
        WithKnowledgeVec   = [bool](Get-Flag $Flags 'WithKnowledgeVector' $false)
        WithoutAppCluster  = [bool](Get-Flag $Flags 'WithoutAppCluster' $false)
        Help               = [bool](Get-Flag $Flags 'Help' $false)
        VersionFlag        = $versionFlag
        DirFlag            = [string](Get-Flag $Flags 'Dir' '')
        UrlFlag            = [string](Get-Flag $Flags 'Url' '')
        HubPortFlag        = [string](Get-Flag $Flags 'HubPort' '')
        VmPortRangeFlag    = [string](Get-Flag $Flags 'VmPortRange' '')
        EgressAllowFlag    = [string](Get-Flag $Flags 'EgressAllowlist' '')
        Stage              = 'startup'
        Dir                = ''
        HadExistingEnv     = $false
        LicenseAccepted    = $false
        ComposeBase        = @()
        MinisignExe        = ''
        BundleSource       = 'remote'
        BundleSourceDir    = ''
        Listeners          = @{}
        OurPorts           = $null
        PortExplicit       = @{}
        ScriptDir          = [string](Get-Flag $Flags 'ScriptDir' '')
    }
    # Values already present in the invocation environment win over a persisted .env.
    $script:PxEnv = [ordered]@{}
    foreach ($key in $c.EnvKeys) {
        $v = Get-EnvVar $key
        if ($v) { $script:PxEnv[$key] = $v }
    }
}

function Show-Usage {
    @'
PrivOS self-hosted installer (Windows)

  irm https://github.com/PrivOS-AI/privos/releases/latest/download/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File install.ps1 [flags]

Flags (the irm | iex form reads the matching $env:PRIVOS_* variables instead,
for example $env:PRIVOS_UPGRADE = '1'):
  -Version <tag>          Bundle/stack version to install (default: latest published)
  -Dir <path>             Install directory (default: %LOCALAPPDATA%\PrivOS)
  -Url <root-url>         Public URL the hub is reachable at (rewrites ROOT_URL on re-run)
  -HubPort <port>         Host port for the hub (default: 3000)
  -VmPortRange <lo-hi>    Loopback host-port range for the sandbox VM pool (default: 30000-30999)
  -EgressAllowlist <list> Comma-separated IPv4 CIDRs agent VM containers may reach despite the
                          default-deny on private/link-local/carrier-grade-NAT destinations
                          (TCP only). Empty by default.
  -Yes                    Non-interactive: assume "no" for optional-sidecar prompts AND
                          accept the PrivOS Community License 1.0 (see LICENSE)
  -AcceptLicense          Accept the PrivOS Community License 1.0 without -Yes's other effects
  -Upgrade                Pull latest images for the current install and recreate containers
  -Uninstall              Stop and remove the stack (add -Purge to also delete data)
  -Purge                  With -Uninstall: also delete data, volumes, networks and the install dir
  -WithKnowledgeVector    Enable the Weaviate knowledge-vector sidecar
  -WithoutAppCluster      Opt out of the App Cluster (marketplace MCP-app runtime; needs Docker
                          socket access). ON by default - see docs/self-hosted-install.md.
  -AllowDevSigningKey     Local testing only: proceed despite a DEV-ONLY minisign key
  -Help                   Show this help

Requires Windows 10 22H2 / Windows 11 (x64) and Docker Desktop 4.30+ with the WSL2 backend
and Linux containers. No administrator rights are needed.

The script is not Authenticode signed: run the file form with -ExecutionPolicy Bypass, and
expect a SmartScreen prompt if the file was downloaded in a browser.

License: PrivOS Community License 1.0 (PCL-1.0) - free for up to 10 Active
Human Users (people who sign in with an account; bots, integrations, AI
agents, and guests who never sign in do not count), counted across all
deployments your company runs. More than that, hosted/managed services, and
commercial redistribution require a license from Roxane, Inc.
(legal@privos.ai). Full text: <install dir>\LICENSE and
https://github.com/PrivOS-AI/privos/blob/main/LICENSE - plain-English FAQ:
https://github.com/PrivOS-AI/privos/blob/main/LICENSE-FAQ.md
'@ | Write-Host
}

function Resolve-BundleBaseUrl {
    $override = Get-EnvVar 'PRIVOS_BUNDLE_BASE_URL'
    if ($override) { return $override }
    $tag = $script:PxState.VersionFlag
    if (-not $tag) { $tag = $script:BundleReleaseTag }
    return "$($script:PxConst.GithubReleasesBase)/$tag"
}

# Fails closed: a DEV-signed bundle must never become an install's trust root by accident.
function Test-DevSigningKey {
    if ($script:PxConst.MinisignPublicKeyIsDevOnly -ne 'true') { return }
    if ($script:PxState.AllowDevKey) {
        Write-InstallLog 'WARNING: proceeding with the DEV-ONLY scaffold signing key (-AllowDevSigningKey / PRIVOS_ALLOW_DEV_KEY=1) - do not use for a production install.'
        return
    }
    Stop-Install 'refusing to install with a DEV-ONLY signing key (see SIGNING.md) - this build of install.ps1 has not been re-signed with a production key. Pass -AllowDevSigningKey or set PRIVOS_ALLOW_DEV_KEY=1 only for local testing.'
}

# True when Dir is one of the protected locations (compared case-insensitively, with
# either slash style and no trailing slash).
function Test-ProtectedDir {
    param([string]$Dir, [string[]]$Protected)
    $norm = { param($p) ($p -replace '/', '\').TrimEnd('\').ToLowerInvariant() }
    $d = & $norm $Dir
    foreach ($p in $Protected) {
        if (-not $p) { continue }
        if ($d -eq (& $norm $p)) { return $true }
    }
    return $false
}

# --dir/PRIVOS_DIR flows into bind-mount paths and Remove-Item -Recurse under
# -Uninstall -Purge - validate it strictly. Returns the backslash form; throws on
# anything unsafe.
function Get-ValidatedPrivosDir {
    param([string]$Path, [string[]]$Protected = $null)
    if (-not $Path) { Stop-Install '-Dir must not be empty' }
    if ($Path -notmatch '^[A-Za-z]:[\\/]') { Stop-Install "-Dir must be an absolute path on a local drive, like C:\PrivOS (got: $Path)" }
    if ($Path -match '[''"`$;&|<>%*?\x00-\x1f]') { Stop-Install "-Dir contains unsupported characters (got: $Path) - use plain path characters only." }
    $segments = @(($Path.Substring(3) -split '[\\/]') | Where-Object { $_ -ne '' })
    foreach ($seg in $segments) {
        if ($seg -eq '..') { Stop-Install "-Dir must not contain '..' path segments (got: $Path)" }
        if ($seg -eq '.') { Stop-Install "-Dir must not contain '.' path segments (got: $Path)" }
    }
    $resolved = ($Path.Substring(0, 2) + '\' + ($segments -join '\')).TrimEnd('\')
    if ($segments.Count -eq 0) { Stop-Install "-Dir resolves to the drive root $($Path.Substring(0, 2))\ - refusing (this value is later passed to Remove-Item -Recurse under -Purge)." }
    if ($null -eq $Protected) {
        $Protected = @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP, $env:SystemDrive + '\Users', $env:SystemDrive + '\Windows')
    }
    if (Test-ProtectedDir -Dir $resolved -Protected $Protected) {
        Stop-Install "-Dir resolves to $resolved, a protected system directory - refusing (this value is later passed to Remove-Item -Recurse under -Purge)."
    }
    return $resolved
}

function Get-DefaultPrivosDir {
    $base = $env:LOCALAPPDATA
    if (-not $base) { Stop-Install 'LOCALAPPDATA is not set - pass -Dir <path> (for example -Dir C:\PrivOS).' }
    return (Join-Path $base 'PrivOS')
}

# ---------------------------------------------------------------------------
# .env load/render (install.sh env_quote / env_unquote / load_existing_env / write_env_file)
# ---------------------------------------------------------------------------

function ConvertTo-EnvQuoted {
    param([string]$Value)
    return "'" + $Value.Replace("'", "'\''") + "'"
}

# Exact inverse of ConvertTo-EnvQuoted.
function ConvertFrom-EnvQuoted {
    param([string]$Value)
    if ($Value.Length -ge 2 -and $Value.StartsWith("'") -and $Value.EndsWith("'")) {
        $inner = $Value.Substring(1, $Value.Length - 2)
        return $inner.Replace("'\''", "'")
    }
    return $Value
}

# Reads <dir>\.env into PxEnv for keys not already set by the invocation environment.
function Import-ExistingEnv {
    $envFile = Join-Path $script:PxState.Dir '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return }
    $known = @{}
    foreach ($k in $script:PxConst.EnvKeys) { $known[$k] = $true }
    foreach ($line in [IO.File]::ReadAllLines($envFile)) {
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $line.Substring(0, $idx)
        if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
        if (-not $known.ContainsKey($key)) { continue }
        if (Test-EnvSet $key) { continue }
        $script:PxEnv[$key] = ConvertFrom-EnvQuoted $line.Substring($idx + 1)
    }
}

# One-way migration guard: a MinIO-era .env has no path forward through -Upgrade.
function Test-UpgradeAcrossRename {
    $envFile = Join-Path $script:PxState.Dir '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return }
    $hit = @([IO.File]::ReadAllLines($envFile) | Where-Object { $_ -match '^MINIO_[A-Za-z_]*=' })
    if ($hit.Count -eq 0) { return }
    Stop-Install @'
refusing -Upgrade: this install's .env is from before the MinIO -> RustFS rename (it still has MINIO_* keys). -Upgrade never migrates object data, so this refusal is not a data-loss regression - it is the only prompt you would otherwise not get before the rename silently breaks file upload. To move this install forward by hand:
  1. stop the stack:  docker compose -f compose.yml down
  2. in .env, copy the old values into the new keys, then delete the old ones:
       MINIO_ROOT_USER     -> RUSTFS_ROOT_USER
       MINIO_ROOT_PASSWORD -> RUSTFS_ROOT_PASSWORD
       MINIO_ACCESS_KEY    -> RUSTFS_ACCESS_KEY
       MINIO_SECRET_KEY    -> RUSTFS_SECRET_KEY
       MINIO_BUCKET        -> RUSTFS_BUCKET
       PRIVOS_MINIO_PORT   -> PRIVOS_RUSTFS_PORT
       PRIVOS_MINIO_MEM    -> PRIVOS_RUSTFS_MEM
       PRIVOS_MINIO_CPUS   -> PRIVOS_RUSTFS_CPUS
  3. re-run install.ps1 -Upgrade
'@
}

# Renders the .env text: header + every ENV_KEYS entry as KEY='value', LF endings.
function Format-EnvFile {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("# Generated by install.ps1 - do not hand-edit while the stack is running;`n")
    [void]$sb.Append("# re-run install.ps1 (or -Upgrade) instead. Contains secrets: readable only by your Windows account.`n")
    foreach ($key in $script:PxConst.EnvKeys) {
        [void]$sb.Append($key + '=' + (ConvertTo-EnvQuoted (Get-EnvValue $key)) + "`n")
    }
    return $sb.ToString()
}

function Write-EnvFile {
    param([string]$Path)
    Write-TextFile -Path $Path -Text (Format-EnvFile)
    Protect-PrivatePath -Path $Path
}

# Windows counterpart of chmod 0600/0700: only the current account keeps access.
# Best effort - a failure is reported, never fatal.
function Protect-PrivatePath {
    param([string]$Path)
    if (-not (Test-IsWindows)) { return }
    try {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $grant = "*${sid}:F"
        if (Test-Path -LiteralPath $Path -PathType Container) { $grant = "*${sid}:(OI)(CI)F" }
        $r = Invoke-Native -File 'icacls.exe' -ArgList @($Path, '/inheritance:r', '/grant:r', $grant)
        if ($r.Code -ne 0) { Write-InstallLog "WARNING: could not restrict permissions on $Path (icacls exit $($r.Code))." }
    }
    catch {
        Write-InstallLog "WARNING: could not restrict permissions on ${Path}: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# Secrets (install.sh generate_secrets / generate_vapid_keypair / mongo_keyfile_content)
# ---------------------------------------------------------------------------

function New-RandomBytes {
    param([int]$Count)
    $bytes = New-Object byte[] $Count
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return , $bytes
}

function New-RandomHex {
    param([int]$Bytes = 32)
    return (([BitConverter]::ToString((New-RandomBytes $Bytes))).Replace('-', '').ToLowerInvariant())
}

# base64(sha512("keyfile:" + password)) - the exact derivation install.sh uses, so a re-run
# with the same root password writes the same keyfile.
function Get-MongoKeyfileContent {
    param([string]$RootPassword)
    $sha = [Security.Cryptography.SHA512]::Create()
    try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('keyfile:' + $RootPassword)) } finally { $sha.Dispose() }
    return [Convert]::ToBase64String($digest)
}

function Write-MongoKeyfile {
    $dir = Join-Path $script:PxState.Dir 'secrets'
    $file = Join-Path $dir 'mongo-keyfile'
    Write-TextFile -Path $file -Text (Get-MongoKeyfileContent (Get-EnvValue 'MONGO_ROOT_PASSWORD'))
    return $file
}

# Web Push VAPID keypair (RFC 8292): public = base64url of the 65-byte uncompressed point
# 0x04||X||Y, private = base64url of the 32-byte scalar D. Returns @{ Public; Private }.
function New-VapidKeypairDotNet {
    $ecdsa = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve]::CreateFromFriendlyName('nistP256'))
    try {
        $p = $ecdsa.ExportParameters($true)
        $pad = {
            param([byte[]]$b)
            if ($b.Length -ge 32) { return , [byte[]]$b[($b.Length - 32)..($b.Length - 1)] }
            $o = New-Object byte[] 32
            [Array]::Copy($b, 0, $o, 32 - $b.Length, $b.Length)
            return , $o
        }
        $x = & $pad $p.Q.X
        $y = & $pad $p.Q.Y
        $d = & $pad $p.D
        $pub = New-Object byte[] 65
        $pub[0] = 4
        [Array]::Copy($x, 0, $pub, 1, 32)
        [Array]::Copy($y, 0, $pub, 33, 32)
        return @{ Public = (ConvertTo-Base64Url $pub); Private = (ConvertTo-Base64Url $d) }
    }
    finally { $ecdsa.Dispose() }
}

# Fallback for a .NET Framework without ECDsa.ExportParameters: the same openssl commands
# as install.sh, run in a throwaway alpine/openssl container pinned by the same digest
# as install.sh's OPENSSL_FALLBACK_IMAGE.
function New-VapidKeypairContainer {
    $sh = @'
set -e
k=$(mktemp)
openssl ecparam -name prime256v1 -genkey -noout -out "$k" 2>/dev/null
openssl ec -in "$k" -noout -text 2>/dev/null | sed -n '/^priv:/,/^pub:/p' | sed '1d;$d' | tr -d ' \n:'
echo
openssl ec -in "$k" -noout -text 2>/dev/null | sed -n '/^pub:/,/^ASN1 OID/p' | sed '1d;$d' | tr -d ' \n:'
echo
'@
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sh))
    $run = Invoke-Native -File 'docker' -ArgList @('run', '--rm', '--network', 'none', '--entrypoint', 'sh', $script:PxConst.OpensslFallbackImage, '-c', "echo $b64 | base64 -d | sh") -StdoutOnly
    $hex = @($run.Lines | Where-Object { $_ -match '^[0-9a-f]+$' })
    if ($run.Code -ne 0 -or $hex.Count -lt 2) { Stop-Install 'generating the VAPID keypair in the alpine/openssl container failed.' }
    $priv = $hex[0]
    $pub = $hex[1]
    if ($priv.Length -gt 64) { $priv = $priv.Substring($priv.Length - 64) }
    while ($priv.Length -lt 64) { $priv = '0' + $priv }
    return @{ Public = (ConvertTo-Base64Url (ConvertFrom-HexString $pub)); Private = (ConvertTo-Base64Url (ConvertFrom-HexString $priv)) }
}

function New-VapidKeypair {
    try { return (New-VapidKeypairDotNet) }
    catch {
        Write-InstallLog "NOTE: .NET could not generate the VAPID keypair ($($_.Exception.Message)); using a throwaway openssl container instead."
        return (New-VapidKeypairContainer)
    }
}

function New-Secrets {
    Set-EnvDefault 'MONGO_ROOT_USER' 'privos'
    Set-EnvDefault 'MONGO_ROOT_PASSWORD' (New-RandomHex 32)
    Set-EnvDefault 'ADMIN_PASS' (New-RandomHex 24)
    Set-EnvDefault 'ADMIN_EMAIL' 'admin@localhost'
    Set-EnvDefault 'REG_TOKEN' (New-RandomHex 32)
    Set-EnvDefault 'SANDBOX_API_KEY' (New-RandomHex 32)
    # Encrypts the sandbox proxy's egress-credential catalog at rest.
    Set-EnvDefault 'CATALOG_SECRET_KEY' (New-RandomHex 32)
    Set-EnvDefault 'RUSTFS_ROOT_USER' 'privos-root'
    Set-EnvDefault 'RUSTFS_ROOT_PASSWORD' (New-RandomHex 32)
    Set-EnvDefault 'RUSTFS_ACCESS_KEY' ('privos-' + (New-RandomHex 6))
    # RustFS caps a service-account secret key at 8-40 chars: 16 bytes = 32 hex chars.
    Set-EnvDefault 'RUSTFS_SECRET_KEY' (New-RandomHex 16)
    Set-EnvDefault 'RUSTFS_BUCKET' 'privos'
    Set-EnvDefault 'WEAVIATE_ROOT_KEY' (New-RandomHex 32)
    # Mutual HMAC challenge secret between the hub and the App Cluster.
    Set-EnvDefault 'PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN' (New-RandomHex 32)
    # Encrypted-secret-store key: 32 raw bytes, base64-encoded.
    Set-EnvDefault 'PRIVOS_SECRET_STORE_KEY' ([Convert]::ToBase64String((New-RandomBytes 32)))
    Set-EnvDefault 'PRIVOS_DEPLOYMENT_ID' ([guid]::NewGuid().ToString().ToLowerInvariant())
    Set-EnvDefault 'VAPID_SUBJECT' ('mailto:' + (Get-EnvValue 'ADMIN_EMAIL'))
    if (-not (Test-EnvSet 'VAPID_PUBLIC_KEY') -or -not (Test-EnvSet 'VAPID_PRIVATE_KEY')) {
        $vapid = New-VapidKeypair
        $script:PxEnv['VAPID_PUBLIC_KEY'] = $vapid.Public
        $script:PxEnv['VAPID_PRIVATE_KEY'] = $vapid.Private
    }
    $user = Get-EnvValue 'MONGO_ROOT_USER'
    $pass = Get-EnvValue 'MONGO_ROOT_PASSWORD'
    $script:PxEnv['MONGO_URL'] = "mongodb://${user}:${pass}@mongo:27017/privos?replicaSet=rs0&authSource=admin&w=1"
    $script:PxEnv['MONGO_OPLOG_URL'] = "mongodb://${user}:${pass}@mongo:27017/local?replicaSet=rs0&authSource=admin&w=1"
    $script:PxEnv['MONGODB_URL'] = "mongodb://${user}:${pass}@mongo:27017/?replicaSet=rs0&authSource=admin&w=1"
}

# ---------------------------------------------------------------------------
# Config resolution (install.sh resolve_config / prompt_sidecars / finalize_sidecar_config)
# ---------------------------------------------------------------------------

function Resolve-Config {
    $c = $script:PxConst
    $s = $script:PxState
    Set-EnvDefault 'PRIVOS_PROJECT' $c.ProjectName
    Set-EnvDefault 'PRIVOS_NETWORK' $c.NetworkName
    Set-EnvDefault 'PRIVOS_AGENT_NETWORK' $c.AgentNetworkName
    # Ports set explicitly (flag, env, or a prior .env loaded on re-run) are never moved by
    # the auto-fallback; they hard-fail in Test-Ports instead.
    $s.PortExplicit = @{
        Hub    = [bool]($s.HubPortFlag -or (Test-EnvSet 'PRIVOS_HUB_PORT'))
        Board  = (Test-EnvSet 'PRIVOS_BOARD_PORT')
        Proxy  = (Test-EnvSet 'PRIVOS_PROXY_PORT')
        Rustfs = (Test-EnvSet 'PRIVOS_RUSTFS_PORT')
        Range  = [bool]($s.VmPortRangeFlag -or (Test-EnvSet 'PRIVOS_VM_PORT_RANGE'))
    }
    Set-EnvDefault 'PRIVOS_HUB_PORT' ([string]$c.DefaultHubPort)
    Set-EnvDefault 'PRIVOS_BOARD_PORT' ([string]$c.DefaultBoardPort)
    Set-EnvDefault 'PRIVOS_PROXY_PORT' ([string]$c.DefaultProxyPort)
    Set-EnvDefault 'PRIVOS_RUSTFS_PORT' ([string]$c.DefaultRustfsPort)
    Set-EnvDefault 'PRIVOS_VM_PORT_RANGE' $c.DefaultVmPortRange
    Set-EnvDefault 'PRIVOS_EGRESS_ALLOWLIST' ''
    Set-EnvDefault 'PRIVOS_HUB_TRUSTED_PROXIES' '127.0.0.0/8,::1,172.16.0.0/12'
    $stackVersion = 'latest'
    if ($s.VersionFlag) { $stackVersion = $s.VersionFlag }
    Set-EnvDefault 'PRIVOS_STACK_VERSION' $stackVersion
    Set-EnvDefault 'PRIVOS_MONGO_CACHE_GB' '1'; Set-EnvDefault 'PRIVOS_MONGO_MEM' '1g'; Set-EnvDefault 'PRIVOS_MONGO_CPUS' '2'
    Set-EnvDefault 'PRIVOS_RUSTFS_MEM' '512m'; Set-EnvDefault 'PRIVOS_RUSTFS_CPUS' '1'
    Set-EnvDefault 'PRIVOS_HUB_MEM' '2g'; Set-EnvDefault 'PRIVOS_HUB_CPUS' '2'
    Set-EnvDefault 'PRIVOS_BOARD_MEM' '512m'; Set-EnvDefault 'PRIVOS_BOARD_CPUS' '1'
    Set-EnvDefault 'PRIVOS_PROXY_MEM' '512m'; Set-EnvDefault 'PRIVOS_PROXY_CPUS' '1'
    Set-EnvDefault 'PRIVOS_WEAVIATE_MEM' '2g'; Set-EnvDefault 'PRIVOS_WEAVIATE_CPUS' '1'
    Set-EnvDefault 'PRIVOS_APP_CLUSTER_MEM' '256m'; Set-EnvDefault 'PRIVOS_APP_CLUSTER_CPUS' '1'
    Set-EnvDefault 'SERVICE_USAGE_AUTHORIZATION_FAIL_CLOSED' 'true'
    Set-EnvDefault 'PRIVOS_LLM_PROVIDER' 'byo'
    Set-EnvDefault 'PRIVOS_WITH_KNOWLEDGE_VECTOR' 'false'
    # The App Cluster is the community marketplace runtime - ON by default.
    Set-EnvDefault 'PRIVOS_WITH_APP_CLUSTER' 'true'

    if ($s.UrlFlag) { $script:PxEnv['PRIVOS_ROOT_URL'] = $s.UrlFlag }
    if ($s.HubPortFlag) { $script:PxEnv['PRIVOS_HUB_PORT'] = $s.HubPortFlag }
    if ($s.VmPortRangeFlag) { $script:PxEnv['PRIVOS_VM_PORT_RANGE'] = $s.VmPortRangeFlag }
    if ($s.EgressAllowFlag) { $script:PxEnv['PRIVOS_EGRESS_ALLOWLIST'] = $s.EgressAllowFlag }
    if ($s.VersionFlag) { $script:PxEnv['PRIVOS_STACK_VERSION'] = $s.VersionFlag }
    if ($s.WithKnowledgeVec) { $script:PxEnv['PRIVOS_WITH_KNOWLEDGE_VECTOR'] = 'true' }
    if ($s.WithoutAppCluster) { $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'false' }

    # Move any busy DEFAULT ports before ROOT_URL is derived, so the summary URL reflects
    # the port the hub actually binds.
    Resolve-PortConflicts

    Set-EnvDefault 'PRIVOS_ROOT_URL' ('http://localhost:' + (Get-EnvValue 'PRIVOS_HUB_PORT'))

    Test-ValidPort (Get-EnvValue 'PRIVOS_HUB_PORT') '-HubPort/PRIVOS_HUB_PORT'
    Test-ValidPort (Get-EnvValue 'PRIVOS_BOARD_PORT') 'PRIVOS_BOARD_PORT'
    Test-ValidPort (Get-EnvValue 'PRIVOS_PROXY_PORT') 'PRIVOS_PROXY_PORT'
    Test-ValidPort (Get-EnvValue 'PRIVOS_RUSTFS_PORT') 'PRIVOS_RUSTFS_PORT'
}

function Read-YesNo {
    param([string]$Prompt, [bool]$DefaultYes)
    $ans = ''
    try { $ans = Read-Host $Prompt } catch { $ans = '' }
    if ($null -eq $ans) { $ans = '' }
    if ($DefaultYes) { return -not ($ans -match '^[Nn]') }
    return [bool]($ans -match '^[Yy]')
}

# True when a person can answer prompts (not -Yes, a console with input is attached).
function Test-ConsoleAvailable {
    try { return ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) } catch { return $false }
}

function Read-SidecarChoices {
    # Only ever prompt on a genuinely fresh install; a re-run keeps what was persisted, and an
    # explicit flag always wins.
    $s = $script:PxState
    if ($s.HadExistingEnv) { return }
    if ($s.AssumeYes -or -not (Test-ConsoleAvailable)) { return }
    if (-not $s.WithKnowledgeVec) {
        Write-Host @'

Enable the knowledge-vector sidecar (Weaviate)?
  Managed knowledge base / semantic search. Adds a Weaviate container,
  ~+2 GB RAM (raises the practical minimum from 4 GB to 8 GB).
'@
        if (Read-YesNo '  Enable? [y/N]' $false) { $script:PxEnv['PRIVOS_WITH_KNOWLEDGE_VECTOR'] = 'true' } else { $script:PxEnv['PRIVOS_WITH_KNOWLEDGE_VECTOR'] = 'false' }
    }
    # App Cluster is ON by default: this is an acknowledgement prompt, only an explicit "n" disables it.
    if (-not $s.WithoutAppCluster) {
        Write-Host @'

The App Cluster (community marketplace runtime) is enabled by default.
  Runs marketplace MCP apps as containers on THIS host, over a dial-out
  tunnel to the hub - no inbound port. Needs Docker socket access, which is
  root-equivalent inside the Docker Desktop VM (no-new-privileges, all
  capabilities dropped).
'@
        if (Read-YesNo '  Continue with Docker socket access enabled? [Y/n]' $true) { $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'true' } else { $script:PxEnv['PRIVOS_WITH_APP_CLUSTER'] = 'false' }
    }
}

function Complete-SidecarConfig {
    # PRIVOS_DOCKER_SOCKET_GID is resolved later by Resolve-DockerSocketGid, from the daemon side,
    # once the bundle (and its netguard image reference) is verified.
    $profiles = @()
    if ((Get-EnvValue 'PRIVOS_WITH_KNOWLEDGE_VECTOR') -eq 'true') { $profiles += 'knowledge-vector' }
    if ((Get-EnvValue 'PRIVOS_WITH_APP_CLUSTER') -eq 'true') { $profiles += 'app-cluster' }
    $script:PxEnv['COMPOSE_PROFILES'] = ($profiles -join ',')
}

# ---------------------------------------------------------------------------
# Port-conflict detection. Get-PortListeners / Get-ContainerPortsJson / Get-ExcludedPortRanges
# are the only OS-touching pieces; tests redefine them after dot-sourcing.
# ---------------------------------------------------------------------------

# `netstat -ano -p TCP` text -> @{ port = @{ Pid; Cmd } } (listening sockets only).
function ConvertFrom-NetstatOutput {
    param([string[]]$Lines)
    $map = @{}
    foreach ($line in $Lines) {
        if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            $port = [int]$Matches[1]
            if (-not $map.ContainsKey($port)) { $map[$port] = @{ Pid = $Matches[2]; Cmd = 'unknown' } }
        }
    }
    return $map
}

# `netsh int ipv4 show excludedportrange protocol=tcp` text -> @( @{ Start; End } ).
function ConvertFrom-ExcludedPortRangeOutput {
    param([string[]]$Lines)
    $ranges = @()
    foreach ($line in $Lines) {
        if ($line -match '^\s*(\d+)\s+(\d+)\s*\*?\s*$') {
            $ranges += , @{ Start = [int]$Matches[1]; End = [int]$Matches[2] }
        }
    }
    return $ranges
}

function Get-ExcludedPortRanges {
    if (-not (Test-IsWindows)) { return @() }
    $r = Invoke-Native -File 'netsh.exe' -ArgList @('int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp') -StdoutOnly
    if ($r.Code -ne 0) { return @() }
    return @(ConvertFrom-ExcludedPortRangeOutput $r.Lines)
}

function Get-PortListeners {
    $map = @{}
    $conns = $null
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
    }
    if ($null -ne $conns -and $conns.Count -gt 0) {
        foreach ($cn in $conns) {
            $port = [int]$cn.LocalPort
            if ($map.ContainsKey($port)) { continue }
            $name = 'unknown'
            $p = Get-Process -Id $cn.OwningProcess -ErrorAction SilentlyContinue
            if ($p) { $name = $p.ProcessName }
            $map[$port] = @{ Pid = [string]$cn.OwningProcess; Cmd = $name }
        }
        return $map
    }
    $r = Invoke-Native -File 'netstat.exe' -ArgList @('-ano', '-p', 'TCP') -StdoutOnly
    if ($r.Code -ne 0) { Stop-Install 'neither Get-NetTCPConnection nor netstat is available - cannot perform the port-conflict check.' }
    $map = ConvertFrom-NetstatOutput $r.Lines
    foreach ($port in @($map.Keys)) {
        $p = Get-Process -Id ([int]$map[$port].Pid) -ErrorAction SilentlyContinue
        if ($p) { $map[$port].Cmd = $p.ProcessName }
    }
    return $map
}

function Get-ContainerPortsJson {
    param([string]$Container)
    $r = Invoke-Native -File 'docker' -ArgList @('inspect', '-f', '{{json .NetworkSettings.Ports}}', $Container) -StdoutOnly
    if ($r.Code -ne 0) { return '' }
    return $r.Text
}

# Host ports a container publishes, from `docker inspect` JSON (HostPort fields).
function Get-HostPortsFromInspectJson {
    param([string]$Json)
    $ports = @()
    foreach ($m in [regex]::Matches($Json, '"HostPort":"(\d+)"')) { $ports += [int]$m.Groups[1].Value }
    return $ports
}

# A listener is "ours" when one of this stack's containers publishes that host port
# (Docker Desktop shows the owner as com.docker.backend or wslrelay, not the container).
function Test-PortAlreadyOurs {
    param([int]$Port)
    $s = $script:PxState
    if ($null -eq $s.OurPorts) {
        $set = @{}
        foreach ($name in @('hub', 'sandbox-board', 'sandbox-proxy', 'rustfs', 'publisher')) {
            $json = Get-ContainerPortsJson ($script:PxConst.ProjectName + '-' + $name)
            if ($json) { foreach ($hp in (Get-HostPortsFromInspectJson $json)) { $set[$hp] = $true } }
        }
        $s.OurPorts = $set
    }
    return $s.OurPorts.ContainsKey($Port)
}

function Test-PortExcluded {
    param([int]$Port)
    $s = $script:PxState
    if (-not $s.ContainsKey('Excluded') -or $null -eq $s.Excluded) { $s.Excluded = @(Get-ExcludedPortRanges) }
    foreach ($rg in $s.Excluded) { if ($Port -ge $rg.Start -and $Port -le $rg.End) { return $true } }
    return $false
}

# Free = nobody listening (or the listener is our own container) and not inside a range
# Windows reserves (Hyper-V / WinNAT), which Docker cannot bind either.
function Test-PortFree {
    param([int]$Port)
    $l = $script:PxState.Listeners
    if ($l.ContainsKey($Port) -and -not (Test-PortAlreadyOurs $Port)) { return $false }
    if (Test-PortExcluded $Port) { return $false }
    return $true
}

function Find-FreePort {
    param([int]$Start, [int[]]$Avoid = @())
    for ($p = $Start; $p -le 65535; $p++) {
        if ((Test-PortFree $p) -and ($Avoid -notcontains $p)) { return $p }
    }
    return 0
}

function Test-RangeHasConflict {
    param([int]$Lo, [int]$Hi)
    for ($p = $Lo; $p -le $Hi; $p++) { if (-not (Test-PortFree $p)) { return $true } }
    return $false
}

# On a FRESH install a DEFAULT service port already held by an unrelated process is moved
# to the next free port (announced) rather than aborting. Explicit ports are never moved.
function Resolve-PortConflicts {
    $s = $script:PxState
    $s.Listeners = Get-PortListeners
    $s.OurPorts = $null
    $claimed = @()
    foreach ($e in @(@('HUB', 'Hub'), @('BOARD', 'Board'), @('PROXY', 'Proxy'), @('RUSTFS', 'Rustfs'))) {
        $var = 'PRIVOS_' + $e[0] + '_PORT'
        $cur = [int](Get-EnvValue $var)
        $claimed += $cur
        if ($s.PortExplicit[$e[1]]) { continue }
        if (-not (Test-PortFree $cur)) {
            $new = Find-FreePort -Start $cur -Avoid $claimed
            if ($new -eq 0) { Stop-Install "no free port at or above $cur for $($e[0]) - free one or pass a port flag/env." }
            Write-InstallLog "Port $cur ($($e[0])) is in use - using $new instead (pin it with a flag/env to override)."
            $script:PxEnv[$var] = [string]$new
            $claimed[$claimed.Count - 1] = $new
        }
    }
    if (-not $s.PortExplicit.Range) {
        $range = Get-EnvValue 'PRIVOS_VM_PORT_RANGE'
        [void](Expand-PortRange $range)
        $lo = [int]($range.Split('-')[0]); $hi = [int]($range.Split('-')[1]); $span = $hi - $lo + 1
        $shifted = $false
        while (Test-RangeHasConflict $lo $hi) {
            $lo = $hi + 1; $hi = $lo + $span - 1; $shifted = $true
            if ($hi -gt 65535) { Stop-Install "no free $span-port window for the sandbox VM pool - pass -VmPortRange." }
        }
        if ($shifted) {
            Write-InstallLog "Sandbox VM port range in use - using $lo-$hi instead (override with -VmPortRange)."
            $script:PxEnv['PRIVOS_VM_PORT_RANGE'] = "$lo-$hi"
        }
    }
}

function Test-Ports {
    param([int[]]$Requested)
    $s = $script:PxState
    $s.Listeners = Get-PortListeners
    $s.OurPorts = $null
    $conflicts = @()
    foreach ($port in $Requested) {
        if ($s.Listeners.ContainsKey($port) -and -not (Test-PortAlreadyOurs $port)) { $conflicts += @{ Port = $port; Why = ('PID ' + $s.Listeners[$port].Pid + ' ' + $s.Listeners[$port].Cmd) }; continue }
        if (Test-PortExcluded $port) { $conflicts += @{ Port = $port; Why = 'reserved by Windows (excluded port range of Hyper-V/WinNAT)' } }
    }
    if ($conflicts.Count -gt 0) {
        Write-Host 'Port conflict - refusing to write any state:'
        foreach ($cf in $conflicts) { Write-Host ('  {0,-8} {1}' -f $cf.Port, $cf.Why) }
        Write-Host ''
        Write-Host 'Override with -HubPort / -VmPortRange, or stop the owning process, then re-run.'
        Write-Host 'Reserved ranges can be listed with: netsh int ipv4 show excludedportrange protocol=tcp'
        return $false
    }
    return $true
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

function Get-HttpProbe {
    param([string]$Uri, [string]$Method = 'Get')
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method $Method -TimeoutSec 15
        $d = ''
        try { $h = $r.Headers['Date']; if ($h) { $d = [string](@($h)[0]) } } catch { $d = '' }
        return @{ Status = [int]$r.StatusCode; Date = $d }
    }
    catch {
        $status = 0
        $resp = $null
        if ($_.Exception.PSObject.Properties['Response']) { $resp = $_.Exception.Response }
        if ($resp) { try { $status = [int]$resp.StatusCode } catch { $status = 0 } }
        return @{ Status = $status; Date = '' }
    }
}

function Test-RegistryReachability {
    $g = Get-HttpProbe -Uri 'https://ghcr.io/v2/'
    if ($g.Status -ne 200 -and $g.Status -ne 401) {
        Stop-Install "cannot reach ghcr.io (HTTP $($g.Status)) - the images are pulled from there. Check DNS, outbound firewall (TCP 443) and any corporate proxy; Docker Desktop has its OWN proxy settings (Settings > Resources > Proxies)."
    }
    $h = Get-HttpProbe -Uri 'https://github.com' -Method 'Head'
    if (@(200, 301, 302) -notcontains $h.Status) {
        Stop-Install "cannot reach github.com (HTTP $($h.Status)) - the bundle is downloaded from GitHub Releases. Check DNS / firewall / proxy."
    }
    if ((Get-EnvVar 'HTTPS_PROXY') -or (Get-EnvVar 'HTTP_PROXY')) {
        Write-InstallLog 'NOTE: a proxy is set in this shell. Docker Desktop does NOT inherit it - set the proxy in Docker Desktop (Settings > Resources > Proxies) for image pulls.'
    }
    # A skewed clock breaks TLS and time-bounded signature checks in confusing ways.
    if ($h.Date) {
        try {
            $skew = [Math]::Abs(([DateTimeOffset]::Parse($h.Date, [Globalization.CultureInfo]::InvariantCulture) - [DateTimeOffset]::UtcNow).TotalSeconds)
            if ($skew -gt 300) {
                Write-InstallLog "WARNING: system clock is off by ~$([int]$skew)s vs github.com - TLS and signature checks can fail."
                Write-InstallLog 'Fix: Settings > Time & language > Date & time > Sync now (or enable "Set time automatically"), then re-run.'
            }
        }
        catch { Write-Verbose 'clock skew check skipped' }
    }
}

function Test-PlatformSupported {
    if (-not (Test-IsWindows)) { Stop-Install "this installer supports Windows only (use install.sh on Linux and macOS)." }
    $arch = Resolve-HostArch -Arch (Get-EnvVar 'PROCESSOR_ARCHITECTURE') -Wow64Arch (Get-EnvVar 'PROCESSOR_ARCHITEW6432')
    if ($arch -ne 'x64' -and $arch -ne 'arm64') { Stop-Install "unsupported architecture: $arch - the self-hosted installer supports Windows on x64 (Intel/AMD) and on ARM64." }
    $build = 0
    $caption = 'Windows'
    try {
        $os = Get-CimInstance Win32_OperatingSystem
        $build = [int]$os.BuildNumber
        $caption = [string]$os.Caption
    }
    catch { $build = [Environment]::OSVersion.Version.Build }
    if (-not (Test-WindowsBuildSupported $build)) {
        Stop-Install "Windows build $build is too old - Docker Desktop with WSL2 needs Windows 10 22H2 (build $($script:PxConst.MinWindowsBuild)) or Windows 11."
    }
    # Docker Desktop for Windows on ARM runs on Windows 11 only.
    if ($arch -eq 'arm64' -and $build -lt $script:PxConst.MinWindowsArmBuild) {
        Stop-Install "Windows build $build is too old for Windows on ARM - Docker Desktop on ARM64 needs Windows 11 (build $($script:PxConst.MinWindowsArmBuild) or newer)."
    }
    Write-InstallLog "Platform: $caption (build $build) - $arch - PowerShell $($PSVersionTable.PSVersion)"
    try {
        $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        if ($me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-InstallLog 'NOTE: this PowerShell is elevated. Administrator rights are not needed; the install belongs to your own account, so a normal window is preferred.'
        }
    }
    catch { Write-Verbose 'elevation check skipped' }
}

function Get-DockerDesktopSettings {
    $paths = @()
    if ($env:APPDATA) { $paths = @((Join-Path (Join-Path $env:APPDATA 'Docker') 'settings-store.json'), (Join-Path (Join-Path $env:APPDATA 'Docker') 'settings.json')) }
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        try { return (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json) } catch { continue }
    }
    return $null
}

# Value of a setting by name (case-insensitive: settings-store.json uses AutoStart,
# settings.json uses autoStart), or $null when absent.
function Get-DockerDesktopSetting {
    param($Settings, [string]$Name)
    if ($null -eq $Settings) { return $null }
    $prop = $Settings.PSObject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    if ($prop) { return $prop.Value }
    return $null
}

function Find-DockerExe {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    if ($env:ProgramFiles) {
        $bin = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
        if (Test-Path -LiteralPath (Join-Path $bin 'docker.exe')) {
            $env:Path = $bin + ';' + $env:Path
            return $true
        }
    }
    return $false
}

function Test-DockerDaemonUp {
    $r = Invoke-Native -File 'docker' -ArgList @('info', '--format', '{{.ServerVersion}}') -StdoutOnly
    return ($r.Code -eq 0 -and [bool]$r.Text)
}

# "OSType|OperatingSystem|MemTotal|NCPU" -> object (spaces in OperatingSystem are fine).
function ConvertFrom-DockerInfoLine {
    param([string]$Line)
    $parts = $Line.Split('|')
    if ($parts.Count -lt 4) { return $null }
    $mem = [int64]0
    [void][int64]::TryParse($parts[2], [ref]$mem)
    $cpu = 0
    [void][int]::TryParse($parts[3], [ref]$cpu)
    $arch = ''
    if ($parts.Count -ge 5) { $arch = $parts[4].Trim() }
    return [pscustomobject]@{ OSType = $parts[0]; OperatingSystem = $parts[1]; MemTotal = $mem; NCPU = $cpu; Architecture = $arch }
}

function Confirm-DockerDesktop {
    $c = $script:PxConst
    if (-not (Find-DockerExe)) {
        Stop-Install "Docker Desktop is not installed. Install Docker Desktop (WSL2 backend) from $($c.DockerDesktopUrl) , start it once, and re-run."
    }
    if (-not (Test-DockerDaemonUp)) {
        $exe = $null
        if ($env:ProgramFiles) { $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe' }
        if ($exe -and (Test-Path -LiteralPath $exe)) {
            Write-InstallLog 'Docker Desktop is installed but not running - starting it (up to 120 s)...'
            Start-Process -FilePath $exe | Out-Null
            $deadline = [DateTime]::UtcNow.AddSeconds(120)
            while ([DateTime]::UtcNow -lt $deadline -and -not (Test-DockerDaemonUp)) { Start-Sleep -Seconds 3 }
        }
        if (-not (Test-DockerDaemonUp)) {
            $why = (Invoke-Native -File 'docker' -ArgList @('info')).Text
            if ($why -match '(?i)access is denied|permission denied|docker-users') {
                Stop-Install "Docker Desktop is running but your account may not use it. Add your user to the 'docker-users' group (Computer Management > Local Users and Groups), sign out and in, then re-run."
            }
            Stop-Install "Docker Desktop is not running and could not be started. Start Docker Desktop, wait for 'Engine running', and re-run. Download: $($c.DockerDesktopUrl)"
        }
    }
    $major = (Invoke-Native -File 'docker' -ArgList @('version', '--format', '{{.Server.Version}}') -StdoutOnly).Text
    $api = (Invoke-Native -File 'docker' -ArgList @('version', '--format', '{{.Server.APIVersion}}') -StdoutOnly).Text
    $compose = (Invoke-Native -File 'docker' -ArgList @('compose', 'version', '--short') -StdoutOnly).Text
    $majorParts = ConvertTo-VersionParts $major
    if ($null -eq $majorParts -or $majorParts[0] -lt $c.MinDockerMajor) { Stop-Install "Docker >= $($c.MinDockerMajor) is required (found: $major) - update Docker Desktop." }
    if (-not (Test-VersionAtLeast $compose $c.MinComposeVersion)) { Stop-Install "Docker Compose >= $($c.MinComposeVersion) is required (found: $compose) - update Docker Desktop to 4.30 or newer." }
    if (-not (Test-VersionAtLeast $api $c.MinApiVersion)) { Stop-Install "Docker Engine API >= $($c.MinApiVersion) is required (found: $api) - update Docker Desktop to 4.30 or newer." }

    $line = (Invoke-Native -File 'docker' -ArgList @('info', '--format', '{{.OSType}}|{{.OperatingSystem}}|{{.MemTotal}}|{{.NCPU}}|{{.Architecture}}') -StdoutOnly).Text
    $facts = ConvertFrom-DockerInfoLine $line
    if ($null -eq $facts) { Stop-Install "could not read 'docker info' (got: $line)." }
    if ($facts.OSType -ne 'linux') { Stop-Install "Docker Desktop is in Windows-containers mode. Right-click the Docker tray icon and choose 'Switch to Linux containers', then re-run." }
    if ($facts.OperatingSystem -notmatch 'Docker Desktop') {
        Write-InstallLog "WARNING: the Docker engine reports '$($facts.OperatingSystem)', not Docker Desktop. Only Docker Desktop (WSL2 backend) is verified on Windows."
    }
    # The WSL2 backend is required: the Hyper-V backend is a different VM and is not supported.
    $settings = Get-DockerDesktopSettings
    $wsl = Get-DockerDesktopSetting -Settings $settings -Name 'wslEngineEnabled'
    if ($null -ne $wsl -and -not [bool]$wsl) {
        Stop-Install 'Docker Desktop uses the Hyper-V backend, which is not supported. Enable "Use the WSL 2 based engine" (Settings > General), restart Docker Desktop, and re-run.'
    }
    if ($null -eq $wsl) {
        $w = Invoke-Native -File 'wsl.exe' -ArgList @('--status') -StdoutOnly
        if ($w.Code -ne 0) { Write-InstallLog "WARNING: 'wsl --status' failed (exit $($w.Code)); make sure Docker Desktop runs on the WSL 2 backend." }
    }
    $script:PxState.Docker = $facts
}

function Test-Resources {
    $c = $script:PxConst
    $memMb = [int]([int64]$script:PxState.Docker.MemTotal / 1MB)
    if ($memMb -lt $c.MinRamMb) {
        Stop-Install ("the Docker Desktop VM has $memMb MB of memory; PrivOS needs at least 6 GB there (8 GB recommended). Give WSL 2 more memory: create or edit %UserProfile%\.wslconfig with`n[wsl2]`nmemory=8GB`nthen run 'wsl --shutdown', restart Docker Desktop and re-run.")
    }
    if ($memMb -lt $c.RecommendedRamMb) {
        Write-InstallLog "WARNING: the Docker Desktop VM has $memMb MB of memory; 8 GB is recommended once agents and marketplace apps run (set memory=8GB in %UserProfile%\.wslconfig, then 'wsl --shutdown')."
    }
    $roots = @([IO.Path]::GetPathRoot($script:PxState.Dir))
    if ($env:LOCALAPPDATA) { $roots += [IO.Path]::GetPathRoot($env:LOCALAPPDATA) }
    foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
        try {
            $freeGb = [int]((New-Object System.IO.DriveInfo($root)).AvailableFreeSpace / 1GB)
            if ($freeGb -lt $c.MinDiskGb) { Stop-Install "at least $($c.MinDiskGb) GB free disk is required on drive $root (found $freeGb GB free); images and data live in the Docker Desktop disk image." }
        }
        catch [System.InvalidOperationException] { throw }
        catch { Write-InstallLog "NOTE: could not read free space of $root; skipping the disk check." }
    }
}

function Invoke-Preflight {
    Test-DevSigningKey
    Test-PlatformSupported
    Test-RegistryReachability
    Confirm-DockerDesktop
    Test-Resources
    Resolve-BundleSource
}

# ---------------------------------------------------------------------------
# License acceptance - must run before ANY other install state is written.
# ---------------------------------------------------------------------------

function Test-LicenseAlreadyAccepted {
    $marker = Join-Path $script:PxState.Dir $script:PxConst.LicenseMarkerFile
    if (-not (Test-Path -LiteralPath $marker)) { return $false }
    return [bool](Select-String -LiteralPath $marker -SimpleMatch $script:PxConst.LicenseVersion -Quiet)
}

function Show-LicenseNotice {
    Write-Host @"

PrivOS is licensed under the PrivOS Community License 1.0: free for up to 10
Active Human Users - people who sign in with an account - counted across all
deployments your company runs; bots, integrations, AI agents, and guests who
never sign in do not count. More than that, hosted/managed services, and
commercial redistribution require a license from Roxane, Inc. Full text:
$($script:PxState.Dir)\LICENSE (after install) and
https://github.com/PrivOS-AI/privos/blob/main/LICENSE - plain-English FAQ:
https://github.com/PrivOS-AI/privos/blob/main/LICENSE-FAQ.md

"@
}

# -Yes implies acceptance; -AcceptLicense / PRIVOS_ACCEPT_LICENSE=1 accept without -Yes's
# other effects. Never treats silence as acceptance.
function Confirm-LicenseAcceptance {
    $s = $script:PxState
    if (Test-LicenseAlreadyAccepted) {
        Write-InstallLog "License already accepted ($($s.Dir)\$($script:PxConst.LicenseMarkerFile))."
        return
    }
    Show-LicenseNotice
    if ($s.AssumeYes -or $s.AcceptLicenseFlag) {
        Write-InstallLog 'License accepted (-Yes/-AcceptLicense or PRIVOS_ACCEPT_LICENSE=1).'
        $s.LicenseAccepted = $true
        return
    }
    if (Test-ConsoleAvailable) {
        if (Read-YesNo 'Accept the license? [y/N]' $false) { $s.LicenseAccepted = $true; return }
        Stop-Install 'license not accepted - installation stopped.'
    }
    Stop-Install 'cannot prompt for license acceptance (no console). Re-run with -Yes or -AcceptLicense, or set PRIVOS_ACCEPT_LICENSE=1, after reading the license.'
}

function Write-LicenseMarker {
    if (-not $script:PxState.LicenseAccepted) { return }
    $text = $script:PxConst.LicenseVersion + "`naccepted_at=" + [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') + "`n"
    Write-TextFile -Path (Join-Path $script:PxState.Dir $script:PxConst.LicenseMarkerFile) -Text $text
}

# ---------------------------------------------------------------------------
# Bundle fetch and trust chain
# ---------------------------------------------------------------------------

function Resolve-BundleSource {
    $s = $script:PxState
    $s.BundleSource = 'remote'
    $s.BundleSourceDir = ''
    $dir = $s.ScriptDir
    if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'compose.yml')) -and (Test-Path -LiteralPath (Join-Path $dir 'versions.json'))) {
        $s.BundleSource = 'local'
        $s.BundleSourceDir = $dir
    }
    $suffix = ''
    if ($s.BundleSourceDir) { $suffix = " ($($s.BundleSourceDir))" }
    Write-InstallLog "Bundle source: $($s.BundleSource)$suffix"
}

function Invoke-Download {
    param([string]$Uri, [string]$Dest)
    $last = ''
    for ($i = 1; $i -le 3; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Dest -TimeoutSec 120 | Out-Null
            return
        }
        catch {
            $last = $_.Exception.Message
            if ($i -lt 3) { Start-Sleep -Seconds 2 }
        }
    }
    Stop-Install "failed to download $Uri ($last)"
}

function Get-BundleFile {
    param([string]$Name, [string]$Dest)
    $s = $script:PxState
    if ($s.BundleSource -eq 'local') {
        $src = Join-Path $s.BundleSourceDir $Name
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $Dest -Force }
        return
    }
    Invoke-Download -Uri ((Resolve-BundleBaseUrl) + '/' + $Name) -Dest $Dest
}

function Get-Bundle {
    param([string]$DestDir)
    $c = $script:PxConst
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    foreach ($name in $c.BundleFiles) { Get-BundleFile -Name $name -Dest (Join-Path $DestDir $name) }
    foreach ($name in $c.SignedFiles) { Get-BundleFile -Name "$name.minisig" -Dest (Join-Path $DestDir "$name.minisig") }
    foreach ($name in $c.BundleFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $DestDir $name))) { Stop-Install "bundle is missing $name after fetch" }
    }
}

# Pinned minisign.exe: downloaded from the jedisct1/minisign release, verified against the
# sha256 baked into this script, and stored in <install dir>\bin.
function Install-Minisign {
    $c = $script:PxConst
    $s = $script:PxState
    $binDir = Join-Path $s.Dir 'bin'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('privos-minisign-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        $zip = Join-Path $tmp 'minisign.zip'
        Invoke-Download -Uri "https://github.com/jedisct1/minisign/releases/download/$($c.MinisignVersion)/minisign-$($c.MinisignVersion)-win64.zip" -Dest $zip
        $actual = Get-FileSha256 $zip
        if ($actual -cne $c.MinisignZipSha256) {
            Stop-Install "sha256 mismatch for the minisign $($c.MinisignVersion) download (expected $($c.MinisignZipSha256), got $actual) - refusing to run it."
        }
        Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'x') -Force
        $src = Join-Path (Join-Path (Join-Path (Join-Path $tmp 'x') 'minisign-win64') 'x86_64') 'minisign.exe'
        if (-not (Test-Path -LiteralPath $src)) { Stop-Install 'the minisign archive does not contain x86_64\minisign.exe.' }
        $dest = Join-Path $binDir 'minisign.exe'
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $s.MinisignExe = $dest
    }
    finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

function Test-BundleSignature {
    param([string]$File)
    $c = $script:PxConst
    if (-not (Test-Path -LiteralPath "$File.minisig")) { Stop-Install "missing signature file $File.minisig - refusing to use an unsigned bundle." }
    $r = Invoke-Native -File $script:PxState.MinisignExe -ArgList @('-Vq', '-m', $File, '-x', "$File.minisig", '-P', $c.MinisignPublicKey)
    if ($r.Code -ne 0) { Stop-Install "signature verification FAILED for $File - refusing to use a tampered or corrupted bundle." }
    Write-InstallLog "Signature OK: $(Split-Path -Leaf $File)"
}

# files{}.sha256 of a bundle file in the (already verified) versions.json, or $null.
function Get-BundleFileSha256 {
    param([string]$Name, $VersionsJson)
    $files = $VersionsJson.PSObject.Properties['files']
    if ($null -eq $files -or $null -eq $files.Value) { return $null }
    $entry = $files.Value.PSObject.Properties[$Name]
    if ($null -eq $entry -or $null -eq $entry.Value) { return $null }
    $sha = $entry.Value.PSObject.Properties['sha256']
    if ($null -eq $sha) { return $null }
    return [string]$sha.Value
}

function Test-BundleFileHash {
    param([string]$Name, [string]$Dir, $VersionsJson)
    $expected = Get-BundleFileSha256 -Name $Name -VersionsJson $VersionsJson
    if (-not $expected) { Stop-Install "versions.json has no files[`"$Name`"].sha256 entry - refusing to use an unverifiable bundle file." }
    if ($expected -cnotmatch '^[0-9a-f]{64}$') { Stop-Install "versions.json files[`"$Name`"].sha256 is not a well-formed sha256 hex digest." }
    $actual = Get-FileSha256 (Join-Path $Dir $Name)
    if ($expected -cne $actual) { Stop-Install "sha256 mismatch for $Name (expected $expected, got $actual) - refusing to install/execute a tampered bundle file." }
}

# Full bundle trust chain: minisig-verify the signed files, then hash-verify every remaining
# bundle file against the (now trusted) versions.json. Must complete before anything in
# $Dir is used.
function Test-BundleIntegrity {
    param([string]$Dir)
    $c = $script:PxConst
    foreach ($f in $c.SignedFiles) { Test-BundleSignature (Join-Path $Dir $f) }
    $versions = Get-Content -LiteralPath (Join-Path $Dir 'versions.json') -Raw | ConvertFrom-Json
    foreach ($f in $c.UnsignedHashedFiles) { Test-BundleFileHash -Name $f -Dir $Dir -VersionsJson $versions }
    # Signed AND hash-pinned in the signed versions.json (install.sh parity).
    Test-BundleFileHash -Name 'compose.desktop.yml' -Dir $Dir -VersionsJson $versions
    Write-InstallLog "Bundle integrity verified ($($c.UnsignedHashedFiles.Count) file hashes)."
}

# An upgrade re-runs against the .env of the previous install; take the stack version from
# the verified bundle unless -Version pinned one explicitly.
function Update-StackVersionFromBundle {
    param([string]$Dir)
    if ($script:PxState.VersionFlag) { return }
    $versions = Get-Content -LiteralPath (Join-Path $Dir 'versions.json') -Raw | ConvertFrom-Json
    $p = $versions.PSObject.Properties['stackVersion']
    if ($null -eq $p -or -not $p.Value) { return }
    $bundleVersion = [string]$p.Value
    $current = Get-EnvValue 'PRIVOS_STACK_VERSION'
    if ($current -ne $bundleVersion) {
        Write-InstallLog "Stack version: $current -> $bundleVersion (from the verified bundle)"
        $script:PxEnv['PRIVOS_STACK_VERSION'] = $bundleVersion
    }
}

# ---------------------------------------------------------------------------
# Stack lifecycle
# ---------------------------------------------------------------------------

function Set-ComposePaths {
    $s = $script:PxState
    $base = @('compose', '-f', (Join-Path $s.Dir 'compose.yml'))
    $overlay = Join-Path $s.Dir 'compose.desktop.yml'
    if (Test-Path -LiteralPath $overlay) { $base += @('-f', $overlay) }
    $base += @('--env-file', (Join-Path $s.Dir '.env'), '--project-name', (Get-EnvValue 'PRIVOS_PROJECT'))
    $s.ComposeBase = $base
}

function Initialize-Networks {
    $net = Get-EnvValue 'PRIVOS_NETWORK'
    if ((Invoke-Native -File 'docker' -ArgList @('network', 'inspect', $net) -StdoutOnly).Code -ne 0) {
        $r = Invoke-Native -File 'docker' -ArgList @('network', 'create', $net)
        if ($r.Code -ne 0) { Stop-Install "could not create Docker network ${net}: $($r.Text)" }
        Write-InstallLog "Created Docker network $net"
    }
    # Agent VM containers' dedicated bridge, kept separate so agent VMs cannot reach
    # Redis/RustFS directly. The bridge name is pinned so the netguard rules can match it.
    $agent = Get-EnvValue 'PRIVOS_AGENT_NETWORK'
    if ((Invoke-Native -File 'docker' -ArgList @('network', 'inspect', $agent) -StdoutOnly).Code -ne 0) {
        $iface = $script:PxConst.AgentNetworkBridgeIface
        $r = Invoke-Native -File 'docker' -ArgList @('network', 'create', '--opt', "com.docker.network.bridge.name=$iface", $agent)
        if ($r.Code -ne 0) { Stop-Install "could not create Docker network ${agent}: $($r.Text)" }
        Write-InstallLog "Created Docker network $agent (bridge $iface)"
    }
}

# Containers left over from a previous or foreign install collide on container_name.
function Test-StaleStack {
    $project = Get-EnvValue 'PRIVOS_PROJECT'
    $stale = @()
    foreach ($n in @('mongo', 'redis', 'rustfs', 'rustfs-init', 'hub', 'sandbox-board', 'sandbox-proxy', 'weaviate', 'app-cluster', 'init', 'netguard')) {
        $name = "$project-$n"
        $r = Invoke-Native -File 'docker' -ArgList @('inspect', '-f', '{{json .Config.Labels}}', $name) -StdoutOnly
        if ($r.Code -ne 0) { continue }
        $label = ''
        try {
            $labels = $r.Text | ConvertFrom-Json
            $p = $labels.PSObject.Properties['com.docker.compose.project']
            if ($p) { $label = [string]$p.Value }
        }
        catch { $label = '' }
        if ($label -ne $project) { $stale += $name }
    }
    if ($stale.Count -eq 0) { return }
    Write-InstallLog 'Found containers from a previous/foreign install that would collide on container_name:'
    Write-InstallLog "  $($stale -join ' ')"
    if (-not $script:PxState.AssumeYes -and (Test-ConsoleAvailable)) {
        if (Read-YesNo 'Remove them so this install can proceed? [Y/n]' $true) {
            [void](Invoke-Native -File 'docker' -ArgList (@('rm', '-f') + $stale))
            Write-InstallLog 'Removed stale containers.'
            return
        }
        Stop-Install "stale containers left in place - remove them (docker rm -f $($stale -join ' ')) and re-run."
    }
    Stop-Install "stale containers would collide: $($stale -join ' ') - remove them (docker rm -f $($stale -join ' ')) and re-run, or run interactively to be prompted."
}

function Show-FirewallNotice {
    $port = Get-EnvValue 'PRIVOS_HUB_PORT'
    if ((Invoke-Native -File 'docker' -ArgList @('inspect', ($script:PxConst.ProjectName + '-hub')) -StdoutOnly).Code -eq 0) { return }
    Write-Host @"

NOTE: Windows Defender Firewall may now ask whether to allow "com.docker.backend"
to accept connections. The hub publishes port $port on all network interfaces, the
same bind as the Linux install. Allow it on Private networks to reach the hub from
other devices on your LAN; cancelling the prompt keeps the hub reachable from this
PC only (http://localhost:$port).

"@
}

function Wait-ComposeHealthy {
    param([string]$Service, [int]$TimeoutSec = 120)
    $waited = 0
    while ($waited -lt $TimeoutSec) {
        $r = Invoke-Compose -ComposeArgs @('ps', '--format', '{{.Health}}', $Service) -StdoutOnly
        if ($r.Code -eq 0 -and $r.Text.Trim() -eq 'healthy') { return $true }
        Start-Sleep -Seconds 3
        $waited += 3
    }
    return $false
}

# mongod runs with --keyFile, so auth is enforced and replSetInitiate MUST authenticate as
# root; the credentials expand inside the container and never reach the host command line.
function Initialize-ReplicaSet {
    $js = 'try { rs.status().ok } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] }) }'
    $sh = 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval ''' + $js + ''''
    $r = Invoke-ComposeShell -Service 'mongo' -ShellScript $sh
    if ($r.Code -ne 0) { Stop-Install "replica set initiation failed: $($r.Text)" }
}

# Driver-removal guard: refuse to proceed while any installation is still bound to a
# NON-tunnel App Cluster row. Fails CLOSED: a query error blocks the install.
function Test-LocalRuntimeInstallations {
    if (-not $script:PxState.HadExistingEnv) { return }
    $js = @'
const _db = db.getSiblingDB("privos");
const bound = _db.mcp_apps.aggregate([
  { $match: { localRuntimeClusterId: { $exists: true, $ne: null } } },
  { $lookup: { from: "app_clusters", localField: "localRuntimeClusterId", foreignField: "_id", as: "c" } },
  { $match: { $or: [ { c: { $size: 0 } }, { "c.0.connection": { $ne: "tunnel" } } ] } },
  { $project: { _id: 1, name: 1 } }
]).toArray();
print(JSON.stringify(bound));
'@
    $sh = 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval ''' + $js + ''''
    $r = Invoke-ComposeShell -Service 'mongo' -ShellScript $sh
    if ($r.Code -ne 0) { Stop-Install "could not check for existing local-runtime installations before this upgrade - refusing to proceed blind. mongo output: $($r.Text)" }
    # mongosh may print banner/warning lines first: take the last line that looks like a JSON array.
    $json = @($r.Lines | Where-Object { $_ -match '^\[' }) | Select-Object -Last 1
    if (-not $json) { Stop-Install "could not parse the local-runtime installation check output - refusing to proceed blind (raw: $($r.Text))" }
    try { $parsed = ConvertFrom-Json $json } catch { Stop-Install "could not parse the local-runtime installation check output - refusing to proceed blind (raw: $json)" }
    $items = @($parsed | Where-Object { $null -ne $_ })
    if ($items.Count -gt 0) {
        Write-InstallLog "Refusing to upgrade: $($items.Count) installation(s) are still bound to a non-tunnel local-runtime cluster:"
        foreach ($it in $items) { Write-Host "  - $($it.name) ($($it._id))" }
        Stop-Install 'uninstall the app(s) listed above while local-runtime-driver is still present (this install has not yet removed it), then re-run install.ps1.'
    }
    Write-InstallLog 'No installations bound to a non-tunnel local-runtime cluster - safe to remove local-runtime-driver.'
}

# repository:tag@sha256:digest of the netguard image in the VERIFIED versions.json, or $null when
# the bundle carries no usable reference (unpublished placeholders).
# install.sh check_image_platforms parity: an arm64 Docker engine (Windows on ARM) needs every
# image in the verified versions.json to publish linux/arm64; there is no emulated fallback.
function Test-ImagePlatforms {
    param([string]$Dir)
    $arch = [string]$script:PxState.Docker.Architecture
    if ($arch -notin @('aarch64', 'arm64')) { return }
    $versions = Get-Content -LiteralPath (Join-Path $Dir 'versions.json') -Raw | ConvertFrom-Json
    $missing = @()
    foreach ($img in $versions.images.PSObject.Properties) {
        $p = $img.Value.PSObject.Properties['platforms']
        if ($null -eq $p -or @($p.Value) -notcontains 'linux/arm64') { $missing += $img.Name }
    }
    if ($missing.Count -gt 0) {
        Stop-Install "this Docker engine is arm64 (Windows on ARM) but the selected release does not publish linux/arm64 images for: $($missing -join ' ') - there is no emulated fallback. Install a newer release, or use an x64 machine."
    }
    Write-InstallLog 'Docker engine is arm64 - every image in this release publishes linux/arm64.'
}

function Get-NetguardImageRef {
    param([string]$Dir)
    $versions = Get-Content -LiteralPath (Join-Path $Dir 'versions.json') -Raw | ConvertFrom-Json
    $images = $versions.PSObject.Properties['images']
    if ($null -eq $images -or $null -eq $images.Value) { return $null }
    $ng = $images.Value.PSObject.Properties['netguard']
    if ($null -eq $ng -or $null -eq $ng.Value) { return $null }
    $get = { param($name) $p = $ng.Value.PSObject.Properties[$name]; if ($p -and $p.Value) { [string]$p.Value } else { '' } }
    $repo = & $get 'repository'
    $tag = & $get 'tag'
    $digest = & $get 'digest'
    if ($digest -cmatch '^(?:sha256:)?([0-9a-f]{64})$' -and $repo -and $tag -and $tag -ne 'PLACEHOLDER_STACK_VERSION') {
        return "${repo}:${tag}@sha256:$($Matches[1])"
    }
    return $null
}

# The group that owns /var/run/docker.sock inside the Docker Desktop VM is not known in advance, and
# the app-cluster container needs it (group_add) to talk to the daemon. Ask the daemon side with a
# throwaway container that mounts the socket; an already-set value (invocation env or persisted .env)
# wins. A failed probe falls back to 0 with a warning.
function Resolve-DockerSocketGid {
    param([string]$Dir)
    if ((Get-EnvValue 'PRIVOS_WITH_APP_CLUSTER') -ne 'true') { return }
    if (Test-EnvSet 'PRIVOS_DOCKER_SOCKET_GID') { return }
    $ref = Get-NetguardImageRef -Dir $Dir
    if (-not $ref) { $ref = $script:PxConst.SocketProbeFallbackImage }
    $r = Invoke-Native -File 'docker' -ArgList @('run', '--rm', '--network', 'none', '--entrypoint', 'stat', '-v', '/var/run/docker.sock:/s', $ref, '-c', '%g', '/s') -StdoutOnly
    $gid = $r.Text.Trim()
    if ($r.Code -eq 0 -and $gid -cmatch '^[0-9]+$') {
        $script:PxEnv['PRIVOS_DOCKER_SOCKET_GID'] = $gid
        Write-InstallLog "Docker socket group inside the Docker Desktop VM: $gid"
        return
    }
    Write-InstallLog "WARNING: could not read the docker socket group from the Docker Desktop VM (probe exit $($r.Code)); using 0. If the app-cluster container reports 'EACCES /var/run/docker.sock', set PRIVOS_DOCKER_SOCKET_GID in $Dir\.env to the socket's group and re-run."
    $script:PxEnv['PRIVOS_DOCKER_SOCKET_GID'] = '0'
}

function Start-Stack {
    $logs = 'docker ' + ((@($script:PxState.ComposeBase) + @('logs')) -join ' ')
    $r = Invoke-Compose -ComposeArgs @('pull') -Stream
    if ($r.Code -ne 0) { Stop-Install "docker compose pull failed (exit $($r.Code)) - check your connection to ghcr.io and Docker Desktop's proxy settings." }
    # The egress settings privos-netguard applies are validated before anything
    # starts, so a typo aborts the install as install_docker_user_rules does on
    # Linux (the image is local after the pull above).
    $ng = Get-NetguardImageRef -Dir $script:PxState.Dir
    if ($ng) {
        $ports = '{0},{1},{2},{3}' -f (Get-EnvValue 'PRIVOS_BOARD_PORT'), (Get-EnvValue 'PRIVOS_PROXY_PORT'), (Get-EnvValue 'PRIVOS_RUSTFS_PORT'), (Get-EnvValue 'PRIVOS_VM_PORT_RANGE')
        $mode = Get-EnvValue 'VM_EGRESS_MODE'; if (-not $mode) { $mode = 'open' }
        $check = Invoke-Native -File 'docker' -ArgList @('run', '--rm', '--network', 'none', '-e', "VM_EGRESS_MODE=$mode", $ng, '--check', $ports, (Get-EnvValue 'PRIVOS_EGRESS_ALLOWLIST'))
        if ($check.Code -ne 0) { Stop-Install "invalid egress settings in $($script:PxState.Dir)\.env: $(($check.Lines | Select-Object -Last 3) -join ' ')" }
    }
    $r = Invoke-Compose -ComposeArgs @('up', '-d', 'mongo', 'redis', 'rustfs') -Stream
    if ($r.Code -ne 0) { Stop-Install "docker compose up (data services) failed (exit $($r.Code)) - inspect with: $logs" }
    if (-not (Wait-ComposeHealthy 'mongo' 120)) { Stop-Install "mongo did not become healthy - inspect with: $logs mongo" }
    Initialize-ReplicaSet
    Test-LocalRuntimeInstallations
    if (-not (Wait-ComposeHealthy 'rustfs' 60)) { Stop-Install "rustfs did not become healthy - inspect with: $logs rustfs" }
    # rustfs-init runs once here: `compose up -d` starts it via its dependents'
    # service_completed_successfully conditions after rustfs is healthy.
    $r = Invoke-Compose -ComposeArgs @('up', '-d') -Stream
    if ($r.Code -ne 0) { Stop-Install "docker compose up failed (exit $($r.Code)) - inspect with: $logs" }
}

function Test-HttpOk {
    param([string]$Uri)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
    }
    catch { return $false }
}

function Wait-StackReady {
    $timeout = $script:PxConst.StackReadyTimeoutSec
    $hubPort = Get-EnvValue 'PRIVOS_HUB_PORT'
    $proxyPort = Get-EnvValue 'PRIVOS_PROXY_PORT'
    $deadline = [DateTime]::UtcNow.AddSeconds($timeout)
    $hubOk = $false
    $proxyOk = $false
    # The hub (Meteor) can take a few minutes to boot; print live dots so the wait never looks like a hang.
    Write-Host -NoNewline "  Hub is booting (Meteor - up to ${timeout}s); this is normal"
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not $hubOk -and (Test-HttpOk "http://127.0.0.1:$hubPort/api/info")) { $hubOk = $true; Write-Host -NoNewline ' [hub up]' }
        if (-not $proxyOk -and (Test-HttpOk "http://127.0.0.1:$proxyPort/health")) { $proxyOk = $true; Write-Host -NoNewline ' [proxy up]' }
        if ($hubOk -and $proxyOk) { Write-Host ' ready.'; return $true }
        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 5
    }
    Write-Host ''
    if (-not $hubOk) { Write-InstallLog "hub did not become healthy within ${timeout}s" }
    if (-not $proxyOk) { Write-InstallLog "sandbox-proxy did not become healthy within ${timeout}s" }
    return $false
}

# ---------------------------------------------------------------------------
# Activation and summary
# ---------------------------------------------------------------------------

function Get-RequestCode {
    $r = Invoke-Compose -ComposeArgs @('exec', '-T', 'hub', 'cat', '/var/lib/privos/self-hosted/license-request-code') -StdoutOnly
    if ($r.Code -ne 0) { return '' }
    return ($r.Text -replace '[\r\n]', '')
}

function Get-LicenseStatus {
    $r = Invoke-Compose -ComposeArgs @('exec', '-T', 'hub', 'cat', '/var/lib/privos/self-hosted/license-status') -StdoutOnly
    if ($r.Code -ne 0) { return '' }
    return ($r.Text -replace '[\r\n]', '')
}

function Show-Ready {
    $root = Get-EnvValue 'PRIVOS_ROOT_URL'
    Write-Host ''
    Write-Host 'PrivOS is ready.'
    Write-Host "  Hub:            $root"
    Write-Host "  Install dir:    $($script:PxState.Dir)  (.env is readable only by your Windows account - contains secrets, never printed here)"
    Write-Host ''
    Write-Host "  Reach it locally at $root. To serve it on a public domain,"
    Write-Host '  put your own reverse proxy in front (nginx, Apache, or a Cloudflare'
    Write-Host "  tunnel) - the hub binds $root only."
    Write-Host ''
    $pubPort = Get-EnvValue 'PRIVOS_PUBLISHER_PORT'
    if (-not $pubPort) { $pubPort = [string]$script:PxConst.DefaultPublisherPort }
    $pubBind = Get-EnvValue 'PRIVOS_PUBLISHER_BIND'
    if (-not $pubBind) { $pubBind = '127.0.0.1' }
    $pubUrl = Get-EnvValue 'PRIVOS_PUBLISHER_URL'
    if ($pubUrl) {
        Write-Host "  Publisher:      $pubUrl  (published-files renderer)"
        Write-Host "                  Point your reverse proxy/tunnel for that host at ${pubBind}:${pubPort}."
    }
    else {
        Write-Host "  Publisher:      http://${pubBind}:${pubPort}  (published-files renderer - LOCAL only)"
        Write-Host '                  Published files stay unreachable until you expose it. To turn it on:'
        Write-Host '                    1. Pick a SEPARATE hostname (e.g. publish.example.com) - never the'
        Write-Host '                       hub host: the publisher renders uploaded HTML in a sandboxed origin,'
        Write-Host '                       and sharing the hub origin would break that isolation (install refuses it).'
        Write-Host "                    2. Front ${pubBind}:${pubPort} with your reverse proxy (nginx/Caddy) or a"
        Write-Host '                       Cloudflare tunnel + TLS - same as you did for the hub.'
        Write-Host "                    3. Set PRIVOS_PUBLISHER_URL=https://publish.example.com in $($script:PxState.Dir)\.env"
        Write-Host '                       and re-run install.ps1 (or docker compose up -d) so the hub shows the link.'
        Write-Host '                  Full example (nginx + Cloudflare tunnel): docs/self-hosted-install.md'
    }
}

# Non-interactive summary (-Yes, or no console): readiness plus the request code and
# activate URL so the operator can finish activation later, out of band.
function Show-Summary {
    $code = Get-RequestCode
    $status = Get-LicenseStatus
    Show-Ready
    Write-Host ''
    if ($status -match '"status"\s*:\s*"issued"') {
        Write-Host '  Activation:     done (this install is already registered - nothing to do)'
    }
    elseif ($code) {
        Write-Host '  Activation is REQUIRED before PrivOS is usable - nothing else works until'
        Write-Host '  you finish it. This is a free registration of this install, not a paid'
        Write-Host '  licence: no card, no cost, just an email to register the deployment.'
        Write-Host "  Request code:   $code"
        Write-Host "  Activate at:    https://client.privos.io/self-hosted/activate#code=$code"
    }
    else {
        Write-Host '  Activation request code not yet available - check again shortly with:'
        Write-Host ('    docker ' + (@($script:PxState.ComposeBase) -join ' ') + ' exec hub cat /var/lib/privos/self-hosted/license-request-code')
    }
}

# Offers to copy the code to the clipboard (single keypress).
function Invoke-ClipboardOffer {
    param([string]$Text)
    if (-not (Get-Command Set-Clipboard -ErrorAction SilentlyContinue)) {
        Write-Host '  (No clipboard cmdlet detected - copy the code above manually.)'
        return
    }
    Write-Host -NoNewline '  Press [c] to copy the code, or any other key to continue... '
    $key = ''
    try { $key = [Console]::ReadKey($true).KeyChar } catch { $key = '' }
    Write-Host ''
    if ($key -eq 'c' -or $key -eq 'C') {
        try { Set-Clipboard -Value $Text; Write-Host '  Copied to clipboard.' }
        catch { Write-Host '  Could not access the clipboard - copy the code manually.' }
    }
}

# Sleeps up to $Seconds, returning $true early when the operator pressed Ctrl-C (read as a
# key because TreatControlCAsInput is on, so the script is not killed mid-install).
function Wait-OrSkip {
    param([int]$Seconds)
    for ($i = 0; $i -lt $Seconds; $i++) {
        Start-Sleep -Seconds 1
        try {
            if ([Console]::KeyAvailable) {
                $k = [Console]::ReadKey($true)
                if ($k.Key -eq [ConsoleKey]::C -and ($k.Modifiers -band [ConsoleModifiers]::Control)) { return $true }
            }
        }
        catch { Write-Verbose 'no console for skip detection' }
    }
    return $false
}

# Interactive activation: wait for the request code, let the operator copy it and activate
# online, poll the hub's activation status until issued (30 min max, Ctrl-C skips), show who
# it activated as, and only then print readiness.
function Invoke-InteractiveActivation {
    $code = ''
    $waited = 0
    Write-Host -NoNewline 'Waiting for the license request code'
    while ($waited -lt 120) {
        $code = Get-RequestCode
        if ($code) { break }
        Start-Sleep -Seconds 3
        $waited += 3
        Write-Host -NoNewline '.'
    }
    Write-Host ''
    if (-not $code) {
        Write-Host '  Activation request code not ready yet - falling back to the non-interactive summary.'
        Show-Summary
        return
    }
    Write-Host ''
    Write-Host '  +-- Activation request code -------------------------------'
    Write-Host "  |   $code"
    Write-Host '  +----------------------------------------------------------'
    Write-Host ''
    Write-Host '  Activation is REQUIRED before PrivOS is usable - this is a free'
    Write-Host '  registration of this install, not a paid licence: no card, no cost.'
    Write-Host '  Activate this deployment:'
    Write-Host "    1. Open   https://client.privos.io/self-hosted/activate#code=$code"
    Write-Host '    2. Sign in (or create a free PrivOS account).'
    Write-Host '    3. Complete activation. The hub unlocks by itself within a minute.'
    Write-Host '       Its AI models step then shows the Roxane provider (starts with'
    Write-Host '       $0 credit, top up at client.privos.io) and lets you add your own.'
    Write-Host ''
    Invoke-ClipboardOffer -Text $code

    Write-Host ''
    Write-Host '  Waiting for activation to complete (up to 30 min). Press Ctrl-C to skip and finish later.'
    $deadline = [DateTime]::UtcNow.AddSeconds(1800)
    $kind = ''
    $statusJson = ''
    $oldCtrl = $null
    try { $oldCtrl = [Console]::TreatControlCAsInput; [Console]::TreatControlCAsInput = $true } catch { $oldCtrl = $null }
    try {
        while ([DateTime]::UtcNow -lt $deadline) {
            $statusJson = Get-LicenseStatus
            $kind = ''
            try { $parsed = ConvertFrom-Json $statusJson; $p = $parsed.PSObject.Properties['status']; if ($p) { $kind = [string]$p.Value } } catch { $kind = '' }
            if ($kind -eq 'issued') { break }
            if (Wait-OrSkip 10) { break }
            Write-Host -NoNewline '.'
        }
    }
    finally {
        if ($null -ne $oldCtrl) { try { [Console]::TreatControlCAsInput = $oldCtrl } catch { Write-Verbose 'console state not restored' } }
    }
    Write-Host ''
    if ($kind -eq 'issued') {
        $email = ''
        $ws = ''
        try {
            $parsed = ConvertFrom-Json $statusJson
            $pe = $parsed.PSObject.Properties['ownerEmail']; if ($pe) { $email = [string]$pe.Value }
            $pw = $parsed.PSObject.Properties['workspaceName']; if ($pw) { $ws = [string]$pw.Value }
        }
        catch { Write-Verbose 'status JSON not parseable' }
        $who = ''
        if ($email) { $who += " - $email" }
        if ($ws) { $who += " (workspace: $ws)" }
        Write-Host "  [OK] Activated$who"
    }
    else {
        Write-Host '  Activation not completed yet - the hub keeps polling in the background.'
        Write-Host "  Finish anytime at https://client.privos.io/self-hosted/activate#code=$code"
    }
    Show-Ready
}

# Docker Desktop must start at sign-in for the stack to come back after a reboot (the
# containers restart on their own once the engine is up). Never fatal.
function Show-AutostartNote {
    try {
        $settings = Get-DockerDesktopSettings
        $auto = Get-DockerDesktopSetting -Settings $settings -Name 'autoStart'
        if ($null -ne $auto -and [bool]$auto) { return }
        Write-Host ''
        Write-Host '  Restart after reboot: the PrivOS containers restart by themselves, but only once Docker'
        Write-Host '  Desktop is running. Turn on Docker Desktop > Settings > General >'
        Write-Host '  "Start Docker Desktop when you sign in to your computer" so the stack returns after a reboot.'
    }
    catch { Write-Verbose 'autostart check skipped' }
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

function Remove-Install {
    $s = $script:PxState
    if (-not (Test-Path -LiteralPath (Join-Path $s.Dir 'compose.yml'))) { Stop-Install "no install found at $($s.Dir)" }
    [void](Find-DockerExe)
    Import-ExistingEnv
    Set-EnvDefault 'PRIVOS_PROJECT' $script:PxConst.ProjectName
    Set-EnvDefault 'PRIVOS_NETWORK' $script:PxConst.NetworkName
    Set-EnvDefault 'PRIVOS_AGENT_NETWORK' $script:PxConst.AgentNetworkName
    Set-ComposePaths
    # A stopped Docker Desktop would make every docker call below fail quietly and
    # then delete the install dir, leaving containers and volumes nobody can find.
    if (-not (Test-DockerDaemonUp)) { Stop-Install 'Docker Desktop is not running - start it, then re-run -Uninstall.' }
    $down = @('down', '--remove-orphans')
    if ($s.Purge) { $down += '--volumes' }
    $r = Invoke-Compose -ComposeArgs $down -Stream
    if ($r.Code -ne 0) { Write-InstallLog "WARNING: docker compose down exited $($r.Code); continuing." }
    if ($s.Purge) {
        # Started outside compose: agent VM containers (sandbox-proxy) and the marketplace
        # apps the App Cluster runs (containers and volumes labelled mcp-app=true, plus
        # their network). Images stay: they are a cache, not data.
        $agents = (Invoke-Native -File 'docker' -ArgList @('ps', '-aq', '--filter', "network=$(Get-EnvValue 'PRIVOS_AGENT_NETWORK')") -StdoutOnly).Lines
        $apps = (Invoke-Native -File 'docker' -ArgList @('ps', '-aq', '--filter', 'label=mcp-app=true') -StdoutOnly).Lines
        foreach ($c in @(@($agents) + @($apps) | Where-Object { $_ } | Select-Object -Unique)) { [void](Invoke-Native -File 'docker' -ArgList @('rm', '-f', $c)) }
        $appVols = (Invoke-Native -File 'docker' -ArgList @('volume', 'ls', '-q', '--filter', 'label=mcp-app=true') -StdoutOnly).Lines
        foreach ($v in @($appVols | Where-Object { $_ })) { [void](Invoke-Native -File 'docker' -ArgList @('volume', 'rm', '-f', $v)) }
        [void](Invoke-Native -File 'docker' -ArgList @('network', 'rm', $script:PxConst.AppClusterAppsNetwork))
        # privos-netguard leaves its DOCKER-USER rules in place when it stops
        # (agents may outlive the stack); remove them inside the Desktop VM now.
        $ng = Get-NetguardImageRef -Dir $s.Dir
        if ($ng) {
            $clear = Invoke-Native -File 'docker' -ArgList @('run', '--rm', '--network', 'host', '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW', $ng, '--clear')
            if ($clear.Code -ne 0) { Write-InstallLog 'WARNING: could not remove the privos-netguard firewall rules; restarting Docker Desktop clears them.' }
        }
        $project = Get-EnvValue 'PRIVOS_PROJECT'
        $vols = (Invoke-Native -File 'docker' -ArgList @('volume', 'ls', '-q', '--filter', "label=com.docker.compose.project=$project") -StdoutOnly).Lines
        foreach ($v in @($vols | Where-Object { $_ })) { [void](Invoke-Native -File 'docker' -ArgList @('volume', 'rm', '-f', $v)) }
        [void](Invoke-Native -File 'docker' -ArgList @('network', 'rm', (Get-EnvValue 'PRIVOS_NETWORK')))
        [void](Invoke-Native -File 'docker' -ArgList @('network', 'rm', (Get-EnvValue 'PRIVOS_AGENT_NETWORK')))
        Remove-Item -LiteralPath $s.Dir -Recurse -Force
        Write-InstallLog 'Uninstalled and purged all data.'
    }
    else {
        Write-InstallLog "Stopped. Data preserved in Docker volumes and $($s.Dir). Re-run install.ps1 to restart, or add -Purge to delete data."
    }
}

# ---------------------------------------------------------------------------
# Failure diagnostics (install.sh write_diagnostics_bundle) - EXCLUDES .env and secrets.
# ---------------------------------------------------------------------------

function Write-DiagnosticsBundle {
    param([int]$Rc)
    try {
        $ts = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('privos-diag-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        $s = $script:PxState
        $sys = @("stage=$($s.Stage) exit=$Rc time=$ts", "powershell=$($PSVersionTable.PSVersion)", "os=$([Environment]::OSVersion.VersionString)", "arch=$(Get-EnvVar 'PROCESSOR_ARCHITECTURE')")
        if ($s.Dir) { $sys += "dir=$($s.Dir)" }
        Set-Content -LiteralPath (Join-Path $tmp 'system.txt') -Value $sys
        if (Get-Command docker -ErrorAction SilentlyContinue) {
            Set-Content -LiteralPath (Join-Path $tmp 'docker-version.txt') -Value (Invoke-Native -File 'docker' -ArgList @('version')).Lines
            Set-Content -LiteralPath (Join-Path $tmp 'docker-compose-version.txt') -Value (Invoke-Native -File 'docker' -ArgList @('compose', 'version')).Lines
            Set-Content -LiteralPath (Join-Path $tmp 'docker-info.txt') -Value (Invoke-Native -File 'docker' -ArgList @('info', '--format', '{{.OSType}} | {{.OperatingSystem}} | mem={{.MemTotal}} | cpus={{.NCPU}} | server={{.ServerVersion}}')).Lines
            Set-Content -LiteralPath (Join-Path $tmp 'docker-ps.txt') -Value (Invoke-Native -File 'docker' -ArgList @('ps', '-a')).Lines
            $project = Get-EnvValue 'PRIVOS_PROJECT'
            if (-not $project) { $project = $script:PxConst.ProjectName }
            $names = (Invoke-Native -File 'docker' -ArgList @('ps', '-a', '--format', '{{.Names}}') -StdoutOnly).Lines
            foreach ($n in @($names | Where-Object { $_ -match ('^' + [regex]::Escape($project) + '-') })) {
                $state = Invoke-Native -File 'docker' -ArgList @('inspect', '-f', 'status={{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}', $n)
                Set-Content -LiteralPath (Join-Path $tmp "state-$n.txt") -Value $state.Lines
                $log = Invoke-Native -File 'docker' -ArgList @('logs', '--tail', '80', $n)
                Set-Content -LiteralPath (Join-Path $tmp "log-$n.txt") -Value $log.Lines
            }
        }
        $out = Join-Path ([IO.Path]::GetTempPath()) "privos-install-diagnostics-$ts.zip"
        Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $out -Force
        Write-Host "[privos-install] Diagnostics written to $out (no .env/secrets) - attach it when asking for help."
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    catch { Write-Verbose "diagnostics bundle skipped: $($_.Exception.Message)" }
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

function Invoke-Install {
    $s = $script:PxState
    $c = $script:PxConst

    Set-Stage 'preflight'
    Invoke-Preflight
    $s.HadExistingEnv = Test-Path -LiteralPath (Join-Path $s.Dir '.env')
    if ($s.Mode -eq 'upgrade') { Test-UpgradeAcrossRename }
    Import-ExistingEnv
    Resolve-Config
    Read-SidecarChoices
    Complete-SidecarConfig

    Set-Stage 'publisher url check'
    # The publisher renders arbitrary uploaded HTML in a sandboxed origin; hosting it on the hub's
    # own host would defeat that isolation (cookies are not port-scoped), so it is refused.
    $pubUrl = Get-EnvValue 'PRIVOS_PUBLISHER_URL'
    if ($pubUrl) {
        $pubHost = Get-UrlHostname $pubUrl
        $rootHost = Get-UrlHostname (Get-EnvValue 'PRIVOS_ROOT_URL')
        if (-not $pubHost) { Stop-Install "PRIVOS_PUBLISHER_URL is not a valid URL: $pubUrl" }
        if ($pubHost.ToLowerInvariant() -eq $rootHost.ToLowerInvariant()) {
            Stop-Install "PRIVOS_PUBLISHER_URL host ($pubHost) must differ from the hub host ($rootHost) - the publisher renders untrusted HTML in a sandboxed origin; front it on a separate hostname."
        }
    }

    Set-Stage 'port conflict check'
    $pubPort = Get-EnvValue 'PRIVOS_PUBLISHER_PORT'
    if (-not $pubPort) { $pubPort = [string]$c.DefaultPublisherPort }
    $requested = @([int](Get-EnvValue 'PRIVOS_HUB_PORT'), [int](Get-EnvValue 'PRIVOS_BOARD_PORT'), [int](Get-EnvValue 'PRIVOS_PROXY_PORT'), [int](Get-EnvValue 'PRIVOS_RUSTFS_PORT'), [int]$pubPort)
    $requested += Expand-PortRange (Get-EnvValue 'PRIVOS_VM_PORT_RANGE')
    if (-not (Test-Ports $requested)) { throw (New-Object System.InvalidOperationException('port conflict')) }

    Set-Stage 'license acceptance'
    Confirm-LicenseAcceptance

    Set-Stage 'creating directories'
    New-Item -ItemType Directory -Force -Path (Join-Path $s.Dir 'secrets') | Out-Null
    Protect-PrivatePath (Join-Path $s.Dir 'secrets')
    Write-LicenseMarker
    Install-Minisign

    Set-Stage 'fetching and verifying the bundle'
    Get-Bundle -DestDir $s.Dir
    Test-BundleIntegrity -Dir $s.Dir
    Test-ImagePlatforms -Dir $s.Dir
    Update-StackVersionFromBundle -Dir $s.Dir
    Resolve-DockerSocketGid -Dir $s.Dir

    Set-Stage 'generating secrets'
    New-Secrets
    [void](Write-MongoKeyfile)
    Write-EnvFile -Path (Join-Path $s.Dir '.env')
    Set-ComposePaths

    Set-Stage 'network setup'
    Initialize-Networks

    Set-Stage 'bringing up the stack (docker compose)'
    Test-StaleStack
    Show-FirewallNotice
    Show-AutostartNote
    Start-Stack

    Set-Stage 'waiting for hub + sandbox-proxy to become healthy'
    if (-not (Wait-StackReady)) {
        Stop-Install ('stack did not become healthy in time - inspect with: docker ' + (@($s.ComposeBase) -join ' ') + ' logs')
    }

    # Interactive activation only when not -Yes and a console is attached; otherwise print the
    # non-interactive summary.
    if (-not $s.AssumeYes -and (Test-ConsoleAvailable)) {
        Set-Stage 'license activation'
        Invoke-InteractiveActivation
    }
    else {
        Show-Summary
    }
}

# Returns the process exit code (0 ok, 1 failed). Never calls `exit`: under `irm | iex`
# that would close the user's PowerShell window.
function Invoke-Main {
    param([hashtable]$Flags = @{})
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $ProgressPreference = 'SilentlyContinue'
    try {
        if ($PSVersionTable.PSVersion.Major -lt 5) { Stop-Install 'PowerShell 5.1 or newer is required.' }
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { Write-Verbose 'TLS 1.2 not forced' }
        Initialize-State $Flags
        if ($script:PxState.Help) { Show-Usage; return 0 }
        Set-Stage 'resolving -Dir'
        $dirIn = $script:PxState.DirFlag
        if (-not $dirIn) { $dirIn = Get-EnvVar 'PRIVOS_DIR' }
        if (-not $dirIn) { $dirIn = Get-DefaultPrivosDir }
        $script:PxState.Dir = Get-ValidatedPrivosDir $dirIn
        # Compose interpolates ${PRIVOS_DIR}: forward slashes keep the bind sources clean on Windows.
        $script:PxEnv['PRIVOS_DIR'] = $script:PxState.Dir.Replace('\', '/')

        if ($script:PxState.Mode -eq 'uninstall') {
            Set-Stage 'uninstall'
            Remove-Install
            return 0
        }
        Write-InstallLog 'NOTE: install.ps1 is not Authenticode signed; the bundle it downloads is minisign-verified.'
        Invoke-Install
        return 0
    }
    catch {
        $ex = $_.Exception
        Write-Host ''
        Write-Host "[privos-install] ERROR: $($ex.Message)"
        if ($ex -isnot [System.InvalidOperationException]) { Write-Host $_.ScriptStackTrace }
        Write-Host "[privos-install] Install did not complete (stage: $($script:PxState.Stage), exit 1)."
        Write-Host '[privos-install] Nothing here rolls back destructively - re-running install.ps1 is safe and reuses what was already written (secrets, .env), retrying only what failed.'
        Write-DiagnosticsBundle 1
        return 1
    }
    finally {
        # Do not leave generated secrets in the caller's session (irm | iex runs in it).
        $script:PxEnv = [ordered]@{}
    }
}

# Tests dot-source this file with PRIVOS_INSTALL_PS1_NO_MAIN=1 to exercise single
# functions; every real run (file, irm | iex) executes main.
if ($env:PRIVOS_INSTALL_PS1_NO_MAIN -ne '1') {
    $privosScriptDir = ''
    if (Test-Path variable:PSScriptRoot) { $privosScriptDir = [string]$PSScriptRoot }
    $privosRc = Invoke-Main -Flags @{
        Version             = $Version
        Dir                 = $Dir
        Url                 = $Url
        HubPort             = $HubPort
        VmPortRange         = $VmPortRange
        EgressAllowlist     = $EgressAllowlist
        Yes                 = [bool]$Yes
        AcceptLicense       = [bool]$AcceptLicense
        Upgrade             = [bool]$Upgrade
        Uninstall           = [bool]$Uninstall
        Purge               = [bool]$Purge
        WithKnowledgeVector = [bool]$WithKnowledgeVector
        WithoutAppCluster   = [bool]$WithoutAppCluster
        AllowDevSigningKey  = [bool]$AllowDevSigningKey
        Help                = [bool]$Help
        ScriptDir           = $privosScriptDir
    }
    $privosCmdPath = ''
    if (Test-Path variable:PSCommandPath) { $privosCmdPath = [string]$PSCommandPath }
    $privosRc = @($privosRc)[-1]
    if ($privosCmdPath -and $privosRc -ne 0) { exit $privosRc }
}
