package pl.fieldmaster.app;

import android.Manifest;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

public final class FieldOperationsService extends Service implements LocationListener {
    static final String ACTION_START = "pl.fieldmaster.app.action.START_FIELD_MODE";
    static final String ACTION_STOP = "pl.fieldmaster.app.action.STOP_FIELD_MODE";
    static final String ACTION_TRIGGER_TIMER = "pl.fieldmaster.app.action.TRIGGER_TIMER";
    private static final long LOCATION_INTERVAL_MS = 5_000;
    private static final float LOCATION_DISTANCE_METERS = 3f;
    private static final AtomicLong LAST_TIMER_TRIGGER = new AtomicLong(0);

    private static volatile boolean running;
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private LocationManager locationManager;
    private long lastLocationSentAt;
    private Location lastLocationSent;

    static void startFieldMode(Context context) {
        NativeSessionStore.setFieldModeEnabled(context, true);
        Intent intent = new Intent(context, FieldOperationsService.class).setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    static void stopFieldMode(Context context) {
        NativeSessionStore.setFieldModeEnabled(context, false);
        Intent intent = new Intent(context, FieldOperationsService.class).setAction(ACTION_STOP);
        if (running) context.startService(intent);
        else context.stopService(intent);
    }

    static void triggerTimerFromActivity(Context context) {
        Intent intent = new Intent(context, FieldOperationsService.class).setAction(ACTION_TRIGGER_TIMER);
        if (running) context.startService(intent);
        else context.startForegroundService(intent);
    }

    static void triggerTimerFromAccessibility(Context context) {
        if (running) {
            context.startService(new Intent(context, FieldOperationsService.class).setAction(ACTION_TRIGGER_TIMER));
            return;
        }
        triggerTimerFallback(context);
    }

    static boolean isRunning() {
        return running;
    }

    private static void triggerTimerFallback(Context context) {
        long now = SystemClock.elapsedRealtime();
        long previous = LAST_TIMER_TRIGGER.getAndSet(now);
        if (now - previous < 900) return;

        Context appContext = context.getApplicationContext();
        PowerManager powerManager = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = powerManager == null ? null : powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "Fieldmaster:VolumeTimerFallback"
        );
        if (wakeLock != null) wakeLock.acquire(20_000);

        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.execute(() -> {
            try {
                NativeApiClient.Result result = NativeApiClient.triggerTimer(appContext);
                NativeNotifications.showTimerResult(appContext, result);
            } finally {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                executor.shutdown();
            }
        });
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        NativeNotifications.createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            NativeSessionStore.setFieldModeEnabled(this, false);
            stopLocationUpdates();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean fieldMode = NativeSessionStore.isFieldModeEnabled(this);
        startAsForeground(fieldMode
            ? "GPS w tle uruchamia się…"
            : "Przetwarzanie akcji przycisku Volume Up…");

        if (fieldMode) startLocationUpdates();
        if (ACTION_TRIGGER_TIMER.equals(action)) triggerTimer();
        return fieldMode ? START_STICKY : START_NOT_STICKY;
    }

    private void startAsForeground(String detail) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            if (hasLocationPermission()) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            startForeground(
                NativeNotifications.OPERATIONS_ID,
                NativeNotifications.operationsNotification(this, detail),
                type
            );
        } else {
            startForeground(
                NativeNotifications.OPERATIONS_ID,
                NativeNotifications.operationsNotification(this, detail)
            );
        }
    }

    private void startLocationUpdates() {
        if (!hasLocationPermission() || !NativeSessionStore.hasSession(this) || locationManager == null) {
            updateOperationsNotification("Brak zgody na lokalizację lub aktywnej sesji.");
            return;
        }
        try {
            locationManager.removeUpdates(this);
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    LOCATION_INTERVAL_MS,
                    LOCATION_DISTANCE_METERS,
                    this,
                    Looper.getMainLooper()
                );
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    15_000,
                    10f,
                    this,
                    Looper.getMainLooper()
                );
            }
            updateOperationsNotification("GPS w tle aktywny. Oczekiwanie na pozycję…");
        } catch (SecurityException error) {
            updateOperationsNotification("Android odebrał uprawnienie lokalizacji.");
        }
    }

    private void stopLocationUpdates() {
        if (locationManager == null) return;
        try {
            locationManager.removeUpdates(this);
        } catch (SecurityException ignored) {
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (!NativeSessionStore.isFieldModeEnabled(this) || !NativeSessionStore.hasSession(this)) return;
        long now = SystemClock.elapsedRealtime();
        float distance = lastLocationSent == null ? Float.MAX_VALUE : lastLocationSent.distanceTo(location);
        boolean accuracyImproved = lastLocationSent != null
            && location.hasAccuracy()
            && lastLocationSent.hasAccuracy()
            && location.getAccuracy() < lastLocationSent.getAccuracy() * 0.7f;
        if (lastLocationSent != null && now - lastLocationSentAt < 8_000 && distance < 5f && !accuracyImproved) {
            return;
        }
        lastLocationSent = new Location(location);
        lastLocationSentAt = now;
        updateOperationsNotification(
            "GPS aktywny • dokładność " + Math.round(Math.max(0, location.getAccuracy())) + " m"
        );
        networkExecutor.execute(() -> NativeApiClient.sendLocation(getApplicationContext(), location));
    }

    private void triggerTimer() {
        long now = SystemClock.elapsedRealtime();
        long previous = LAST_TIMER_TRIGGER.getAndSet(now);
        if (now - previous < 900) return;

        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        PowerManager.WakeLock wakeLock = powerManager == null ? null : powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "Fieldmaster:VolumeTimer"
        );
        if (wakeLock != null) wakeLock.acquire(20_000);

        updateOperationsNotification("Volume Up odebrany • uruchamianie timera…");
        networkExecutor.execute(() -> {
            try {
                NativeApiClient.Result result = NativeApiClient.triggerTimer(getApplicationContext());
                NativeNotifications.showTimerResult(getApplicationContext(), result);
                updateOperationsNotification(result.success
                    ? "Timer uruchomiony • GPS działa w tle"
                    : "Timer odrzucony • " + result.message);
            } finally {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                if (!NativeSessionStore.isFieldModeEnabled(this)) {
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf();
                }
            }
        });
    }

    private void updateOperationsNotification(String detail) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(
                NativeNotifications.OPERATIONS_ID,
                NativeNotifications.operationsNotification(this, detail)
            );
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onProviderEnabled(String provider) {
        updateOperationsNotification("GPS aktywny. Oczekiwanie na pozycję…");
    }

    @Override
    public void onProviderDisabled(String provider) {
        updateOperationsNotification("Włącz lokalizację systemową, aby raportować GPS.");
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        stopLocationUpdates();
        networkExecutor.shutdownNow();
        super.onDestroy();
    }
}
