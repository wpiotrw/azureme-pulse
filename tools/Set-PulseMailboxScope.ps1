<#
.SYNOPSIS
    Ogranicza dostęp aplikacji "AzureMe Pulse Reader" do wskazanych skrzynek Exchange Online.

.DESCRIPTION
    Skrypt konfiguruje kontrolę dostępu opartą na rolach dla aplikacji w Exchange Online
    (Role Based Access Control for Applications). Jest idempotentny: istniejące obiekty
    wykorzystuje ponownie, brakujące tworzy.
    Wykonuje kolejno:
      1. wskaźnik jednostki usługi w Exchange Online (New-ServicePrincipal),
      2. oznaczenie skrzynek atrybutem niestandardowym (Set-Mailbox),
      3. zakres zarządzania obejmujący oznaczone skrzynki (New-ManagementScope),
      4. przypisanie ról aplikacyjnych w tym zakresie (New-ManagementRoleAssignment),
      5. test autoryzacji dla każdej skrzynki (Test-ServicePrincipalAuthorization).

    Domyślne role:
      Application Mail.Send             - wysyłka powiadomień ze skrzynki nadawczej,
      Application MailboxSettings.Read  - odczyt ustawień skrzynki przez sondę Exchange Online.

    WAŻNE: uprawnienia nadane w Exchange Online sumują się z uprawnieniami nadanymi w Microsoft Entra ID.
    Zawężenie działa dopiero po usunięciu uprawnień aplikacyjnych Mail.Send i MailboxSettings.Read
    z rejestracji aplikacji w Entra ID. Skrypt tego nie robi; przypomina o tym w podsumowaniu.
    Zmiany wchodzą w życie po czasie od 30 minut do 2 godzin (pamięć podręczna uprawnień aplikacji).

    Wymagania osoby uruchamiającej: członkostwo w grupie ról Organization Management
    w Exchange Online albo rola Exchange Administrator w Microsoft Entra ID.
    Dokumentacja: https://learn.microsoft.com/exchange/permissions-exo/application-rbac

.PARAMETER AppId
    Identyfikator aplikacji (Application ID, Client ID).

.PARAMETER ServicePrincipalObjectId
    Identyfikator obiektu jednostki usługi (Object ID ze strony Enterprise applications,
    nie ze strony App registrations). Skrypt New-PulseReaderApp.ps1 podaje go w polu ServicePrincipal.

.PARAMETER Mailbox
    Adresy skrzynek, do których aplikacja ma mieć dostęp: skrzynka nadawcza powiadomień
    oraz skrzynka sprawdzana przez sondę (może to być ta sama skrzynka).

.PARAMETER Role
    Role aplikacyjne Exchange Online do przypisania.

.PARAMETER ScopeName
    Nazwa zakresu zarządzania.

.PARAMETER CustomAttribute
    Atrybut niestandardowy skrzynki używany jako znacznik (CustomAttribute1 do CustomAttribute15).

.PARAMETER AttributeValue
    Wartość znacznika wpisywana do atrybutu.

.PARAMETER DisplayName
    Nazwa wyświetlana wskaźnika jednostki usługi w Exchange Online.

.PARAMETER UserPrincipalName
    Konto administratora używane do logowania, gdy nie ma aktywnego połączenia.

.PARAMETER Force
    Pozwala nadpisać atrybut skrzynki, który ma już inną wartość.

.PARAMETER KeepConnection
    Pozostawia połączenie z Exchange Online po zakończeniu. Domyślnie skrypt rozłącza
    tylko połączenie, które sam nawiązał.

.EXAMPLE
    .\Set-PulseMailboxScope.ps1 -AppId c18228d2-9c77-4462-b529-e2ff8e6ff790 -ServicePrincipalObjectId 00000000-0000-0000-0000-000000000000 -Mailbox pulse@contoso.onmicrosoft.com -WhatIf
    Pokazuje planowane zmiany bez ich wykonania.

.EXAMPLE
    .\Set-PulseMailboxScope.ps1 -AppId c18228d2-9c77-4462-b529-e2ff8e6ff790 -ServicePrincipalObjectId 00000000-0000-0000-0000-000000000000 -Mailbox pulse@contoso.onmicrosoft.com
    Ogranicza wysyłkę i odczyt ustawień do jednej skrzynki.

.EXAMPLE
    .\Set-PulseMailboxScope.ps1 -AppId 8dbb3f1b-49ec-4455-b315-42263fbf5bd6 -ServicePrincipalObjectId 00000000-0000-0000-0000-000000000000 -Mailbox admin@fabrikam.onmicrosoft.com -Role 'Application MailboxSettings.Read'
    Tenant bez wysyłki powiadomień: tylko odczyt ustawień skrzynki przez sondę.

