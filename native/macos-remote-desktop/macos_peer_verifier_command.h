#ifndef IMCODES_NATIVE_MACOS_REMOTE_DESKTOP_MACOS_PEER_VERIFIER_COMMAND_H_
#define IMCODES_NATIVE_MACOS_REMOTE_DESKTOP_MACOS_PEER_VERIFIER_COMMAND_H_

namespace imcodes::remote_desktop::macos {

struct MacosPeerVerifierCommandResult {
  bool handled = false;
  int exit_code = 0;
};

/**
 * Handles the bounded root-host peer-verification mode. The accepted Unix
 * socket is inherited as descriptor 3; no peer identity is accepted from IPC
 * JSON or environment variables. A normal LaunchAgent invocation is reported
 * as unhandled so its main can continue through the worker path.
 */
MacosPeerVerifierCommandResult MaybeRunMacosPeerVerifierCommand(
    int argc, const char* const argv[]) noexcept;

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_NATIVE_MACOS_REMOTE_DESKTOP_MACOS_PEER_VERIFIER_COMMAND_H_
