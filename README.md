# AzureMe Pulse

Portal stanu usług Microsoft 365 i Azure: https://pulse.azureme.pl

## Jak to działa

1. Zadanie GitHub Actions (`.github/workflows/probes.yml`) co około 5 minut uruchamia `probes/probe.mjs`.
2. Skrypt wysyła żądania HTTP bez uwierzytelnienia do publicznych punktów końcowych Microsoft i zapisuje wynik w `status.json`.
3. Plik trafia na gałąź `data` (jedna, nadpisywana rewizja), dzięki czemu pomiary nie przebudowują strony.
4. Strona `index.html`, serwowana przez GitHub Pages z gałęzi `main`, pobiera `status.json` i pokazuje go w sekcji „Pomiary rzeczywiste”.

## Co jest rzeczywiste, a co demonstracyjne

- Rzeczywiste: sekcja „Pomiary rzeczywiste” (osiągalność i czas odpowiedzi z jednej lokalizacji).
- Demonstracyjne: pozostałe sekcje, w tym odtworzenie incydentu z 12–13 listopada 2026. Chronologia pochodzi z publicznych źródeł, wartości liczbowe są symulowane.

## Ograniczenia sond

Sonda bez logowania potwierdza, że warstwa dostępowa usługi odpowiada. Nie sprawdza operacji po zalogowaniu, więc nie wykryje każdej awarii.

Niezależny projekt. Nie jest powiązany z Microsoft.

## Powiadomienia e-mail (opcjonalne)

Moduł `probes/notify.mjs` wysyła wiadomość przy zmianie stanu (dwa kolejne nieudane pomiary sondy, zmiana stanu w Service health, nowe lub zamknięte zgłoszenie, nieudany odczyt przez Graph, nowe zdarzenie Azure Status) oraz raport dobowy po godzinie 06:00 UTC.

Konfiguracja w sekrecie repozytorium `PULSE_NOTIFY`:

```json
{ "to": ["adres-odbiorcy"], "tenant": "Tenant 1", "from": "adres-skrzynki-nadawczej" }
```

- `tenant`: etykieta tenanta z `PULSE_TENANTS`, w którym istnieje skrzynka nadawcza.
- Aplikacja w tym tenancie wymaga uprawnienia aplikacyjnego `Mail.Send` (Microsoft Graph) ze zgodą administratora.
- Adresy istnieją wyłącznie w sekrecie; nie trafiają do repozytorium, dziennika zadania ani pliku `status.json`.
- Bez sekretu moduł niczego nie wysyła.

## Skrypty konfiguracyjne (`tools/`)

- `New-PulseReaderApp.ps1`: tworzy w tenancie aplikację „AzureMe Pulse Reader”, nadaje uprawnienia Microsoft Graph tylko do odczytu i dodaje poświadczenie federacyjne dla GitHub Actions.
- `Set-PulseMailboxScope.ps1`: ogranicza w Exchange Online dostęp aplikacji (wysyłka poczty, odczyt ustawień skrzynki) do wskazanych skrzynek. Po jego uruchomieniu należy usunąć w Entra ID uprawnienia aplikacyjne `Mail.Send` i `MailboxSettings.Read`.

Oba skrypty obsługują `-WhatIf` i można je bezpiecznie uruchamiać wielokrotnie.
