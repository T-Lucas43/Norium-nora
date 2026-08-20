[CmdletBinding()]
param(
    [string]$ResourceGroup = "rg-norium-dev",
    [string]$Location = "eastus2",
    [string]$Subscription = "",
    [string]$ContainerImage = "ghcr.io/t-lucas43/norium-nora:latest",
    [string]$RegistryUsername = "T-Lucas43",
    [switch]$UploadLocalData,
    [switch]$SkipValidation
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$backendRoot = Join-Path $repositoryRoot "norium-back-end"
$frontendRoot = Join-Path $repositoryRoot "norium-front-end"
$localEnvPath = Join-Path $backendRoot ".env"
$localDataPath = Join-Path $backendRoot "data"
$authConfigPath = Join-Path $localDataPath "auth_config_db.json"
$portableGitHubCli = Join-Path $repositoryRoot "tmp\github-cli\bin\gh.exe"
$allowedSecretNames = @(
    "NORIUM_BOOTSTRAP_ADMIN_EMAIL", "NORIUM_BOOTSTRAP_ADMIN_USER_ID",
    "NORIUM_BOOTSTRAP_ADMIN_NAME", "NORIUM_BOOTSTRAP_ADMIN_PASSWORD",
    "GROQ_API_KEY", "NORA_MODEL", "NORA_FALLBACK_MODELS", "NORA_INTENT_LLM", "NORA_TTS_PROVIDER",
    "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL_ID",
    "ELEVENLABS_LANGUAGE_CODE", "EDGE_TTS_VOICE", "EDGE_TTS_RATE",
    "EDGE_TTS_PITCH", "EDGE_TTS_VOLUME", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "WHATSAPP_INSTANCE_ID",
    "WHATSAPP_INSTANCE_TOKEN", "WHATSAPP_CLIENT_TOKEN", "WHATSAPP_OWNER_USER_ID",
    "WHATSAPP_WEBHOOK_SECRET", "WHATSAPP_MEDIA_HOSTS", "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_OWNER_EMAIL", "TELEGRAM_OWNER_USER_ID",
    "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_ALLOWED_CHAT_IDS", "SAMIERP_ID_PARCEIRO",
    "SAMIERP_SIGLA", "SAMIERP_SENHA", "SAMIERP_BOLETO_URL"
)

function Invoke-AzureCli {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $result = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI falhou: az $($Arguments -join ' ')"
    }
    return $result
}

function Invoke-GitHubCli {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $executable = if (Get-Command gh -ErrorAction SilentlyContinue) { "gh" } elseif (Test-Path -LiteralPath $portableGitHubCli) { $portableGitHubCli } else { $null }
    if (-not $executable) {
        throw "GitHub CLI nao encontrada."
    }
    $result = & $executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI falhou. Confirme a autenticacao com gh auth status."
    }
    return $result
}

function Read-DotEnv {
    param([string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $values
    }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            continue
        }
        $name = $matches[1]
        $value = $matches[2].Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($value) {
            $values[$name] = $value
        }
    }
    return $values
}

function New-DataStagingDirectory {
    if (-not (Test-Path -LiteralPath $localDataPath)) {
        throw "Diretorio de dados local nao encontrado: $localDataPath"
    }
    $stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("norium-data-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
    Copy-Item -Path (Join-Path $localDataPath "*") -Destination $stagingRoot -Recurse -Force

    $legacyUploads = Join-Path $backendRoot "uploads"
    if (Test-Path -LiteralPath $legacyUploads) {
        $uploadsTarget = Join-Path $stagingRoot "uploads"
        New-Item -ItemType Directory -Force -Path $uploadsTarget | Out-Null
        Copy-Item -Path (Join-Path $legacyUploads "*") -Destination $uploadsTarget -Recurse -Force
    }

    $legacyOauth = Join-Path $backendRoot "oauth_accounts"
    if (Test-Path -LiteralPath $legacyOauth) {
        $oauthTarget = Join-Path $stagingRoot "oauth_accounts"
        New-Item -ItemType Directory -Force -Path $oauthTarget | Out-Null
        Copy-Item -Path (Join-Path $legacyOauth "*") -Destination $oauthTarget -Recurse -Force
    }
    return $stagingRoot
}

function Remove-ValidatedTemporaryDirectory {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
        return
    }
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if (-not $resolvedPath.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Recusa ao remover um diretorio fora da pasta temporaria: $resolvedPath"
    }
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI nao encontrada. Adicione a CLI oficial ao PATH."
}

