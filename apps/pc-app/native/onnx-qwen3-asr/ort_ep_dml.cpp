#if defined(IMCODES_HAS_ONNXRUNTIME) && defined(IMCODES_ORT_HAS_DML)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <dml_provider_factory.h>
#include <onnxruntime_cxx_api.h>

namespace imcodes::qwen3 {

bool append_dml_execution_provider(OrtSessionOptions* raw_opts, int device_id) {
  if (!raw_opts) return false;
  OrtStatus* status = OrtSessionOptionsAppendExecutionProvider_DML(raw_opts, device_id);
  if (status == nullptr) {
    return true;
  }
  Ort::GetApi().ReleaseStatus(status);
  return false;
}

}  // namespace imcodes::qwen3
#endif
