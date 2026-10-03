// src/version.js — Version metadata for axona.track and protocol kernel
import { KERNEL_VERSION as PROTOCOL_KERNEL_VERSION } from '@axona/protocol';

export const APP_VERSION = '0.3.5';
export const KERNEL_VERSION = PROTOCOL_KERNEL_VERSION || '4.100.0';
