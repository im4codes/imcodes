#include "macos_peer_verifier_command.h"
#include "macos_session_identity.h"
#include "macos_virtual_display_authority_link.h"
#include "macos_virtual_display_authority_link_posix.h"
#include "macos_virtual_display_resident.h"
#include "macos_virtual_display_resident_loop.h"
#include "macos_virtual_display_supervisor_posix.h"
#include "macos_worker_ipc_client.h"

#include <sys/wait.h>

#include <bsm/audit.h>
#include <bsm/audit_session.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <spawn.h>
#include <sysexits.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstring>
#include <iostream>
#include <cstdio>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

extern char** environ;

namespace {

constexpr char kWorkerFileName[] = "imcodes-remote-desktop-worker";
/** Must match kLaunchAgentArgument in the worker and LAUNCH_AGENT_ARGUMENT in
 *  the TypeScript that writes the plist. */
constexpr char kSessionModeArgument[] = "--macos-remote-desktop-launch-agent";

bool ResolveSiblingWorker(std::string* worker_path) {
  uint32_t size = 0;
  if (_NSGetExecutablePath(nullptr, &size) != -1 || size == 0 ||
      size > 64 * 1024) {
    return false;
  }
  std::vector<char> executable(size);
  if (_NSGetExecutablePath(executable.data(), &size) != 0) return false;
  const std::string current(executable.data());
  const std::string::size_type slash = current.find_last_of('/');
  if (slash == std::string::npos) return false;
  *worker_path = current.substr(0, slash + 1);
  worker_path->append(kWorkerFileName);
  return true;
}

// Publishes which session launchd actually loaded this agent into.
//
// The plist cannot carry it: one `LimitLoadToSessionType` array serves both
// Aqua and LoginWindow, so the installed artifact is identical for the two and
// only the running process can tell them apart. The worker re-derives both
// values from the kernel and refuses to run if they disagree, so this is a
// declaration the worker checks, never an authority it trusts.
bool DeclareSessionIdentity() {
  namespace macos = imcodes::remote_desktop::macos;
  const macos::MacosSessionIdentityObservation observation =
      macos::ObserveMacosSessionIdentity();
  const std::string_view session_type =
      macos::ClassifyMacosSessionType(observation);
  if (session_type.empty()) {
    // Neither an Aqua console session nor a login window. Refused here rather
    // than exec'ing a worker that would have to guess.
    std::cerr << "macos_launch_agent_session_type_unclassified\n";
    return false;
  }
  char audit_session[32];
  std::snprintf(audit_session, sizeof(audit_session), "%u",
                observation.audit_session_id);
  const std::string session_value(session_type);
  return ::setenv(macos::kEnvSessionType, session_value.c_str(), 1) == 0
      && ::setenv(macos::kEnvAuditSessionId, audit_session, 1) == 0;
}

int ExecVerifiedSiblingWorker(int argc, const char* const argv[]) {
  std::string worker_path;
  if (!ResolveSiblingWorker(&worker_path)) {
    std::cerr << "macos_launch_agent_worker_path_unavailable\n";
    return EX_OSERR;
  }

  std::vector<char*> forwarded;
  forwarded.reserve(static_cast<size_t>(argc) + 1);
  forwarded.push_back(worker_path.data());
  for (int index = 1; index < argc; ++index) {
    forwarded.push_back(const_cast<char*>(argv[index]));
  }
  forwarded.push_back(nullptr);
  execv(worker_path.c_str(), forwarded.data());
  const int error = errno;
  std::cerr << "macos_launch_agent_worker_exec_failed errno=" << error
            << " message=" << std::strerror(error) << '\n';
  return error == ENOENT ? EX_UNAVAILABLE : EX_OSERR;
}

/**
 * Set by SIGTERM/SIGINT. launchd asks politely first, and an agent that ignored
 * that would be killed with a helper still running and nobody left to reap it.
 */
std::atomic_bool g_stop_requested{false};

void OnStopSignal(int) noexcept { g_stop_requested.store(true); }

/** Spawns the worker as a CHILD, so this process survives it and can own the
 *  helper across route lifetimes. exec-replacing ourselves -- which is what
 *  this agent used to do -- left no process to own anything. */
bool SpawnWorkerChild(const std::string& worker_path,
                      int argc,
                      const char* const argv[],
                      pid_t* child) {
  std::vector<char*> forwarded;
  forwarded.reserve(static_cast<std::size_t>(argc) + 1);
  std::string program(worker_path);
  forwarded.push_back(program.data());
  for (int index = 1; index < argc; ++index) {
    forwarded.push_back(const_cast<char*>(argv[index]));
  }
  forwarded.push_back(nullptr);
  // The worker's own environment, unchanged. It carries the daemon IPC socket
  // and the session declaration the worker re-derives from the kernel anyway.
  // It carries NO display authority: that lives only on the link this process
  // holds, and the link descriptor is close-on-exec.
  return posix_spawn(child, worker_path.c_str(), nullptr, nullptr,
                     forwarded.data(), environ) == 0;
}

/** This process's own audit session, for the readiness/route binding. */
std::uint32_t OwnAuditSessionId() {
  auditinfo_addr_t info = {};
  if (getaudit_addr(&info, sizeof(info)) != 0) return 0;
  return static_cast<std::uint32_t>(info.ai_asid);
}

/**
 * Runs as the resident virtual-display owner for this console session.
 *
 * Ordering matters and is not arbitrary: the authority link is established
 * BEFORE the worker is spawned. A worker that started first would run for a
 * while with no display authority available and would cache that as "no display
 * on this machine" -- which is a wrong answer that persists for the session.
 */
int RunResidentAgent(int argc, const char* const argv[]) {
  namespace macos = imcodes::remote_desktop::macos;

  std::string worker_path;
  if (!ResolveSiblingWorker(&worker_path)) {
    std::cerr << "macos_launch_agent_worker_path_unavailable\n";
    return EX_OSERR;
  }

  std::signal(SIGTERM, OnStopSignal);
  std::signal(SIGINT, OnStopSignal);
  // A daemon that goes away mid-write must surface as a failed write, not as
  // this process being killed with a helper still running.
  std::signal(SIGPIPE, SIG_IGN);

  macos::MacosVirtualDisplayAuthorityLink link(
      macos::CreatePosixAuthorityLinkSeam());
  std::string link_error;
  const bool linked =
      link.Establish(macos::kVirtualDisplayAuthoritySocketPath, &link_error);
  if (!linked) {
    // FAIL OPEN FOR THE SESSION, CLOSED FOR THE DISPLAY. No authority link
    // means no virtual display, and that is reported honestly by readiness --
    // but the remote-desktop session itself does not depend on a display, so
    // refusing to start the worker here would take out the whole feature over
    // an optional one. The reason is named rather than swallowed.
    std::cerr << "macos_launch_agent_virtual_display_unavailable reason="
              << link_error << '\n';
  }

  pid_t worker = -1;
  if (!SpawnWorkerChild(worker_path, argc, argv, &worker)) {
    const int error = errno;
    std::cerr << "macos_launch_agent_worker_spawn_failed errno=" << error
              << " message=" << std::strerror(error) << '\n';
    return error == ENOENT ? EX_UNAVAILABLE : EX_OSERR;
  }

  const auto worker_alive = [&worker] {
    if (worker <= 0) return false;
    int status = 0;
    const pid_t reaped = ::waitpid(worker, &status, WNOHANG);
    if (reaped == worker) {
      worker = -1;
      return false;
    }
    return reaped == 0;
  };
  const auto stop_worker = [&worker] {
    if (worker <= 0) return;
    ::kill(worker, SIGTERM);
    // Bounded: a worker that will not go must not hold this process open.
    for (int attempt = 0; attempt < 50; ++attempt) {
      int status = 0;
      if (::waitpid(worker, &status, WNOHANG) == worker) {
        worker = -1;
        return;
      }
      struct timespec pause = {0, 100'000'000};
      (void)nanosleep(&pause, nullptr);
    }
    ::kill(worker, SIGKILL);
    int status = 0;
    (void)::waitpid(worker, &status, 0);
    worker = -1;
  };

  if (linked) {
    macos::ResidentOwnerSeam seam;
    // The peer on this link is root, and the link already proved it. There is
    // no per-frame identity decision left, and no second channel for another
    // kind of peer to arrive on -- this process binds nothing.
    seam.daemon_identity = [&link] {
      macos::ControlPeerIdentity daemon;
      daemon.uid = 0;
      daemon.pid = 1;  // a real process answered; the link proved which kind
      daemon.authenticated =
          link.state() == macos::AuthorityLinkState::kEstablished;
      return daemon;
    };
    seam.authority_challenge = [&link] { return link.challenge(); };
    seam.observe_session = [&link] {
      macos::AgentSessionContext context;
      // uid and audit session come from the KERNEL, never from anything the
      // daemon said: they are what this process actually is.
      context.uid = static_cast<std::uint32_t>(::getuid());
      context.audit_session_id = OwnAuditSessionId();
      const macos::MacosSessionIdentityObservation observed =
          macos::ObserveMacosSessionIdentity();
      context.session_type = std::string(macos::ClassifyMacosSessionType(observed));
      // The service generation comes from the AUTHENTICATED LINK and is fixed
      // for the life of that connection. It was hardcoded to 1, which made the
      // whole generation rule vacuous: every daemon incarnation looked like
      // generation 1, so a grant minted for a previous one could never be
      // told apart from a current one.
      context.service_generation = link.challenge().service_generation;
      return context;
    };
    seam.socket_identity = [] {
      // The rendezvous object this agent is bound to. Re-read every poll so a
      // replacement under the same name revokes rather than being served.
      macos::PathNodeFacts facts;
      macos::SocketIdentity identity;
      const macos::AuthorityLinkSeam probe = macos::CreatePosixAuthorityLinkSeam();
      if (probe.inspect(macos::kVirtualDisplayAuthoritySocketPath, &facts) &&
          facts.exists) {
        identity.device = facts.device;
        identity.inode = facts.inode;
      }
      return identity;
    };
    seam.now_ms = [] {
      struct timespec now = {};
      if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return std::uint64_t{0};
      return static_cast<std::uint64_t>(now.tv_sec) * 1000ULL +
             static_cast<std::uint64_t>(now.tv_nsec) / 1'000'000ULL;
    };
    macos::MacosVirtualDisplayResidentOwner owner(
        macos::SupervisorPolicy{}, macos::CreatePosixSupervisorSeam(),
        std::move(seam));

    macos::ResidentLoopSeam loop;
    loop.wait_readable = [](int descriptor, std::uint32_t interval_ms) {
      struct pollfd entry = {};
      entry.fd = descriptor;
      entry.events = POLLIN;
      const int ready = ::poll(&entry, 1, static_cast<int>(interval_ms));
      return ready > 0;
    };
    loop.worker_alive = worker_alive;
    loop.write_line = [](int descriptor, const std::string& line) {
      return macos::WriteAuthorityLinkLine(
          descriptor, line, macos::kAuthorityLinkWriteTimeoutMs);
    };
    loop.stop_worker = stop_worker;
    loop.stop_requested = [] { return g_stop_requested.load(); };

    const macos::ResidentLoopOutcome outcome =
        macos::RunResidentLoop(&owner, &link, macos::ResidentLoopOptions{}, loop);
    // The reason is named, and it is not a secret: it says which lifetime
    // ended, never what the challenge was.
    std::cerr << "macos_launch_agent_resident_stopped reason="
              << macos::ResidentLoopOutcomeText(outcome) << '\n';
    return EX_OK;
  }

  // No display authority: still supervise the worker, so the session works.
  while (!g_stop_requested.load() && worker_alive()) {
    struct timespec pause = {1, 0};
    (void)nanosleep(&pause, nullptr);
  }
  stop_worker();
  return EX_OK;
}

}  // namespace

int main(int argc, const char* argv[]) {
  const auto verifier =
      imcodes::remote_desktop::macos::MaybeRunMacosPeerVerifierCommand(
          argc, argv);
  if (verifier.handled) return verifier.exit_code;
  if (geteuid() == 0) {
    std::cerr << "macos_launch_agent_refuses_root_worker_start\n";
    return EX_NOPERM;
  }
  if (!DeclareSessionIdentity()) {
    std::cerr << "macos_launch_agent_session_identity_unavailable\n";
    return EX_OSERR;
  }

  // SESSION MODE becomes RESIDENT. Every other invocation -- the readiness and
  // permission commands the daemon runs as short-lived processes -- keeps the
  // tail-exec, because those must answer and exit rather than take ownership
  // of anything.
  for (int index = 1; index < argc; ++index) {
    if (argv[index] != nullptr &&
        std::strcmp(argv[index], kSessionModeArgument) == 0) {
      return RunResidentAgent(argc, argv);
    }
  }
  return ExecVerifiedSiblingWorker(argc, argv);
}
