package pl.fieldmaster.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;

final class NativeNotifications {
    static final String OPERATIONS_CHANNEL = "fieldmaster_operations";
    static final String ALERTS_CHANNEL = "fieldmaster_timer_alerts";
    static final int OPERATIONS_ID = 24071;
    private static final int TIMER_RESULT_ID = 24072;

    private NativeNotifications() {
    }

    static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel operations = new NotificationChannel(
            OPERATIONS_CHANNEL,
            "Tryb terenowy Fieldmaster",
            NotificationManager.IMPORTANCE_LOW
        );
        operations.setDescription("Stała lokalizacja i obsługa przycisku Volume Up podczas rozgrywki.");
        operations.setShowBadge(false);
        manager.createNotificationChannel(operations);

        NotificationChannel alerts = new NotificationChannel(
            ALERTS_CHANNEL,
            "Timer Fieldmaster",
            NotificationManager.IMPORTANCE_HIGH
        );
        alerts.setDescription("Potwierdzenie uruchomienia timera i błędy akcji sprzętowych.");
        alerts.enableVibration(true);
        alerts.setVibrationPattern(new long[]{0, 180, 90, 280});
        alerts.setLightColor(Color.rgb(163, 255, 79));
        alerts.enableLights(true);
        alerts.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        manager.createNotificationChannel(alerts);
    }

    static Notification operationsNotification(Context context, String detail) {
        Intent openIntent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(
            context, 10, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent timerIntent = new Intent(context, FieldOperationsService.class)
            .setAction(FieldOperationsService.ACTION_TRIGGER_TIMER);
        PendingIntent timer = PendingIntent.getService(
            context, 11, timerIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(context, FieldOperationsService.class)
            .setAction(FieldOperationsService.ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(
            context, 12, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new Notification.Builder(context, OPERATIONS_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Fieldmaster — tryb terenowy aktywny")
            .setContentText(detail)
            .setStyle(new Notification.BigTextStyle().bigText(
                detail + "\nVolume Up uruchamia timer. Lokalizacja jest wysyłana także po wygaszeniu ekranu."
            ))
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setColor(Color.rgb(163, 255, 79))
            .addAction(new Notification.Action.Builder(
                R.drawable.ic_notification, "URUCHOM TIMER", timer
            ).build())
            .addAction(new Notification.Action.Builder(
                R.drawable.ic_notification, "ZATRZYMAJ", stop
            ).build())
            .build();
    }

    static void showTimerResult(Context context, NativeApiClient.Result result) {
        createChannels(context);
        String title = result.success ? "Timer uruchomiony" : "Nie uruchomiono timera";
        String detail;
        if (result.success && result.seconds > 0) detail = "Odliczanie: " + result.seconds + " s.";
        else if (result.success) detail = "Serwer przyjął akcję Volume Up.";
        else detail = result.message;

        Intent openIntent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(
            context, 13, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new Notification.Builder(context, ALERTS_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(detail)
            .setStyle(new Notification.BigTextStyle().bigText(detail))
            .setCategory(Notification.CATEGORY_EVENT)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setColor(result.success ? Color.rgb(163, 255, 79) : Color.rgb(255, 94, 82))
            .build();

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(TIMER_RESULT_ID, notification);
    }
}
