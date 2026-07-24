package pl.fieldmaster.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

public final class FieldmasterAccessibilityService extends AccessibilityService {
    private long lastTriggerAt;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.flags |= AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS;
            setServiceInfo(info);
        }
    }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            return false;
        }
        if (!NativeSessionStore.isFieldModeEnabled(this) || !NativeSessionStore.hasSession(this)) return false;
        if (!NativeSessionStore.isHardwareButtonEnabled(this, keyCode)) return false;

        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            long now = SystemClock.elapsedRealtime();
            if (now - lastTriggerAt >= 900) {
                lastTriggerAt = now;
                String action = NativeSessionStore.hardwareButtonAction(this, keyCode);
                String keyLabel = keyCode == KeyEvent.KEYCODE_VOLUME_UP ? "Volume Up" : "Volume Down";
                if (!MainActivity.dispatchHardwareActionIfForeground(keyLabel, action)) {
                    FieldOperationsService.triggerHardwareActionFromAccessibility(this, action, keyLabel);
                }
            }
        }
        return true;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Usługa nie czyta treści ekranu ani elementów interfejsu.
    }

    @Override
    public void onInterrupt() {
        // Brak strumienia mowy lub innego zadania wymagającego przerwania.
    }
}
