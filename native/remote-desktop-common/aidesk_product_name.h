#ifndef IMCODES_REMOTE_DESKTOP_COMMON_AIDESK_PRODUCT_NAME_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_AIDESK_PRODUCT_NAME_H_

// Native shared source. test/spec/aidesk-persistent-indicator.test.ts binds
// this value to shared/aidesk-product.json, the JS/TS authoring source.
#define IMCODES_AIDESK_PRODUCT_NAME_LITERAL "aiDesk.to by IM.codes"
#define IMCODES_AIDESK_WIDEN_INNER(value) L##value
#define IMCODES_AIDESK_WIDEN(value) IMCODES_AIDESK_WIDEN_INNER(value)

namespace imcodes::remote_desktop::common {
inline constexpr char kAiDeskProductName[] = IMCODES_AIDESK_PRODUCT_NAME_LITERAL;
inline constexpr wchar_t kAiDeskProductNameWide[] =
    IMCODES_AIDESK_WIDEN(IMCODES_AIDESK_PRODUCT_NAME_LITERAL);
}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_AIDESK_PRODUCT_NAME_H_
