import product from './aidesk-product.json' with { type: 'json' };

/** One authored source for every OS-visible aiDesk product/launcher name. */
export const AIDESK_PRODUCT = Object.freeze(product);

export const AIDESK_PRODUCT_NAME = AIDESK_PRODUCT.displayName;
export const AIDESK_MACOS_APP_NAME = AIDESK_PRODUCT.macosAppName;
export const AIDESK_MACOS_BUNDLE_ID = AIDESK_PRODUCT.macosBundleId;
export const AIDESK_LINUX_DESKTOP_FILE_NAME = AIDESK_PRODUCT.linuxDesktopFileName;
export const AIDESK_WINDOWS_SHORTCUT_FILE_NAME = AIDESK_PRODUCT.windowsShortcutFileName;
