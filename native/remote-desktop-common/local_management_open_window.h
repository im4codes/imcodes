#ifndef IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_OPEN_WINDOW_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_OPEN_WINDOW_H_

// How a native surface (the Windows/Linux indicator, the macOS app and disclosure) asks the controlled node to open -- or focus -- the
// local management panel as an independent window. The decision (native window, app-mode browser, default browser, single instance,
// no desktop) lives in ONE place, the node (shared/local-panel-window.ts); a native surface only POSTs this request to the loopback
// panel and, when the node does not answer 200, falls back to the open it did before (so an older node, or a failure, never leaves
// it without an entry).
//
// The request carries a custom header and no Origin: a web page can do neither (a custom header forces a preflight the panel never
// answers, and every cross-site POST carries an Origin), so no site can make the node open windows.
//
// Must match REMOTE_DESKTOP_LOCAL_MANAGEMENT in shared/remote-desktop-local-management.ts (pinned by a spec test).

#include <string>
#include <string_view>

#if !defined(_WIN32)
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

namespace imcodes::remote_desktop::common {

inline constexpr char kLocalManagementHost[] = "127.0.0.1";
inline constexpr unsigned short kLocalManagementPort = 43751;
inline constexpr char kLocalManagementOpenWindowPath[] = "/open-window";
inline constexpr char kLocalManagementOpenWindowHeader[] = "x-aidesk-open-window";
/** Connecting to loopback is immediate; the answer may take a few seconds (the node starts a browser or native window). */
inline constexpr int kLocalManagementConnectTimeoutMs = 1000;
inline constexpr int kLocalManagementOpenWindowAnswerTimeoutMs = 10000;

/** The exact HTTP request text. Pure, so it can be tested without a socket. */
inline std::string LocalManagementOpenWindowRequest() {
  std::string request = "POST ";
  request += kLocalManagementOpenWindowPath;
  request += " HTTP/1.1\r\nHost: ";
  request += kLocalManagementHost;
  request += ":" + std::to_string(kLocalManagementPort);
  request += "\r\n";
  request += kLocalManagementOpenWindowHeader;
  request += ": 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
  return request;
}

/** The status code of an HTTP response head ("HTTP/1.1 200 OK..."), or 0 when it is not one. */
inline int LocalManagementHttpStatus(std::string_view head) {
  if (head.size() < 12 || head.substr(0, 5) != "HTTP/") return 0;
  const size_t space = head.find(' ');
  if (space == std::string_view::npos || space + 4 > head.size()) return 0;
  int status = 0;
  for (size_t i = space + 1; i < space + 4; ++i) {
    if (head[i] < '0' || head[i] > '9') return 0;
    status = status * 10 + (head[i] - '0');
  }
  return status;
}

/** True when the node answered 200: it opened or focused the window (or, with no desktop, correctly did nothing). */
inline bool LocalManagementOpenWindowAccepted(std::string_view response) {
  return LocalManagementHttpStatus(response) == 200;
}

#if !defined(_WIN32)
/**
 * Blocking POSIX implementation (Linux and macOS). Call it from a context that may block for a few seconds (a forked child, a
 * background queue); never from a UI thread. `port` is a parameter only so tests can use their own listener.
 */
inline bool RequestLocalManagementWindow(unsigned short port = kLocalManagementPort,
                                         int answer_timeout_ms = kLocalManagementOpenWindowAnswerTimeoutMs) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return false;
  bool accepted = false;
  do {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    if (::inet_pton(AF_INET, kLocalManagementHost, &address.sin_addr) != 1) break;
    const int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0 || ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) break;
    const int connected = ::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address));
    if (connected != 0) {
      pollfd wait{fd, POLLOUT, 0};
      if (::poll(&wait, 1, kLocalManagementConnectTimeoutMs) != 1) break;
      int error = 0;
      socklen_t length = sizeof(error);
      if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) != 0 || error != 0) break;
    }
    if (::fcntl(fd, F_SETFL, flags) < 0) break;
    timeval timeout{answer_timeout_ms / 1000, (answer_timeout_ms % 1000) * 1000};
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    const std::string request = LocalManagementOpenWindowRequest();
    size_t sent = 0;
    while (sent < request.size()) {
      const ssize_t written = ::send(fd, request.data() + sent, request.size() - sent, 0);
      if (written <= 0) { sent = request.size() + 1; break; }
      sent += static_cast<size_t>(written);
    }
    if (sent != request.size()) break;
    char buffer[64];
    size_t received = 0;
    while (received < 12) {
      const ssize_t read = ::recv(fd, buffer + received, sizeof(buffer) - received, 0);
      if (read <= 0) break;
      received += static_cast<size_t>(read);
    }
    accepted = LocalManagementOpenWindowAccepted(std::string_view(buffer, received));
  } while (false);
  ::close(fd);
  return accepted;
}
#endif  // !_WIN32

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_MANAGEMENT_OPEN_WINDOW_H_
