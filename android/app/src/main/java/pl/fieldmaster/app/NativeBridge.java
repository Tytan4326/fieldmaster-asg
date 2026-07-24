package pl.fieldmaster.app;

import android.webkit.JavascriptInterface;

import java.lang.ref.WeakReference;

public final class NativeBridge {
    private final WeakReference<MainActivity> activityReference;

    NativeBridge(MainActivity activity) {
        activityReference = new WeakReference<>(activity);
    }

    @JavascriptInterface
    public void configureSession(String token, String baseUrl) {
        MainActivity activity = activityReference.get();
        if (activity == null) return;
        NativeSessionStore.configureSession(activity, token, baseUrl);
        if (token == null || token.isBlank()) activity.disableFieldMode();
        activity.notifyWebStatus();
    }

    @JavascriptInterface
    public void setFieldMode(boolean enabled) {
        MainActivity activity = activityReference.get();
        if (activity == null) return;
        if (enabled) activity.enableFieldMode();
        else activity.disableFieldMode();
    }

    @JavascriptInterface
    public void requestLocationPermissions() {
        MainActivity activity = activityReference.get();
        if (activity != null) activity.requestOperationalPermissions();
    }

    @JavascriptInterface
    public void openAccessibilitySettings() {
        MainActivity activity = activityReference.get();
        if (activity != null) activity.openAccessibilitySettings();
    }

    @JavascriptInterface
    public void openBatteryOptimizationSettings() {
        MainActivity activity = activityReference.get();
        if (activity != null) activity.openBatteryOptimizationSettings();
    }

    @JavascriptInterface
    public void triggerTimer() {
        MainActivity activity = activityReference.get();
        if (activity != null) activity.triggerTimerFromNative();
    }

    @JavascriptInterface
    public String getStatus() {
        MainActivity activity = activityReference.get();
        return activity == null ? "{\"native\":false}" : activity.nativeStatusJson();
    }

    @JavascriptInterface
    public String getVersion() {
        return BuildConfig.VERSION_NAME;
    }
}
