package com.im.codes;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate (which initializes the bridge)
        registerPlugin(AuthSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Forward deep link callbacks to AuthSessionPlugin
        Uri uri = intent.getData();
        if (uri != null && "imcodes".equals(uri.getScheme())) {
            AuthSessionPlugin authPlugin = (AuthSessionPlugin) getBridge().getPlugin("AuthSession").getInstance();
            if (authPlugin != null) {
                authPlugin.handleCallback(uri);
            }
        }
    }
}
