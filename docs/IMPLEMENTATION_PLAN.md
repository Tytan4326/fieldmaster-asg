# Plan wykonania i odbiór

## Etap 1 — MVP PWA

Zakres repozytorium: lobby, role, GPS, widoczność drużyn, mapa taktyczna, geofencing, timer ekranowy, SOS, historia, statystyki, CSV, PWA/offline i backend realtime. Odbiór wymaga przejścia scenariusza dwiema kartami uczestników i jedną kartą administratora, poprawnego filtrowania pozycji oraz utrzymania kolejki po odcięciu sieci.

## Etap 2 — stabilizacja pilota

- adapter PostgreSQL, migracje, backup/restore i polityka retencji,
- rozszerzenie automatycznych testów przeglądarkowych do pełnego CI,
- prawdziwe kafle MapLibre i biblioteka MGRS,
- Web Push, monitoring i raport PDF,
- pilotaż dzienny z 10–20 urządzeniami, następnie test 26 h.

## Etap 3 — Android terenowy

- foreground GPS z widocznym powiadomieniem,
- kolejka SQLite i synchronizacja,
- akcja timera w powiadomieniu oraz opcjonalny przycisk sprzętowy,
- polityka oszczędzania baterii i pomiar na wspieranych modelach,
- dobrowolny tryb ograniczony; zawsze dostępne SOS, wyjście i instrukcja wezwania 112.

## Kryteria bezpieczeństwa przed użyciem terenowym

1. Uczestnik widzi i akceptuje aktualną zgodę oraz plan ratunkowy.
2. Operator wykonał test GPS, dźwięku, SOS i łączności dla każdego urządzenia.
3. Awaria serwera/internetu nie blokuje wezwania pomocy; istnieje radio/telefoniczny kanał zapasowy.
4. Test dowodzi, że OPFOR nie otrzymuje pozycji SERE na poziomie API ani websocketu.
5. Znana jest osoba dyżurna, numer alarmowy, punkty ewakuacji i procedura zakończenia gry.
6. Po zakończeniu sesji serwer odrzuca dalsze lokalizacje, a urządzenia zatrzymują watch GPS.

## Testy akceptacyjne MVP

- duplikat kryptonimu w tej samej sesji jest odrzucony;
- drużyna nie może być samodzielnie zmieniona po dołączeniu;
- SERE 20 s i OPFOR 60 s kończą się właściwym komunikatem;
- aktywacja SOS wymaga dwóch świadomych kroków i jest widoczna dla obu drużyn;
- wyjście poza polygon uruchamia alarm lokalny i zapisuje zdarzenie;
- admin może rozpocząć, wstrzymać, wznowić i zakończyć sesję;
- kolejka offline synchronizuje zdarzenia bez duplikatów;
- CSV zawiera uczestników, liczniki i znaczące zdarzenia;
- po zakończeniu gry klient zatrzymuje geolokalizację.
