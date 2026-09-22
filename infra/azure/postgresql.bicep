@description('Azure region for the managed PostgreSQL server.')
param location string = resourceGroup().location

@description('Globally unique PostgreSQL Flexible Server name.')
param serverName string

@description('Application database name.')
param databaseName string = 'norium'

@description('Temporary administrative login used only by the migration workflow.')
param administratorLogin string = 'noriumbootstrap'

@secure()
@description('Temporary administrative password generated inside GitHub Actions.')
param administratorPassword string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: {
    application: 'norium'
    environment: 'production'
    component: 'postgresql'
    managedBy: 'github-actions'
  }
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    version: '16'
    createMode: 'Create'
    backup: {
      backupRetentionDays: 35
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    storage: {
      autoGrow: 'Enabled'
      storageSizeGB: 32
      tier: 'P4'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output serverName string = server.name
output host string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
