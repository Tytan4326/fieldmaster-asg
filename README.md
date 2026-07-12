# FIELDMASTER — ASG / SERE / OPFOR

Fieldmaster to mobilna PWA i panel dowodzenia do dobrowolnych, legalnych szkoleń terenowych. Projekt zawiera działający MVP z backendem realtime, instalowalnym interfejsem mobilnym, trybem offline i lokalnym zapisem sesji.

## Uruchomienie — jeden dwuklik

Kliknij dwukrotnie `START_FIELDMASTER.cmd`. Skrypt sam sprawdzi zależności, uruchomi serwer i otworzy panel administratora.

- Panel administratora: `http://localhost:8080/?view=admin`
- Dołączenie uczestnika: `http://localhost:8080/?view=join`
- PIN administratora: `2468`
- Zamknięcie okna „Fieldmaster Server” zatrzymuje aplikację.
- Stan sesji zapisuje się w `data/local-state.json` i wraca po ponownym uruchomieniu.

Telefon w tej samej sieci może otworzyć adres IP komputera, np. `http://192.168.1.20:8080/?view=join`. Przeglądarki wymagają jednak HTTPS dla prawdziwego GPS, dlatego zastosowanie terenowe na telefonach powinno korzystać z wdrożenia HTTPS.

## Funkcje MVP

- dołączanie przez kod z unikalnym kryptonimem, wyborem SERE/OPFOR i zgodami,
- blokada samodzielnej zmiany drużyny,
- synchronizacja wielu urządzeń przez REST i Socket.IO,
- admin widzi wszystkich; OPFOR tylko OPFOR; SERE tylko siebie,
- aktywny SOS ujawnia pozycję osoby wzywającej pomocy wszystkim,
- GPS w lobby lub podczas aktywnej sesji (według ustawień), geofencing i alarm granicy,
- timer SERE 20 s oraz OPFOR 60 s z sygnałem dźwiękowym,
- dwustopniowe potwierdzenie SOS i obsługa alarmu przez administratora,
- mapa taktyczna, lista uczestników, historia, komunikaty i statystyki,
- eksport raportu CSV,
- instalowalna PWA, cache aplikacji i lokalna kolejka offline,
- trwały lokalny zapis stanu po restarcie serwera.
- wiele równoległych, całkowicie rozdzielonych sesji z własnymi kodami, uczestnikami i stanem,
- 20 funkcji włączanych osobno przez administratora, w tym GPS, granica, SOS, timery, dołączanie i widoczność OPFOR.

## Testy

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& 'C:\Program Files\nodejs\npm.cmd' run check
```

Testy integracyjne uruchamiają osobne serwery i sprawdzają logowanie, duplikaty kryptonimów, prywatność obu drużyn, start gry, timer, SOS, wiele sesji, zmianę kodu oraz blokowanie funkcji.

## Docker

Opcjonalnie:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Aplikacja będzie dostępna pod `http://localhost:8080`.

## Publikacja HTTPS

Plik `render.yaml` jest gotowy do wdrożenia typu Blueprint w Render po umieszczeniu projektu na GitHubie. Podczas pierwszego wdrożenia trzeba ustawić bezpieczne `ADMIN_PASSWORD`; `JWT_SECRET` zostanie wygenerowany automatycznie.

Publiczne wdrożenie:

- aplikacja: `https://fieldmaster-t8t4.onrender.com/`
- panel administratora: `https://fieldmaster-t8t4.onrender.com/?view=admin`
- dołączenie uczestnika: `https://fieldmaster-t8t4.onrender.com/?view=join`
- kryptonim administratora: `GAME-MASTER`
- hasło administratora jest zapisane wyłącznie w lokalnym, ignorowanym przez Git pliku `.env`

Bezpłatna instancja Render usypia się po okresie bezczynności, dlatego pierwsze otwarcie po dłuższej przerwie może potrwać około minuty.

### Telefon, instalacja i GPS

1. Otwórz publiczny link dołączania w Chrome na Androidzie albo Safari na iPhonie.
2. Naciśnij `Zainstaluj aplikację`. Jeżeli system nie pokaże instalatora, aplikacja wyświetli właściwą instrukcję dla telefonu.
3. W ustawieniach strony ustaw lokalizację na `Zezwalaj` i włącz dokładną lokalizację telefonu.
4. Podczas testu GPS pozostaw ekran aktywny i najlepiej wyjdź na otwartą przestrzeń.

Po zaakceptowaniu zgód pozycja jest wysyłana organizatorowi już w lobby, dzięki czemu można sprawdzić urządzenia przed rozpoczęciem gry. Aplikacja najpierw próbuje dokładnego GPS, następnie automatycznie przełącza się na tryb zgodny i ponawia połączenie. Mapa używa domyślnie zdjęć satelitarnych Esri z wymaganym przypisaniem źródła oraz nakładki UTM/MGRS.

Administrator może zmienić drużynę uczestnika w zakładce `Uczestnicy` do momentu rozpoczęcia gry. W górnym pasku przełącza aktywną sesję, a w `Ustawieniach` tworzy kolejne sesje, zmienia ich kody i steruje 20 funkcjami. Granicę edytuje się w `Ustawieniach`: kliknięcie dodaje punkt, przeciągnięcie zielonego uchwytu przesuwa punkt, a wyczyszczenie punktów nie zmienia widoku mapy. Na komputerze bez odbiornika GPS można utworzyć obszar wokół ręcznie ustawionego środka mapy.

Mapa zapamiętuje ręczne przesunięcie i zbliżenie osobno dla każdego widoku i każdej sesji. Automatyczne wyśrodkowanie następuje przy pierwszym otwarciu oraz po rozpoczęciu gry; późniejsze aktualizacje GPS nie przejmują sterowania kamerą.

GitHub Pages nie jest odpowiedni dla tej aplikacji, ponieważ nie uruchamia backendu realtime. Hosting Sites również nie jest używany w obecnej architekturze, ponieważ wymaga Cloudflare Workers zamiast długotrwałego serwera Socket.IO.

## Tryb demonstracyjny

- `/?view=admin` — administrator,
- `/?view=join` — onboarding,
- `/?view=player&team=SERE&callsign=RAVEN&demo=1` — SERE bez prawdziwego GPS,
- `/?view=player&team=OPFOR&callsign=VIPER&demo=1` — OPFOR bez prawdziwego GPS.

## Ograniczenia platform

PWA nie może niezawodnie przechwytywać przycisków głośności ani stale utrzymywać GPS po wygaszeniu ekranu, szczególnie na iOS. Dlatego MVP ma duży przycisk ekranowy timera. Wersja terenowa wymagająca stałego GPS w tle powinna być natywną aplikacją Android z jawnym foreground service. Aplikacja nigdy nie blokuje numeru 112 ani możliwości zakończenia udziału.

## Dokumentacja

- [Architektura i specyfikacja techniczna](docs/ARCHITECTURE.md)
- [Plan wykonania i kryteria odbioru](docs/IMPLEMENTATION_PLAN.md)
- [Model danych PostgreSQL](server/schema.sql)
