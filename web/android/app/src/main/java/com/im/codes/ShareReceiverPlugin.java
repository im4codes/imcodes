package com.im.codes;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.MimeTypeMap;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {
    private static final String TAG = "ShareReceiverPlugin";
    public static final long MAX_SHARE_BYTES = 50L * 1024L * 1024L;

    private static final List<JSObject> PENDING_SHARES = new ArrayList<>();
    private static WeakReference<ShareReceiverPlugin> activeInstanceRef = new WeakReference<>(null);

    @Override
    public void load() {
        super.load();
        synchronized (PENDING_SHARES) {
            activeInstanceRef = new WeakReference<>(this);
        }
    }

    @PluginMethod
    public void consumePendingShares(PluginCall call) {
        JSArray items = new JSArray();
        synchronized (PENDING_SHARES) {
            for (JSObject item : PENDING_SHARES) {
                items.put(item);
            }
            PENDING_SHARES.clear();
        }
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    @SuppressWarnings("deprecation")
    public static boolean handleShareIntent(Context context, Intent intent) {
        if (context == null || intent == null) {
            return false;
        }
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return false;
        }

        CharSequence rawText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String sharedText = rawText != null ? rawText.toString().trim() : null;

        Set<Uri> uris = new LinkedHashSet<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri streamUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (streamUri != null) {
                uris.add(streamUri);
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> streamUris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (streamUris != null) {
                for (Uri u : streamUris) {
                    if (u != null) {
                        uris.add(u);
                    }
                }
            }
        }

        ClipData clipData = intent.getClipData();
        if (clipData != null) {
            for (int i = 0; i < clipData.getItemCount(); i++) {
                ClipData.Item item = clipData.getItemAt(i);
                if (item != null && item.getUri() != null) {
                    uris.add(item.getUri());
                }
            }
        }

        // Clear action and extras immediately so configuration changes don't re-trigger
        intent.setAction(null);
        intent.removeExtra(Intent.EXTRA_STREAM);
        intent.removeExtra(Intent.EXTRA_TEXT);
        intent.setClipData(null);

        JSArray filesArray = new JSArray();
        String errorCode = null;
        long totalBytesRead = 0L;
        ContentResolver resolver = context.getContentResolver();

        for (Uri uri : uris) {
            FileMeta meta = resolveFileMeta(resolver, uri);
            if (meta.size > MAX_SHARE_BYTES || totalBytesRead + Math.max(0L, meta.size) > MAX_SHARE_BYTES) {
                errorCode = "file_too_large";
                continue;
            }
            try (InputStream in = resolver.openInputStream(uri)) {
                if (in == null) {
                    if (errorCode == null) errorCode = "read_failed";
                    continue;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[16 * 1024];
                int read;
                long fileBytes = 0L;
                boolean tooLarge = false;
                while ((read = in.read(buffer)) != -1) {
                    fileBytes += read;
                    totalBytesRead += read;
                    if (fileBytes > MAX_SHARE_BYTES || totalBytesRead > MAX_SHARE_BYTES) {
                        tooLarge = true;
                        break;
                    }
                    out.write(buffer, 0, read);
                }
                if (tooLarge) {
                    errorCode = "file_too_large";
                    continue;
                }
                byte[] bytes = out.toByteArray();
                JSObject fileObj = new JSObject();
                fileObj.put("name", meta.name);
                fileObj.put("mimeType", meta.mimeType);
                fileObj.put("size", bytes.length);
                fileObj.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                filesArray.put(fileObj);
            } catch ( Throwable t ) {
                Log.w(TAG, "Failed to read shared URI: " + uri, t);
                if (errorCode == null) {
                    errorCode = "read_failed";
                }
            }
        }

        boolean hasText = sharedText != null && !sharedText.isEmpty();
        if (filesArray.length() == 0 && !hasText && errorCode == null) {
            return false;
        }

        JSObject payload = new JSObject();
        payload.put("id", UUID.randomUUID().toString());
        payload.put("files", filesArray);
        if (hasText) {
            payload.put("text", sharedText);
        }
        if (errorCode != null) {
            payload.put("error", errorCode);
        }

        dispatchOrEnqueue(payload);
        return true;
    }

    private static void dispatchOrEnqueue(JSObject payload) {
        synchronized (PENDING_SHARES) {
            ShareReceiverPlugin instance = activeInstanceRef.get();
            if (instance != null && instance.getBridge() != null && instance.hasListeners("sharedPayload")) {
                instance.notifyListeners("sharedPayload", payload);
            } else {
                PENDING_SHARES.add(payload);
            }
        }
    }

    private static final class FileMeta {
        final String name;
        final String mimeType;
        final long size;

        FileMeta(String name, String mimeType, long size) {
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
        }
    }

    private static FileMeta resolveFileMeta(ContentResolver resolver, Uri uri) {
        String displayName = null;
        long size = -1L;
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
                    displayName = cursor.getString(nameIdx);
                }
                int sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                    size = cursor.getLong(sizeIdx);
                }
            }
        } catch (Throwable ignored) {
            // Fall back to URI path segment below
        }

        if (displayName == null || displayName.trim().isEmpty()) {
            String lastSegment = uri.getLastPathSegment();
            if (lastSegment != null && !lastSegment.trim().isEmpty()) {
                int slashIdx = lastSegment.lastIndexOf('/');
                displayName = slashIdx >= 0 ? lastSegment.substring(slashIdx + 1) : lastSegment;
            }
        }
        if (displayName == null || displayName.trim().isEmpty()) {
            displayName = "shared-file";
        }

        String mimeType = null;
        try {
            mimeType = resolver.getType(uri);
        } catch (Throwable ignored) {
            // Ignore
        }
        if (mimeType == null || mimeType.trim().isEmpty()) {
            int dotIdx = displayName.lastIndexOf('.');
            if (dotIdx >= 0 && dotIdx < displayName.length() - 1) {
                String ext = displayName.substring(dotIdx + 1).toLowerCase(Locale.ROOT);
                mimeType = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            }
        }
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "application/octet-stream";
        }

        return new FileMeta(displayName, mimeType, size);
    }
}
