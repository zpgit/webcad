// Integrity checking for the geometry payload.
//
// CRC-32 rather than a cryptographic digest, for two reasons. The failure being
// guarded against is a torn write or a truncated read, not a forged document -
// nothing outside the origin can reach a browser-local store. And
// `crypto.subtle` is undefined outside a secure context, which would make
// saving fail on a plain-http origin; a save path that can lose a user's
// geometry because of how the page was served is not worth the stronger hash.
//
// Table-driven, so a multi-megabyte checkpoint costs milliseconds. The cost is
// real and paid on every save and every open, which is why it is measured
// rather than assumed.

const TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const index = (crc ^ (bytes[i] ?? 0)) & 0xff;
    crc = (TABLE[index] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The checksum as it appears in a manifest: eight lowercase hex digits. */
export function checksumOf(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0');
}
