#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

namespace imcodes::qwen3 {

struct Qwen3SpecialTokenIds {
  int64_t im_start{151644};      // <|im_start|>
  int64_t im_end{151645};        // <|im_end|>
  int64_t eos{151645};           // <|im_end|>
  int64_t pad{151643};           // <|endoftext|>
  int64_t endoftext{151643};     // <|endoftext|>
  int64_t audio_start{151669};   // <|audio_start|>
  int64_t audio_end{151670};     // <|audio_end|>
  int64_t audio_pad{151676};     // <|audio_pad|>
  int64_t asr_text{151704};      // <asr_text>
  int64_t newline{198};          // \n (GPT-2 byte token "Ċ")
  int64_t system_id{8948};       // system
  int64_t user_id{872};          // user
  int64_t assistant_id{77091};   // assistant
};

/**
 * Self-contained zero-dependency Byte-Level BPE tokenizer for Qwen3-ASR.
 * Loads `vocab.json`, `merges.txt`, and `tokenizer_config.json` from a tokenizer directory.
 */
class Qwen3Tokenizer {
 public:
  Qwen3Tokenizer() = default;

  /** Load tokenizer files from directory (containing vocab.json, merges.txt, tokenizer_config.json). */
  bool load(const std::filesystem::path& tokenizer_dir, std::string& out_error);

  /** Test/helper constructor from explicit token->id map and optional merge rules ("a b"). */
  bool load_from_memory(
      const std::unordered_map<std::string, int64_t>& vocab,
      const std::vector<std::string>& merges = {},
      const std::unordered_map<int64_t, std::string>& added_tokens = {});

  /** Encode UTF-8 text to token IDs. If parse_special is true, matches added special tokens verbatim. */
  std::vector<int64_t> encode(const std::string& text, bool parse_special = true) const;

  /**
   * Decode token IDs using a unified byte buffer so multi-byte UTF-8 sequences split across
   * BPE tokens reassemble cleanly. Skips <|...|> special tokens; preserves <asr_text> when
   * `include_asr_tag` is true. Incomplete trailing UTF-8 emits U+FFFD (\xEF\xBF\xBD).
   */
  std::string decode(const std::vector<int64_t>& tokens, bool include_asr_tag = true) const;

  bool is_loaded() const { return !id_to_token_.empty(); }
  size_t vocab_size() const { return id_to_token_.size(); }

  int64_t eos_token_id() const { return special_.eos; }
  int64_t pad_token_id() const { return special_.pad; }
  int64_t endoftext_token_id() const { return special_.endoftext; }
  int64_t im_start_token_id() const { return special_.im_start; }
  int64_t im_end_token_id() const { return special_.im_end; }
  int64_t audio_start_token_id() const { return special_.audio_start; }
  int64_t audio_end_token_id() const { return special_.audio_end; }
  int64_t audio_pad_token_id() const { return special_.audio_pad; }
  int64_t asr_text_token_id() const { return special_.asr_text; }
  const Qwen3SpecialTokenIds& special_ids() const { return special_; }

  bool try_get_token_id(const std::string& token, int64_t& out_id) const;
  std::string get_token(int64_t id) const;

 private:
  void refresh_special_ids();
  void encode_plain_span(const std::string& text, std::vector<int64_t>& out_ids) const;
  std::vector<std::string> bpe(const std::string& byte_level_token) const;

  std::unordered_map<int64_t, std::string> id_to_token_;
  std::unordered_map<std::string, int64_t> token_to_id_;
  std::unordered_map<std::string, int64_t> special_token_to_id_;
  std::vector<std::string> special_tokens_sorted_;  // Sorted longest-first for greedy special matching
  std::unordered_map<std::string, int> bpe_ranks_;
  Qwen3SpecialTokenIds special_;
};

}  // namespace imcodes::qwen3
