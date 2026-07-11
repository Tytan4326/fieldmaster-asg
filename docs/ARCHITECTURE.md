# Specyfikacja techniczna Fieldmaster

## 1. Zakres i zasady bezpieczeństwa

System obsługuje wyłącznie jawne, dobrowolne sesje szkoleniowe. Śledzenie rozpoczyna się po akceptacji zgody i starcie aktywnej sesji, kończy po wyjściu uczestnika lub zakończeniu sesji, a UI stale pokazuje stan GPS. SOS jest zawsze dostępny i czasowo znosi ograniczenia widoczności wyłącznie dla lokalizacji osoby wzywającej pomocy. System nie blokuje telefonu, numerów alarmowych ani wyjścia z aplikacji.

MVP jest PWA „online-first” z bezpieczną kolejką zdarzeń offline. Funkcje wymagające niezawodnego działania w tle należą do późniejszego klienta natywnego Android.

## 2. Architektura

```text
PWA uczestnika ─┐                     ┌─ PostgreSQL (stan, zdarzenia)
PWA admina ─────┼─ HTTPS / Socket.IO ─┤
Android (etap 2)┘                     └─ worker raportów / powiadomień
```

- Klient: semantyczny HTML, CSS, JavaScript ES2022, Web App Manifest, service worker. Brak procesu budowania w prototypie ułatwia audyt i uruchomienie w obecnym środowisku. Docelowo moduły można przenieść 1:1 do React/TypeScript.
- API: Node.js 20, Express, Socket.IO, JWT, walidacja Zod, ograniczanie liczby żądań.
- Dane docelowe: PostgreSQL 16; lokalizacje i zdarzenia są dopisywane, bieżący stan uczestnika jest aktualizowany transakcyjnie. Uruchomienie lokalne używa adaptera pamięciowego z okresowym, atomowym zapisem JSON do `data/local-state.json`. DDL jest gotowy, lecz adapter PostgreSQL pozostaje warunkiem publicznego pilotażu wielosesyjnego.
- Deployment: reverse proxy TLS, kontenery `app` i `db`, healthcheck, sekrety tylko ze zmiennych środowiskowych.

## 3. Role i uprawnienia

| Operacja | Admin | Moderator | SERE | OPFOR |
|---|---:|---:|---:|---:|
| Pełna mapa i historia tras | tak | tak | nie | nie |
| Obsługa SOS/statusów | tak | tak | własny SOS | własny SOS |
| Krytyczne ustawienia/start/koniec | tak | nie | nie | nie |
| Mapa własnej drużyny | tak | tak | opcjonalnie | tak |
| Lokalizacja SERE | tak | tak | tylko własna | nie |
| Lokalizacja aktywnego SOS | tak | tak | tak | tak |

Autoryzacja jest sprawdzana po stronie serwera dla każdego REST endpointu i pokoju Socket.IO. Filtrowanie markerów tylko w UI jest niedopuszczalne.

## 4. Model danych

Główne encje: `users`, `games`, `participants`, `locations`, `events`, `timers`, `sos_alerts`, `messages`, `zones`, `refresh_tokens`. Każdy rekord domenowy zawiera `game_id`, co ogranicza ryzyko przecieku danych pomiędzy sesjami. Lokalizacje mają czas urządzenia i serwera, dokładność oraz opcjonalny stan baterii. Pełne DDL znajduje się w `server/schema.sql`.

Retencja domyślna: dokładne lokalizacje 30 dni, raporty zbiorcze 12 miesięcy, po czym automatyczne usunięcie lub anonimizacja. Administrator może wcześniej usunąć sesję. Zmiana retencji wymaga jawnej informacji w zgodzie.

## 5. API REST

| Metoda i ścieżka | Cel | Uprawnienie |
|---|---|---|
| `POST /api/auth/admin` | logowanie organizatora | publiczne + rate limit |
| `POST /api/games` | utworzenie sesji/kodu | admin |
| `GET /api/games/:code/public` | bezpieczne dane lobby | publiczne |
| `POST /api/games/:code/join` | kryptonim, drużyna, zgody | publiczne + limit |
| `POST /api/games/:id/start|pause|resume|finish` | sterowanie grą | admin |
| `PATCH /api/participants/:id` | status/drużyna | admin/moderator wg pola |
| `POST /api/locations/batch` | pakiet punktów GPS | uczestnik |
| `POST /api/timers` | uruchomienie timera | uczestnik/admin |
| `POST /api/sos` | aktywacja SOS | uczestnik |
| `PATCH /api/sos/:id` | acknowledge/resolve/false-alarm | admin/moderator |
| `POST /api/messages` | komunikat do odbiorców | admin |
| `GET /api/games/:id/events` | filtrowana historia | admin/moderator |
| `GET /api/games/:id/report.csv` | eksport | admin |

