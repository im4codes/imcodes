#ifndef IMCODES_REMOTE_DESKTOP_ICE_CANDIDATE_QUEUE_H_
#define IMCODES_REMOTE_DESKTOP_ICE_CANDIDATE_QUEUE_H_

#include <cstddef>
#include <string>
#include <vector>

namespace imcodes::rd {

struct PendingRemoteIceCandidate {
  std::string mid;
  std::string candidate;
};

// WebRTC trickle candidates can arrive while SetRemoteDescription is still
// asynchronous. Keep that race bounded and FIFO; never silently discard the
// first host candidate, because many same-LAN peers gather only one.
class PendingRemoteIceCandidates {
 public:
  explicit PendingRemoteIceCandidates(size_t maximum) : maximum_(maximum) {}
  ~PendingRemoteIceCandidates();

  bool Push(std::string mid, std::string candidate);
  std::vector<PendingRemoteIceCandidate> TakeAll();
  void Clear();
  size_t size() const { return values_.size(); }

 private:
  const size_t maximum_;
  std::vector<PendingRemoteIceCandidate> values_;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_ICE_CANDIDATE_QUEUE_H_
