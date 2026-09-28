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
  const ua = navigator.userAgent || '';
  let os = 'Unknown OS';
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
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
  const isStandalone = (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: fullscreen)')?.matches ||
    window.navigator.standalone === true ||
    document.referrer.includes('android-app://')
  );

  return {
    os,
    browser,
    isStandalone,
    displayMode: isStandalone ? 'standalone-pwa' : 'browser-tab',
    userAgent: ua,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: navigator.deviceMemory || null,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      pixelRatio: window.devicePixelRatio || 1
    },
    touchSupported: 'ontouchstart' in window || navigator.maxTouchPoints > 0
  };
}

/**
 * Get or create persistent device ID & human-friendly slug
 */
export function getOrCreateDeviceId() {
  let uuid = localStorage.getItem('axona.track.device_uuid');
  let name = localStorage.getItem('axona.track.device_name');

  if (!uuid) {
    uuid = (typeof crypto.randomUUID === 'function') 
      ? crypto.randomUUID() 
      : 'dev-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
    localStorage.setItem('axona.track.device_uuid', uuid);
  }

  if (!name) {
    const platform = detectPlatform();
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const osShort = platform.os.toLowerCase().replace(/[^a-z0-9]/g, '');
    const modeShort = platform.isStandalone ? 'pwa' : 'tab';
    const hex = uuid.replace(/-/g, '').slice(0, 4);

    name = `${adj}-${animal}-${osShort}-${modeShort}-${hex}`;
    localStorage.setItem('axona.track.device_name', name);
  }

  return { uuid, name };
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
