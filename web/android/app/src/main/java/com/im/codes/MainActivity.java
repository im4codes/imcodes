package com.im.codes;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate (which initializes the bridge)
        registerPlugin(AuthSessionPlugin.class);
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
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
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
