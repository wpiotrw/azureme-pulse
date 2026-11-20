# AzureMe Pulse – notatki techniczne

Portal: https://pulse.azureme.pl (GitHub Pages; gałąź `main`, dane w gałęzi `data`).

Ten plik zawiera wyłącznie informacje potrzebne do budowania i testowania portalu. Pełne notatki projektu (zasady pracy, stan, decyzje, dziennik zmian, konfiguracja) są prywatne: dokument `claude/azureme-pulse-CLAUDE.md` w projekcie Claude właściciela. Każda sesja pracy zaczyna się od jego przeczytania i kończy jego aktualizacją. Do tego pliku nie dopisywać stanu prac, decyzji, dziennika zmian ani opisu konfiguracji.

## Zasady

- Nie dodawać do repozytorium opisu architektury, skryptów konfiguracyjnych, nazw aplikacji, uprawnień ani ścieżek z komputera właściciela. Bez folderów `docs/` i `tools/`.
- Identyfikatory tenantów, aplikacji i subskrypcji oraz adresy e-mail nie mogą trafić do kodu, logów ani plików danych. Sekretów nie wklejać do kodu.
- `index.html` jest plikiem generowanym; zmiany wprowadza się w `dev/src.html`.
- Kod testować przed publikacją. Teksty portalu po polsku, z tłumaczeniem w `dev/i18n/hand.txt`.

## Układ repozytorium

| Ścieżka | Zawartość |
|---|---|
| `index.html` | Cały portal w jednym pliku. **Plik generowany – nie edytować ręcznie.** |
| `dev/src.html` | Źródło portalu (HTML, CSS, JS w jednym pliku). Tu wprowadza się zmiany. |
| `dev/build.py` | Buduje `index.html`: wstawia słownik tłumaczeń, znacznik wersji, punkty globu. |
| `dev/i18n/` | `runtime.js` (warstwa tłumaczenia w przeglądarce, reguły `PRE`/`POST`), `hand.txt` (`polski|angielski`, tu dopisuje się nowe teksty), `idx.txt` + `tr_keys.json` (starszy słownik indeksowany). |
| `dev/tests/` | Testy Node (`t4` sondy i zdarzenia, `t5` teczki incydentów, `t6` sygnały i RIPE Atlas, `t7` poczta, `t8` porównanie tygodniowe Cloudflare, `t9` Azure Service Health w subskrypcjach) i dane testowe w `data/`. |
| `dev/shots/` | Skrypty Playwright (zrzuty i testy w przeglądarce; `en.py` wykrywa nieprzetłumaczone teksty). Wymagają Chrome pod `/usr/bin/google-chrome`. |
| `probes/` | Kod sond uruchamiany w GitHub Actions: `probe.mjs`, `health.mjs`, `azurehealth.mjs`, `cases.mjs`, `signals.mjs`, `notify.mjs`. |
| `incidents.json`, `routines/incydenty.md` | Rejestr incydentów i instrukcja zadania, które go prowadzi. |

## Procedura zmiany portalu

1. Edytować `dev/src.html`. Nowe polskie teksty dopisać do `dev/i18n/hand.txt` z tłumaczeniem.
2. `python3 dev/build.py && node --check dev/.out/p.js`
3. `cd dev/tests && for t in t4 t5 t6 t7 t8 t9; do node $t.mjs | tail -1; done`
4. `python3 dev/shots/en.py` – wynik `MISS []` i `ERRORS []`. Zrzuty: `v3.py` (wszystkie zakładki), `v10.py`–`v12.py` (przegląd, nawigacja), `v16.py` (telefon: zakres, opis wykresu, przykład awarii, zwijany pasek; zmienna `LIVE` wskazuje plik danych), `v15.py` (zakładka „Telemetria”), `v14.py` (wykresy: podpowiedź, kliknięcie, okno sondy, ruch), `v18.py` (zgłoszenia Microsoft na „Przeglądzie”: karty, brak powtórzeń, kafelek paska; domyślne dane `live18.json`), `v13.py` (sondy, także na danych z wstrzykniętymi błędami; katalog zrzutów w zmiennej `SHOTS`). Zrzuty obejrzeć przed publikacją: telefon 390 px, komputer 1280 px, tryb ciemny i jasny.
5. Zatwierdzenie: `git pull -q --rebase --autostash origin main`, opis po polsku, na końcu wiersze `Co-Authored-By` i `Claude-Session`, potem `git -c push.negotiate=true push -q origin main`.
6. Zmiana w `probes/**` uruchamia przebieg „Probes”; sprawdzić log: `gh run list --workflow Probes`, `gh run view <id> --log`.

Pułapki tłumaczeń: klucz kończący się literą nie dopasuje się przed cyfrą (potrzebna reguła `PRE` w `runtime.js`); reguła `(\d+) godzin…` przepisuje „24 godziny”, więc zdania z liczbą godzin wymagają własnej, wcześniejszej reguły albo innego sformułowania; teksty z `::before/::after` nie są tłumaczone.
