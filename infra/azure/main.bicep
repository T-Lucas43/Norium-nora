@description('Regiao do Azure Container Apps e do armazenamento persistente.')
param location string = 'eastus2'

@description('Nome estavel do Container App nesta assinatura e grupo de recursos.')
param appName string = 'norium-${uniqueString(subscription().subscriptionId, resourceGroup().id)}'

@description('Imagem privada criada pelo GitHub Actions e armazenada no GHCR.')
param containerImage string = 'ghcr.io/noriumnoraai-ui/norium-nora:latest'

@description('Usuario que possui o pacote no GitHub Container Registry.')
param registryUsername string = 'noriumnoraai-ui'

@secure()
@description('Token GitHub com permissao read:packages, usado apenas pelo Container Apps para baixar a imagem privada.')
param registryPassword string

@secure()
@description('Configuracoes sensiveis importadas do .env local sem grava-las no repositorio.')
param secretSettings object = {}

@description('Cria o executor duravel da Nora. Permanece falso ate PostgreSQL, segredos e piloto serem aprovados.')
param noraBrainEnabled bool = false

@secure()
@description('URL PostgreSQL do cerebro. Obrigatoria somente quando noraBrainEnabled=true.')
param noraBrainDatabaseUrl string = ''

@secure()
@description('Segredo HMAC compartilhado somente entre web e executor, com pelo menos 32 caracteres.')
param noraBrainInternalSecret string = ''

@secure()
@description('Credencial OpenAI exclusiva do executor. Obrigatoria somente quando noraBrainEnabled=true.')
param noraBrainOpenAiApiKey string = ''

@description('Modelo de rotina aprovado para o piloto da Nora.')
param noraBrainRoutineModel string = 'gpt-5.6-luna'

@description('Modelo documental aprovado para o piloto da Nora.')
param noraBrainDocumentModel string = 'gpt-5.6-sol'

var environmentName = 'cae-${appName}'
var noraExecutorName = '${appName}-nora-executor'
var storageAccountName = 'st${uniqueString(subscription().subscriptionId, resourceGroup().id)}'
var fileShareName = 'norium-data'
var environmentStorageName = 'noriumdata'
var publicUrl = 'https://${appName}.${managedEnvironment.properties.defaultDomain}'
var commonTags = {
  application: 'norium'
  environment: 'production'
  managedBy: 'bicep'
  costProfile: 'free-consumption'
}
var baselineEnvironment = [
  { name: 'ENVIRONMENT', value: 'production' }
  { name: 'PORT', value: '8000' }
  { name: 'NORIUM_DATA_DIR', value: '/app/data' }
  { name: 'NORIUM_AI_COSTS_SQLITE_VFS', value: 'unix-dotfile' }
  { name: 'NORIUM_SPA_DIR', value: '/app/static' }
  { name: 'BACKEND_PUBLIC_URL', value: publicUrl }
  { name: 'FRONTEND_URL', value: publicUrl }
  { name: 'GMAIL_REDIRECT_URI', value: '${publicUrl}/api/auth/callback/gmail' }
  { name: 'GOOGLE_REDIRECT_URI', value: '${publicUrl}/api/integracoes/google/callback' }
  { name: 'PYTHONUNBUFFERED', value: '1' }
]
var applicationSecrets = [for setting in items(secretSettings): {
  name: toLower(replace(setting.key, '_', '-'))
  value: string(setting.value)
}]
var secretEnvironment = [for setting in items(secretSettings): {
  name: setting.key
  secretRef: toLower(replace(setting.key, '_', '-'))
}]
var noraWebSecrets = noraBrainEnabled ? [
  { name: 'nora-brain-database-url', value: noraBrainDatabaseUrl }
  { name: 'nora-brain-internal-secret', value: noraBrainInternalSecret }
] : []
var noraWebEnvironment = noraBrainEnabled ? [
  { name: 'NORA_BRAIN_ENABLED', value: '1' }
  { name: 'NORA_BRAIN_DATABASE_URL', secretRef: 'nora-brain-database-url' }
  { name: 'NORA_BRAIN_DB_SSLMODE', value: 'verify-full' }
  { name: 'NORA_BRAIN_INTERNAL_SECRET', secretRef: 'nora-brain-internal-secret' }
  { name: 'NORA_BRAIN_PROVIDER', value: 'openai' }
  { name: 'NORA_BRAIN_ROUTINE_MODEL', value: noraBrainRoutineModel }
  { name: 'NORA_BRAIN_DOCUMENT_MODEL', value: noraBrainDocumentModel }
  { name: 'NORA_BRAIN_ALLOW_MODEL_CALLS', value: '0' }
  { name: 'NORA_BRAIN_EXECUTOR_ENABLED', value: '0' }
  { name: 'NORA_LEGACY_WRITER_SINGLETON', value: '1' }
] : []

