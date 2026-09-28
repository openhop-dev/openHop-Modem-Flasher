// Android Chrome has no Web Serial, but has WebUSB - use the serial-over-WebUSB polyfill there
const useUsbPolyfill = /Android/i.test(navigator.userAgent) && 'usb' in navigator;

export const serialAPI = useUsbPolyfill
  ? (await import('/lib/polyfill/serial.js?v=openhop14')).serial
  : navigator.serial;

export const serialSupported = Boolean(serialAPI);
