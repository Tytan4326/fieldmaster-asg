package pl.fieldmaster.app;

import android.content.Context;
import android.location.Location;
import android.os.BatteryManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Locale;

final class NativeApiClient {
    private NativeApiClient() {
    }

    static Result triggerTimer(Context context) {
        return post(context, "/api/timers", new JSONObject());
    }

    static Result triggerHardwareAction(Context context, String action) {
        return switch (action == null ? "" : action.trim().toUpperCase(Locale.ROOT)) {
            case "TIMER" -> post(context, "/api/timers", new JSONObject());
            case "HIT" -> post(context, "/api/hits", new JSONObject());
            case "SOS" -> post(context, "/api/sos", new JSONObject());
            default -> Result.failure(400, "Nieobsługiwana akcja przycisku.");
        };
    }

    static Result sendLocation(Context context, Location location) {
        try {
            JSONObject body = new JSONObject()
                .put("latitude", location.getLatitude())
                .put("longitude", location.getLongitude())
                .put("accuracy", Math.max(0, location.getAccuracy()))
                .put("timestamp", Instant.ofEpochMilli(location.getTime()).toString());

            if (location.hasBearing()) {
                body.put("heading", normalizeHeading(location.getBearing()));
                body.put("headingSource", "GPS");
            } else {
                body.put("heading", JSONObject.NULL);
            }
            if (location.hasSpeed()) body.put("speed", Math.max(0, location.getSpeed()));
            else body.put("speed", JSONObject.NULL);

            BatteryManager batteryManager = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
            int battery = batteryManager == null ? -1 : batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            if (battery >= 0 && battery <= 100) body.put("battery", battery);

            return post(context, "/api/locations", body);
        } catch (Exception error) {
            return Result.failure(0, "Nie przygotowano pozycji GPS: " + error.getMessage());
        }
    }

    private static Result post(Context context, String path, JSONObject body) {
        String token = NativeSessionStore.token(context);
        if (token.isBlank()) return Result.failure(401, "Najpierw dołącz do sesji w aplikacji.");

        HttpURLConnection connection = null;
        try {
            URL url = new URL(NativeSessionStore.baseUrl(context) + path);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(15_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "Fieldmaster-Android/" + BuildConfig.VERSION_NAME);
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            connection.getOutputStream().write(payload);

            int status = connection.getResponseCode();
            String responseBody = readBody(status >= 200 && status < 300
                ? connection.getInputStream()
                : connection.getErrorStream());
            JSONObject response = responseBody.isBlank() ? new JSONObject() : new JSONObject(responseBody);
            if (status >= 200 && status < 300) {
                return Result.success(
                    status,
                    response.optLong("endsAt", 0),
                    response.optInt("seconds", 0)
                );
            }
            return Result.failure(status, response.optString("error", "Błąd serwera (" + status + ")."));
        } catch (Exception error) {
            return Result.failure(0, "Brak połączenia z serwerem: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readBody(InputStream input) throws Exception {
        if (input == null) return "";
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
            return body.toString();
        }
    }

    private static double normalizeHeading(float heading) {
        return ((heading % 360f) + 360f) % 360f;
    }

    static final class Result {
        final boolean success;
        final int status;
        final String message;
        final long endsAt;
        final int seconds;

        private Result(boolean success, int status, String message, long endsAt, int seconds) {
            this.success = success;
            this.status = status;
            this.message = message;
            this.endsAt = endsAt;
            this.seconds = seconds;
        }

        static Result success(int status, long endsAt, int seconds) {
            return new Result(true, status, "", endsAt, seconds);
        }

        static Result failure(int status, String message) {
            return new Result(false, status, message, 0, 0);
        }
    }
}
