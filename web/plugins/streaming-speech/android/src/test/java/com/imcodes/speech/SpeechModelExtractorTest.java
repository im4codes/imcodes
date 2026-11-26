package com.imcodes.speech;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * Unit tests for {@link SpeechModelExtractor} covering atomic extraction,
 * interrupted ".part" recovery, single-flight concurrency, retry after failure,
 * and non-extracting availability checks.
 */
public final class SpeechModelExtractorTest {
    @Rule
    public final TemporaryFolder tempFolder = new TemporaryFolder();

    private static Map<String, byte[]> buildModelFixtures() {
        Map<String, byte[]> assets = new HashMap<>();
        for (String name : SpeechModelExtractor.MODEL_FILES) {
            if ("hotwords.txt".equals(name)) {
                assets.put(name, new byte[0]);
            } else {
                assets.put(name, ("payload:" + name).getBytes(StandardCharsets.UTF_8));
            }
        }
        return assets;
    }

    private static byte[] readAll(File file) throws IOException {
        byte[] buf = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int offset = 0;
            while (offset < buf.length) {
                int read = in.read(buf, offset, buf.length - offset);
                if (read < 0) break;
                offset += read;
            }
            assertEquals(buf.length, offset);
        }
        return buf;
    }

    @Test
    public void extractsAllModelFilesAtomicallyAndReusesValidCache() throws Exception {
        File noBackupDir = tempFolder.newFolder("nobackup-reuse");
        Map<String, byte[]> assets = buildModelFixtures();
        Map<String, AtomicInteger> opens = new HashMap<>();
        for (String name : SpeechModelExtractor.MODEL_FILES) {
            opens.put(name, new AtomicInteger(0));
        }

        SpeechModelExtractor.AssetOpener opener = name -> {
            opens.get(name).incrementAndGet();
            return new ByteArrayInputStream(assets.get(name));
        };

        File root = SpeechModelExtractor.ensureExtracted(noBackupDir, opener);
        assertTrue(SpeechModelExtractor.isCacheComplete(root));
        assertTrue(new File(root, SpeechModelExtractor.CACHE_COMPLETE_MARKER).isFile());
        for (String name : SpeechModelExtractor.MODEL_FILES) {
            File extracted = new File(root, name);
            assertTrue(extracted.isFile());
            assertArrayEquals(assets.get(name), readAll(extracted));
            assertFalse(new File(extracted.getPath() + ".part").exists());
        }
        assertFalse(new File(root, SpeechModelExtractor.CACHE_COMPLETE_MARKER + ".part").exists());

        // Seed stale hotwords to verify cached runs still sync hotwords without re-extracting large weights.
        try (FileOutputStream out = new FileOutputStream(new File(root, "hotwords.txt"))) {
            out.write("STALE".getBytes(StandardCharsets.UTF_8));
        }
        SpeechModelExtractor.ensureExtracted(noBackupDir, opener);
        assertEquals(1, opens.get("conv_frontend.onnx").get());
        assertEquals(1, opens.get("decoder.int4.weights").get());
        assertEquals(2, opens.get("hotwords.txt").get());
        assertEquals(0L, new File(root, "hotwords.txt").length());
    }

    @Test
    public void recoversFromInterruptedPartFilesAndTruncatedTargets() throws Exception {
        File noBackupDir = tempFolder.newFolder("nobackup-recover");
        Map<String, byte[]> assets = buildModelFixtures();
        File root = SpeechModelExtractor.resolveCacheRoot(noBackupDir);
        assertTrue(root.mkdirs());

        // Simulate a process killed mid-extraction: partial .part files and truncated target, no .cache-complete.
        try (FileOutputStream out = new FileOutputStream(new File(root, "decoder.int4.weights.part"))) {
            out.write("corrupt-partial".getBytes(StandardCharsets.UTF_8));
        }
        try (FileOutputStream out = new FileOutputStream(new File(root, "encoder.int4.weights"))) {
            out.write(new byte[0]);
        }
        try (FileOutputStream out = new FileOutputStream(new File(root, ".cache-complete.part"))) {
            out.write("incomplete".getBytes(StandardCharsets.UTF_8));
        }

        assertFalse(SpeechModelExtractor.isCacheComplete(root));

        SpeechModelExtractor.ensureExtracted(noBackupDir, name -> new ByteArrayInputStream(assets.get(name)));
        assertTrue(SpeechModelExtractor.isCacheComplete(root));
        assertFalse(new File(root, "decoder.int4.weights.part").exists());
        assertFalse(new File(root, ".cache-complete.part").exists());
        assertArrayEquals(assets.get("encoder.int4.weights"), readAll(new File(root, "encoder.int4.weights")));
        assertArrayEquals(assets.get("decoder.int4.weights"), readAll(new File(root, "decoder.int4.weights")));
    }

    @Test
    public void singleFlightCoalescesConcurrentWarmUpAndEnsureExtracted() throws Exception {
        File noBackupDir = tempFolder.newFolder("nobackup-singleflight");
        Map<String, byte[]> assets = buildModelFixtures();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger convOpens = new AtomicInteger(0);

        SpeechModelExtractor.AssetOpener opener = name -> {
            if ("conv_frontend.onnx".equals(name)) {
                convOpens.incrementAndGet();
                entered.countDown();
                try {
                    assertTrue(release.await(5, TimeUnit.SECONDS));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted", e);
                }
            }
            return new ByteArrayInputStream(assets.get(name));
        };

        CompletableFuture<File> first = SpeechModelExtractor.warmUpAsync(noBackupDir, opener);
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        CompletableFuture<File> second = SpeechModelExtractor.warmUpAsync(noBackupDir, opener);
        CompletableFuture<File> waiter = CompletableFuture.supplyAsync(() -> {
            try {
                return SpeechModelExtractor.ensureExtracted(noBackupDir, opener);
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });

        release.countDown();
        File root1 = first.get(5, TimeUnit.SECONDS);
        File root2 = second.get(5, TimeUnit.SECONDS);
        File root3 = waiter.get(5, TimeUnit.SECONDS);
        assertEquals(root1, root2);
        assertEquals(root1, root3);
        assertEquals(1, convOpens.get());
        assertTrue(SpeechModelExtractor.isCacheComplete(root1));
    }

    @Test
    public void clearsInFlightStateOnFailureAndRecoversOnRetry() throws Exception {
        File noBackupDir = tempFolder.newFolder("nobackup-retry");
        Map<String, byte[]> assets = buildModelFixtures();
        AtomicBoolean failWeights = new AtomicBoolean(true);

        SpeechModelExtractor.AssetOpener opener = name -> {
            if (failWeights.get() && "decoder.int4.weights".equals(name)) {
                throw new IOException("Simulated read error");
            }
            return new ByteArrayInputStream(assets.get(name));
        };

        try {
            SpeechModelExtractor.ensureExtracted(noBackupDir, opener);
            fail("Expected IOException on simulated asset read failure");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("Simulated read error"));
        }
        File root = SpeechModelExtractor.resolveCacheRoot(noBackupDir);
        assertFalse(SpeechModelExtractor.isCacheComplete(root));

        failWeights.set(false);
        SpeechModelExtractor.ensureExtracted(noBackupDir, opener);
        assertTrue(SpeechModelExtractor.isCacheComplete(root));
    }

    @Test
    public void availableValidatesWithoutExtractingAndUsesCompletedCacheFastPath() throws Exception {
        File noBackupDir = tempFolder.newFolder("nobackup-avail");
        Map<String, byte[]> assets = buildModelFixtures();
        AtomicInteger bytesReadFromWeights = new AtomicInteger(0);

        SpeechModelExtractor.AssetOpener probingOpener = name -> {
            byte[] payload = assets.get(name);
            InputStream raw = new ByteArrayInputStream(payload);
            if (!"decoder.int4.weights".equals(name)) {
                return raw;
            }
            return new FilterInputStream(raw) {
                @Override
                public int read() throws IOException {
                    int b = super.read();
                    if (b >= 0) bytesReadFromWeights.incrementAndGet();
                    return b;
                }

                @Override
                public int read(byte[] b, int off, int len) throws IOException {
                    int n = super.read(b, off, len);
                    if (n > 0) bytesReadFromWeights.addAndGet(n);
                    return n;
                }
            };
        };

        // Cold check reads at most 1 probe byte and never creates the extracted cache.
        assertTrue(SpeechModelExtractor.areAssetsAvailable(noBackupDir, probingOpener));
        assertTrue(bytesReadFromWeights.get() <= 1);
        assertFalse(SpeechModelExtractor.resolveCacheRoot(noBackupDir).exists());

        // Missing required weight reports unavailable.
        SpeechModelExtractor.AssetOpener missingWeight = name -> {
            if ("encoder.int4.weights".equals(name)) throw new IOException("missing");
            return new ByteArrayInputStream(assets.get(name));
        };
        assertFalse(SpeechModelExtractor.areAssetsAvailable(noBackupDir, missingWeight));

        // Once cache is complete, available() returns true without opening bundled assets.
        SpeechModelExtractor.ensureExtracted(noBackupDir, name -> new ByteArrayInputStream(assets.get(name)));
        AtomicInteger cacheBypassOpens = new AtomicInteger(0);
        assertTrue(SpeechModelExtractor.areAssetsAvailable(noBackupDir, name -> {
            cacheBypassOpens.incrementAndGet();
            return new ByteArrayInputStream(assets.get(name));
        }));
        assertEquals(0, cacheBypassOpens.get());
    }
}
