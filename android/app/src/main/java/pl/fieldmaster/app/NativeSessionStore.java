package pl.fieldmaster.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

final class NativeSessionStore {
    private static final String PREFS = "fieldmaster_native";
    private static final String KEY_TOKEN = "participant_token";
    private static final String KEY_BASE_URL = "base_url";
    private static final String KEY_FIELD_MODE = "field_mode";

    private NativeSessionStore() {
    }

    static void configureSession(Context context, String token, String baseUrl) {
        SharedPreferences.Editor editor = preferences(context).edit();
        if (token == null || token.isBlank()) {
            editor.remove(KEY_TOKEN).remove(KEY_BASE_URL).putBoolean(KEY_FIELD_MODE, false).apply();
            return;
        }
        editor.putString(KEY_TOKEN, token.trim());
        editor.putString(KEY_BASE_URL, validatedBaseUrl(baseUrl));
        editor.apply();
    }

    static String token(Context context) {
        return preferences(context).getString(KEY_TOKEN, "");
    }

    static String baseUrl(Context context) {
        return preferences(context).getString(KEY_BASE_URL, BuildConfig.FIELDMASTER_URL);
    }

    static boolean hasSession(Context context) {
        return !token(context).isBlank();
    }

    static boolean isFieldModeEnabled(Context context) {
        return preferences(context).getBoolean(KEY_FIELD_MODE, false);
    }

    static void setFieldModeEnabled(Context context, boolean enabled) {
        preferences(context).edit().putBoolean(KEY_FIELD_MODE, enabled).apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String validatedBaseUrl(String candidate) {
        try {
            Uri expected = Uri.parse(BuildConfig.FIELDMASTER_URL);
            Uri parsed = Uri.parse(candidate == null ? "" : candidate.trim());
            if (!"https".equalsIgnoreCase(parsed.getScheme())) return BuildConfig.FIELDMASTER_URL;
            if (!expected.getHost().equalsIgnoreCase(parsed.getHost())) return BuildConfig.FIELDMASTER_URL;
            return parsed.buildUpon().path("").query(null).fragment(null).build().toString().replaceAll("/$", "");
        } catch (Exception ignored) {
            return BuildConfig.FIELDMASTER_URL;
        }
    }
}
