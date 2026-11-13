package com.imcodes.speech;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure-Java Qwen3 byte-level BPE tokenizer compatible with HuggingFace
 * vocab.json / merges.txt / tokenizer_config.json and iOS Token Prefix Rollback.
 */
public final class Qwen3Tokenizer {
    public static final int DEFAULT_PAD_TOKEN_ID = 151643;
    public static final int DEFAULT_IM_START_TOKEN_ID = 151644;
    public static final int DEFAULT_EOS_TOKEN_ID = 151645;
    public static final int DEFAULT_AUDIO_START_TOKEN_ID = 151669;
    public static final int DEFAULT_AUDIO_END_TOKEN_ID = 151670;
    public static final int DEFAULT_AUDIO_PAD_TOKEN_ID = 151676;
    public static final int DEFAULT_ASR_TEXT_TOKEN_ID = 151704;

    private static final Pattern QWEN3_PRETOKENIZE_PATTERN = Pattern.compile(
        "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+",
        Pattern.UNICODE_CHARACTER_CLASS
    );

    private static final String[] BYTE_TO_UNICODE = new String[256];
    private static final Map<Integer, Integer> UNICODE_CP_TO_BYTE = new HashMap<>(512);

    static {
        boolean[] used = new boolean[256];
        int[] bytes = new int[256];
        int[] cps = new int[256];
        int count = 0;
        for (int b = 33; b <= 126; b++) {
            used[b] = true;
            bytes[count] = b;
            cps[count++] = b;
        }
        for (int b = 161; b <= 172; b++) {
            used[b] = true;
            bytes[count] = b;
            cps[count++] = b;
        }
        for (int b = 174; b <= 255; b++) {
            used[b] = true;
            bytes[count] = b;
            cps[count++] = b;
        }
        int nextCp = 256;
        for (int b = 0; b < 256; b++) {
            if (!used[b]) {
                bytes[count] = b;
                cps[count++] = nextCp++;
            }
        }
        for (int i = 0; i < 256; i++) {
            String encoded = new String(Character.toChars(cps[i]));
            BYTE_TO_UNICODE[bytes[i]] = encoded;
            UNICODE_CP_TO_BYTE.put(cps[i], bytes[i]);
        }
    }

    private final Map<String, Integer> token2Id;
    private final String[] id2Token;
    private final Map<String, Integer> mergePairRank;
    private final List<Map.Entry<String, Integer>> specialTokensLongestFirst;
    private final Set<Integer> specialTokenIds;
    private final Set<Integer> skippableSpecialTokenIds;
    private final ConcurrentHashMap<String, int[]> bpeCache = new ConcurrentHashMap<>();

    public final int eosTokenId;
    public final int padTokenId;
    public final int imStartTokenId;
    public final int imEndTokenId;
    public final int audioStartTokenId;
    public final int audioEndTokenId;
    public final int audioPadTokenId;
    public final int asrTextTokenId;

    private Qwen3Tokenizer(
        Map<String, Integer> token2Id,
        String[] id2Token,
        Map<String, Integer> mergePairRank,
        Map<String, Integer> specialTokens,
        int eosTokenId,
        int padTokenId
    ) {
        this.token2Id = token2Id;
        this.id2Token = id2Token;
        this.mergePairRank = mergePairRank;

        List<Map.Entry<String, Integer>> sortedSpecials = new ArrayList<>(specialTokens.entrySet());
        sortedSpecials.sort((a, b) -> Integer.compare(b.getKey().length(), a.getKey().length()));
        this.specialTokensLongestFirst = Collections.unmodifiableList(sortedSpecials);

        Set<Integer> specialIds = new HashSet<>();
        for (Map.Entry<String, Integer> entry : sortedSpecials) {
            specialIds.add(entry.getValue());
        }
        this.specialTokenIds = Collections.unmodifiableSet(specialIds);

        Set<Integer> skippable = new HashSet<>();
        addIfPresent(skippable, token2Id, "<|im_start|>");
        addIfPresent(skippable, token2Id, "<|im_end|>");
        addIfPresent(skippable, token2Id, "<|endoftext|>");
        this.imStartTokenId = token2Id.getOrDefault("<|im_start|>", DEFAULT_IM_START_TOKEN_ID);
        this.imEndTokenId = token2Id.getOrDefault("<|im_end|>", DEFAULT_EOS_TOKEN_ID);
        this.eosTokenId = eosTokenId >= 0 ? eosTokenId : this.imEndTokenId;
        this.padTokenId = padTokenId >= 0 ? padTokenId : token2Id.getOrDefault("<|endoftext|>", DEFAULT_PAD_TOKEN_ID);
        this.audioStartTokenId = token2Id.getOrDefault("<|audio_start|>", DEFAULT_AUDIO_START_TOKEN_ID);
        this.audioEndTokenId = token2Id.getOrDefault("<|audio_end|>", DEFAULT_AUDIO_END_TOKEN_ID);
        this.audioPadTokenId = token2Id.getOrDefault("<|audio_pad|>", DEFAULT_AUDIO_PAD_TOKEN_ID);
        this.asrTextTokenId = token2Id.getOrDefault("<asr_text>", DEFAULT_ASR_TEXT_TOKEN_ID);
        skippable.add(this.eosTokenId);
        skippable.add(this.padTokenId);
        this.skippableSpecialTokenIds = Collections.unmodifiableSet(skippable);
    }

