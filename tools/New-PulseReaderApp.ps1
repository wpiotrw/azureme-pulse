<#
.SYNOPSIS
    Tworzy w tenancie Microsoft Entra aplikację "AzureMe Pulse Reader" dla portalu https://pulse.azureme.pl.

.DESCRIPTION
    Skrypt jest idempotentny: istniejące obiekty wykorzystuje ponownie, brakujące tworzy.
    Tworzy lub uzupełnia:
      1. rejestrację aplikacji (jeden tenant, bez sekretu i bez certyfikatu),
      2. jednostkę usługi (service principal),
      3. uprawnienia aplikacyjne Microsoft Graph, wyłącznie do odczytu, wraz ze zgodą administratora:
           ServiceHealth.Read.All   - stan usług i incydenty Service Health
                                      https://graphpermissions.merill.net/permission/ServiceHealth.Read.All
           ServiceMessage.Read.All  - komunikaty Centrum wiadomości
                                      https://graphpermissions.merill.net/permission/ServiceMessage.Read.All
         Węższych uprawnień dla tych interfejsów Microsoft Graph nie udostępnia.
      4. poświadczenie federacyjne (federated identity credential) dla GitHub Actions,
         dzięki któremu zadanie loguje się bez sekretu.

    Uprawnienia delegowane wymagane od osoby uruchamiającej skrypt:
      Application.ReadWrite.All        - utworzenie rejestracji aplikacji i jednostki usługi
      AppRoleAssignment.ReadWrite.All  - nadanie zgody administratora na uprawnienia aplikacyjne
    UWAGA: oba zakresy mają szeroki zasięg (wszystkie aplikacje w tenancie). Skrypt używa ich
    tylko do opisanych czynności. Zgodę na uprawnienia aplikacyjne Microsoft Graph może nadać
    Administrator ról uprzywilejowanych (Privileged Role Administrator) albo Administrator globalny.

    Uwierzytelnianie: interaktywne, aplikacją Microsoft Graph PowerShell. Własna rejestracja
    aplikacji nie jest tu potrzebna, bo skrypt uruchamia się jednorazowo przy konfiguracji.

.PARAMETER TenantId
    Identyfikator lub domena tenanta. Bez tego parametru logowanie trafia do tenanta domyślnego konta.

.PARAMETER DisplayName
    Nazwa wyświetlana aplikacji.

.PARAMETER GitHubRepository
    Repozytorium GitHub w formacie właściciel/nazwa.

.PARAMETER GitHubBranch
    Gałąź, z której uruchamiane jest zadanie GitHub Actions.

.PARAMETER GitHubSubject
    Dokładna wartość oświadczenia sub z tokenu OIDC zadania GitHub Actions.
    GitHub wystawia ją dla tego repozytorium w formacie z identyfikatorami liczbowymi:
    repo:<właściciel>@<id właściciela>/<repozytorium>@<id repozytorium>:ref:refs/heads/<gałąź>.
    Gdy logowanie zadania kończy się błędem AADSTS700213, właściwą wartość podaje
    pole błędu w pliku status.json na gałęzi data.

.PARAMETER KeepConnection
    Pozostawia połączenie z Microsoft Graph po zakończeniu. Domyślnie skrypt rozłącza
    tylko połączenie, które sam nawiązał.

.EXAMPLE
    .\New-PulseReaderApp.ps1 -TenantId contoso.onmicrosoft.com -WhatIf
    Pokazuje planowane zmiany bez ich wykonania.

.EXAMPLE
    .\New-PulseReaderApp.ps1 -TenantId contoso.onmicrosoft.com
    Tworzy aplikację, nadaje uprawnienia i dodaje poświadczenie federacyjne.

