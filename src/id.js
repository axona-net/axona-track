// src/id.js — Persistent device identity & environment profiling for axona.track

const ADJECTIVES = [
  'swift', 'bold', 'calm', 'brave', 'sharp', 'vivid', 'keen', 'steady',
  'silent', 'bright', 'nimble', 'amber', 'azure', 'silver', 'stellar', 'cosmic',
  'astral', 'atomic', 'solar', 'polar', 'lunar', 'quantum', 'iron', 'golden'
];

const ANIMALS = [
  'falcon', 'lynx', 'otter', 'badger', 'panther', 'osprey', 'cougar', 'eagle',
  'heron', 'hawk', 'fox', 'wolf', 'condor', 'jaguar', 'cheetah', 'harrier',
  'kestrel', 'seal', 'orca', 'dolphin', 'marten', 'finch', 'raven', 'crane'
];

/**
 * Detect OS / platform
 */
export function detectPlatform() {
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
  let os = 'Unknown OS';
  const hasTouch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 1);
  if (/iPad|iPhone|iPod/.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && hasTouch)) {
    os = 'iOS';
  } else if (/Android/.test(ua)) {
    os = 'Android';
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    os = 'macOS';
  } else if (/Windows/.test(ua)) {
    os = 'Windows';
  } else if (/Linux/.test(ua)) {
    os = 'Linux';
  }

  // Browser detection
  // Note: iOS browsers (Chrome/CriOS, Firefox/FxiOS, Edge/EdgiOS, Opera/OPT) all include "Safari" in their UA string.
  // We MUST check Edge, Opera, Firefox, and Chrome BEFORE Safari to avoid misclassifying other browsers on iOS as Safari.
  let browser = 'Unknown Browser';
  if (/Edg|Edge|EdgiOS|EdgA/i.test(ua)) {
    browser = 'Edge';
  } else if (/OPR|Opera|OPT/i.test(ua)) {
    browser = 'Opera';
  } else if (/Firefox|FxiOS/i.test(ua)) {
    browser = 'Firefox';
  } else if (/CriOS|Chrome|CrMo/i.test(ua)) {
    browser = 'Chrome';
  } else if (/Safari/i.test(ua)) {
    browser = 'Safari';
  }

  // Standalone PWA detection
  const isStandalone = typeof window !== 'undefined' && (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: fullscreen)')?.matches ||
    window.navigator?.standalone === true ||
    (typeof document !== 'undefined' && document.referrer?.includes('android-app://'))
  );

  return {
    os,
    browser,
    isStandalone: !!isStandalone,
    displayMode: isStandalone ? 'standalone-pwa' : 'browser-tab',
    userAgent: ua,
    hardwareConcurrency: (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null) || null,
    deviceMemory: (typeof navigator !== 'undefined' ? navigator.deviceMemory : null) || null,
    screen: typeof window !== 'undefined' && window.screen ? {
      width: window.screen.width,
      height: window.screen.height,
      pixelRatio: window.devicePixelRatio || 1
    } : null,
    touchSupported: typeof window !== 'undefined' ? ('ontouchstart' in window || (navigator?.maxTouchPoints > 0)) : false
  };
}

/**
 * Accurately describe device type and suitable status icons, incorporating browser & OS
 */
export function getDeviceTypeDesc(platform) {
  const p = platform || detectPlatform();
  const ua = p.userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
  let noun = 'Device';
  let wakeIcon = '💻';
  let sleepIcon = '💤';

  if (p.os === 'iOS') {
    wakeIcon = '📱';
    sleepIcon = '📴';
    if (/iPad/.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && p.touchSupported)) {
      noun = 'iPad';
    } else {
      noun = 'Phone';
    }
  } else if (p.os === 'Android') {
    wakeIcon = '📱';
    sleepIcon = '📴';
    if (/Mobile/.test(ua)) {
      noun = 'Phone';
    } else {
      noun = 'Tablet';
    }
  } else if (p.os === 'macOS') {
    noun = 'Mac';
    wakeIcon = '💻';
    sleepIcon = '💤';
  } else if (p.os === 'Windows') {
    noun = 'PC';
    wakeIcon = '💻';
    sleepIcon = '💤';
  } else if (p.os === 'Linux') {
    noun = 'Linux PC';
    wakeIcon = '💻';
    sleepIcon = '💤';
  }

  const browserLabel = p.browser && p.browser !== 'Unknown Browser' ? p.browser : '';
  const osLabel = p.os && p.os !== 'Unknown OS' ? p.os : '';
  let descriptor = noun;
  if (osLabel && browserLabel) {
    descriptor = `${noun} (${osLabel} ${browserLabel})`;
  } else if (browserLabel) {
    descriptor = `${noun} (${browserLabel})`;
  } else if (osLabel) {
    descriptor = `${noun} (${osLabel})`;
  }

  return { noun, descriptor, wakeIcon, sleepIcon, os: p.os, browser: p.browser };
}

/**
 * Get or create persistent human-friendly device name incorporating browser identity
 * Format: adj-animal-os-browser-mode-rand (6 parts)
 * Migrates legacy 5-part names (adj-animal-os-mode-rand) seamlessly.
 */
export function getOrCreateDeviceName() {
  // Clear any legacy UUID from storage
  try {
    localStorage.removeItem('axona.track.device_uuid');
  } catch {}

  const platform = detectPlatform();
  const osShort = platform.os.toLowerCase().replace(/[^a-z0-9]/g, '');
  const browserShort = platform.browser.toLowerCase().replace(/[^a-z0-9]/g, '');
  const modeShort = platform.isStandalone ? 'pwa' : 'tab';

  let name = null;
  try {
    name = localStorage.getItem('axona.track.device_name');
  } catch {}

  if (name) {
    const parts = name.split('-');
    // Migration 1: If legacy 5-part name (adj-animal-os-mode-rand), inject browserShort at index 3
    if (parts.length === 5) {
      parts.splice(3, 0, browserShort);
      name = parts.join('-');
      try {
        localStorage.setItem('axona.track.device_name', name);
      } catch {}
    } else if (parts.length === 6) {
      // If browser changed or was previously misclassified, update browser slot
      if (parts[3] !== browserShort && browserShort !== 'unknownbrowser') {
        parts[3] = browserShort;
        name = parts.join('-');
        try {
          localStorage.setItem('axona.track.device_name', name);
        } catch {}
      }
    }
  }

  if (!name) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const rand = Math.random().toString(36).slice(2, 6);

    name = `${adj}-${animal}-${osShort}-${browserShort}-${modeShort}-${rand}`;
    try {
      localStorage.setItem('axona.track.device_name', name);
    } catch {}
  }

  return name;
}

// Backward-compat alias returning { name }
export function getOrCreateDeviceId() {
  return { name: getOrCreateDeviceName() };
}

/**
 * Gather live dynamic environment stats (network, battery)
 */
export async function getLiveEnvironmentStats() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  const netStats = {
    onLine: navigator.onLine,
    effectiveType: conn?.effectiveType || 'unknown',
    downlink: conn?.downlink || null,
    rtt: conn?.rtt || null,
    saveData: !!conn?.saveData
  };

  let batteryStats = null;
  if (typeof navigator.getBattery === 'function') {
    try {
      const b = await navigator.getBattery();
      batteryStats = {
        charging: b.charging,
        level: Math.round(b.level * 100),
        chargingTime: b.chargingTime,
        dischargingTime: b.dischargingTime
      };
    } catch {
      // Battery API disallowed by permission policy or browser
    }
  }

  return {
    network: netStats,
    battery: batteryStats,
    timestamp: Date.now()
  };
}
