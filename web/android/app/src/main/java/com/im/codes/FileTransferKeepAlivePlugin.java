package com.im.codes;

import android.content.Context;
import android.webkit.WebView;

import androidx.annotation.Nullable;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin bridging active WebView uploads to FileTransferForegroundService
 * and keeping WebView JS timers running while backgrounded during an upload.
 */
@CapacitorPlugin(name = "FileTransferKeepAlive")
public class FileTransferKeepAlivePlugin extends Plugin {
    private static volatile boolean keepAliveActive = false;

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            call.resolve(ret);
            return;
        }
        String title = call.getString("title");
        String text = call.getString("text");
        keepAliveActive = true;

        Runnable startTask = () -> {
            resumeWebViewTimers(getBridge());
            boolean started = FileTransferForegroundService.start(context, title, text);
            JSObject ret = new JSObject();
            ret.put("started", started);
            call.resolve(ret);
        };

        if (getActivity() != null) {
            getActivity().runOnUiThread(startTask);
        } else {
            startTask.run();
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        keepAliveActive = false;
        Context context = getContext();
        if (context != null) {
            FileTransferForegroundService.stop(context);
        }
        JSObject ret = new JSObject();
        ret.put("stopped", true);
        call.resolve(ret);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (!keepAliveActive) {
            return;
        }
        Bridge bridge = getBridge();
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) {
            webView.post(() -> resumeWebViewTimersIfActive(bridge));
        }
    }

    @Override
    protected void handleOnDestroy() {
        keepAliveActive = false;
        Context context = getContext();
        if (context != null) {
            FileTransferForegroundService.stop(context);
        }
        super.handleOnDestroy();
    }

    public static void resumeWebViewTimersIfActive(@Nullable Bridge bridge) {
        if (!keepAliveActive) {
            return;
        }
        resumeWebViewTimers(bridge);
    }

    private static void resumeWebViewTimers(@Nullable Bridge bridge) {
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) {
            webView.resumeTimers();
        }
    }
}
