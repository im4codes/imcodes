package com.im.codes;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate (which initializes the bridge)
        registerPlugin(AuthSessionPlugin.class);
        registerPlugin(ShareReceiverPlugin.class);
        registerPlugin(NativeClipboardPlugin.class);
        // JPushPlugin only exists in the `china` flavor source set. Load it via
        // reflection so the `global` flavor compiles and runs without any JPush
        // class dependency. (BuildConfig.HAS_JPUSH is set per-flavor in app/build.gradle.)
        if (BuildConfig.HAS_JPUSH) {
            try {
                @SuppressWarnings("unchecked")
                Class<? extends Plugin> jpushClass =
                    (Class<? extends Plugin>) Class.forName("com.im.codes.JPushPlugin");
                registerPlugin(jpushClass);
            } catch (ClassNotFoundException e) {
                Log.w("MainActivity", "JPushPlugin not present despite HAS_JPUSH=true — china flavor sources missing?");
            } catch (Throwable t) {
                Log.e("MainActivity", "Failed to register JPushPlugin", t);
            }
        }
        super.onCreate(savedInstanceState);
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
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
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
}