.NOTES
    Wersja: 1.0.0 (13-11-2026)
    Autor:  Piotr Wiśniewski - APN Promise S.A.
    Zmiany: 1.0.0 - pierwsza wersja.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')]
    [string]$AppId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')]
    [string]$ServicePrincipalObjectId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Mailbox,

    [ValidateSet('Application Mail.Send', 'Application MailboxSettings.Read')]
    [string[]]$Role = @('Application Mail.Send', 'Application MailboxSettings.Read'),

    [string]$ScopeName = 'AzureMe Pulse',

    [ValidatePattern('^CustomAttribute([1-9]|1[0-5])$')]
    [string]$CustomAttribute = 'CustomAttribute1',

    [ValidatePattern("^[A-Za-z0-9_-]{1,64}$")]
    [string]$AttributeValue = 'AzureMePulse',

    [string]$DisplayName = 'AzureMe Pulse Reader',
    [string]$UserPrincipalName,
    [switch]$Force,
    [switch]$KeepConnection
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RequiredModule = 'ExchangeOnlineManagement'
$ScopeFilter    = "$CustomAttribute -eq '$AttributeValue'"

function Test-PulseModule {
    # Sprawdza obecność modułu Exchange Online w wersji 3 lub nowszej (wymaga jej Get-ConnectionInformation).
    $module = Get-Module -ListAvailable -Name $RequiredModule | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $module) {
        throw "Brak modułu $RequiredModule. Zainstaluj go poleceniem: Install-Module $RequiredModule -Scope CurrentUser"
    }
    if ($module.Version.Major -lt 3) {
        throw "Moduł $RequiredModule ma wersję $($module.Version). Wymagana jest wersja 3.0.0 lub nowsza: Update-Module $RequiredModule"
    }
    Import-Module -Name $RequiredModule -ErrorAction Stop
}

function Connect-PulseExchange {
    # Zwraca $true, gdy połączenie nawiązał ten skrypt (wtedy na końcu je rozłącza).
    $active = @(Get-ConnectionInformation | Where-Object { $_.State -eq 'Connected' -and -not $_.IsEopSession })
    if ($active.Count -gt 0) {
        Write-Host "Używam istniejącego połączenia: konto $($active[0].UserPrincipalName), tenant $($active[0].TenantID)."
        return $false
    }
    $connect = @{ ShowBanner = $false }
    if ($UserPrincipalName) { $connect['UserPrincipalName'] = $UserPrincipalName }
    Connect-ExchangeOnline @connect
    $active = @(Get-ConnectionInformation | Where-Object { $_.State -eq 'Connected' -and -not $_.IsEopSession })
    Write-Host "Połączono: konto $($active[0].UserPrincipalName), tenant $($active[0].TenantID)."
    return $true
}

Test-PulseModule
$connectedHere = Connect-PulseExchange

