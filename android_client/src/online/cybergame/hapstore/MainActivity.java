package online.cybergame.hapstore;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private WebView webView;
    private long lastBackPressTime = 0;
    private static final long BACK_PRESS_INTERVAL = 2000;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        initCrashHandler();
        super.onCreate(savedInstanceState);

        try {
            // 1. Инициализация WebView
            webView = new WebView(this);
            webView.setBackgroundColor(Color.parseColor("#060412"));
            setContentView(webView);

            // 2. Аппаратное ускорение рендеринга WebGL / Canvas
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

            // 3. Настройка WebSettings
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setMediaPlaybackRequiresUserGesture(false); // Автовоспроизведение звука и видео
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);
            settings.setSupportZoom(false);
            settings.setBuiltInZoomControls(false);
            settings.setDisplayZoomControls(false);

            // 4. CookieManager для сохранения игровых сессий
            try {
                CookieManager cookieManager = CookieManager.getInstance();
                cookieManager.setAcceptCookie(true);
                cookieManager.setAcceptThirdPartyCookies(webView, true);
            } catch (Throwable ignored) {}

            // 5. Автономный перехват локальных ассетов для домена localhost (CORS-friendly)
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return handleLocalRequest(request.getUrl());
                }

                @SuppressWarnings("deprecation")
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                    return handleLocalRequest(Uri.parse(url));
                }
            });

            // 6. Полноэкранный режим Edge-to-Edge
            setupEdgeToEdge();

            // 7. Загрузка стартовой страницы HCG
            webView.loadUrl("https://localhost/index.html");

        } catch (Throwable t) {
            logFatalError("onCreate error", t);
        }
    }

    private WebResourceResponse handleLocalRequest(Uri uri) {
        if (uri == null) return null;
        String host = uri.getHost();

        // Перехватываем все запросы к localhost и 127.0.0.1
        if ("localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host)) {
            String path = uri.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) {
                path = "/index.html";
            }
            if (path.startsWith("/")) {
                path = path.substring(1);
            }

            try {
                InputStream is = getAssets().open(path);
                String mimeType = getMimeType(path);

                Map<String, String> responseHeaders = new HashMap<>();
                responseHeaders.put("Access-Control-Allow-Origin", "*");
                responseHeaders.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                responseHeaders.put("Access-Control-Allow-Headers", "*");
                responseHeaders.put("Cache-Control", "no-cache");

                return new WebResourceResponse(mimeType, "UTF-8", 200, "OK", responseHeaders, is);
            } catch (IOException e) {
                // Если файл не найден напрямую, пробуем относительный путь в assets/
                if (!path.startsWith("assets/")) {
                    try {
                        InputStream is = getAssets().open("assets/" + path);
                        String mimeType = getMimeType(path);
                        Map<String, String> responseHeaders = new HashMap<>();
                        responseHeaders.put("Access-Control-Allow-Origin", "*");
                        return new WebResourceResponse(mimeType, "UTF-8", 200, "OK", responseHeaders, is);
                    } catch (IOException ignored) {}
                }
            }
        }
        // Внешние запросы к боевому серверу (https://hapstore.cyber-game.online) уходят в сеть штатно
        return null;
    }

    private String getMimeType(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }

    private void setupEdgeToEdge() {
        try {
            Window window = getWindow();
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            );

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams layoutParams = window.getAttributes();
                layoutParams.layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(layoutParams);
            }
        } catch (Throwable ignored) {}
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            setupEdgeToEdge();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            try {
                webView.onPause();
                webView.pauseTimers();
            } catch (Throwable ignored) {}
        }
        try {
            CookieManager.getInstance().flush();
        } catch (Throwable ignored) {}
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            try {
                webView.resumeTimers();
                webView.onResume();
            } catch (Throwable ignored) {}
        }
    }

    @Override
    public void onBackPressed() {
        long currentTime = System.currentTimeMillis();
        if (currentTime - lastBackPressTime < BACK_PRESS_INTERVAL) {
            super.onBackPressed();
        } else {
            lastBackPressTime = currentTime;
            Toast.makeText(this, "Нажмите назад ещё раз, чтобы выйти из HCG", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            try {
                webView.destroy();
            } catch (Throwable ignored) {}
            webView = null;
        }
        super.onDestroy();
    }

    private void initCrashHandler() {
        Thread.UncaughtExceptionHandler defaultHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            logFatalError("UncaughtException", throwable);
            if (defaultHandler != null) {
                defaultHandler.uncaughtException(thread, throwable);
            }
        });
    }

    private void logFatalError(String context, Throwable throwable) {
        try {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            throwable.printStackTrace(pw);
            String stackTrace = sw.toString();

            File crashFile = new File("/storage/emulated/0/Download/hcg-crash.log");
            FileWriter fw = new FileWriter(crashFile, true);
            fw.write("=== HCG CRASH REPORT (" + context + ") ===\n");
            fw.write("Time: " + new java.util.Date() + "\n");
            fw.write("Device: " + Build.MANUFACTURER + " " + Build.MODEL + " (Android " + Build.VERSION.RELEASE + ", API " + Build.VERSION.SDK_INT + ")\n\n");
            fw.write(stackTrace);
            fw.write("\n===========================================\n\n");
            fw.close();
        } catch (Throwable ignored) {}
    }
}