    private static void addIfPresent(Set<Integer> set, Map<String, Integer> map, String key) {
        Integer id = map.get(key);
        if (id != null) set.add(id);
    }

    private static String readUtf8File(File file) throws IOException {
        try (FileInputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n > 0) {
                    out.write(buf, 0, n);
                }
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    public static Qwen3Tokenizer fromDirectory(File dir) throws IOException {
        File vocabFile = new File(dir, "vocab.json");
        File mergesFile = new File(dir, "merges.txt");
        File configFile = new File(dir, "tokenizer_config.json");
        String vocabJson = readUtf8File(vocabFile);
        String mergesTxt = readUtf8File(mergesFile);
        String configJson = configFile.isFile() ? readUtf8File(configFile) : "{}";
        return fromContents(vocabJson, mergesTxt, configJson);
    }

    public static Qwen3Tokenizer fromContents(String vocabJson, String mergesTxt, String configJson) throws IOException {
        Map<String, Integer> token2Id = new HashMap<>(200000);
        int maxId = parseVocabJson(vocabJson, token2Id);

        Map<String, Integer> specialTokens = new LinkedHashMap<>();
        int[] eosPad = new int[] { -1, -1 };
        if (configJson != null && !configJson.trim().isEmpty()) {
            maxId = parseTokenizerConfig(configJson, token2Id, specialTokens, eosPad, maxId);
        }

        // Ensure core Qwen3 chat/audio markers exist as special tokens even with minimal test fixtures.
        String[] coreSpecials = {
            "<|endoftext|>", "<|im_start|>", "<|im_end|>",
            "<|audio_start|>", "<|audio_end|>", "<|audio_pad|>", "<asr_text>"
        };
        for (String tok : coreSpecials) {
            Integer id = token2Id.get(tok);
            if (id != null && !specialTokens.containsKey(tok)) {
                specialTokens.put(tok, id);
            }
        }

        String[] id2Token = new String[Math.max(0, maxId + 1)];
        for (Map.Entry<String, Integer> entry : token2Id.entrySet()) {
            int id = entry.getValue();
            if (id >= 0 && id < id2Token.length) {
                id2Token[id] = entry.getKey();
            }
        }

        Map<String, Integer> merges = new HashMap<>(200000);
        if (mergesTxt != null) {
            String[] lines = mergesTxt.split("\\r?\\n");
            int rank = 0;
            for (String line : lines) {
                if (line.isEmpty() || line.startsWith("#version:")) continue;
                int sp = line.indexOf(' ');
                if (sp <= 0 || sp + 1 >= line.length()) continue;
                merges.put(line, rank++);
            }
        }

        return new Qwen3Tokenizer(token2Id, id2Token, merges, specialTokens, eosPad[0], eosPad[1]);
    }

    public int getTokenId(String token) {
        Integer id = token2Id.get(token);
        return id != null ? id : -1;
    }

    public int[] encode(String text) {
        if (text == null || text.isEmpty()) return new int[0];
        List<Integer> out = new ArrayList<>();
        int pos = 0;
        int len = text.length();
        while (pos < len) {
            boolean matchedSpecial = false;
            for (Map.Entry<String, Integer> entry : specialTokensLongestFirst) {
                String tok = entry.getKey();
                if (text.startsWith(tok, pos)) {
                    out.add(entry.getValue());
                    pos += tok.length();
                    matchedSpecial = true;
                    break;
                }
            }
            if (matchedSpecial) continue;

            int nextSpecial = len;
            for (Map.Entry<String, Integer> entry : specialTokensLongestFirst) {
                int idx = text.indexOf(entry.getKey(), pos);
                if (idx >= 0 && idx < nextSpecial) {
                    nextSpecial = idx;
                }
            }
            String chunk = text.substring(pos, nextSpecial);
            Matcher matcher = QWEN3_PRETOKENIZE_PATTERN.matcher(chunk);
            while (matcher.find()) {
                String piece = matcher.group();
                if (piece.isEmpty()) continue;
                String byteEncoded = encodeBytesToUnicode(piece);
                int[] pieceIds = encodeBpeCached(byteEncoded);
                for (int id : pieceIds) {
                    out.add(id);
                }
            }
            pos = nextSpecial;
        }
        int[] result = new int[out.size()];
        for (int i = 0; i < result.length; i++) result[i] = out.get(i);
        return result;
    }

    private int[] encodeBpeCached(String piece) {
        int[] cached = bpeCache.get(piece);
        if (cached != null) return cached;
        int[] computed = encodeBpe(piece);
        if (bpeCache.size() < 32768) {
            bpeCache.putIfAbsent(piece, computed);
        }
        return computed;
    }

    private int[] encodeBpe(String piece) {
        Integer wholeId = token2Id.get(piece);
        if (wholeId != null) {
            return new int[] { wholeId };
        }
        List<String> word = new ArrayList<>(piece.length());
        for (int i = 0; i < piece.length(); ) {
            int cp = piece.codePointAt(i);
            int charCount = Character.charCount(cp);
            word.add(piece.substring(i, i + charCount));
            i += charCount;
        }
        if (word.isEmpty()) return new int[0];

        while (word.size() > 1) {
            int bestRank = Integer.MAX_VALUE;
            String bestFirst = null;
            String bestSecond = null;
            for (int i = 0; i < word.size() - 1; i++) {
                String first = word.get(i);
                String second = word.get(i + 1);
                Integer rank = mergePairRank.get(first + " " + second);
                if (rank != null && rank < bestRank) {
                    bestRank = rank;
                    bestFirst = first;
                    bestSecond = second;
                }
            }
            if (bestFirst == null) break;

            List<String> merged = new ArrayList<>(word.size());
            String combined = bestFirst + bestSecond;
            int i = 0;
            while (i < word.size()) {
                if (i + 1 < word.size()
                    && word.get(i).equals(bestFirst)
                    && word.get(i + 1).equals(bestSecond)) {
                    merged.add(combined);
                    i += 2;
                } else {
                    merged.add(word.get(i));
                    i++;
                }
            }
            word = merged;
        }

        List<Integer> ids = new ArrayList<>(word.size());
        for (String tok : word) {
            Integer id = token2Id.get(tok);
            if (id != null) {
                ids.add(id);
            } else {
                for (int i = 0; i < tok.length(); ) {
                    int cp = tok.codePointAt(i);
                    String single = tok.substring(i, i + Character.charCount(cp));
                    Integer sid = token2Id.get(single);
                    if (sid != null) ids.add(sid);
                    i += Character.charCount(cp);
                }
            }
        }
        int[] out = new int[ids.size()];
        for (int i = 0; i < out.length; i++) out[i] = ids.get(i);
        return out;
    }

    private static String encodeBytesToUnicode(String piece) {
        byte[] utf8 = piece.getBytes(StandardCharsets.UTF_8);
        StringBuilder sb = new StringBuilder(utf8.length);
        for (byte b : utf8) {
            sb.append(BYTE_TO_UNICODE[b & 0xFF]);
        }
        return sb.toString();
    }

    public String decode(int[] tokens) {
        return decode(tokens, 0, tokens.length, true);
    }

    public String decode(int[] tokens, int from, int to, boolean skipSpecialTokens) {
        if (tokens == null || from >= to) return "";
        StringBuilder out = new StringBuilder();
        ByteArrayOutputStream byteBuf = new ByteArrayOutputStream();
        int limit = Math.min(to, tokens.length);
        for (int i = Math.max(0, from); i < limit; i++) {
            int id = tokens[i];
            if (id < 0 || id >= id2Token.length) continue;
            String tok = id2Token[id];
            if (tok == null) continue;
            if (specialTokenIds.contains(id) || isBracketSpecialToken(tok)) {
                if (skippableSpecialTokenIds.contains(id)) continue;
                flushByteBuffer(byteBuf, out);
                if (!skipSpecialTokens) {
                    out.append(tok);
                }
                continue;
            }
            appendTokenBytes(tok, byteBuf);
        }
        flushByteBuffer(byteBuf, out);
        return out.toString();
    }

    private static boolean isBracketSpecialToken(String tok) {
        return (tok.startsWith("<|") && tok.endsWith("|>")) || "<asr_text>".equals(tok);
    }

    private static void appendTokenBytes(String tok, ByteArrayOutputStream byteBuf) {
        for (int i = 0; i < tok.length(); ) {
            int cp = tok.codePointAt(i);
            Integer b = UNICODE_CP_TO_BYTE.get(cp);
            if (b != null) {
                byteBuf.write(b);
            } else {
                byte[] utf8 = tok.substring(i, i + Character.charCount(cp)).getBytes(StandardCharsets.UTF_8);
                byteBuf.write(utf8, 0, utf8.length);
            }
            i += Character.charCount(cp);
        }
    }

    private static void flushByteBuffer(ByteArrayOutputStream byteBuf, StringBuilder out) {
        if (byteBuf.size() == 0) return;
        out.append(new String(byteBuf.toByteArray(), StandardCharsets.UTF_8));
        byteBuf.reset();
    }

    /**
     * Strips EOS/PAD, drops the last rollbackCount text tokens while preserving any
     * leading "language <Lang><asr_text>" header, and walks back across incomplete
     * multi-byte UTF-8 sequences (U+FFFD) just like iOS Qwen3ASR.swift.
     */
    public int[] safePrefixTokensForRollback(int[] tokens, int rollbackCount) {
        if (tokens == null || tokens.length == 0) return new int[0];
        int end = tokens.length;
        while (end > 0 && (tokens[end - 1] == eosTokenId || tokens[end - 1] == padTokenId)) {
            end--;
        }
        int headerEnd = 0;
        for (int i = end - 1; i >= 0; i--) {
            if (tokens[i] == asrTextTokenId) {
                headerEnd = i + 1;
                break;
            }
        }
        int trim = Math.max(0, rollbackCount);
        if (end - headerEnd <= trim) {
            return new int[0];
        }
        end -= trim;
        while (end > headerEnd) {
            String decoded = decode(tokens, headerEnd, end, true);
            if (!decoded.trim().endsWith("\uFFFD")) {
                break;
            }
            end--;
        }
        return end > headerEnd ? Arrays.copyOf(tokens, end) : new int[0];
    }

    /**
     * Strips leading "language <Lang><asr_text>" scaffold tokens when present,
     * decodes UTF-8 speech tokens, and drops trailing incomplete replacement chars.
     */
    public String extractFinalText(int[] tokens) {
        if (tokens == null || tokens.length == 0) return "";
        int end = tokens.length;
        while (end > 0 && (tokens[end - 1] == eosTokenId || tokens[end - 1] == padTokenId)) {
            end--;
        }
        int start = 0;
        int prefixWindow = Math.min(16, end);
        for (int i = 0; i < prefixWindow; i++) {
            if (tokens[i] == asrTextTokenId) {
                if (i == 0) {
                    start = 1;
                } else {
                    String prefixText = decode(tokens, 0, i + 1, false);
                    if (prefixText.startsWith("language ") && prefixText.endsWith("<asr_text>")) {
                        start = i + 1;
                    }
                }
                break;
            }
        }
        String decoded = decode(tokens, start, end, true);
        if (decoded.indexOf('\uFFFD') >= 0) {
            decoded = decoded.replace("\uFFFD", "");
        }
        return decoded.trim();
    }

    // ---- Lightweight RFC 8259 parser for vocab.json and tokenizer_config.json ----

    private static final class JsonReader {
        final String src;
        int pos;

        JsonReader(String src) {
            this.src = src;
        }

        void skipWs() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n') pos++;
                else break;
            }
        }