.NOTES
    Wersja: 1.1.0 (13-11-2026)
    Autor:  Piotr Wiśniewski - APN Promise S.A.
    Zmiany: 1.1.0 - podmiot poświadczenia w formacie GitHub z identyfikatorami liczbowymi;
                    istniejące poświadczenie o tej samej nazwie jest aktualizowane.
            1.0.1 - wynik i komunikaty podają nazwę aplikacji.
            1.0.0 - pierwsza wersja.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string]$TenantId,
    [string]$DisplayName = 'AzureMe Pulse Reader',
    [ValidatePattern('^[^/\s]+/[^/\s]+$')]
    [string]$GitHubRepository = 'wpiotrw/azureme-pulse',
    [string]$GitHubBranch = 'main',
    [string]$GitHubSubject = 'repo:wpiotrw@37083541/azureme-pulse@1457006440:ref:refs/heads/main',
    [switch]$KeepConnection
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RequiredModules = @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications')
$RequiredScopes  = @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All')
$GraphAppId      = '00000003-0000-0000-c000-000000000000'   # stały identyfikator aplikacji Microsoft Graph
$AppRoleNames    = @('ServiceHealth.Read.All', 'ServiceMessage.Read.All')
$Issuer          = 'https://token.actions.githubusercontent.com'
$Audience        = 'api://AzureADTokenExchange'
$Subject         = if ($GitHubSubject) { $GitHubSubject } else { "repo:${GitHubRepository}:ref:refs/heads/${GitHubBranch}" }
$CredentialName  = 'github-actions-' + ($GitHubBranch -replace '[^A-Za-z0-9-]', '-')

function Test-PulseModules {
    # Sprawdza obecność wymaganych podmodułów. Nie instaluje metapakietu Microsoft.Graph.
    $missing = @($RequiredModules | Where-Object { -not (Get-Module -ListAvailable -Name $_) })
    if ($missing.Count -gt 0) {
        $list = $missing -join ', '
        throw "Brak modułów: $list. Zainstaluj je poleceniem: Install-Module $list -Scope CurrentUser"
    }
    foreach ($name in $RequiredModules) { Import-Module -Name $name -ErrorAction Stop }
}

function Connect-PulseGraph {
    # Zwraca $true, gdy połączenie nawiązał ten skrypt (wtedy na końcu je rozłącza).
    $context = Get-MgContext
    if ($context) {
        $hasScopes  = @($RequiredScopes | Where-Object { $context.Scopes -notcontains $_ }).Count -eq 0
        $sameTenant = (-not $TenantId) -or ($TenantId -match '^[0-9a-fA-F-]{36}$' -and $context.TenantId -eq $TenantId)
        if ($hasScopes -and $sameTenant) {
            Write-Host "Używam istniejącego połączenia: konto $($context.Account), tenant $($context.TenantId)."
            return $false
        }
        Write-Host "Istniejące połączenie (tenant $($context.TenantId)) nie pasuje do wymagań. Loguję ponownie."
    }
    $connect = @{ Scopes = $RequiredScopes; NoWelcome = $true }
    if ($TenantId) { $connect['TenantId'] = $TenantId }
    Connect-MgGraph @connect
    $context = Get-MgContext
    Write-Host "Połączono: konto $($context.Account), tenant $($context.TenantId)."
    return $true
}

Test-PulseModules
$connectedHere = Connect-PulseGraph

