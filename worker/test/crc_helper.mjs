import { crc32 } from 'node:zlib';
export function zlibCrc(buf){ return crc32(buf) >>> 0; }
