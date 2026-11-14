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

## Zasady językowe wpisów (obowiązkowe)

- Terminologia Microsoft według polskiego interfejsu Service health (Kondycja usługi): typ zgłoszenia „incydent (incident)” albo „porada (advisory)”; stany: „Badanie”, „Obniżenie wydajności usługi”, „Przerwa w świadczeniu usługi”, „Przywracanie usługi”, „Przedłużone odzyskiwanie usługi”, „Usługa została przywrócona”.
- Nie używać: „degradacja”, „komunikat doradczy”, „próbka” (jest: „pomiar”), nazw pól technicznych w rodzaju `resolved: false`.
- Daty w formacie dd-mm-rrrr, godziny z dopiskiem UTC. Zdania do 25 słów, rejestr bezosobowy, bez ocen i wykrzykników.
- Nazwy własne Microsoft w brzmieniu angielskim; skrót rozwinąć przy pierwszym użyciu.

## Zgłoszenia powiązane

- Jeden incydent Microsoft to jeden wpis. Lista usług z sekcji „More info” opisuje zakres incydentu i nie tworzy osobnych wpisów.
- Pole `ids`: identyfikatory tego samego zdarzenia (na przykład zgłoszenie usługi i zgłoszenie pakietu Microsoft 365).
- Pole `related`: identyfikatory zgłoszeń, które według treści komunikatów Microsoft są skutkiem tego incydentu. Pole `related_note`: jedno zdanie z uzasadnieniem. Nie dopisywać powiązań bez podstawy w komunikacie Microsoft.

## Wersja angielska wpisu (obowiązkowa)

- Portal ma przełącznik języka. Każde pole tekstowe wpisu ma odpowiednik angielski w polu z przyrostkiem `_en`: `title_en`, `duration_en`, `summary_en`, `own_probes_en`, `related_note_en`.
- Przy każdej zmianie pola polskiego zaktualizować w tym samym zapisie pole `_en`. Portal dopasowuje tłumaczenie do dokładnego brzmienia pola polskiego, dlatego nieaktualne pole `_en` pokazuje czytelnikowi nieaktualną treść.
- Tekst angielski jest wiernym przekładem tekstu polskiego, bez dodatkowych informacji. Stany Microsoft w brzmieniu angielskim: „Service degradation”, „Service interruption”, „Restoring service”, „Extended recovery”, „Service restored”. Typy zgłoszeń: „incident”, „advisory”. Daty w tym samym formacie co w tekście polskim.

## Obserwacje zewnętrzne do karty analizy (pole `timeline`)

- Portal sam prowadzi kartę analizy każdego incydentu (plik `cases.json` w gałęzi `data`): komunikaty Microsoft i własne pomiary. Zadanie nie zmienia tego pliku.
- Rolą zadania jest uzupełnienie karty o to, czego portal sam nie zmierzy: obserwacje innych podmiotów, na przykład dane o wolumenie ruchu (Cloudflare Radar), zasięgu (ThousandEyes, Downdetector) lub przyczynie (raport Microsoft po zdarzeniu).
- Obserwacje zapisywać we wpisie rejestru w polu `timeline` jako listę obiektów: `t` (czas zdarzenia w formacie ISO 8601, UTC), `source` (nazwa źródła), `url` (adres https), `title` (jedno zdanie), `text` (jedno lub dwa zdania z liczbami podanymi przez źródło) oraz `title_en` i `text_en`.
- Portal dopasowuje wpis rejestru do karty analizy po identyfikatorach z pól `ids` i `related`, dlatego identyfikator Microsoft musi być we wpisie.
- Każda obserwacja musi mieć źródło, które da się otworzyć. Nie zapisywać liczb szacowanych samodzielnie ani obserwacji bez adresu źródła. Jeżeli źródła podają różne wartości, zapisać każdą osobno z nazwą źródła.
- Po zamknięciu incydentu przez Microsoft: ustawić `end`, dopisać do `timeline` raport Microsoft po zdarzeniu, gdy zostanie opublikowany, i zakończyć aktualizowanie wpisu.
