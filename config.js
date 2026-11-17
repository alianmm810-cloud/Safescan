// ============================================================
// إعدادات SafeScan
// الصق هنا بيانات firebaseConfig الخاصة بتطبيق الويب من Firebase
// (Project settings > Your apps > Web app > SDK setup and configuration > Config)
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyDGM8y-6fAe82qPpSdI43eZTvVjntJtT8s",
  authDomain: "safescan-79b29.firebaseapp.com",
  projectId: "safescan-79b29",
  storageBucket: "safescan-79b29.firebasestorage.app",
  messagingSenderId: "11756581665",
  appId: "1:11756581665:web:3b4fefcd3b4a591a844460"
};

// مدة الفحص البصري بالأشهر (شهري)
export const VISUAL_MONTHS = 1;
// مدة دورة الورشة بالأشهر (سنوي)
export const WORKSHOP_MONTHS = 12;
// أقصى مسافة مسموحة بين المفتش والطفاية بالمتر (للتنبيه فقط، لا تمنع الفحص)
export const DEFAULT_RADIUS_M = 50;
