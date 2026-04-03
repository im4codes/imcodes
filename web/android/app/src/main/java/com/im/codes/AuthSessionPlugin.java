package com.im.codes;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android equivalent of the iOS AuthSessionPlugin.
 * Opens a Chrome Custom Tab for passkey authentication,
 * then captures the imcodes:// deep link callback.
 */
@CapacitorPlugin(name = "AuthSession")
public class AuthSessionPlugin extends Plugin {

    private static final String ERROR_MISSING_PARAMETERS = "missing_parameters";
    private static final String ERROR_NO_BROWSER_AVAILABLE = "no_browser_available";
    private static final String ERROR_CUSTOM_TAB_FAILED = "custom_tab_failed";
    private static final String ERROR_USER_CANCELLED = "user_cancelled";
    private static final int CALLBACK_TIMEOUT_MS = 3000;

    private PluginCall pendingCall;
    private String callbackScheme;
    private boolean callbackReceived;

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        callbackScheme = call.getString("callbackScheme");

        if (url == null || callbackScheme == null) {
            call.reject("Missing url or callbackScheme", ERROR_MISSING_PARAMETERS);
            return;
        }

        pendingCall = call;
        callbackReceived = false;

        Uri uri = Uri.parse(url);
        if (launchCustomTab(uri) || launchBrowserIntent(uri)) {
            call.setKeepAlive(true);
            return;
        }

        pendingCall = null;
        callbackReceived = false;
        call.reject("No browser available for authentication", ERROR_NO_BROWSER_AVAILABLE);
    }

    private boolean launchCustomTab(Uri uri) {
        if (getActivity() == null) {
            return false;
        }
        try {
            CustomTabsIntent customTabsIntent = new CustomTabsIntent.Builder().build();
            customTabsIntent.launchUrl(getActivity(), uri);
            return true;
        } catch (ActivityNotFoundException exception) {
            return false;
        }
    }

    private boolean launchBrowserIntent(Uri uri) {
        if (getActivity() == null) {
            return false;
        }
        Intent viewIntent = new Intent(Intent.ACTION_VIEW, uri);
        viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (getActivity().getPackageManager().resolveActivity(viewIntent, PackageManager.MATCH_DEFAULT_ONLY) == null) {
            return false;
        }
        try {
            getActivity().startActivity(viewIntent);
            return true;
        } catch (ActivityNotFoundException exception) {
            return false;
        }
    }

    private void rejectPendingCall(String message, String code) {
        if (pendingCall != null) {
            PluginCall currentCall = pendingCall;
            pendingCall = null;
            callbackReceived = false;
            currentCall.reject(message, code);
        }
    }

    /**
     * Called by MainActivity when a deep link with the callback scheme is received.
     */
    public void handleCallback(Uri uri) {
        if (pendingCall == null) return;
        if (uri != null && uri.getScheme() != null && uri.getScheme().equals(callbackScheme)) {
            callbackReceived = true;
            JSObject ret = new JSObject();
            ret.put("url", uri.toString());
            pendingCall.resolve(ret);
            pendingCall = null;
            callbackReceived = false;
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
        if (pendingCall != null && !callbackReceived) {
            getBridge().getWebView().postDelayed(() -> {
                if (pendingCall != null && !callbackReceived) {
                    rejectPendingCall("Authentication cancelled", ERROR_USER_CANCELLED);
                }
            }, CALLBACK_TIMEOUT_MS);
        }
    }
}
