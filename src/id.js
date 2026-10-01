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
  let browser = 'Unknown Browser';
  if (/CriOS|Chrome/.test(ua) && !/Edge|Edg|OPR/.test(ua)) {
    browser = 'Chrome';
  } else if (/Safari/.test(ua) && !/Chrome|CriOS/.test(ua)) {
    browser = 'Safari';
  } else if (/Firefox|FxiOS/.test(ua)) {
    browser = 'Firefox';
  } else if (/Edg|Edge/.test(ua)) {
    browser = 'Edge';
  } else if (/OPR|Opera/.test(ua)) {
    browser = 'Opera';
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
 * Accurately describe device type and suitable status icons
 */
export function getDeviceTypeDesc(platform) {
  const p = platform || detectPlatform();
  const ua = p.userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
  if (p.os === 'iOS') {
    if (/iPad/.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && p.touchSupported)) {
      return { noun: 'iPad', wakeIcon: '📱', sleepIcon: '📴' };
    }
    return { noun: 'Phone', wakeIcon: '📱', sleepIcon: '📴' };
  }
  if (p.os === 'Android') {
    if (/Mobile/.test(ua)) {
      return { noun: 'Phone', wakeIcon: '📱', sleepIcon: '📴' };
    }
    return { noun: 'Tablet', wakeIcon: '📱', sleepIcon: '📴' };
  }
  if (p.os === 'macOS') {
    return { noun: 'Mac', wakeIcon: '💻', sleepIcon: '💤' };
  }
  if (p.os === 'Windows') {
    return { noun: 'PC', wakeIcon: '💻', sleepIcon: '💤' };
  }
  if (p.os === 'Linux') {
    return { noun: 'Linux PC', wakeIcon: '💻', sleepIcon: '💤' };
  }
  return { noun: 'Device', wakeIcon: '💻', sleepIcon: '💤' };
}

/**
 * Get or create persistent human-friendly device name (UUID removed per David / Council)
 */
export function getOrCreateDeviceName() {
  // Clear any legacy UUID from storage
  try {
    localStorage.removeItem('axona.track.device_uuid');
  } catch {}

  let name = null;
  try {
    name = localStorage.getItem('axona.track.device_name');
  } catch {}

  if (!name) {
    const platform = detectPlatform();
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const osShort = platform.os.toLowerCase().replace(/[^a-z0-9]/g, '');
    const modeShort = platform.isStandalone ? 'pwa' : 'tab';
    const rand = Math.random().toString(36).slice(2, 6);

    name = `${adj}-${animal}-${osShort}-${modeShort}-${rand}`;
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
