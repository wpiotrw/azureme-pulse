# AzureMe Pulse: rejestr incydentów (rutyna godzinowa)

Cel: utrzymywać `incidents.json` na gałęzi `main`. Strona https://pulse.azureme.pl czyta ten plik w sekcji „Rejestr incydentów”.

## Zasady nadrzędne

1. Wykonaj pracę w tym przebiegu. Nie deleguj jej do podagentów.
2. Nie wymyślaj niczego. Każdy identyfikator, godzina i opis skutków musi pochodzić ze źródła, które odczytałeś w tym przebiegu, i mieć adres w polu `sources`. Gdzie źródła milczą, napisz „nie podano w źródłach”.
3. Zmieniaj wyłącznie `incidents.json`. Nie dotykaj `index.html`, `CNAME`, `probes/`, `.github/` ani `routines/`.
4. Nie zgłaszaj zatwierdzenia, którego nie utworzyłeś: zapisz `git rev-parse origin/main` przed wypchnięciem i po `git fetch`. Jeśli wartości są równe, a miały się zmienić, przebieg się nie powiódł: napisz FAILED w pierwszej linii.
5. Gdy nie ma nic do zmiany, niczego nie zatwierdzaj. To poprawny wynik.

## Kroki

1. Uruchom `date -u '+%Y-%m-%d %H:%M UTC'`. To czas przebiegu.
2. Pobierz aktualny stan: `git fetch origin main data` (bez repozytorium: `git clone https://github.com/wpiotrw/azureme-pulse /tmp/pulse`). Odczytaj `git show origin/main:incidents.json` oraz `git show origin/data:status.json`.
3. Z `status.json` wyznacz dla każdej usługi próbki z ostatnich 90 minut. Anomalia to co najmniej 2 kolejne nieudane próbki tej samej usługi. Pojedyncza nieudana próbka nie jest anomalią.
4. Najpierw odczytaj pole `health` z `status.json`: to oficjalny stan Service Health z tenantów testowych (usługi i zgłoszenia z ostatnich 7 dni, pole `resolved` mówi, czy Microsoft zamknął zgłoszenie). Traktuj je jako źródło nadrzędne wobec serwisów zewnętrznych i podawaj w `sources` jako „Microsoft Service Health (odczyt portalu)” z adresem https://pulse.azureme.pl/#pomiary. Nie ustawiaj `end`, dopóki zgłoszenie ma `resolved: false`. Do rejestru trafiają tylko zgłoszenia o charakterze incydentu z realnym wpływem na dostępność usługi; drobnych, długotrwałych usterek funkcji nie dodawaj. Następnie sprawdź źródła publiczne z ostatnich 24 godzin: stronę stanu Microsoft (https://status.cloud.microsoft), komunikaty konta Microsoft 365 Status oraz wiarygodne serwisy opisujące incydenty Microsoft 365 i Azure. Szukaj identyfikatorów w formacie dwóch liter i cyfr (na przykład EX…, MO…, TM…).
5. Zdecyduj:
   - Brak anomalii, brak otwartego wpisu, brak nowego incydentu w źródłach: zakończ bez zmian.
   - Nowy incydent potwierdzony w źródłach: dodaj wpis z polami `ids`, `title`, `start`, `end` (pomiń, dopóki trwa), `duration`, `services`, `summary`, `sources`, `own_probes`.
   - Otwarty wpis: zaktualizuj `summary`, `services` i `sources`. Ustaw `end` i `duration` dopiero wtedy, gdy źródło potwierdza zakończenie.
   - Anomalia w sondach bez potwierdzenia w źródłach: dodaj wpis z `ids: []`, tytułem „Anomalia w pomiarach: <usługa>” i opisem samych pomiarów. Nie nazywaj tego awarią Microsoft.
6. W polu `own_probes` zawsze podaj, co w oknie incydentu pokazały własne sondy: liczba nieudanych próbek na usługę i zakres czasu, albo „Własne pomiary nie wykazały odchyleń”.
7. Czasy zapisuj w UTC w formacie ISO 8601 z literą Z. Teksty po polsku, językiem technicznym, bez skrótów bez rozwinięcia.
8. Ustaw `updated` na czas przebiegu. Sprawdź plik: `python3 -c "import json;d=json.load(open('incidents.json'));assert d['schema']==1 and isinstance(d['incidents'],list)"`. Każdy adres w `sources` musi zaczynać się od `https://`.
9. Zatwierdź z opisem `incidents: <krótko co się zmieniło>` i wypchnij na `main`. Nie używaj wymuszonego wypchnięcia. Gdy `main` się przesunął, wykonaj `git pull --rebase origin main`, powtórz krok 8 i wypchnij ponownie.

## Odpowiedź

Najwyżej sześć linii: czy coś zmieniono, identyfikatory i tytuły dotkniętych wpisów, wartości SHA przed i po, źródła niedostępne w tym przebiegu.
