# AzureMe Pulse

Portal stanu usług Microsoft 365 i Azure: https://pulse.azureme.pl

Portal co kilka minut sprawdza z internetu publiczne punkty wejścia usług Microsoft, zestawia wynik z komunikatami Microsoft o stanie usług oraz z zewnętrznymi pomiarami sieci i pokazuje to na jednej stronie. Opis sond, źródeł danych i pojęć jest w portalu, w zakładkach „Opis sond” i „Słownik”.

Portal jest projektem prywatnym i nie jest powiązany z firmą Microsoft.

## Praca nad portalem

Źródło portalu to `dev/src.html`; `index.html` jest plikiem generowanym przez `python3 dev/build.py`. Testy są w `dev/tests`, skrypty zrzutów w `dev/shots`. Procedura: `CLAUDE.md`.