try {
    Write-Host "Legenda: zielony = już istniało, żółty = zmienione w tym uruchomieniu." -ForegroundColor DarkGray
    Write-Host "Aplikacja: $DisplayName ($AppId)"
    Write-Host "Zakres: $ScopeName, filtr: $ScopeFilter"

    # 1. Wskaźnik jednostki usługi w Exchange Online.
    $sp = Get-ServicePrincipal -Identity $ServicePrincipalObjectId -ErrorAction SilentlyContinue
    if ($sp) {
        Write-Host "Wskaźnik jednostki usługi już istnieje: $($sp.DisplayName)" -ForegroundColor Green
    }
    elseif ($PSCmdlet.ShouldProcess($DisplayName, 'Utworzenie wskaźnika jednostki usługi w Exchange Online')) {
        $sp = New-ServicePrincipal -AppId $AppId -ObjectId $ServicePrincipalObjectId -DisplayName $DisplayName
        Write-Host "Utworzono wskaźnik jednostki usługi: $DisplayName" -ForegroundColor Yellow
    }

    # 2. Oznaczenie skrzynek atrybutem niestandardowym.
    foreach ($address in $Mailbox) {
        $mbx = Get-Mailbox -Identity $address -ErrorAction Stop
        $current = [string]$mbx.$CustomAttribute
        if ($current -eq $AttributeValue) {
            Write-Host "Skrzynka już oznaczona: $($mbx.PrimarySmtpAddress)" -ForegroundColor Green
            continue
        }
        if ($current -and -not $Force) {
            throw "Skrzynka $($mbx.PrimarySmtpAddress) ma w $CustomAttribute wartość '$current'. Wskaż inny atrybut parametrem -CustomAttribute albo użyj -Force, aby ją nadpisać."
        }
        if ($PSCmdlet.ShouldProcess($mbx.PrimarySmtpAddress, "Ustawienie $CustomAttribute = $AttributeValue")) {
            $set = @{ Identity = $mbx.Identity; $CustomAttribute = $AttributeValue }
            Set-Mailbox @set
            Write-Host "Oznaczono skrzynkę: $($mbx.PrimarySmtpAddress)" -ForegroundColor Yellow
        }
    }

    # 3. Zakres zarządzania.
    $scope = Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue
    if ($scope) {
        if ([string]$scope.RecipientFilter -eq $ScopeFilter) {
            Write-Host "Zakres zarządzania już istnieje: $ScopeName" -ForegroundColor Green
        }
        elseif ($PSCmdlet.ShouldProcess($ScopeName, "Zmiana filtru zakresu na: $ScopeFilter")) {
            Set-ManagementScope -Identity $ScopeName -RecipientRestrictionFilter $ScopeFilter
            Write-Host "Zaktualizowano filtr zakresu: $ScopeName (poprzednio: $($scope.RecipientFilter))" -ForegroundColor Yellow
        }
    }
    elseif ($PSCmdlet.ShouldProcess($ScopeName, "Utworzenie zakresu zarządzania z filtrem: $ScopeFilter")) {
        $scope = New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter $ScopeFilter
        Write-Host "Utworzono zakres zarządzania: $ScopeName" -ForegroundColor Yellow
    }

    # 4. Przypisania ról aplikacyjnych w zakresie.
    foreach ($roleName in $Role) {
        $existing = @(Get-ManagementRoleAssignment -Role $roleName -ErrorAction SilentlyContinue |
            Where-Object { $_.RoleAssigneeType -eq 'ServicePrincipal' -and $_.RoleAssigneeName -in @($ServicePrincipalObjectId, $AppId, $DisplayName) })
        if ($existing.Count -gt 0) {
            $assignment = $existing[0]
            # Nazwa właściwości z zakresem nie jest opisana w dokumentacji, dlatego odczyt jest zabezpieczony.
            $scopeProperty = $assignment.PSObject.Properties['CustomResourceScope']
            $currentScope = if ($scopeProperty) { [string]$scopeProperty.Value } else { '' }
            if ($currentScope -eq $ScopeName) {
                Write-Host "Rola już przypisana w zakresie: $roleName" -ForegroundColor Green
            }
            elseif ($PSCmdlet.ShouldProcess($roleName, "Zmiana zakresu przypisania na: $ScopeName")) {
                Set-ManagementRoleAssignment -Identity $assignment.Identity -CustomResourceScope $ScopeName
                Write-Host "Zmieniono zakres przypisania roli: $roleName" -ForegroundColor Yellow
            }
            continue
        }
        if ($PSCmdlet.ShouldProcess($roleName, "Przypisanie roli aplikacji w zakresie: $ScopeName")) {
            $null = New-ManagementRoleAssignment -App $ServicePrincipalObjectId -Role $roleName -CustomResourceScope $ScopeName
            Write-Host "Przypisano rolę: $roleName" -ForegroundColor Yellow
        }
    }

    # 5. Test autoryzacji. Polecenie pomija pamięć podręczną, więc wynik jest aktualny od razu.
    if (-not $WhatIfPreference) {
        foreach ($address in $Mailbox) {
            Write-Host "Test autoryzacji dla skrzynki: $address"
            $result = Test-ServicePrincipalAuthorization -Identity $ServicePrincipalObjectId -Resource $address
            $result | Format-Table -Property @('RoleName', 'GrantedPermissions', 'AllowedResourceScope', 'InScope') -AutoSize
        }
    }

    Write-Host ''
    Write-Host 'Pozostało do wykonania ręcznie:' -ForegroundColor Cyan
    Write-Host '  1. W Microsoft Entra ID usuń z aplikacji uprawnienia aplikacyjne Mail.Send i MailboxSettings.Read'
    Write-Host '     (App registrations > API permissions oraz zgoda administratora w Enterprise applications > Permissions).'
    Write-Host '     Bez tego kroku aplikacja zachowuje dostęp do wszystkich skrzynek.'
    Write-Host '  2. W sekretach repozytorium GitHub wpisz te same skrzynki: mailboxUser w PULSE_TENANTS, from w PULSE_NOTIFY.'
    Write-Host '  3. Odczekaj od 30 minut do 2 godzin, zanim zmiana zacznie obowiązywać w Microsoft Graph.'
}
finally {
    if ($connectedHere -and -not $KeepConnection) {
        try { Disconnect-ExchangeOnline -Confirm:$false } catch { Write-Verbose "Rozłączenie nie powiodło się: $($_.Exception.Message)" }
    }
}
