package com.im.codes;

import android.content.Intent;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android equivalent of the iOS AuthSessionPlugin.
 * Opens a Chrome Custom Tab for passkey authentication,
 * then captures the imcodes:// deep link callback.
 */
@CapacitorPlugin(name = "AuthSession")
public class AuthSessionPlugin extends Plugin {

    private PluginCall pendingCall;
    private String callbackScheme;

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        callbackScheme = call.getString("callbackScheme");

        if (url == null || callbackScheme == null) {
            call.reject("Missing url or callbackScheme");
            return;
        }

        pendingCall = call;
        call.setKeepAlive(true);

        CustomTabsIntent customTabsIntent = new CustomTabsIntent.Builder().build();
        customTabsIntent.launchUrl(getActivity(), Uri.parse(url));
    }

    /**
     * Called by MainActivity when a deep link with the callback scheme is received.
     */
    public void handleCallback(Uri uri) {
        if (pendingCall == null) return;
        if (uri != null && uri.getScheme() != null && uri.getScheme().equals(callbackScheme)) {
            var ret = new com.getcapacitor.JSObject();
            ret.put("url", uri.toString());
            pendingCall.resolve(ret);
            pendingCall = null;
        }
    }

    /**
     * Called when user returns to app without completing auth (e.g. back button).
     */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // Give a small delay — if handleCallback fires from onNewIntent, it will
        // resolve before this timer. If user just pressed back, we reject.
        if (pendingCall != null) {
            getBridge().getWebView().postDelayed(() -> {
                if (pendingCall != null) {
                    pendingCall.reject("cancelled");
                    pendingCall = null;
                }
            }, 1000);
        }
    }
}
