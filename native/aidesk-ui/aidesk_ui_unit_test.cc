#include "aidesk_ui_strings.h"
#include "../remote-desktop-common/local_management_ipc.h"
#include "../remote-desktop-common/local_management_open_window.h"

#include <cstdlib>
#include <iostream>
#include <string>
#if !defined(_WIN32)
#include <cstring>
#include <thread>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {
void Check(bool value, const char* message) {
  if (!value) { std::cerr << message << '\n'; std::exit(1); }
}

#if !defined(_WIN32)
// A real loopback listener answering one request: the open-window client must treat only a 200 as "the node opened the window".
unsigned short ServeOnce(const char* reply, std::string* seen, std::thread* worker) {
  const int listener = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address));
  listen(listener, 1);
  socklen_t length = sizeof(address);
  getsockname(listener, reinterpret_cast<sockaddr*>(&address), &length);
  *worker = std::thread([=] {
    const int client = accept(listener, nullptr, nullptr);
    char buffer[1024];
    const ssize_t received = recv(client, buffer, sizeof(buffer), 0);
    if (seen != nullptr && received > 0) seen->assign(buffer, static_cast<size_t>(received));
    if (reply != nullptr) send(client, reply, std::strlen(reply), 0);
    close(client);
    close(listener);
  });
  return ntohs(address.sin_port);
}
#endif

void CheckOpenWindowRequest() {
  using namespace imcodes::remote_desktop::common;
  Check(LocalManagementHttpStatus("HTTP/1.1 200 OK\r\n") == 200, "status 200");
  Check(LocalManagementHttpStatus("HTTP/1.1 502 Bad Gateway") == 502, "status 502");
  Check(LocalManagementHttpStatus("garbage") == 0 && LocalManagementHttpStatus("") == 0 &&
            LocalManagementHttpStatus("HTTP/1.1 2x0 ") == 0, "status garbage");
  const std::string request = LocalManagementOpenWindowRequest();
  Check(request.rfind("POST /open-window HTTP/1.1\r\n", 0) == 0, "open-window request line");
  Check(request.find("x-aidesk-open-window: 1\r\n") != std::string::npos, "open-window header");
  Check(request.find("Host: 127.0.0.1:43751\r\n") != std::string::npos, "open-window host");
  Check(request.find("Origin") == std::string::npos, "open-window has no Origin");
#if !defined(_WIN32)
  { std::string seen; std::thread worker; const auto port = ServeOnce("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", &seen, &worker);
    Check(RequestLocalManagementWindow(port, 2000), "node answered 200"); worker.join();
    Check(seen.rfind("POST /open-window", 0) == 0, "request reached the node"); }
  { std::thread worker; const auto port = ServeOnce("HTTP/1.1 404 Not Found\r\n\r\n", nullptr, &worker);
    Check(!RequestLocalManagementWindow(port, 2000), "older node (404) falls back"); worker.join(); }
  { std::thread worker; const auto port = ServeOnce("HTTP/1.1 401 Unauthorized\r\n\r\n", nullptr, &worker);
    Check(!RequestLocalManagementWindow(port, 2000), "older panel (401) falls back"); worker.join(); }
  { std::thread worker; const auto port = ServeOnce("HTTP/1.1 502 Bad Gateway\r\n\r\n", nullptr, &worker);
    Check(!RequestLocalManagementWindow(port, 2000), "node failure (502) falls back"); worker.join(); }
  { std::thread worker; const auto port = ServeOnce(nullptr, nullptr, &worker);
    Check(!RequestLocalManagementWindow(port, 300), "silent node falls back"); worker.join(); }
  Check(!RequestLocalManagementWindow(1, 300), "nothing listening falls back");
#endif
}
}

int main() {
  using namespace imcodes::aidesk::ui;
  using namespace imcodes::remote_desktop::common;
  Check(LocaleFromLanguageTag("zh-Hant-HK") == Locale::kZhTw, "traditional locale");
  Check(LocaleFromLanguageTag("zh-CN") == Locale::kZhCn, "simplified locale");
  Check(LocaleFromLanguageTag("es-MX") == Locale::kEs, "spanish locale");
  Check(!Translate(Locale::kJa, Text::kDisconnect).empty(), "seven-language text");
  Check(FormatDuration(65'000) == "01:05", "short duration");
  Check(FormatDuration(3'661'000) == "01:01:01", "long duration");
  const std::string bootstrap =
      "{\"version\":1,\"protocolVersion\":1,\"endpoint\":\"/tmp/a.sock\","
      "\"bootstrapSecret\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\","
      "\"runtimeVersion\":\"2026.9.1\",\"productVersion\":\"2026.9.1\"}";
  const auto parsed = ParseLocalManagementBootstrap(bootstrap);
  Check(parsed.has_value() && parsed->endpoint == "/tmp/a.sock", "bootstrap parse");
  Check(!ParseLocalManagementBootstrap(bootstrap + "x").has_value(), "bootstrap reject");
  for (int locale = static_cast<int>(Locale::kEn);
       locale <= static_cast<int>(Locale::kKo); ++locale) {
    for (int text = static_cast<int>(Text::kProductName);
         text <= static_cast<int>(Text::kAccessPaused); ++text) {
      Check(!Translate(static_cast<Locale>(locale), static_cast<Text>(text)).empty(),
            "translation completeness");
    }
  }
  CheckOpenWindowRequest();
  return 0;
}
