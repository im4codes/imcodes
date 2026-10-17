#ifndef IMCODES_POSIX_SHARED_LOCAL_MANAGEMENT_OPEN_WINDOW_POSIX_H_
#define IMCODES_POSIX_SHARED_LOCAL_MANAGEMENT_OPEN_WINDOW_POSIX_H_

// The blocking POSIX (Linux and macOS) client of the node's open-window endpoint. The OS-neutral request/response contract is in
// ../remote-desktop-common/local_management_open_window.h; this file holds the socket code that the common directory must not carry.

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <string>
#include <string_view>

#include "../remote-desktop-common/local_management_open_window.h"

namespace imcodes::remote_desktop::common {

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

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_POSIX_SHARED_LOCAL_MANAGEMENT_OPEN_WINDOW_POSIX_H_
