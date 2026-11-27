package com.im.codes;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;
import com.imcodes.speech.SpeechModelExtractor;
import com.imcodes.speech.StreamingSpeechPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate (which initializes the bridge)
        registerPlugin(AuthSessionPlugin.class);
        registerPlugin(ShareReceiverPlugin.class);
        registerPlugin(NativeClipboardPlugin.class);
        registerPlugin(FileTransferKeepAlivePlugin.class);
        registerPlugin(BackgroundPushPlugin.class);
        if (!isPluginListedInCapacitorPlugins("com.imcodes.speech.StreamingSpeechPlugin")) {
            registerPlugin(StreamingSpeechPlugin.class);
        }
        super.onCreate(savedInstanceState);
        SpeechModelExtractor.warmUpAsync(this);
        // Lock OS-level accessibility font scaling so fixed-width mobile controls/cards stay proportional.
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            if (settings != null) {
                settings.setTextZoom(100);
            }
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM
                && getBridge() != null && getBridge().getWebView() != null) {
            View webViewParent = (View) getBridge().getWebView().getParent();
            if (webViewParent != null) {
                ViewCompat.setOnApplyWindowInsetsListener(webViewParent, (v, insets) -> {
                    int bottom = 0;
                    if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
                        Insets imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime());
                        bottom = Math.max(0, imeInsets.bottom);
                    }
                    ViewGroup.LayoutParams rawLp = v.getLayoutParams();
                    if (rawLp instanceof ViewGroup.MarginLayoutParams) {
                        ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) rawLp;
                        if (lp.bottomMargin != bottom) {
                            lp.bottomMargin = bottom;
                            v.setLayoutParams(lp);
                        }
                    }
                    return ViewCompat.onApplyWindowInsets(v, insets);
                });
            }
        }
        ShareReceiverPlugin.handleShareIntent(this, getIntent());
        BackgroundPushPlugin.handleNotificationIntent(getIntent());
    }

    @Override
    public void onPause() {
        super.onPause();
        FileTransferKeepAlivePlugin.resumeWebViewTimersIfActive(getBridge());
    }

    @Override
    public void onDestroy() {
        FileTransferForegroundService.stop(this);
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
        BackgroundPushPlugin.handleNotificationIntent(intent);
        // Forward external file/text shares to ShareReceiverPlugin
        if (ShareReceiverPlugin.handleShareIntent(this, intent)) {
            return;
        }
        // Forward deep link callbacks to AuthSessionPlugin
        if (intent == null) {
            return;
        }
        Uri uri = intent.getData();
        if (uri == null || !"imcodes".equals(uri.getScheme()) || getBridge() == null) {
            return;
        }
        PluginHandle pluginHandle = getBridge().getPlugin("AuthSession");
        if (pluginHandle == null) {
            return;
        }
        Object instance = pluginHandle.getInstance();
        if (instance instanceof AuthSessionPlugin) {
            ((AuthSessionPlugin) instance).handleCallback(uri);
        }
    }

    private boolean isPluginListedInCapacitorPlugins(String classpath) {
        String quoted = "\"" + classpath + "\"";
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(getAssets().open("capacitor.plugins.json"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.contains(quoted)) {
                    return true;
                }
            }
        } catch (Exception ignored) {
            // Asset may be absent or stale in cap-copy-only builds; fall back to explicit registration.
        }
        return false;
    }
}
