import { Buffer } from "buffer";
// Use defineProperty with configurable:false so SES lockdown cannot remove it
try {
  Object.defineProperty(globalThis, 'Buffer', {
    value: Buffer,
    writable: true,
    enumerable: false,
    configurable: false
  });
} catch(e) {
  // If already defined (non-configurable), just assign
  globalThis.Buffer = Buffer;
}
