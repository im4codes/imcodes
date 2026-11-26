#include "third_party/imcodes_remote_desktop/pipe_ipc.h"

#include <windows.h>

#include <atomic>
#include <chrono>
#include <string>
#include <thread>

#include "test/gtest.h"

namespace imcodes::rd {
namespace {

std::wstring UniquePipePath() {
  return L"\\\\.\\pipe\\imcodes-remote-desktop-test-" +
         std::to_wstring(GetCurrentProcessId()) + L"-" +
         std::to_wstring(GetTickCount64());
}

// A daemon stand-in: accepts one client and then stays silent, which is exactly
// the state the real daemon sits in between lease renewals.
class SilentPipeServer {
 public:
  explicit SilentPipeServer(const std::wstring& path) {
    server_ = CreateNamedPipeW(path.c_str(), PIPE_ACCESS_DUPLEX,
                              PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                              1, 64 * 1024, 64 * 1024, 0, nullptr);
  }
  ~SilentPipeServer() {
    if (server_ != INVALID_HANDLE_VALUE) {
      DisconnectNamedPipe(server_);
      CloseHandle(server_);
    }
  }
  bool valid() const { return server_ != INVALID_HANDLE_VALUE; }
  HANDLE handle() const { return server_; }
  void Accept() { ConnectNamedPipe(server_, nullptr); }

 private:
  HANDLE server_ = INVALID_HANDLE_VALUE;
};

// REPRODUCTION: the worker used one non-overlapped handle for both directions.
// Windows serialises I/O per handle, so an outbound frame could not leave while
// the read loop was parked waiting for the daemon -- the session then advanced
// one lease renewal (five seconds) per hop. This test keeps a read pending and
// requires the write to complete anyway.
TEST(PipeIpcTest, WriteCompletesWhileAReadIsPending) {
  const std::wstring path = UniquePipePath();
  SilentPipeServer server(path);
  ASSERT_TRUE(server.valid());

  PipeChannel channel;
  std::thread accept([&server] { server.Accept(); });
  const bool connected = channel.Connect(path, std::chrono::seconds(5));
  accept.join();
  ASSERT_TRUE(connected);

  std::atomic<bool> reading{true};
  std::thread reader([&channel, &reading] {
    char buffer[256];
    channel.Read(buffer, sizeof(buffer));
    reading = false;
  });

  // Give the read time to be genuinely pending inside the kernel.
  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  EXPECT_TRUE(reading.load());

  // The write runs on its own thread so a regression reports a failure instead
  // of hanging the suite: with one non-overlapped handle it would never return
  // until the daemon spoke, which is the defect this covers.
  std::atomic<bool> wrote{false};
  std::atomic<bool> write_result{false};
  std::thread writer([&channel, &wrote, &write_result] {
    write_result = channel.Write("{\"type\":\"remote_desktop.status\"}\n");
    wrote = true;
  });
  for (int waited = 0; waited < 15 && !wrote.load(); ++waited) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  EXPECT_TRUE(wrote.load());
  EXPECT_TRUE(reading.load()) << "the read must still be pending";

  // Unblock both threads so the test can finish either way.
  const std::string wake = "{}\n";
  DWORD written = 0;
  WriteFile(server.handle(), wake.data(), static_cast<DWORD>(wake.size()),
            &written, nullptr);
  writer.join();
  reader.join();
  EXPECT_TRUE(write_result.load());
  channel.Close();
}

TEST(PipeIpcTest, ReadsWhatTheDaemonSends) {
  const std::wstring path = UniquePipePath();
  SilentPipeServer server(path);
  ASSERT_TRUE(server.valid());

  PipeChannel channel;
  std::thread accept([&server] { server.Accept(); });
  const bool connected = channel.Connect(path, std::chrono::seconds(5));
  accept.join();
  ASSERT_TRUE(connected);

  const std::string line = "{\"type\":\"remote_desktop.lease\"}\n";
  DWORD written = 0;
  ASSERT_TRUE(WriteFile(server.handle(), line.data(),
                        static_cast<DWORD>(line.size()), &written, nullptr));

  char buffer[256] = {};
  const size_t read = channel.Read(buffer, sizeof(buffer));
  EXPECT_EQ(std::string(buffer, read), line);
  channel.Close();
}

TEST(PipeIpcTest, RefusesAMissingPipeWithoutBlocking) {
  PipeChannel channel;
  const auto started = std::chrono::steady_clock::now();
  EXPECT_FALSE(channel.Connect(UniquePipePath(), std::chrono::seconds(5)));
  const auto elapsed = std::chrono::steady_clock::now() - started;
  EXPECT_LT(std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count(),
            1000);
}

}  // namespace
}  // namespace imcodes::rd
