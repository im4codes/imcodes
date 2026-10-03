#include "linux_vnc_backend.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>

#include "../remote-desktop-common/value_types.h"

namespace imcodes::remote_desktop::linux_platform {

using common::CapturedFrame;
using common::CapturedFrameSink;
using common::DisplayTopology;
using common::PixelSize;
using common::ReadinessState;

namespace {

// ── Standalone DES (ECB, single 8-byte block) ───────────────────────────────
//
// The ONLY place DES appears anywhere in this codebase: the legacy RFB
// "VNC Authentication" security type (2) is specified in terms of it, and
// so is the on-disk vncpasswd file format. Pulling in a whole crypto library
// for one 64-bit block cipher used nowhere else is not worth the extra link
// surface, so this is a small, self-contained implementation -- the same
// tradeoff most minimal VNC client libraries make. Bit numbering follows the
// DES/FIPS 46-3 convention (bit 1 is the most significant bit); Encrypt() is
// verified against the FIPS 46-3 published test vector in a static_assert-
// style check the first time ProbeVncServer or a password decrypt runs (see
// RunDesSelfCheck below) rather than trusted blind.
namespace des {

constexpr int kInitialPermutation[64] = {
    58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
    62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
    57, 49, 41, 33, 25, 17, 9,  1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
};
constexpr int kFinalPermutation[64] = {
    40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
    38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
    36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
    34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9,  49, 17, 57, 25,
};
constexpr int kExpansion[48] = {
    32, 1,  2,  3,  4,  5,  4,  5,  6,  7,  8,  9,
    8,  9,  10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
    16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
    24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
};
constexpr int kPermutationP[32] = {
    16, 7,  20, 21, 29, 12, 28, 17, 1,  15, 23, 26, 5,  18, 31, 10,
    2,  8,  24, 14, 32, 27, 3,  9,  19, 13, 30, 6,  22, 11, 4,  25,
};
constexpr int kSBox[8][4][16] = {
    {{14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7},
     {0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8},
     {4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0},
     {15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13}},
    {{15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10},
     {3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5},
     {0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15},
     {13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9}},
    {{10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8},
     {13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1},
     {13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7},
     {1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12}},
    {{7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15},
     {13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9},
     {10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4},
     {3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14}},
    {{2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9},
     {14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6},
     {4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14},
     {11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3}},
    {{12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11},
     {10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8},
     {9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6},
     {4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13}},
    {{4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1},
     {13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6},
     {1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2},
     {6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12}},
    {{13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7},
     {1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2},
     {7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8},
     {2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11}},
};
constexpr int kPermutedChoice1[56] = {
    57, 49, 41, 33, 25, 17, 9,  1,  58, 50, 42, 34, 26, 18,
    10, 2,  59, 51, 43, 35, 27, 19, 11, 3,  60, 52, 44, 36,
    63, 55, 47, 39, 31, 23, 15, 7,  62, 54, 46, 38, 30, 22,
    14, 6,  61, 53, 45, 37, 29, 21, 13, 5,  28, 20, 12, 4,
};
constexpr int kPermutedChoice2[48] = {
    14, 17, 11, 24, 1,  5,  3,  28, 15, 6,  21, 10,
    23, 19, 12, 4,  26, 8,  16, 7,  27, 20, 13, 2,
    41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
    44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
};
constexpr int kRoundShifts[16] = {1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1};

using Block64 = std::uint64_t;

// bit 1 = most significant bit of the 64-bit word, matching the tables above.
Block64 Permute(Block64 input, const int* table, int table_size, int input_bits) {
  Block64 output = 0;
  for (int i = 0; i < table_size; ++i) {
    const int source_bit = table[i];
    const Block64 bit = (input >> (input_bits - source_bit)) & 1ULL;
    output = (output << 1) | bit;
  }
  return output;
}

std::array<Block64, 16> KeySchedule(Block64 key64) {
  Block64 key56 = Permute(key64, kPermutedChoice1, 56, 64);
  std::uint32_t c = static_cast<std::uint32_t>((key56 >> 28) & 0x0FFFFFFF);
  std::uint32_t d = static_cast<std::uint32_t>(key56 & 0x0FFFFFFF);
  std::array<Block64, 16> round_keys{};
  for (int round = 0; round < 16; ++round) {
    const int shift = kRoundShifts[round];
    c = ((c << shift) | (c >> (28 - shift))) & 0x0FFFFFFF;
    d = ((d << shift) | (d >> (28 - shift))) & 0x0FFFFFFF;
    const Block64 cd = (static_cast<Block64>(c) << 28) | d;
    round_keys[round] = Permute(cd, kPermutedChoice2, 48, 56);
  }
  return round_keys;
}

std::uint32_t FeistelF(std::uint32_t half, Block64 round_key) {
  const Block64 expanded = Permute(half, kExpansion, 48, 32);
  const Block64 mixed = expanded ^ round_key;
  std::uint32_t sbox_output = 0;
  for (int box = 0; box < 8; ++box) {
    const int shift = 42 - box * 6;
    const int chunk = static_cast<int>((mixed >> shift) & 0x3F);
    const int row = ((chunk & 0x20) >> 4) | (chunk & 0x01);
    const int col = (chunk >> 1) & 0x0F;
    sbox_output = (sbox_output << 4) | static_cast<std::uint32_t>(kSBox[box][row][col]);
  }
  return static_cast<std::uint32_t>(Permute(sbox_output, kPermutationP, 32, 32));
}

// One DES block operation. `round_keys` supplied in encrypt order (K1..K16)
// for encryption, or reversed (K16..K1) for decryption -- DES's Feistel
// structure is its own inverse under reversed round-key order, so this one
// function serves both directions.
Block64 Crypt(Block64 block, const std::array<Block64, 16>& round_keys) {
  const Block64 permuted = Permute(block, kInitialPermutation, 64, 64);
  std::uint32_t left = static_cast<std::uint32_t>((permuted >> 32) & 0xFFFFFFFF);
  std::uint32_t right = static_cast<std::uint32_t>(permuted & 0xFFFFFFFF);
  for (int round = 0; round < 16; ++round) {
    const std::uint32_t next_right = left ^ FeistelF(right, round_keys[round]);
    left = right;
    right = next_right;
  }
  const Block64 preoutput = (static_cast<Block64>(right) << 32) | left;
  return Permute(preoutput, kFinalPermutation, 64, 64);
}

std::array<std::uint8_t, 8> Encrypt(const std::array<std::uint8_t, 8>& plaintext,
                                    const std::array<std::uint8_t, 8>& key) {
  Block64 block = 0, key64 = 0;
  for (int i = 0; i < 8; ++i) {
    block = (block << 8) | plaintext[i];
    key64 = (key64 << 8) | key[i];
  }
  const Block64 cipher = Crypt(block, KeySchedule(key64));
  std::array<std::uint8_t, 8> out{};
  for (int i = 7; i >= 0; --i) {
    out[i] = static_cast<std::uint8_t>(cipher >> ((7 - i) * 8));
  }
  return out;
}

std::array<std::uint8_t, 8> Decrypt(const std::array<std::uint8_t, 8>& ciphertext,
                                    const std::array<std::uint8_t, 8>& key) {
  Block64 block = 0, key64 = 0;
  for (int i = 0; i < 8; ++i) {
    block = (block << 8) | ciphertext[i];
    key64 = (key64 << 8) | key[i];
  }
  std::array<Block64, 16> round_keys = KeySchedule(key64);
  std::reverse(round_keys.begin(), round_keys.end());
  const Block64 plain = Crypt(block, round_keys);
  std::array<std::uint8_t, 8> out{};
  for (int i = 7; i >= 0; --i) {
    out[i] = static_cast<std::uint8_t>(plain >> ((7 - i) * 8));
  }
  return out;
}

// Verified once, cheaply, rather than trusted: the FIPS 46-3 published test
// vector (key 0x133457799BBCDFF1, plaintext 0x0123456789ABCDEF must encrypt
// to 0x85E813540F0AB405). A hand-transcribed permutation/S-box table that is
// wrong anywhere produces silently-wrong ciphertext, not a crash -- this
// turns that failure mode into a loud, immediate one instead of a VNC
// server rejecting every real password forever for no visible reason.
bool SelfCheck() noexcept {
  const std::array<std::uint8_t, 8> key = {0x13, 0x34, 0x57, 0x79, 0x9B, 0xBC, 0xDF, 0xF1};
  const std::array<std::uint8_t, 8> plain = {0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF};
  const std::array<std::uint8_t, 8> expected = {0x85, 0xE8, 0x13, 0x54, 0x0F, 0x0A, 0xB4, 0x05};
  return Encrypt(plain, key) == expected;
}

}  // namespace des

// The RFB spec's own fixed key for the vncpasswd on-disk format -- public,
// identical for every installation, not a secret. See DecryptVncPasswordFile.
constexpr std::array<std::uint8_t, 8> kFixedPasswordFileKey = {
    0x17, 0x52, 0x6B, 0x06, 0x23, 0x4E, 0x58, 0x07,
};

// DES, as specified by the RFB protocol for BOTH the challenge-response and
// the password-file format, is applied with each key byte's BITS reversed
// -- a historical quirk of the original vncpasswd implementation that every
// interoperable client and server has carried forward since.
std::uint8_t ReverseBits(std::uint8_t byte) noexcept {
  std::uint8_t out = 0;
  for (int bit = 0; bit < 8; ++bit) {
    out = static_cast<std::uint8_t>((out << 1) | ((byte >> bit) & 1));
  }
  return out;
}

std::array<std::uint8_t, 8> BitReversedKey(const std::array<std::uint8_t, 8>& key) noexcept {
  std::array<std::uint8_t, 8> out{};
  for (int i = 0; i < 8; ++i) out[i] = ReverseBits(key[i]);
  return out;
}

std::int64_t NowMicroseconds() noexcept {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

class VectorFrameStorage final : public common::FrameStorage {
 public:
  explicit VectorFrameStorage(std::vector<std::byte> bytes) noexcept
      : bytes_(std::move(bytes)) {}
  [[nodiscard]] const std::byte* data() const noexcept override { return bytes_.data(); }
  [[nodiscard]] std::size_t size() const noexcept override { return bytes_.size(); }

 private:
  std::vector<std::byte> bytes_;
};

// ── Minimal blocking socket helpers ─────────────────────────────────────────

int ConnectWithTimeout(const std::string& host, std::uint16_t port, int timeout_ms) noexcept {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* resolved = nullptr;
  const std::string port_str = std::to_string(port);
  if (getaddrinfo(host.c_str(), port_str.c_str(), &hints, &resolved) != 0 || resolved == nullptr) {
    return -1;
  }
  int fd = -1;
  for (addrinfo* candidate = resolved; candidate != nullptr; candidate = candidate->ai_next) {
    fd = socket(candidate->ai_family, candidate->ai_socktype, candidate->ai_protocol);
    if (fd < 0) continue;
    timeval tv{};
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (connect(fd, candidate->ai_addr, candidate->ai_addrlen) == 0) break;
    close(fd);
    fd = -1;
  }
  freeaddrinfo(resolved);
  if (fd >= 0) {
    const int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  }
  return fd;
}

bool ReadFull(int fd, void* buffer, std::size_t length) noexcept {
  auto* cursor = static_cast<std::uint8_t*>(buffer);
  std::size_t remaining = length;
  while (remaining > 0) {
    const ssize_t got = recv(fd, cursor, remaining, 0);
    if (got <= 0) return false;
    cursor += got;
    remaining -= static_cast<std::size_t>(got);
  }
  return true;
}

bool WriteFull(int fd, const void* buffer, std::size_t length) noexcept {
  const auto* cursor = static_cast<const std::uint8_t*>(buffer);
  std::size_t remaining = length;
  while (remaining > 0) {
    const ssize_t sent = send(fd, cursor, remaining, MSG_NOSIGNAL);
    if (sent <= 0) return false;
    cursor += sent;
    remaining -= static_cast<std::size_t>(sent);
  }
  return true;
}

std::uint16_t ReadU16(int fd, bool* ok) noexcept {
  std::uint8_t buffer[2];
  if (!ReadFull(fd, buffer, 2)) { *ok = false; return 0; }
  return static_cast<std::uint16_t>((buffer[0] << 8) | buffer[1]);
}

std::uint32_t ReadU32(int fd, bool* ok) noexcept {
  std::uint8_t buffer[4];
  if (!ReadFull(fd, buffer, 4)) { *ok = false; return 0; }
  return (static_cast<std::uint32_t>(buffer[0]) << 24) |
         (static_cast<std::uint32_t>(buffer[1]) << 16) |
         (static_cast<std::uint32_t>(buffer[2]) << 8) |
         static_cast<std::uint32_t>(buffer[3]);
}

// One shared struct for the pieces of the handshake ProbeVncServer and the
// real capture loop both need, so the probe is a genuine prefix of the real
// connection sequence rather than a second, divergent implementation of it.
struct RfbConnection {
  int fd = -1;
  std::uint16_t framebuffer_width = 0;
  std::uint16_t framebuffer_height = 0;

  ~RfbConnection() { if (fd >= 0) close(fd); }
};

/**
 * RFB version handshake + security negotiation + ClientInit/ServerInit.
 * On success, `out` is left positioned exactly after ServerInit (i.e. the
 * server name bytes already consumed), ready for SetPixelFormat/
 * SetEncodings/FramebufferUpdateRequest.
 */
bool Handshake(const std::string& host, std::uint16_t port,
              const std::string& password, int timeout_ms, RfbConnection* out) {
  out->fd = ConnectWithTimeout(host, port, timeout_ms);
  if (out->fd < 0) return false;

  char server_version[13] = {};
  if (!ReadFull(out->fd, server_version, 12)) return false;
  if (std::strncmp(server_version, "RFB 003.0", 9) != 0) return false;
  // We speak up to 3.8 and every server in practice accepts a 3.8 client
  // line regardless of which 3.x it advertised.
  const char* client_version = "RFB 003.008\n";
  if (!WriteFull(out->fd, client_version, 12)) return false;

  bool ok = true;
  // RFB >= 3.7: server sends a COUNT then that many 1-byte security types.
  // RFB 3.3: server instead sends a single 4-byte security type directly.
  // Distinguishing by the version string keeps this correct for either.
  const bool legacy_security = std::strncmp(server_version, "RFB 003.003", 11) == 0
      || std::strncmp(server_version, "RFB 003.006", 11) == 0;
  std::uint8_t chosen_type = 0;
  if (legacy_security) {
    const std::uint32_t type = ReadU32(out->fd, &ok);
    if (!ok || (type != 1 && type != 2)) return false;
    chosen_type = static_cast<std::uint8_t>(type);
  } else {
    std::uint8_t count = 0;
    if (!ReadFull(out->fd, &count, 1)) return false;
    if (count == 0) return false;  // server sent a failure reason instead.
    std::vector<std::uint8_t> types(count);
    if (!ReadFull(out->fd, types.data(), count)) return false;
    bool has_none = false, has_vnc_auth = false;
    for (const auto type : types) {
      if (type == 1) has_none = true;
      if (type == 2) has_vnc_auth = true;
    }
    // Prefer None when offered even if a password was supplied: a server
    // that does not require one should not force us to have guessed right.
    if (has_none) chosen_type = 1;
    else if (has_vnc_auth) chosen_type = 2;
    else return false;
    if (!WriteFull(out->fd, &chosen_type, 1)) return false;
  }

  if (chosen_type == 2) {
    std::uint8_t challenge[16];
    if (!ReadFull(out->fd, challenge, 16)) return false;
    std::array<std::uint8_t, 8> key{};
    for (int i = 0; i < 8; ++i) {
      key[i] = i < static_cast<int>(password.size())
          ? static_cast<std::uint8_t>(password[i]) : 0;
    }
    const auto des_key = BitReversedKey(key);
    std::uint8_t response[16];
    for (int block = 0; block < 2; ++block) {
      std::array<std::uint8_t, 8> plain{};
      std::memcpy(plain.data(), challenge + block * 8, 8);
      const auto cipher = des::Encrypt(plain, des_key);
      std::memcpy(response + block * 8, cipher.data(), 8);
    }
    if (!WriteFull(out->fd, response, 16)) return false;
  }

  // RFB 3.3 has no SecurityResult after None; 3.7+ always sends one.
  if (!(legacy_security && chosen_type == 1)) {
    const std::uint32_t result = ReadU32(out->fd, &ok);
    if (!ok || result != 0) return false;  // 0 == OK.
  }

  const std::uint8_t shared_flag = 1;  // don't disconnect any other viewer.
  if (!WriteFull(out->fd, &shared_flag, 1)) return false;

  out->framebuffer_width = ReadU16(out->fd, &ok);
  out->framebuffer_height = ReadU16(out->fd, &ok);
  if (!ok || out->framebuffer_width == 0 || out->framebuffer_height == 0) return false;
  std::uint8_t pixel_format[16];
  if (!ReadFull(out->fd, pixel_format, 16)) return false;
  const std::uint32_t name_length = ReadU32(out->fd, &ok);
  if (!ok || name_length > 1u << 20) return false;
  std::vector<std::uint8_t> name(name_length);
  if (name_length > 0 && !ReadFull(out->fd, name.data(), name_length)) return false;
  return true;
}

/**
 * Force the server to send pixels in the exact byte layout the rest of this
 * codebase's capture pipeline already assumes for every other source
 * (BGRA8888 -- see X11CaptureAdapter::CaptureOnce's own "common frame
 * contract" comment): 32 bits per pixel, blue at byte offset 0, green at 1,
 * red at 2. Forcing the format server-side, rather than converting whatever
 * the server happens to prefer, keeps this adapter's pixel handling as
 * simple (and as auditable) as X11's.
 */
bool SetPixelFormatBgra8888(int fd) noexcept {
  std::uint8_t message[20] = {};
  message[0] = 0;  // SetPixelFormat
  message[4] = 32;  // bits-per-pixel
  message[5] = 24;  // depth
  message[6] = 0;   // big-endian-flag: little-endian on the wire.
  message[7] = 1;   // true-colour-flag
  message[8] = 0; message[9] = 255;   // red-max = 255
  message[10] = 0; message[11] = 255; // green-max = 255
  message[12] = 0; message[13] = 255; // blue-max = 255
  message[14] = 16;  // red-shift   (byte 2: R)
  message[15] = 8;   // green-shift (byte 1: G)
  message[16] = 0;   // blue-shift  (byte 0: B)
  return WriteFull(fd, message, sizeof(message));
}

bool SetEncodingsRawOnly(int fd) noexcept {
  std::uint8_t header[4] = {2, 0, 0, 1};  // SetEncodings, pad, 1 encoding.
  std::uint8_t raw_encoding[4] = {0, 0, 0, 0};  // encoding type 0 == Raw.
  return WriteFull(fd, header, sizeof(header)) && WriteFull(fd, raw_encoding, sizeof(raw_encoding));
}

bool RequestFramebufferUpdate(int fd, std::uint16_t width, std::uint16_t height,
                              bool incremental) noexcept {
  std::uint8_t message[10];
  message[0] = 3;  // FramebufferUpdateRequest
  message[1] = incremental ? 1 : 0;
  message[2] = 0; message[3] = 0;  // x
  message[4] = 0; message[5] = 0;  // y
  message[6] = static_cast<std::uint8_t>(width >> 8);
  message[7] = static_cast<std::uint8_t>(width & 0xFF);
  message[8] = static_cast<std::uint8_t>(height >> 8);
  message[9] = static_cast<std::uint8_t>(height & 0xFF);
  return WriteFull(fd, message, sizeof(message));
}

/**
 * Read exactly one FramebufferUpdate message (Raw-encoded rectangles only,
 * since that is all we ever request) into `framebuffer`, a
 * width*height*4-byte BGRA8888 buffer the caller owns and keeps across
 * calls. Every request this adapter sends is non-incremental (see
 * PollLoop's own comment on why), so in practice the server always answers
 * with one rectangle covering the whole frame -- but this still only
 * overwrites the rectangles actually present in the reply, rather than
 * assuming a single full-frame rectangle's shape, so a server that answers
 * with several smaller rectangles instead is still handled correctly.
 */
bool ReadFramebufferUpdate(int fd, std::uint16_t width, std::uint16_t height,
                           std::vector<std::uint8_t>* framebuffer) noexcept {
  std::uint8_t header[4];
  if (!ReadFull(fd, header, 4)) return false;
  if (header[0] != 0) return false;  // not a FramebufferUpdate; unsupported.
  const std::uint16_t rect_count = static_cast<std::uint16_t>((header[2] << 8) | header[3]);
  const std::size_t row_bytes = static_cast<std::size_t>(width) * 4;
  for (std::uint16_t rect = 0; rect < rect_count; ++rect) {
    std::uint8_t rect_header[12];
    if (!ReadFull(fd, rect_header, 12)) return false;
    const std::uint16_t x = static_cast<std::uint16_t>((rect_header[0] << 8) | rect_header[1]);
    const std::uint16_t y = static_cast<std::uint16_t>((rect_header[2] << 8) | rect_header[3]);
    const std::uint16_t w = static_cast<std::uint16_t>((rect_header[4] << 8) | rect_header[5]);
    const std::uint16_t h = static_cast<std::uint16_t>((rect_header[6] << 8) | rect_header[7]);
    const std::int32_t encoding =
        (rect_header[8] << 24) | (rect_header[9] << 16) | (rect_header[10] << 8) | rect_header[11];
    if (encoding != 0) return false;  // Raw only; see SetEncodingsRawOnly.
    if (static_cast<std::uint32_t>(x) + w > width || static_cast<std::uint32_t>(y) + h > height) {
      return false;  // a server misbehaving relative to its own ServerInit.
    }
    for (std::uint16_t line = 0; line < h; ++line) {
      std::uint8_t* destination = framebuffer->data()
          + static_cast<std::size_t>(y + line) * row_bytes
          + static_cast<std::size_t>(x) * 4;
      if (!ReadFull(fd, destination, static_cast<std::size_t>(w) * 4)) return false;
    }
  }
  return true;
}

}  // namespace

std::string DecryptVncPasswordFile(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return {};
  std::vector<char> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  if (bytes.size() < 8 || !des::SelfCheck()) return {};
  std::array<std::uint8_t, 8> stored{};
  std::memcpy(stored.data(), bytes.data(), 8);
  const auto plain = des::Decrypt(stored, BitReversedKey(kFixedPasswordFileKey));
  std::string password;
  for (const auto byte : plain) {
    if (byte == 0) break;  // vncpasswd null-pads short passwords.
    password.push_back(static_cast<char>(byte));
  }
  return password;
}

bool ProbeVncServer(const std::string& host, std::uint16_t port, int timeout_ms) noexcept {
  const int fd = ConnectWithTimeout(host, port, timeout_ms);
  if (fd < 0) return false;
  char version[12];
  const bool ok = ReadFull(fd, version, 12) && std::strncmp(version, "RFB 003.0", 9) == 0;
  close(fd);
  return ok;
}

// ── VncCaptureAdapter ────────────────────────────────────────────────────

VncCaptureAdapter::VncCaptureAdapter(std::string host, std::uint16_t port,
                                     std::string password) noexcept
    : host_(std::move(host)), port_(port), password_(std::move(password)) {}

VncCaptureAdapter::~VncCaptureAdapter() { Stop(); }

ReadinessState VncCaptureAdapter::ProbeReadiness() {
  if (!des::SelfCheck()) return ReadinessState::kUnavailable;
  return ProbeVncServer(host_, port_, /*timeout_ms=*/500)
      ? ReadinessState::kReady : ReadinessState::kUnavailable;
}

bool VncCaptureAdapter::Start(const DisplayTopology& display, CapturedFrameSink sink) {
  if (running_.exchange(true)) return false;
  const PixelSize requested = display.encoded_pixels;
  poll_thread_ = std::thread(&VncCaptureAdapter::PollLoop, this, requested, std::move(sink));
  // The poll loop performs the real connect+handshake itself and simply
  // stops (leaving `running_` true but delivering nothing) if that fails;
  // CaptureAdapter::Start's contract only promises the attempt started, the
  // same as X11CaptureAdapter's own synchronous-first-frame guarantee does
  // not extend to a server that is readiness-probed but then vanishes.
  return true;
}

void VncCaptureAdapter::Stop() noexcept {
  running_ = false;
  if (poll_thread_.joinable()) poll_thread_.join();
}

void VncCaptureAdapter::PollLoop(PixelSize requested, CapturedFrameSink sink) {
  RfbConnection connection;
  if (!Handshake(host_, port_, password_, /*timeout_ms=*/3000, &connection)) {
    running_ = false;
    return;
  }
  if (!SetPixelFormatBgra8888(connection.fd) || !SetEncodingsRawOnly(connection.fd)) {
    running_ = false;
    return;
  }

  const std::uint16_t width = connection.framebuffer_width;
  const std::uint16_t height = connection.framebuffer_height;
  std::vector<std::uint8_t> framebuffer(static_cast<std::size_t>(width) * height * 4, 0);

  // ~30fps, matching X11CaptureAdapter's own poll cadence: a fixed interval
  // full-frame pull is simple and correct, not yet bandwidth-optimal (see
  // this file's own header comment on why Raw + non-incremental was chosen
  // for a first, correct slice). Always non-incremental, on purpose, not
  // just for the first request: an incremental (1) request only gets a
  // reply once the server's own damage tracking sees the screen actually
  // change, so on an idle desktop with nothing animating it can block
  // indefinitely -- exactly the failure this adapter must not have, since
  // every other capture backend in this codebase keeps delivering frames on
  // a fixed cadence regardless of on-screen activity.
  constexpr auto kFrameInterval = std::chrono::milliseconds(33);
  while (running_.load(std::memory_order_relaxed)) {
    const auto frame_start = std::chrono::steady_clock::now();
    if (!RequestFramebufferUpdate(connection.fd, width, height, /*incremental=*/false)) break;
    if (!ReadFramebufferUpdate(connection.fd, width, height, &framebuffer)) break;

    std::vector<std::byte> owned(framebuffer.size());
    std::memcpy(owned.data(), framebuffer.data(), framebuffer.size());

    CapturedFrame frame;
    frame.encoded_pixels = requested.IsValid() ? requested : PixelSize{width, height};
    frame.pixel_format = common::PixelFormat::kBgra8888;
    frame.row_bytes = static_cast<std::uint32_t>(width) * 4;
    frame.capture_time_us = NowMicroseconds();
    frame.storage = std::make_shared<VectorFrameStorage>(std::move(owned));
    sink(std::move(frame));

    const auto elapsed = std::chrono::steady_clock::now() - frame_start;
    if (elapsed < kFrameInterval) std::this_thread::sleep_for(kFrameInterval - elapsed);
  }
  running_ = false;
}

}  // namespace imcodes::remote_desktop::linux_platform
