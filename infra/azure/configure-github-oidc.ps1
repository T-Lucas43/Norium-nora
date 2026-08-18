[CmdletBinding()]
param(
    [string]$ResourceGroup = "rg-norium-dev",
    [string]$Repository = "T-Lucas43/Norium-nora",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$portableGitHubCli = Join-Path $repositoryRoot "tmp\github-cli\bin\gh.exe"
$gh = if (Get-Command gh -ErrorAction SilentlyContinue) { "gh" } elseif (Test-Path -LiteralPath $portableGitHubCli) { $portableGitHubCli } else { throw "GitHub CLI nao encontrada." }

$account = az account show --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $account) { throw "Azure CLI nao autenticada." }
$deployment = az deployment group show --resource-group $ResourceGroup --name norium-dev --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $deployment) { throw "Deployment norium-dev nao encontrado." }

$displayName = "github-norium-nora-azure-dev"
$clientId = (az ad app list --display-name $displayName --query "[0].appId" --output tsv | Out-String).Trim()
if (-not $clientId) {
    $clientId = (az ad app create --display-name $displayName --query appId --output tsv | Out-String).Trim()
}

$servicePrincipalId = (az ad sp show --id $clientId --query id --output tsv 2>$null | Out-String).Trim()
if (-not $servicePrincipalId) {
    $servicePrincipalId = (az ad sp create --id $clientId --query id --output tsv | Out-String).Trim()
}

$scope = "/subscriptions/$($account.id)/resourceGroups/$ResourceGroup"
$assignmentExists = (az role assignment list --assignee-object-id $servicePrincipalId --scope $scope --role Contributor --query "length(@)" --output tsv | Out-String).Trim()
if ($assignmentExists -eq "0") {
    az role assignment create --assignee-object-id $servicePrincipalId --assignee-principal-type ServicePrincipal --role Contributor --scope $scope --output none
    if ($LASTEXITCODE -ne 0) { throw "Nao foi possivel atribuir a funcao Contributor no grupo de desenvolvimento." }
}

$credentialName = "github-main"
$credentialExists = (az ad app federated-credential list --id $clientId --query "[?name=='$credentialName'] | length(@)" --output tsv | Out-String).Trim()
if ($credentialExists -eq "0") {
    $credentialPath = Join-Path ([System.IO.Path]::GetTempPath()) ("norium-federated-" + [guid]::NewGuid().ToString("N") + ".json")
    try {
        @{
            name = $credentialName
            issuer = "https://token.actions.githubusercontent.com"
            subject = "repo:${Repository}:ref:refs/heads/${Branch}"
            description = "GitHub Actions deploy do Norium para Azure Container Apps"
            audiences = @("api://AzureADTokenExchange")
        } | ConvertTo-Json | Set-Content -LiteralPath $credentialPath -Encoding utf8
        az ad app federated-credential create --id $clientId --parameters $credentialPath --output none
        if ($LASTEXITCODE -ne 0) { throw "Nao foi possivel criar a credencial federada." }
    }
    finally {
        if (Test-Path -LiteralPath $credentialPath) { Remove-Item -LiteralPath $credentialPath -Force }
    }
}

$containerAppName = [string]$deployment.properties.outputs.containerAppName.value
$publicUrl = [string]$deployment.properties.outputs.publicUrl.value
& $gh variable set AZURE_CLIENT_ID --repo $Repository --body $clientId
& $gh variable set AZURE_TENANT_ID --repo $Repository --body ([string]$account.tenantId)
& $gh variable set AZURE_SUBSCRIPTION_ID --repo $Repository --body ([string]$account.id)
& $gh variable set AZURE_RESOURCE_GROUP --repo $Repository --body $ResourceGroup
& $gh variable set AZURE_CONTAINER_APP_NAME --repo $Repository --body $containerAppName
& $gh variable set AZURE_PUBLIC_URL --repo $Repository --body $publicUrl
if ($LASTEXITCODE -ne 0) { throw "Nao foi possivel configurar as variaveis no GitHub." }

Write-Host "GitHub Actions configurado com OpenID Connect para $publicUrl"
