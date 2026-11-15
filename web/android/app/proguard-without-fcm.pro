# withoutFcm flavor excludes com.google.android.gms, so optional Play Store
# in-app update hooks inside @capgo/capacitor-updater (and its play-core
# app-update dependency) reference stripped GMS Task/Status classes in unused
# methods. Keep strict missing-class checks on withFcm by scoping these rules
# strictly to withoutFcm.
-dontwarn com.google.android.gms.tasks.**
-dontwarn com.google.android.gms.common.api.ApiException
-dontwarn com.google.android.gms.common.api.Status
