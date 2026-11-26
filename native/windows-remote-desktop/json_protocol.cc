#include "third_party/imcodes_remote_desktop/json_protocol.h"

// This compatibility translation unit is intentionally not part of any build.
// The Windows worker links the implementation from the platform-neutral common
// target; keep this file only for tooling that inventories product-only source.
static_assert(imcodes::rd::kProtocolVersion == 2);
