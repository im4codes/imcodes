package com.imcodes.speech;

import android.content.Context;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Extracts compressed Qwen3-ASR offline speech assets from APK assets into the
 * app's private no-backup cache directory using single-flight background
 * coordination and atomic ".part" file publication.
 */
public final class SpeechModelExtractor {
    public static final String MODEL_CACHE_DIR = "qwen3-asr-9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e";
    public static final String CACHE_COMPLETE_MARKER = ".cache-complete";
    public static final String[] MODEL_FILES = {
        "conv_frontend.onnx",
        "encoder.int4.onnx",
        "encoder.int4.weights",
        "decoder.int4.onnx",
        "decoder.int4.weights",
        "tokenizer/vocab.json",
        "tokenizer/merges.txt",
        "tokenizer/tokenizer_config.json",
        "hotwords.txt"
    };

    private static final int COPY_BUFFER_BYTES = 65536;

    private static final ExecutorService WARMUP_EXECUTOR = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "imcodes-speech-model-warmup");
        thread.setDaemon(true);
        thread.setPriority(Math.min(Thread.NORM_PRIORITY, Thread.MIN_PRIORITY + 1));
        return thread;
    });

    private static final Object FLIGHT_LOCK = new Object();
    private static final Map<String, CompletableFuture<File>> IN_FLIGHT = new HashMap<>();

    @FunctionalInterface
    public interface AssetOpener {
        InputStream open(String name) throws IOException;
    }

    private SpeechModelExtractor() {}

    public static File resolveCacheRoot(File noBackupFilesDir) throws IOException {
        if (noBackupFilesDir == null) {
            throw new IOException("Speech no-backup cache directory unavailable");
        }
        return new File(noBackupFilesDir, MODEL_CACHE_DIR);
    }

    public static boolean isCacheComplete(File root) {
        if (root == null) {
            return false;
        }
        File readyMarker = new File(root, CACHE_COMPLETE_MARKER);
        if (!readyMarker.isFile()) {
            return false;
        }
        for (String name : MODEL_FILES) {
            File cached = new File(root, name);
            if (!cached.isFile() || (!"hotwords.txt".equals(name) && cached.length() == 0)) {
                return false;
            }
        }
        return true;
    }

    public static boolean areAssetsAvailable(Context context) {
        if (context == null) {
            return false;
        }
        Context appContext = context.getApplicationContext();
        Context effective = appContext != null ? appContext : context;
        return areAssetsAvailable(effective.getNoBackupFilesDir(), name -> effective.getAssets().open(name));
    }

    public static boolean areAssetsAvailable(File noBackupFilesDir, AssetOpener opener) {
        if (noBackupFilesDir != null && isCacheComplete(new File(noBackupFilesDir, MODEL_CACHE_DIR))) {
            return true;
        }
        if (opener == null) {
            return false;
        }
        for (String name : MODEL_FILES) {
            try (InputStream input = opener.open(name)) {
                if (input == null) {
                    return false;
                }
                if (!"hotwords.txt".equals(name) && input.read() < 0) {
                    return false;
                }
            } catch (IOException e) {
                return false;
            }
        }
        return true;
    }

    public static CompletableFuture<File> warmUpAsync(Context context) {
        if (context == null) {
            CompletableFuture<File> failed = new CompletableFuture<>();
            failed.completeExceptionally(new IOException("Android context unavailable"));
            return failed;
        }
        Context appContext = context.getApplicationContext();
        Context effective = appContext != null ? appContext : context;
        try {
            return warmUpAsync(effective.getNoBackupFilesDir(), name -> effective.getAssets().open(name));
        } catch (IOException e) {
            CompletableFuture<File> failed = new CompletableFuture<>();
            failed.completeExceptionally(e);
            return failed;
        }
    }

    public static CompletableFuture<File> warmUpAsync(File noBackupFilesDir, AssetOpener opener) throws IOException {
        if (opener == null) {
            throw new IOException("Speech asset opener unavailable");
        }
        final File cacheRoot = resolveCacheRoot(noBackupFilesDir);
        final String key = cacheKey(cacheRoot);
        final CompletableFuture<File> flight;
        final boolean isOwner;
        synchronized (FLIGHT_LOCK) {
            CompletableFuture<File> existing = IN_FLIGHT.get(key);
            if (existing != null && !existing.isDone()) {
                flight = existing;
                isOwner = false;
            } else {
                CompletableFuture<File> created = new CompletableFuture<>();
                IN_FLIGHT.put(key, created);
                flight = created;
                isOwner = true;
            }
        }
        if (isOwner) {
            try {
                WARMUP_EXECUTOR.execute(() -> {
                    try {
                        extractIfNeeded(cacheRoot, opener);
                        flight.complete(cacheRoot);
                    } catch (Throwable error) {
                        flight.completeExceptionally(error);
                    } finally {
                        synchronized (FLIGHT_LOCK) {
                            if (IN_FLIGHT.get(key) == flight) {
                                IN_FLIGHT.remove(key);
                            }
                        }
                    }
                });
            } catch (RuntimeException submitFailure) {
                synchronized (FLIGHT_LOCK) {
                    if (IN_FLIGHT.get(key) == flight) {
                        IN_FLIGHT.remove(key);
                    }
                }
                flight.completeExceptionally(submitFailure);
            }
        }
        return flight;
    }

    public static File ensureExtracted(Context context) throws IOException {
        if (context == null) {
            throw new IOException("Android context unavailable");
        }
        Context appContext = context.getApplicationContext();
        Context effective = appContext != null ? appContext : context;
        return ensureExtracted(effective.getNoBackupFilesDir(), name -> effective.getAssets().open(name));
    }

    public static File ensureExtracted(File noBackupFilesDir, AssetOpener opener) throws IOException {
        CompletableFuture<File> flight = warmUpAsync(noBackupFilesDir, opener);
        try {
            return flight.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while extracting speech model assets", e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof IOException) {
                throw (IOException) cause;
            }
            if (cause instanceof RuntimeException) {
                throw (RuntimeException) cause;
            }
            if (cause instanceof Error) {
                throw (Error) cause;
            }
            throw new IOException("Speech model extraction failed", cause);
        }
    }

    public static String readHotwords(Context context) throws IOException {
        if (context == null) {
            return "";
        }
        Context appContext = context.getApplicationContext();
        Context effective = appContext != null ? appContext : context;
        return readHotwords(name -> effective.getAssets().open(name));
    }

    public static String readHotwords(AssetOpener opener) throws IOException {
        if (opener == null) {
            return "";
        }
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(opener.open("hotwords.txt"), StandardCharsets.UTF_8)
        )) {
            return String.join(
                " ",
                reader.lines().map(String::trim).filter(line -> !line.isEmpty()).toArray(String[]::new)
            );
        }
    }

    private static String cacheKey(File root) {
        try {
            return root.getCanonicalPath();
        } catch (IOException ignored) {
            return root.getAbsolutePath();
        }
    }

    private static void extractIfNeeded(File root, AssetOpener opener) throws IOException {
        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) {
            throw new IOException("Speech cache directory unavailable: " + root);
        }
        File readyMarker = new File(root, CACHE_COMPLETE_MARKER);
        if (!isCacheComplete(root)) {
            readyMarker.delete();
            for (String name : MODEL_FILES) {
                extractAssetFile(root, opener, name);
            }
            File pendingMarker = new File(root, CACHE_COMPLETE_MARKER + ".part");
            try {
                try (FileOutputStream markerOut = new FileOutputStream(pendingMarker)) {
                    markerOut.write(MODEL_CACHE_DIR.getBytes(StandardCharsets.UTF_8));
                }
                if (!pendingMarker.renameTo(readyMarker)) {
                    throw new IOException("Speech cache marker publish failed");
                }
            } finally {
                pendingMarker.delete();
            }
        } else {
            // Keep tiny optional hotwords.txt synchronized even when large weights are cached.
            extractAssetFile(root, opener, "hotwords.txt");
        }
    }

    private static void extractAssetFile(File root, AssetOpener opener, String name) throws IOException {
        File file = new File(root, name);
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("Speech cache directory unavailable");
        }
        try (InputStream input = opener.open(name)) {
            if (input == null) {
                throw new IOException("Missing speech asset: " + name);
            }
            File pending = new File(file.getPath() + ".part");
            try {
                try (FileOutputStream output = new FileOutputStream(pending)) {
                    byte[] buffer = new byte[COPY_BUFFER_BYTES];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        output.write(buffer, 0, count);
                    }
                }
                if (!pending.renameTo(file)) {
                    throw new IOException("Speech cache publish failed");
                }
            } finally {
                pending.delete();
            }
        }
    }
}