        char peek() {
            skipWs();
            return pos < src.length() ? src.charAt(pos) : '\0';
        }

        void expect(char expected) throws IOException {
            skipWs();
            if (pos >= src.length() || src.charAt(pos) != expected) {
                throw new IOException("Expected '" + expected + "' at position " + pos);
            }
            pos++;
        }

        String readString() throws IOException {
            skipWs();
            if (pos >= src.length() || src.charAt(pos) != '"') {
                throw new IOException("Expected string at position " + pos);
            }
            pos++;
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (pos >= src.length()) throw new IOException("Unterminated escape");
                    char esc = src.charAt(pos++);
                    switch (esc) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            if (pos + 4 > src.length()) throw new IOException("Invalid \\u escape");
                            int code = Integer.parseInt(src.substring(pos, pos + 4), 16);
                            sb.append((char) code);
                            pos += 4;
                            break;
                        default:
                            sb.append(esc);
                            break;
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new IOException("Unterminated string");
        }

        long readLong() throws IOException {
            skipWs();
            int start = pos;
            if (pos < src.length() && src.charAt(pos) == '-') pos++;
            while (pos < src.length() && Character.isDigit(src.charAt(pos))) pos++;
            if (pos == start) throw new IOException("Expected integer at position " + pos);
            return Long.parseLong(src.substring(start, pos));
        }