$account = Invoke-AzureCli account show --output json | ConvertFrom-Json
if (-not $account -or $account.state -ne "Enabled") {
    throw "Nenhuma assinatura Azure ativa foi encontrada. Execute az login."
}
if ($Subscription) {
    Invoke-AzureCli account set --subscription $Subscription --output none | Out-Null
}

$registryPassword = (Invoke-GitHubCli auth token --hostname github.com | Out-String).Trim()
if (-not $registryPassword) {
    throw "O token GitHub necessario para baixar a imagem privada nao foi encontrado."
}

$dotenv = Read-DotEnv -Path $localEnvPath
$secretSettings = @{}
foreach ($name in $allowedSecretNames) {
    if ($dotenv.ContainsKey($name)) {
        $secretSettings[$name] = $dotenv[$name]
    }
}
if (Test-Path -LiteralPath $authConfigPath) {
    $authConfig = Get-Content -LiteralPath $authConfigPath -Raw | ConvertFrom-Json
    if ($authConfig.secret -and ([string]$authConfig.secret).Length -ge 32) {
        $secretSettings["NORIUM_AUTH_SECRET"] = [string]$authConfig.secret
    }
}
if (-not $secretSettings.ContainsKey("NORIUM_AUTH_SECRET")) {
    throw "O segredo persistente nao foi encontrado em data/auth_config_db.json."
}

$parameterPath = Join-Path ([System.IO.Path]::GetTempPath()) ("norium-container-parameters-" + [guid]::NewGuid().ToString("N") + ".json")
$dataStagingPath = ""