resource storageAccount 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: storageAccountName
  location: location
  tags: commonTags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    defaultToOAuthAuthentication: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2025-06-01' = {
  parent: storageAccount
  name: 'default'
  properties: {}
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2025-06-01' = {
  parent: fileService
  name: fileShareName
  properties: {
    enabledProtocols: 'SMB'
    shareQuota: 5
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  tags: commonTags
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: managedEnvironment
  name: environmentStorageName
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: fileShare.name
      accessMode: 'ReadWrite'
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: commonTags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8000
        transport: 'auto'
      }
      registries: [
        {
          server: 'ghcr.io'
          username: registryUsername
          passwordSecretRef: 'ghcr-token'
        }
      ]
      secrets: concat([
        {
          name: 'ghcr-token'
          value: registryPassword
        }
      ], applicationSecrets, noraWebSecrets)
    }
    template: {
      containers: [
        {
          name: 'norium'
          image: containerImage
          env: concat(baselineEnvironment, secretEnvironment, noraWebEnvironment)
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          volumeMounts: [
            {
              volumeName: 'norium-data'
              mountPath: '/app/data'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 10
              failureThreshold: 5
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 12
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'norium-data'
          storageType: 'AzureFile'
          storageName: environmentStorage.name
        }
      ]
    }
  }
}

resource noraExecutor 'Microsoft.App/containerApps@2025-01-01' = if (noraBrainEnabled) {
  name: noraExecutorName
  location: location
  tags: union(commonTags, { component: 'nora-executor' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: 'ghcr.io'
          username: registryUsername
          passwordSecretRef: 'ghcr-token'
        }
      ]
      secrets: [
        { name: 'ghcr-token', value: registryPassword }
        { name: 'nora-brain-database-url', value: noraBrainDatabaseUrl }
        { name: 'nora-brain-internal-secret', value: noraBrainInternalSecret }
        { name: 'nora-brain-openai-key', value: noraBrainOpenAiApiKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'nora-executor'
          image: containerImage
          command: ['python']
          args: ['-m', 'app.modules.nora.brain.worker']
          env: [
            { name: 'ENVIRONMENT', value: 'production' }
            { name: 'PYTHONUNBUFFERED', value: '1' }
            { name: 'NORA_BRAIN_DATABASE_URL', secretRef: 'nora-brain-database-url' }
            { name: 'NORA_BRAIN_DB_SSLMODE', value: 'verify-full' }
            { name: 'NORA_BRAIN_INTERNAL_SECRET', secretRef: 'nora-brain-internal-secret' }
            { name: 'OPENAI_API_KEY', secretRef: 'nora-brain-openai-key' }
            { name: 'NORA_BRAIN_INTERNAL_URL', value: publicUrl }
            { name: 'NORA_BRAIN_PROVIDER', value: 'openai' }
            { name: 'NORA_BRAIN_ROUTINE_MODEL', value: noraBrainRoutineModel }
            { name: 'NORA_BRAIN_DOCUMENT_MODEL', value: noraBrainDocumentModel }
            { name: 'NORA_BRAIN_ALLOW_MODEL_CALLS', value: '1' }
            { name: 'NORA_BRAIN_EXECUTOR_ENABLED', value: '1' }
            { name: 'NORA_LEGACY_WRITER_SINGLETON', value: '0' }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output containerAppName string = containerApp.name
output containerAppEnvironmentName string = managedEnvironment.name
output publicUrl string = publicUrl
output storageAccountName string = storageAccount.name
output fileShareName string = fileShare.name
output persistentDataPath string = '/app/data'
output noraExecutorAppName string = noraBrainEnabled ? noraExecutor.name : ''
