#ifndef IMCODES_REMOTE_DESKTOP_COMMON_CLIPBOARD_PASTE_ASSEMBLER_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_CLIPBOARD_PASTE_ASSEMBLER_H_

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

#include "data_channel_payload.h"

namespace imcodes::remote_desktop::common {

/** Bounded, single-transfer assembly for the remote-desktop paste control. */
class ClipboardPasteAssembler final {
 public:
  enum class Result { kRejected, kAccepted, kComplete };

  Result Append(std::string_view paste_id, std::uint64_t chunk_index,
                std::uint64_t chunk_count, std::string_view text,
                std::chrono::steady_clock::time_point now,
                std::string* complete_text) {
    if (complete_text == nullptr) return Reject();
    complete_text->clear();
    Expire(now);
    if (paste_id.empty() || paste_id.size() > rd::kMaxRequestIdBytes ||
        text.empty() || text.size() > rd::kMaxPasteTextChunkBytes ||
        chunk_count == 0 || chunk_count > rd::kMaxPasteTextChunks ||
        chunk_index >= chunk_count) {
      return Reject();
    }

    if (paste_id_.empty()) {
      if (chunk_index != 0) return Result::kRejected;
      paste_id_.assign(paste_id);
      chunk_count_ = chunk_count;
      next_chunk_index_ = 0;
    }
    if (paste_id != paste_id_ || chunk_count != chunk_count_ ||
        chunk_index != next_chunk_index_ ||
        text.size() > rd::kMaxPasteTextBytes - text_.size()) {
      Reset();
      return Result::kRejected;
    }
    text_.append(text);
    ++next_chunk_index_;
    last_chunk_at_ = now;
    if (next_chunk_index_ != chunk_count_) return Result::kAccepted;
    *complete_text = std::move(text_);
    Reset();
    return Result::kComplete;
  }

  void Expire(std::chrono::steady_clock::time_point now) {
    if (!paste_id_.empty() && now - last_chunk_at_ >=
                                  std::chrono::milliseconds(
                                      rd::kPasteTextTransferTimeoutMs)) {
      Reset();
    }
  }

  bool pending() const noexcept { return !paste_id_.empty(); }

 private:
  Result Reject() {
    Reset();
    return Result::kRejected;
  }
  void Reset() {
    paste_id_.clear();
    chunk_count_ = 0;
    next_chunk_index_ = 0;
    text_.clear();
    last_chunk_at_ = {};
  }

  std::string paste_id_;
  std::uint64_t chunk_count_ = 0;
  std::uint64_t next_chunk_index_ = 0;
  std::string text_;
  std::chrono::steady_clock::time_point last_chunk_at_{};
};

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_CLIPBOARD_PASTE_ASSEMBLER_H_