try {
    if (-not $SkipValidation) {
        Write-Host "Validando backend, frontend e infraestrutura..."
        Push-Location $backendRoot
        try {
            & .\venv\Scripts\python.exe -m compileall app main.py
            if ($LASTEXITCODE -ne 0) { throw "A compilacao do backend falhou." }
            & .\venv\Scripts\python.exe -m unittest discover -s tests
            if ($LASTEXITCODE -ne 0) { throw "Os testes do backend falharam." }
        }
        finally { Pop-Location }

        Push-Location $frontendRoot
        try {
            & npm.cmd run lint
            if ($LASTEXITCODE -ne 0) { throw "O lint do frontend falhou." }
            & npm.cmd test
            if ($LASTEXITCODE -ne 0) { throw "Os testes do frontend falharam." }
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw "O build do frontend falhou." }
        }
        finally { Pop-Location }

        Invoke-AzureCli bicep build --file (Join-Path $PSScriptRoot "main.bicep") --stdout --output none | Out-Null
    }

    $parameterDocument = @{
        '$schema' = "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#"
        contentVersion = "1.0.0.0"
        parameters = @{
            location = @{ value = $Location }
            containerImage = @{ value = $ContainerImage }
            registryUsername = @{ value = $RegistryUsername }
            registryPassword = @{ value = $registryPassword }
            secretSettings = @{ value = $secretSettings }
        }
    }
    $parameterDocument | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $parameterPath -Encoding utf8

    Write-Host "Registrando os provedores serverless necessarios..."
    Invoke-AzureCli provider register --namespace Microsoft.App --wait --output none | Out-Null
    Invoke-AzureCli provider register --namespace Microsoft.Storage --wait --output none | Out-Null
    Invoke-AzureCli extension add --name containerapp --upgrade --yes --output none | Out-Null

    $resourceGroupExists = (Invoke-AzureCli group exists --name $ResourceGroup --output tsv).Trim() -eq "true"
    if (-not $resourceGroupExists) {
        Invoke-AzureCli group create --name $ResourceGroup --location $Location --output none | Out-Null
    }

    Write-Host "Criando ou atualizando Container Apps e Azure Files..."
    $deploymentJson = Invoke-AzureCli deployment group create `
        --resource-group $ResourceGroup `
        --name "norium-dev" `
        --template-file (Join-Path $PSScriptRoot "main.bicep") `
        --parameters "@$parameterPath" `
        --output json
    $deployment = $deploymentJson | ConvertFrom-Json
    $containerAppName = [string]$deployment.properties.outputs.containerAppName.value
    $publicUrl = [string]$deployment.properties.outputs.publicUrl.value
    $storageAccountName = [string]$deployment.properties.outputs.storageAccountName.value
    $fileShareName = [string]$deployment.properties.outputs.fileShareName.value

    if ($UploadLocalData) {
        Write-Host "Copiando os dados locais para o Azure Files persistente..."
        $dataStagingPath = New-DataStagingDirectory
        $storageKey = (Invoke-AzureCli storage account keys list --resource-group $ResourceGroup --account-name $storageAccountName --query "[0].value" --output tsv | Out-String).Trim()
        $previousStorageAccount = $env:AZURE_STORAGE_ACCOUNT
        $previousStorageKey = $env:AZURE_STORAGE_KEY
        try {
            $env:AZURE_STORAGE_ACCOUNT = $storageAccountName
            $env:AZURE_STORAGE_KEY = $storageKey
            Invoke-AzureCli storage file upload-batch `
                --destination $fileShareName `
                --source $dataStagingPath `
                --output none | Out-Null
        }
        finally {
            $env:AZURE_STORAGE_ACCOUNT = $previousStorageAccount
            $env:AZURE_STORAGE_KEY = $previousStorageKey
        }

        $activeRevision = (Invoke-AzureCli containerapp revision list --resource-group $ResourceGroup --name $containerAppName --query "[?properties.active].name | [0]" --output tsv | Out-String).Trim()
        if ($activeRevision) {
            Invoke-AzureCli containerapp revision restart --resource-group $ResourceGroup --name $containerAppName --revision $activeRevision --output none | Out-Null
        }
    }

    Write-Host "Aguardando a inicializacao serverless..."
    $healthUrl = "$publicUrl/health"
    $healthy = $false
    for ($attempt = 1; $attempt -le 36; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 20
            if ($response.StatusCode -eq 200) {
                $healthy = $true
                break
            }
        }
        catch {
            Start-Sleep -Seconds 10
        }
    }
    if (-not $healthy) {
        throw "O Container App nao respondeu com sucesso em $healthUrl."
    }

    $previousSmokeSecret = $env:NORIUM_SMOKE_AUTH_SECRET
    try {
        $env:NORIUM_SMOKE_AUTH_SECRET = [string]$secretSettings["NORIUM_AUTH_SECRET"]
        & (Join-Path $backendRoot "venv\Scripts\python.exe") (Join-Path $PSScriptRoot "smoke_test.py") $publicUrl
        if ($LASTEXITCODE -ne 0) { throw "A validacao remota do Norium falhou." }
    }
    finally {
        $env:NORIUM_SMOKE_AUTH_SECRET = $previousSmokeSecret
    }

    $outputDirectory = Join-Path $repositoryRoot "output"
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
    @{
        resourceGroup = $ResourceGroup
        containerAppName = $containerAppName
        image = $ContainerImage
        url = $publicUrl
        deployedAt = [DateTime]::UtcNow.ToString("o")
        localDataUploaded = [bool]$UploadLocalData
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDirectory "azure-deployment.json") -Encoding utf8

    Write-Host "Deploy concluido: $publicUrl"
}
finally {
    if (Test-Path -LiteralPath $parameterPath) {
        Remove-Item -LiteralPath $parameterPath -Force
    }
    Remove-ValidatedTemporaryDirectory -Path $dataStagingPath
}