try {
    $organization = Get-MgContext
    Write-Host "Tenant docelowy: $($organization.TenantId)"
    Write-Host "Nazwa aplikacji: $DisplayName"

    # 1. Role aplikacyjne Microsoft Graph odczytywane z tenanta, bez identyfikatorów wpisanych na stałe.
    $graphSp = Get-MgServicePrincipal -Filter "appId eq '$GraphAppId'" -Property 'id,appId,appRoles'
    if (-not $graphSp) { throw 'W tenancie nie znaleziono jednostki usługi Microsoft Graph.' }
    $roles = foreach ($roleName in $AppRoleNames) {
        $role = $graphSp.AppRoles | Where-Object { $_.Value -eq $roleName -and $_.AllowedMemberTypes -contains 'Application' }
        if (-not $role) { throw "Microsoft Graph nie udostępnia roli aplikacyjnej $roleName." }
        $role
    }

    # 2. Rejestracja aplikacji.
    $app = Get-MgApplication -Filter "displayName eq '$($DisplayName -replace "'", "''")'" -All
    if (@($app).Count -gt 1) { throw "Istnieje więcej niż jedna aplikacja o nazwie '$DisplayName'. Usuń duplikat albo podaj inną nazwę." }
    if ($app) {
        Write-Host "Aplikacja już istnieje: $($app.AppId)"
    }
    elseif ($PSCmdlet.ShouldProcess($DisplayName, 'Utworzenie rejestracji aplikacji')) {
        $resourceAccess = @{
            ResourceAppId  = $GraphAppId
            ResourceAccess = @($roles | ForEach-Object { @{ Id = $_.Id; Type = 'Role' } })
        }
        $app = New-MgApplication -DisplayName $DisplayName -SignInAudience 'AzureADMyOrg' `
            -Description 'Odczyt stanu usług Microsoft 365 dla portalu pulse.azureme.pl. Logowanie wyłącznie poświadczeniem federacyjnym GitHub Actions.' `
            -RequiredResourceAccess @($resourceAccess)
        Write-Host "Utworzono aplikację: $($app.AppId)"
    }
    if (-not $app) {
        Write-Host 'Tryb -WhatIf: aplikacja nie istnieje, dalsze kroki zostały pominięte.'
        return
    }

    # 3. Jednostka usługi.
    $sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'"
    if ($sp) {
        Write-Host "Jednostka usługi już istnieje: $($sp.Id)"
    }
    elseif ($PSCmdlet.ShouldProcess($DisplayName, 'Utworzenie jednostki usługi')) {
        $sp = New-MgServicePrincipal -AppId $app.AppId
        Write-Host "Utworzono jednostkę usługi: $($sp.Id)"
    }

    # 4. Zgoda administratora na uprawnienia aplikacyjne.
    if ($sp) {
        $assigned = @(Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All)
        foreach ($role in $roles) {
            if ($assigned | Where-Object { $_.AppRoleId -eq $role.Id -and $_.ResourceId -eq $graphSp.Id }) {
                Write-Host "Uprawnienie już nadane: $($role.Value)"
            }
            elseif ($PSCmdlet.ShouldProcess($role.Value, 'Nadanie uprawnienia aplikacyjnego ze zgodą administratora')) {
                $null = New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
                    -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $role.Id
                Write-Host "Nadano uprawnienie: $($role.Value)"
            }
        }
    }

    # 5. Poświadczenie federacyjne dla GitHub Actions.
    $credentials = @(Get-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id -All)
    $existing = $credentials | Where-Object { $_.Name -eq $CredentialName } | Select-Object -First 1
    if ($credentials | Where-Object { $_.Issuer -eq $Issuer -and $_.Subject -eq $Subject }) {
        Write-Host "Poświadczenie federacyjne już istnieje: $Subject"
    }
    elseif ($existing) {
        # Poświadczenie o tej nazwie istnieje z innym podmiotem (na przykład w starszym formacie): aktualizacja podmiotu.
        if ($PSCmdlet.ShouldProcess("$($existing.Subject) -> $Subject", 'Aktualizacja podmiotu poświadczenia federacyjnego')) {
            Update-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id `
                -FederatedIdentityCredentialId $existing.Id -Subject $Subject
            Write-Host "Zaktualizowano poświadczenie federacyjne: $Subject"
        }
    }
    elseif ($PSCmdlet.ShouldProcess($Subject, 'Dodanie poświadczenia federacyjnego')) {
        $credential = @{
            name        = $CredentialName
            issuer      = $Issuer
            subject     = $Subject
            audiences   = @($Audience)
            description = "GitHub Actions: $GitHubRepository, gałąź $GitHubBranch"
        }
        $null = New-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id -BodyParameter $credential
        Write-Host "Dodano poświadczenie federacyjne: $Subject"
    }

    # 6. Wartości do wpisania w repozytorium GitHub (Settings > Secrets and variables > Actions > Variables).
    [pscustomobject]@{
        DisplayName      = $app.DisplayName
        TenantId         = (Get-MgContext).TenantId
        ClientId         = $app.AppId
        ApplicationObjId = $app.Id
        ServicePrincipal = if ($sp) { $sp.Id } else { $null }
        Subject          = $Subject
    } | Format-List
}
finally {
    if ($connectedHere -and -not $KeepConnection) {
        try { $null = Disconnect-MgGraph } catch { Write-Verbose "Rozłączenie nie powiodło się: $($_.Exception.Message)" }
    }
}
