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

## Najważniejsze funkcje

- dołączanie przez kod z unikalnym kryptonimem, wyborem SERE/OPFOR i zgodami,
- blokada samodzielnej zmiany drużyny,
- synchronizacja wielu urządzeń przez REST i Socket.IO,
- widoczność graczy wynika z roli, drużyny operacyjnej, uprawnień i reguł scenariusza,
- aktywny SOS ujawnia pozycję osoby wzywającej pomocy wszystkim,
- GPS w lobby lub podczas aktywnej sesji (według ustawień), geofencing i alarm granicy,
- timer SERE 20 s oraz OPFOR 60 s z sygnałem dźwiękowym,
- dwustopniowe potwierdzenie SOS i obsługa alarmu przez administratora,
- mapa taktyczna, lista uczestników, historia, komunikaty i statystyki,
- eksport raportu CSV,
- instalowalna PWA, cache aplikacji i lokalna kolejka offline,
- trwały lokalny zapis stanu po restarcie serwera,
- wiele równoległych, całkowicie rozdzielonych sesji z własnymi kodami, uczestnikami i stanem,
- 55 funkcji włączanych osobno przez administratora, wraz z oznaczeniami zalecanymi dla aktywnego trybu,
- konfigurowalny pilot Bluetooth/selfie: dwa uczone sygnały i osobne działania gracza, m.in. trafienie, timer, akcja strefy, SOS, mapa, kompas i funkcje sędziego,
- symetryczny FOV z osią kierunku oraz automatyczna kalibracja obrotu telefonu na podstawie kolejnych odcinków ruchu GPS,
- panel drużyn operacyjnych: dodawanie, usuwanie, limity osób, kolor, kanał radiowy, widoczność mapy, dozwolone role i własny czas respawnu,
- edytowalne role ze zdolnościami kontrolowanymi także indywidualnie: medyk leczy pobliskich rannych, a neutralny i niezniszczalny sędzia może z telefonu zatrzymać grę, nadać alarm oraz pokazać lub ukryć własny GPS,
- samodzielny respawn przełączany przez GM; po wyłączeniu wyeliminowana osoba czeka na medyka albo sędziego,
- presety całej operacji oraz trwałe presety kont personelu; konta mają zakres strony/drużyny, datę wygaśnięcia, notatki i unieważnianie wszystkich zalogowanych urządzeń,
- uproszczony ekran gracza z akcjami na górze oraz oddzielną zakładką informacji, telemetrii i ID operatora,
- wielopoziomowy podręcznik w aplikacji opisujący tryby, role, konta, uprawnienia, GPS, mapę, respawn i bezpieczeństwo,
- pełne archiwum przebiegu: ustawienia, uczestnicy, zdarzenia, wiadomości, SOS i trasy GPS; zapis ręczny i automatyczny przy zakończeniu/resetowaniu,
- eksport archiwum JSON, raport CSV i sterowany czasem Replay tras.

## Testy

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& 'C:\Program Files\nodejs\npm.cmd' run check
```

Testy integracyjne uruchamiają osobne serwery i sprawdzają również drużyny, role, leczenie, neutralnego sędziego, blokadę samodzielnego respawnu, presety oraz wygasanie i unieważnianie kont personelu. `npm run qa:visual` uruchamia Edge i kontroluje układ paneli na komputerze oraz telefonie.

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
- aplikacja dowódcy / personelu: `https://fieldmaster-t8t4.onrender.com/staff.html`
- aplikacja Mistrza Gry: `https://fieldmaster-t8t4.onrender.com/admin.html`
- dołączenie uczestnika: `https://fieldmaster-t8t4.onrender.com/`
- kryptonim administratora: `GAME-MASTER`
- hasło administratora jest zapisane wyłącznie w lokalnym, ignorowanym przez Git pliku `.env`

Bezpłatna instancja Render usypia się po okresie bezczynności, dlatego pierwsze otwarcie po dłuższej przerwie może potrwać około minuty.

### Telefon, instalacja i GPS

1. Otwórz publiczny link dołączania w Chrome na Androidzie albo Safari na iPhonie.
2. Naciśnij `Zainstaluj aplikację`. Jeżeli system nie pokaże instalatora, aplikacja wyświetli właściwą instrukcję dla telefonu.
3. W ustawieniach strony ustaw lokalizację na `Zezwalaj` i włącz dokładną lokalizację telefonu.
4. Podczas testu GPS pozostaw ekran aktywny i najlepiej wyjdź na otwartą przestrzeń.

Pilot konfiguruje się w panelu gracza w `INFO → Pilot Bluetooth / selfie`. Najpierw włącz sterowanie, wybierz działanie A/B i użyj `Naucz sygnał` dla każdego fizycznego przycisku. Zwykła PWA nie może zagwarantować odbioru klawiszy głośności po zablokowaniu telefonu; przy wygaszonym ekranie najlepiej działają sygnały multimedialne, a system Android musi pozostawić aplikację aktywną. Pełna gwarancja wymaga natywnej wersji Android z usługą pierwszoplanową.

Kalibracja FOV działa po włączeniu kompasu. Gracz powinien przejść prosto 15–30 metrów; aplikacja porówna kierunek ruchu GPS z ułożeniem telefonu, zapisze korektę i będzie ją dalej wygładzać.

Po zaakceptowaniu zgód pozycja jest wysyłana organizatorowi już w lobby, dzięki czemu można sprawdzić urządzenia przed rozpoczęciem gry. Aplikacja najpierw próbuje dokładnego GPS, następnie automatycznie przełącza się na tryb zgodny i ponawia połączenie. Mapa używa domyślnie zdjęć satelitarnych Esri z wymaganym przypisaniem źródła oraz nakładki UTM/MGRS.

Administrator może zmienić stronę, drużynę operacyjną i rolę uczestnika w zakładce `Uczestnicy`. W `Drużyny i role` zarządza strukturą oddziałów oraz funkcjonalnymi zdolnościami. W `Ustawienia → Presety` może przygotować całą operację jednym kliknięciem, a w `Archiwum` zapisać i pobrać pełny przebieg. Granicę edytuje się w `Ustawieniach`: kliknięcie dodaje punkt, przeciągnięcie zielonego uchwytu przesuwa punkt, a wyczyszczenie punktów nie zmienia widoku mapy. Na komputerze bez odbiornika GPS można utworzyć obszar wokół ręcznie ustawionego środka mapy.

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
