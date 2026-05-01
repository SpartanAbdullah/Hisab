import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hisaab.app',
  appName: 'Hisaab',
  webDir: 'dist',
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      backgroundColor: '#f8fafc',
      style: 'LIGHT',
    },
  },
};

export default config;
