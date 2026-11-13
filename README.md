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
