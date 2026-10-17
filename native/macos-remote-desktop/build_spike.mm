#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>

#include <utility>

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_APPLE_FRAMEWORK_ONLY
#include "api/create_modular_peer_connection_factory.h"
#endif

namespace {

bool TouchAppleMediaFrameworks() {
  // Referencing concrete Objective-C classes and C functions makes omission
  // of either framework a link error rather than a header-only false green.
  SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
  configuration.width = 16;
  configuration.height = 16;
  const Class shareable_content_class = [SCShareableContent class];

  VTCompressionSessionRef compression_session = nullptr;
  const OSStatus status = VTCompressionSessionCreate(
      kCFAllocatorDefault,
      16,
      16,
      kCMVideoCodecType_H264,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      &compression_session);
  if (compression_session != nullptr) {
    VTCompressionSessionInvalidate(compression_session);
    CFRelease(compression_session);
  }

  return shareable_content_class != Nil && configuration != nil &&
         status != kVTParameterErr;
}

}  // namespace

int main() {
  @autoreleasepool {
    const bool apple_media_available = TouchAppleMediaFrameworks();

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_APPLE_FRAMEWORK_ONLY
    // This exported factory call forces a real symbol from the pinned WebRTC
    // target into the final link. The probe does not create a session or use a
    // second media transport.
    webrtc::PeerConnectionFactoryDependencies dependencies;
    auto peer_factory =
        webrtc::CreateModularPeerConnectionFactory(std::move(dependencies));
    return apple_media_available && peer_factory != nullptr ? 0 : 1;
#else
    return apple_media_available ? 0 : 1;
#endif
  }
}