Operacje kluczowe przyjmują `Idempotency-Key`, by ponowienie kolejki offline nie tworzyło duplikatów. Serwer ignoruje pozycje z nierealną dokładnością/prędkością, ale nigdy nie ukrywa ostatniej znanej pozycji SOS.

## 6. Realtime

Pokoje: `game:{id}:admin`, `game:{id}:moderators`, `game:{id}:team:{team}`, `participant:{id}`. Po uwierzytelnieniu socket otrzymuje tylko dozwolone zdarzenia:

- klient → serwer: `location:update`, `timer:start`, `sos:activate`, `presence:heartbeat`, `queue:sync`;
- serwer → klient: `state:snapshot`, `participant:public`, `timer:tick`, `sos:changed`, `boundary:changed`, `message:new`, `game:changed`.

Serwer wylicza projekcję widoczności osobno dla każdego pokoju. Aktualizacje GPS są ograniczone do ok. 1/5 s podczas ruchu i 1/30 s podczas postoju. Heartbeat co 20 s; po 60 s uczestnik jest oznaczany jako rozłączony.

## 7. Geofencing i mapa

Granica jest polygonem GeoJSON WGS84. Klient wykonuje szybki test point-in-polygon dla natychmiastowego alarmu; serwer powtarza obliczenie jako źródło prawdy. Histereza (np. 20 m lub trzy kolejne próbki) ogranicza fałszywe alarmy GPS. Strefy mają typ `GAME`, `FORBIDDEN`, `SAFE`, `CHECKPOINT` i widoczność per rola.

Warstwa mapowa produkcyjnie: MapLibre GL + zgodny licencyjnie dostawca kafli lub kafle offline. Współrzędne GPS są przechowywane jako WGS84, a UTM/MGRS wyliczane prezentacyjnie. Prototyp pokazuje lokalną siatkę i pozycje bez zależności od zewnętrznego dostawcy map.

## 8. Offline/PWA

Service worker cache'uje shell aplikacji. Zdarzenia są zapisywane w lokalnej kolejce z UUID, czasem urządzenia i numerem sekwencji. Po odzyskaniu sieci klient wysyła batch, serwer deduplikuje po UUID i zwraca zaakceptowany offset. SOS próbuje wysyłać natychmiast; przy braku sieci UI jasno informuje, że alarm nie dotarł i zaleca użycie telefonu/radia/112.

## 9. Prywatność i zabezpieczenia

- TLS, HSTS, CSP, `HttpOnly Secure SameSite` dla sesji admina; krótkie tokeny uczestnika.
- Hasła Argon2id/bcrypt, rotowane refresh tokeny, rate limit i blokada prób logowania.
- Unikalność `(game_id, normalized_callsign)` oraz blokada drużyny po starcie.
- Walidacja wszystkich payloadów, parametryzowane SQL, limit rozmiaru batchy.
- Dziennik audytowy zmian administratora; brak sekretów i dokładnych pozycji w logach infrastruktury.
- Eksport i usunięcie danych, wersjonowana treść zgody, minimalizacja danych osobowych.
- SOS nie zastępuje 112 ani organizacyjnego planu ratunkowego.

## 10. Ograniczenia platform

PWA nie ma standardowego API przycisków głośności. Geolocation API działa wiarygodnie głównie przy aktywnym ekranie; iOS zawiesza PWA w tle. Web Push wymaga zgody i ma ograniczenia platformowe. Pełnoekranowy tryb PWA nie jest trybem kiosk. Wersja Android powinna używać foreground location service z trwałym powiadomieniem, natywnego handlera przycisków tylko podczas aktywnego szkolenia oraz opcjonalnego, dobrowolnego lock-task mode na zarządzanych urządzeniach.

## 11. Obserwowalność i SLO

- cel dostępności podczas sesji: 99,9%, p95 dystrybucji pozycji < 2 s przy sprawnej sieci;
- metryki: aktywne sockety, wiek ostatniej pozycji, kolejki offline, opóźnienie zdarzeń, błędy GPS;
- alerty: brak heartbeatów serwera, wzrost odrzuceń lokalizacji, niedostarczone SOS;
- test obciążenia: co najmniej 150 uczestników, aktualizacja 5–15 s, sesja soak 26 h.
