package com.im.codes;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Reads plain text from the Android system clipboard on explicit user tap,
 * avoiding WebView navigator.clipboard.readText() permission restrictions.
 */
@CapacitorPlugin(name = "NativeClipboard")
public class NativeClipboardPlugin extends Plugin {

    @PluginMethod
    public void readText(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable");
            return;
        }
        activity.runOnUiThread(() -> {
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null) {
                call.reject("Clipboard service unavailable");
                return;
            }
            String text = "";
            if (clipboard.hasPrimaryClip()) {
                ClipData clip = clipboard.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence coerced = clip.getItemAt(0).coerceToText(activity);
                    if (coerced != null) {
                        text = coerced.toString();
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("text", text);
            call.resolve(result);
        });
    }
}
