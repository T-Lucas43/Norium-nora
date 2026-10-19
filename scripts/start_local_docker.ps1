param([switch]$NoBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot 'output/docker-local'
$envPath = Join-Path $runtimeRoot '.env'
$accessPath = Join-Path $runtimeRoot 'access.local.json'
$composePath = Join-Path $projectRoot 'compose.local.yaml'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

function New-LocalRandom([int]$Bytes) {
    $buffer = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Save-LocalEnvironment($Values) {
    $lines = @($Values.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value })
    [IO.File]::WriteAllLines($envPath, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
}
function Wait-LocalApplication {
    $deadline = (Get-Date).AddMinutes(2)
    do {
        try {
            $ready = Invoke-RestMethod 'http://localhost:8765/health/ready' -TimeoutSec 5
            if ($ready.ready) { return }
        } catch { }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'O Norium local não ficou pronto. Confira docker compose logs app; nenhum volume foi removido.'
}

Push-Location $projectRoot
try {
    $revision = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível identificar a revisão local.' }
    $values = [ordered]@{}
    if (Test-Path -LiteralPath $envPath) {
        foreach ($line in Get-Content -LiteralPath $envPath) {
            if ($line -match '^([A-Z_]+)=(.*)$') { $values[$matches[1]] = $matches[2] }
        }
    } else {
        $values['LOCAL_DATABASE_PASSWORD'] = New-LocalRandom 32
        $values['LOCAL_AUTH_SECRET'] = New-LocalRandom 48
        $values['LOCAL_OAUTH_KEY'] = (New-LocalRandom 32) + '='
        $values['LOCAL_WAPI_KEY'] = (New-LocalRandom 32) + '='
        $values['LOCAL_ADMIN_EMAIL'] = 'admin@norium.local'
        $values['LOCAL_ADMIN_PASSWORD'] = 'Local!' + (New-LocalRandom 15)
    }
    foreach ($required in @('LOCAL_DATABASE_PASSWORD', 'LOCAL_AUTH_SECRET', 'LOCAL_OAUTH_KEY', 'LOCAL_WAPI_KEY')) {
        if (-not $values[$required]) { throw "Configuração local incompleta: $required. Nenhuma credencial existente foi substituída." }
    }
    if (-not (Test-Path -LiteralPath $accessPath) -and $values['LOCAL_ADMIN_PASSWORD']) {
        @{ url = 'http://localhost:8765'; email = $values['LOCAL_ADMIN_EMAIL']; password = $values['LOCAL_ADMIN_PASSWORD']; purpose = 'isolated-local-development' } |
            ConvertTo-Json | Set-Content -LiteralPath $accessPath -Encoding utf8
    }
    $values['LOCAL_RELEASE_SHA'] = $revision
    Save-LocalEnvironment $values
    $composeArgs = @('compose', '--env-file', $envPath, '-f', $composePath)
    if ($NoBuild) { & docker @composeArgs up -d } else { & docker @composeArgs up -d --build }
    if ($LASTEXITCODE -ne 0) { throw 'O Docker não iniciou o projeto local. As credenciais e volumes foram preservados.' }
    Wait-LocalApplication

    if ($values['LOCAL_ADMIN_PASSWORD']) {
        # Verify only the newly bootstrapped local account, without retaining or
        # printing the session token. Remove bootstrap from the running container.
        $body = @{ email = $values['LOCAL_ADMIN_EMAIL']; password = $values['LOCAL_ADMIN_PASSWORD']; persistent = $true } | ConvertTo-Json
        $login = Invoke-RestMethod 'http://localhost:8765/api/auth/login' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
        if (-not $login.user) { throw 'O serviço está pronto, mas o primeiro acesso local não foi confirmado.' }
        $values['LOCAL_ADMIN_PASSWORD'] = ''
        Save-LocalEnvironment $values
        & docker @composeArgs up -d --no-build app
        if ($LASTEXITCODE -ne 0) { throw 'O bootstrap foi removido do arquivo. Confira a recriação do container local.' }
        Wait-LocalApplication
    }
    Write-Output 'Norium local disponível em http://localhost:8765'
    Write-Output "Dados da conta local em: $accessPath"
} finally { Pop-Location }
