[CmdletBinding()]
param(
    [string]$ResourceGroup = "rg-norium-dev",
    [string]$Repository = "noriumnoraai-ui/Norium-nora",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$portableGitHubCli = Join-Path $repositoryRoot "tmp\github-cli\bin\gh.exe"
$portableAzureCliPython = Join-Path $repositoryRoot "tmp\azure-cli-portable\Microsoft SDKs\Azure\CLI2\python.exe"
$gh = if (Get-Command gh -ErrorAction SilentlyContinue) { "gh" } elseif (Test-Path -LiteralPath $portableGitHubCli) { $portableGitHubCli } else { throw "GitHub CLI nao encontrada." }

function Invoke-AzureCli {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    $output = if (Test-Path -LiteralPath $portableAzureCliPython) {
        & $portableAzureCliPython -IBm azure.cli @Arguments
    }
    else {
        & az @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI falhou: az $($Arguments -join ' ')"
    }
    return $output
}

function Set-GitHubVariable {
    param([string]$Name, [string]$Value)

    & $gh variable set $Name --repo $Repository --body $Value
    if ($LASTEXITCODE -ne 0) {
        throw "Nao foi possivel configurar a variavel $Name no GitHub."
    }
}

$account = (Invoke-AzureCli account show --output json | Out-String) | ConvertFrom-Json
if (-not $account) { throw "Azure CLI nao autenticada." }
$deployment = (Invoke-AzureCli deployment group show --resource-group $ResourceGroup --name norium-dev --output json | Out-String) | ConvertFrom-Json
if (-not $deployment) { throw "Deployment norium-dev nao encontrado." }
$repositoryMetadata = (& $gh api "repos/$Repository" | Out-String) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $repositoryMetadata) { throw "Repositorio GitHub nao encontrado." }

$displayName = "github-norium-nora-azure-dev"
$applications = @((Invoke-AzureCli ad app list --display-name $displayName --output json | Out-String) | ConvertFrom-Json)
$clientId = [string]$applications[0].appId
if (-not $clientId) {
    $application = (Invoke-AzureCli ad app create --display-name $displayName --output json | Out-String) | ConvertFrom-Json
    $clientId = [string]$application.appId
}

$servicePrincipals = @((Invoke-AzureCli ad sp list --filter "appId eq '$clientId'" --output json | Out-String) | ConvertFrom-Json)
if ($servicePrincipals.Count -eq 0) {
    $servicePrincipal = (Invoke-AzureCli ad sp create --id $clientId --output json | Out-String) | ConvertFrom-Json
}
else {
    $servicePrincipal = $servicePrincipals[0]
}
$servicePrincipalId = [string]$servicePrincipal.id
if (-not $servicePrincipalId) { throw "Service principal do GitHub nao foi criada." }

$scope = "/subscriptions/$($account.id)/resourceGroups/$ResourceGroup"
$assignments = @((Invoke-AzureCli role assignment list --assignee-object-id $servicePrincipalId --scope $scope --role Contributor --output json | Out-String) | ConvertFrom-Json)
if ($assignments.Count -eq 0) {
    Invoke-AzureCli role assignment create --assignee-object-id $servicePrincipalId --assignee-principal-type ServicePrincipal --role Contributor --scope $scope --output none | Out-Null
}

$credentialName = "github-main"
$credentials = @((Invoke-AzureCli ad app federated-credential list --id $clientId --output json | Out-String) | ConvertFrom-Json)
$credential = $credentials | Where-Object { $_.name -eq $credentialName } | Select-Object -First 1
$credentialSubject = "repo:$($repositoryMetadata.owner.login)@$($repositoryMetadata.owner.id)/$($repositoryMetadata.name)@$($repositoryMetadata.id):ref:refs/heads/$Branch"
if (-not $credential -or $credential.subject -ne $credentialSubject) {
    $credentialPath = Join-Path ([System.IO.Path]::GetTempPath()) ("norium-federated-" + [guid]::NewGuid().ToString("N") + ".json")
    try {
        @{
            name = $credentialName
            issuer = "https://token.actions.githubusercontent.com"
            subject = $credentialSubject
            description = "GitHub Actions deploy do Norium para Azure Container Apps"
            audiences = @("api://AzureADTokenExchange")
        } | ConvertTo-Json | Set-Content -LiteralPath $credentialPath -Encoding utf8
        if ($credential) {
            Invoke-AzureCli ad app federated-credential update --id $clientId --federated-credential-id $credential.id --parameters $credentialPath --output none | Out-Null
        }
        else {
            Invoke-AzureCli ad app federated-credential create --id $clientId --parameters $credentialPath --output none | Out-Null
        }
    }
    finally {
        if (Test-Path -LiteralPath $credentialPath) { Remove-Item -LiteralPath $credentialPath -Force }
    }
}

$containerAppName = [string]$deployment.properties.outputs.containerAppName.value
$publicUrl = [string]$deployment.properties.outputs.publicUrl.value
Set-GitHubVariable -Name AZURE_CLIENT_ID -Value $clientId
Set-GitHubVariable -Name AZURE_TENANT_ID -Value ([string]$account.tenantId)
Set-GitHubVariable -Name AZURE_SUBSCRIPTION_ID -Value ([string]$account.id)
Set-GitHubVariable -Name AZURE_RESOURCE_GROUP -Value $ResourceGroup
Set-GitHubVariable -Name AZURE_CONTAINER_APP_NAME -Value $containerAppName
Set-GitHubVariable -Name AZURE_PUBLIC_URL -Value $publicUrl

Write-Host "GitHub Actions configurado com OpenID Connect para $publicUrl"
