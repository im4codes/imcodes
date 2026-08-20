// The SDK targets need one compilation unit so GN applies and exports the
// exact consumer compile configuration. Product code is deliberately absent:
// changing worker implementation bytes must not rebuild the pinned SDK.
namespace imcodes::remote_desktop {

void LibwebrtcSdkAnchor() {}

}  // namespace imcodes::remote_desktop
