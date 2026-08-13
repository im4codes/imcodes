#include "third_party/imcodes_remote_desktop/ice_candidate_queue.h"

#include <algorithm>
#include <utility>

namespace imcodes::rd {

namespace {

void ZeroString(std::string* value) {
  std::fill(value->begin(), value->end(), '\0');
  value->clear();
}

}  // namespace

PendingRemoteIceCandidates::~PendingRemoteIceCandidates() {
  Clear();
}

bool PendingRemoteIceCandidates::Push(std::string mid,
                                      std::string candidate) {
  if (values_.size() >= maximum_) {
    ZeroString(&mid);
    ZeroString(&candidate);
    return false;
  }
  values_.push_back({std::move(mid), std::move(candidate)});
  return true;
}

std::vector<PendingRemoteIceCandidate>
PendingRemoteIceCandidates::TakeAll() {
  std::vector<PendingRemoteIceCandidate> result;
  result.swap(values_);
  return result;
}

void PendingRemoteIceCandidates::Clear() {
  for (PendingRemoteIceCandidate& value : values_) {
    ZeroString(&value.mid);
    ZeroString(&value.candidate);
  }
  values_.clear();
}

}  // namespace imcodes::rd
