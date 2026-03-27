import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.im.codes',
  appName: 'IM.codes',
  webDir: 'dist',
  server: {
    iosScheme: 'https',
    androidScheme: 'https',
    // During development, point to the Vite dev server for live reload.
    // Comment out for production builds.
    // url: 'http://localhost:5173',
    // cleartext: true,
  },
  plugins: {
    CapacitorUpdater: {
      autoUpdate: false,           // we use manual mode in update-manager.ts
      directUpdate: false,         // we handle apply timing ourselves
      autoDeleteFailed: true,
      autoDeletePrevious: true,
      resetWhenUpdate: true,
      statsUrl: '',                // disable stats reporting to Capgo cloud
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchShowDuration: 1000,
      backgroundColor: '#0f172a',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0f172a',
    },
  },
  ios: {
    contentInset: 'never',
    backgroundColor: '#0f172a',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
