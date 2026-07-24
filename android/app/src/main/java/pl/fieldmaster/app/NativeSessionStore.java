package pl.fieldmaster.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import java.util.Set;
import java.util.Locale;

final class NativeSessionStore {
    private static final String PREFS = "fieldmaster_native";
    private static final String KEY_TOKEN = "participant_token";
    private static final String KEY_BASE_URL = "base_url";
    private static final String KEY_FIELD_MODE = "field_mode";
    private static final String KEY_VOLUME_UP_ENABLED = "volume_up_enabled";
    private static final String KEY_VOLUME_UP_ACTION = "volume_up_action";
    private static final String KEY_VOLUME_DOWN_ENABLED = "volume_down_enabled";
    private static final String KEY_VOLUME_DOWN_ACTION = "volume_down_action";
    private static final Set<String> HARDWARE_ACTIONS = Set.of("TIMER", "HIT", "SOS");

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

    static void configureHardwareButtons(
        Context context,
        boolean volumeUpEnabled,
        String volumeUpAction,
        boolean volumeDownEnabled,
        String volumeDownAction
    ) {
        preferences(context).edit()
            .putBoolean(KEY_VOLUME_UP_ENABLED, volumeUpEnabled)
            .putString(KEY_VOLUME_UP_ACTION, validatedHardwareAction(volumeUpAction, "TIMER"))
            .putBoolean(KEY_VOLUME_DOWN_ENABLED, volumeDownEnabled)
            .putString(KEY_VOLUME_DOWN_ACTION, validatedHardwareAction(volumeDownAction, "HIT"))
            .apply();
    }

    static boolean isHardwareButtonEnabled(Context context, int keyCode) {
        if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP) {
            return preferences(context).getBoolean(KEY_VOLUME_UP_ENABLED, true);
        }
        if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN) {
            return preferences(context).getBoolean(KEY_VOLUME_DOWN_ENABLED, false);
        }
        return false;
    }

    static String hardwareButtonAction(Context context, int keyCode) {
        if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP) {
            return validatedHardwareAction(
                preferences(context).getString(KEY_VOLUME_UP_ACTION, "TIMER"),
                "TIMER"
            );
        }
        if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN) {
            return validatedHardwareAction(
                preferences(context).getString(KEY_VOLUME_DOWN_ACTION, "HIT"),
                "HIT"
            );
        }
        return "";
    }

    static boolean volumeUpEnabled(Context context) {
        return preferences(context).getBoolean(KEY_VOLUME_UP_ENABLED, true);
    }

    static String volumeUpAction(Context context) {
        return hardwareButtonAction(context, android.view.KeyEvent.KEYCODE_VOLUME_UP);
    }

    static boolean volumeDownEnabled(Context context) {
        return preferences(context).getBoolean(KEY_VOLUME_DOWN_ENABLED, false);
    }

    static String volumeDownAction(Context context) {
        return hardwareButtonAction(context, android.view.KeyEvent.KEYCODE_VOLUME_DOWN);
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

    private static String validatedHardwareAction(String candidate, String fallback) {
        String action = candidate == null ? "" : candidate.trim().toUpperCase(Locale.ROOT);
        return HARDWARE_ACTIONS.contains(action) ? action : fallback;
    }
}
