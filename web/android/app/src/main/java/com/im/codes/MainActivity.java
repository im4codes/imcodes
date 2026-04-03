package com.im.codes;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate (which initializes the bridge)
        registerPlugin(AuthSessionPlugin.class);
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
