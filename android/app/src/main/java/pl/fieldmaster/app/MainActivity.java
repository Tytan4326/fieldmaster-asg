package pl.fieldmaster.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.File;
import java.lang.ref.WeakReference;

public final class MainActivity extends Activity {
    private static final int REQUEST_FOREGROUND_LOCATION = 4101;
    private static final int REQUEST_BACKGROUND_LOCATION = 4102;
    private static final int REQUEST_NOTIFICATIONS = 4103;
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static WeakReference<MainActivity> foregroundActivity = new WeakReference<>(null);

    private WebView webView;
    private boolean initialPermissionPromptShown;
    private boolean enableFieldModeAfterPermission;
    private GeolocationPermissions.Callback pendingGeolocationCallback;
    private String pendingGeolocationOrigin;
    private long updateDownloadId = -1;
    private boolean downloadReceiverRegistered;
    private String pendingUpdateUrl;
    private String pendingUpdateVersion;
    private final BroadcastReceiver updateDownloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
            long completedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (completedId == updateDownloadId) finishUpdateDownload(completedId);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(11, 14, 12));
        getWindow().setNavigationBarColor(Color.rgb(11, 14, 12));
        getWindow().getDecorView().setSystemUiVisibility(0);
        NativeNotifications.createChannels(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) registerPredictiveBack();
        registerUpdateDownloadReceiver();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(11, 14, 12));
        configureWebView();
        setContentView(webView);

        if (savedInstanceState == null) {
            webView.loadUrl(BuildConfig.FIELDMASTER_URL + "/?view=join&native=android");
        } else {
            webView.restoreState(savedInstanceState);
        }
        webView.postDelayed(this::maybePromptInitialLocation, 700);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " FieldmasterAndroid/" + BuildConfig.VERSION_NAME);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) WebView.startSafeBrowsing(this, null);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.addJavascriptInterface(new NativeBridge(this), "FieldmasterNative");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(
                String origin,
                GeolocationPermissions.Callback callback
            ) {
                if (!isTrustedOrigin(origin)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (hasForegroundLocation()) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingGeolocationOrigin = origin;
                pendingGeolocationCallback = callback;
                requestForegroundLocation(false);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isTrustedUri(uri)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    Toast.makeText(MainActivity.this, "Nie można otworzyć tego adresu.", Toast.LENGTH_LONG).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                notifyWebStatus();
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
                Toast.makeText(this, "Nie można rozpocząć pobierania.", Toast.LENGTH_LONG).show();
            }
        });
    }

    private void maybePromptInitialLocation() {
        if (initialPermissionPromptShown || hasForegroundLocation()) return;
        initialPermissionPromptShown = true;
        new AlertDialog.Builder(this)
            .setTitle("Lokalizacja podczas rozgrywki")
            .setMessage(
                "Fieldmaster potrzebuje lokalizacji dokładnej, aby pokazywać Twoją pozycję GM, " +
                "sprawdzać strefy i prowadzić Replay. Najpierw Android zapyta o lokalizację podczas używania aplikacji."
            )
            .setNegativeButton("Później", null)
            .setPositiveButton("Nadaj uprawnienie", (dialog, which) -> requestForegroundLocation(false))
            .show();
    }

    void requestOperationalPermissions() {
        runOnUiThread(() -> {
            if (!hasForegroundLocation()) {
                requestForegroundLocation(false);
                return;
            }
            requestNotificationPermission();
            requestBackgroundLocationWithExplanation();
        });
    }

    private void requestForegroundLocation(boolean forFieldMode) {
        enableFieldModeAfterPermission |= forFieldMode;
        if (hasForegroundLocation()) {
            completeForegroundPermissionFlow();
            return;
        }
        requestPermissions(
            new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            },
            REQUEST_FOREGROUND_LOCATION
        );
    }

    private void completeForegroundPermissionFlow() {
        boolean granted = hasForegroundLocation();
        if (pendingGeolocationCallback != null) {
            pendingGeolocationCallback.invoke(pendingGeolocationOrigin, granted, false);
            pendingGeolocationCallback = null;
            pendingGeolocationOrigin = null;
        }
        if (!granted) {
            enableFieldModeAfterPermission = false;
            NativeSessionStore.setFieldModeEnabled(this, false);
            Toast.makeText(
                this,
                "Bez lokalizacji GPS tryb terenowy pozostaje wyłączony.",
                Toast.LENGTH_LONG
            ).show();
            notifyWebStatus();
            return;
        }
        requestNotificationPermission();
        if (enableFieldModeAfterPermission) {
            enableFieldModeAfterPermission = false;
            NativeSessionStore.setFieldModeEnabled(this, true);
            requestBackgroundLocationWithExplanation();
            startFieldServiceIfReady();
        }
        notifyWebStatus();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        }
    }

    private void requestBackgroundLocationWithExplanation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || hasBackgroundLocation()) return;
        new AlertDialog.Builder(this)
            .setTitle("GPS po wygaszeniu ekranu")
            .setMessage(
                "Aby pozycja nadal trafiała do GM przy wygaszonym ekranie, ustaw dla Fieldmastera lokalizację " +
                "„Zezwalaj zawsze”. Android wymaga nadania tego uprawnienia w oddzielnym kroku."
            )
            .setNegativeButton("Nie teraz", null)
            .setPositiveButton(
                Build.VERSION.SDK_INT == Build.VERSION_CODES.Q ? "Kontynuuj" : "Otwórz ustawienia",
                (dialog, which) -> {
                    if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
                        requestPermissions(
                            new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION},
                            REQUEST_BACKGROUND_LOCATION
                        );
                    } else {
                        Intent intent = new Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName())
                        );
                        startActivity(intent);
                    }
                }
            )
            .show();
    }

    void enableFieldMode() {
        runOnUiThread(() -> {
            if (!NativeSessionStore.hasSession(this)) {
                Toast.makeText(this, "Najpierw dołącz do sesji jako uczestnik.", Toast.LENGTH_LONG).show();
                return;
            }
            NativeSessionStore.setFieldModeEnabled(this, true);
            if (!hasForegroundLocation()) {
                requestForegroundLocation(true);
                return;
            }
            requestNotificationPermission();
            requestBackgroundLocationWithExplanation();
            startFieldServiceIfReady();
            notifyWebStatus();
        });
    }

    void disableFieldMode() {
        runOnUiThread(() -> {
            FieldOperationsService.stopFieldMode(this);
            notifyWebStatus();
        });
    }

    void openAccessibilitySettings() {
        runOnUiThread(() -> {
            Toast.makeText(
                this,
                "Wybierz „Fieldmaster — przyciski głośności” i włącz usługę.",
                Toast.LENGTH_LONG
            ).show();
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        });
    }

    void openBatteryOptimizationSettings() {
        runOnUiThread(() -> {
            Toast.makeText(
                this,
                "Znajdź Fieldmaster i ustaw brak ograniczeń baterii.",
                Toast.LENGTH_LONG
            ).show();
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        });
    }

    void triggerTimerFromNative() {
        runOnUiThread(() -> {
            if (!NativeSessionStore.hasSession(this)) {
                Toast.makeText(this, "Najpierw dołącz do sesji jako uczestnik.", Toast.LENGTH_LONG).show();
                return;
            }
            if (!hasForegroundLocation()) {
                requestForegroundLocation(false);
                return;
            }
            FieldOperationsService.triggerTimerFromActivity(this);
        });
    }

    void configureHardwareButtons(
        boolean volumeUpEnabled,
        String volumeUpAction,
        boolean volumeDownEnabled,
        String volumeDownAction
    ) {
        runOnUiThread(() -> {
            NativeSessionStore.configureHardwareButtons(
                this,
                volumeUpEnabled,
                volumeUpAction,
                volumeDownEnabled,
                volumeDownAction
            );
            notifyWebStatus();
        });
    }

    void testHardwareButton(String key) {
        runOnUiThread(() -> {
            int keyCode = "DOWN".equalsIgnoreCase(key)
                ? KeyEvent.KEYCODE_VOLUME_DOWN
                : KeyEvent.KEYCODE_VOLUME_UP;
            if (!NativeSessionStore.isHardwareButtonEnabled(this, keyCode)) {
                Toast.makeText(this, "Ten przycisk jest wyłączony.", Toast.LENGTH_SHORT).show();
                return;
            }
            emitHardwareAction(
                keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "Volume Up" : "Volume Down",
                NativeSessionStore.hardwareButtonAction(this, keyCode)
            );
        });
    }

    void installUpdate(String apkUrl, String versionName) {
        runOnUiThread(() -> {
            Uri uri = Uri.parse(apkUrl == null ? "" : apkUrl.trim());
            if (!isTrustedUpdateUri(uri)) {
                Toast.makeText(this, "Odrzucono nieprawidłowy adres aktualizacji.", Toast.LENGTH_LONG).show();
                return;
            }
            if (!getPackageManager().canRequestPackageInstalls()) {
                pendingUpdateUrl = uri.toString();
                pendingUpdateVersion = versionName;
                Toast.makeText(
                    this,
                    "Zezwól Fieldmasterowi instalować aktualizacje, a następnie wróć do aplikacji.",
                    Toast.LENGTH_LONG
                ).show();
                startActivity(new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())
                ));
                return;
            }
            beginUpdateDownload(uri.toString(), versionName);
        });
    }

    private void beginUpdateDownload(String apkUrl, String versionName) {
        DownloadManager manager = getSystemService(DownloadManager.class);
        if (manager == null) {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl)));
            return;
        }
        String safeVersion = versionName == null || versionName.isBlank()
            ? "latest"
            : versionName.replaceAll("[^0-9A-Za-z._-]", "-");
        File directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null) {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl)));
            return;
        }
        File target = new File(directory, "Fieldmaster-" + safeVersion + ".apk");
        if (target.exists()) target.delete();

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(apkUrl))
            .setTitle("Aktualizacja Fieldmaster " + safeVersion)
            .setDescription("Pobieranie podpisanego pakietu APK…")
            .setMimeType(APK_MIME)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(true)
            .setDestinationInExternalFilesDir(
                this,
                Environment.DIRECTORY_DOWNLOADS,
                target.getName()
            );
        updateDownloadId = manager.enqueue(request);
        Toast.makeText(this, "Pobieranie aktualizacji rozpoczęte.", Toast.LENGTH_SHORT).show();
    }

    private void finishUpdateDownload(long downloadId) {
        DownloadManager manager = getSystemService(DownloadManager.class);
        if (manager == null) return;
        try (Cursor cursor = manager.query(
            new DownloadManager.Query().setFilterById(downloadId)
        )) {
            if (cursor == null || !cursor.moveToFirst()) return;
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                Toast.makeText(this, "Nie udało się pobrać aktualizacji.", Toast.LENGTH_LONG).show();
                return;
            }
        }
        Uri apkUri = manager.getUriForDownloadedFile(downloadId);
        if (apkUri == null) {
            Toast.makeText(this, "Nie znaleziono pobranego pakietu APK.", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW)
                .setDataAndType(apkUri, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception error) {
            Toast.makeText(
                this,
                "Android nie otworzył instalatora. Otwórz pobrany plik z powiadomienia.",
                Toast.LENGTH_LONG
            ).show();
        }
    }

    private void registerUpdateDownloadReceiver() {
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        registerReceiver(updateDownloadReceiver, filter, Context.RECEIVER_EXPORTED);
        downloadReceiverRegistered = true;
    }

    private void startFieldServiceIfReady() {
        if (!NativeSessionStore.isFieldModeEnabled(this)
            || !NativeSessionStore.hasSession(this)
            || !hasForegroundLocation()
            || FieldOperationsService.isRunning()) return;
        try {
            FieldOperationsService.startFieldMode(this);
        } catch (SecurityException error) {
            Toast.makeText(
                this,
                "Android zablokował usługę GPS. Sprawdź uprawnienia lokalizacji.",
                Toast.LENGTH_LONG
            ).show();
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        if ((keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)
            && NativeSessionStore.hasSession(this)
            && isParticipantSurface()
            && NativeSessionStore.isHardwareButtonEnabled(this, keyCode)) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                emitHardwareAction(
                    keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "Volume Up" : "Volume Down",
                    NativeSessionStore.hardwareButtonAction(this, keyCode)
                );
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    static boolean dispatchHardwareActionIfForeground(String keyLabel, String action) {
        MainActivity activity = foregroundActivity.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return false;
        activity.runOnUiThread(() -> activity.emitHardwareAction(keyLabel, action));
        return true;
    }

    private void emitHardwareAction(String keyLabel, String action) {
        if (webView == null) return;
        String script = "window.dispatchEvent(new CustomEvent('fieldmaster:native-hardware',{" +
            "detail:{key:" + JSONObject.quote(keyLabel) +
            ",action:" + JSONObject.quote(action) + "}}))";
        webView.evaluateJavascript(script, null);
    }

    private boolean isParticipantSurface() {
        String url = webView == null ? "" : webView.getUrl();
        return url == null || (!url.contains("view=admin") && !url.contains("view=staff"));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_FOREGROUND_LOCATION) {
            completeForegroundPermissionFlow();
            return;
        }
        if (requestCode == REQUEST_BACKGROUND_LOCATION || requestCode == REQUEST_NOTIFICATIONS) {
            startFieldServiceIfReady();
            notifyWebStatus();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        foregroundActivity = new WeakReference<>(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pendingUpdateUrl != null && getPackageManager().canRequestPackageInstalls()) {
            String url = pendingUpdateUrl;
            String version = pendingUpdateVersion;
            pendingUpdateUrl = null;
            pendingUpdateVersion = null;
            beginUpdateDownload(url, version);
        }
        startFieldServiceIfReady();
        notifyWebStatus();
    }

    @Override
    protected void onStop() {
        MainActivity current = foregroundActivity.get();
        if (current == this) foregroundActivity.clear();
        super.onStop();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() {
        handleBackNavigation();
    }

    @TargetApi(Build.VERSION_CODES.TIRAMISU)
    private void registerPredictiveBack() {
        OnBackInvokedCallback callback = this::handleBackNavigation;
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            callback
        );
    }

    private void handleBackNavigation() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finishAfterTransition();
    }

    boolean hasForegroundLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    boolean hasFineLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    boolean hasCoarseLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    boolean hasBackgroundLocation() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    boolean hasNotificationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    boolean isAccessibilityServiceEnabled() {
        ComponentName component = new ComponentName(this, FieldmasterAccessibilityService.class);
        String enabled = Settings.Secure.getString(
            getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        if (enabled == null) return false;
        for (String item : enabled.split(":")) {
            ComponentName candidate = ComponentName.unflattenFromString(item);
            if (component.equals(candidate)) return true;
        }
        return false;
    }

    boolean isIgnoringBatteryOptimizations() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        return manager != null && manager.isIgnoringBatteryOptimizations(getPackageName());
    }

    String nativeStatusJson() {
        JSONObject status = new JSONObject();
        try {
            status.put("native", true);
            status.put("version", BuildConfig.VERSION_NAME);
            status.put("versionCode", BuildConfig.VERSION_CODE);
            status.put("fineLocation", hasFineLocation());
            status.put("coarseLocation", hasCoarseLocation());
            status.put("backgroundLocation", hasBackgroundLocation());
            status.put("notifications", hasNotificationPermission());
            status.put("accessibility", isAccessibilityServiceEnabled());
            status.put("batteryUnrestricted", isIgnoringBatteryOptimizations());
            status.put("fieldMode", NativeSessionStore.isFieldModeEnabled(this));
            status.put("session", NativeSessionStore.hasSession(this));
            status.put("serviceRunning", FieldOperationsService.isRunning());
            status.put("volumeUpEnabled", NativeSessionStore.volumeUpEnabled(this));
            status.put("volumeUpAction", NativeSessionStore.volumeUpAction(this));
            status.put("volumeDownEnabled", NativeSessionStore.volumeDownEnabled(this));
            status.put("volumeDownAction", NativeSessionStore.volumeDownAction(this));
            status.put("canInstallUpdates", getPackageManager().canRequestPackageInstalls());
        } catch (Exception ignored) {
        }
        return status.toString();
    }

    void notifyWebStatus() {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('fieldmaster:native-status'))",
            null
        ));
    }

    private boolean isTrustedOrigin(String origin) {
        try {
            return isTrustedUri(Uri.parse(origin));
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isTrustedUri(Uri uri) {
        Uri expected = Uri.parse(BuildConfig.FIELDMASTER_URL);
        return "https".equalsIgnoreCase(uri.getScheme())
            && expected.getHost() != null
            && expected.getHost().equalsIgnoreCase(uri.getHost());
    }

    private boolean isTrustedUpdateUri(Uri uri) {
        return isTrustedUri(uri)
            && "/downloads/Fieldmaster-android.apk".equals(uri.getPath());
    }

    @Override
    protected void onDestroy() {
        MainActivity current = foregroundActivity.get();
        if (current == this) foregroundActivity.clear();
        if (downloadReceiverRegistered) {
            unregisterReceiver(updateDownloadReceiver);
            downloadReceiverRegistered = false;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("FieldmasterNative");
            webView.destroy();
        }
        super.onDestroy();
    }
}