        Object readAny() throws IOException {
            char c = peek();
            if (c == '"') return readString();
            if (c == '{') {
                expect('{');
                Map<String, Object> map = new LinkedHashMap<>();
                if (peek() == '}') {
                    pos++;
                    return map;
                }
                while (true) {
                    String key = readString();
                    expect(':');
                    map.put(key, readAny());
                    char next = peek();
                    if (next == ',') {
                        pos++;
                    } else if (next == '}') {
                        pos++;
                        return map;
                    } else {
                        throw new IOException("Invalid object delimiter at " + pos);
                    }
                }
            }
            if (c == '[') {
                expect('[');
                List<Object> list = new ArrayList<>();
                if (peek() == ']') {
                    pos++;
                    return list;
                }
                while (true) {
                    list.add(readAny());
                    char next = peek();
                    if (next == ',') {
                        pos++;
                    } else if (next == ']') {
                        pos++;
                        return list;
                    } else {
                        throw new IOException("Invalid array delimiter at " + pos);
                    }
                }
            }
            if (src.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
            if (src.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
            if (src.startsWith("null", pos)) { pos += 4; return null; }
            int start = pos;
            while (pos < src.length()) {
                char ch = src.charAt(pos);
                if (ch == ',' || ch == '}' || ch == ']' || Character.isWhitespace(ch)) break;
                pos++;
            }
            if (pos == start) throw new IOException("Unexpected token at " + pos);
            return src.substring(start, pos);
        }
    }

    private static int parseVocabJson(String vocabJson, Map<String, Integer> token2Id) throws IOException {
        JsonReader r = new JsonReader(vocabJson);
        r.expect('{');
        int maxId = -1;
        if (r.peek() == '}') return maxId;
        while (true) {
            String key = r.readString();
            r.expect(':');
            int id = (int) r.readLong();
            if (id >= 0) {
                token2Id.put(key, id);
                if (id > maxId) maxId = id;
            }
            char next = r.peek();
            if (next == ',') r.pos++;
            else if (next == '}') { r.pos++; break; }
            else throw new IOException("Malformed vocab.json at position " + r.pos);
        }
        return maxId;
    }

    @SuppressWarnings("unchecked")
    private static int parseTokenizerConfig(
        String configJson,
        Map<String, Integer> token2Id,
        Map<String, Integer> specialTokens,
        int[] eosPad,
        int maxId
    ) throws IOException {
        Object parsed = new JsonReader(configJson).readAny();
        if (!(parsed instanceof Map)) return maxId;
        Map<String, Object> root = (Map<String, Object>) parsed;
        Object addedObj = root.get("added_tokens_decoder");
        if (addedObj instanceof Map) {
            Map<String, Object> added = (Map<String, Object>) addedObj;
            for (Map.Entry<String, Object> entry : added.entrySet()) {
                int id;
                try {
                    id = Integer.parseInt(entry.getKey());
                } catch (NumberFormatException ignored) {
                    continue;
                }
                if (!(entry.getValue() instanceof Map)) continue;
                Object contentObj = ((Map<String, Object>) entry.getValue()).get("content");
                if (!(contentObj instanceof String)) continue;
                String content = (String) contentObj;
                token2Id.put(content, id);
                specialTokens.put(content, id);
                if (id > maxId) maxId = id;
            }
        }
        eosPad[0] = resolveConfiguredTokenId(root.get("eos_token"), token2Id);
        eosPad[1] = resolveConfiguredTokenId(root.get("pad_token"), token2Id);
        return maxId;
    }

    @SuppressWarnings("unchecked")
    private static int resolveConfiguredTokenId(Object val, Map<String, Integer> token2Id) {
        String content = null;
        if (val instanceof String) {
            content = (String) val;
        } else if (val instanceof Map) {
            Object c = ((Map<String, Object>) val).get("content");
            if (c instanceof String) content = (String) c;
        }
        if (content == null) return -1;
        Integer id = token2Id.get(content);
        return id != null ? id : -1;
    }
}
