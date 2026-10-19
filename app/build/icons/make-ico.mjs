// Regenerates build/icon.ico — the Windows app icon (electron-builder's
// `win.icon`), a multi-resolution ICO with PNG-compressed entries (Vista+).
//
// The .ico is a committed binary, so this script exists to make it
// REPRODUCIBLE rather than hand-crafted: it is the one recorded path from the
// icon-<size>.png sources in this directory to the packaged icon. Run it after
// changing the source PNGs; nothing runs it automatically.
//
// electron-builder consumes a .ico verbatim (no conversion) but rejects one
// whose largest entry is under 256x256 — hence 256 is mandatory in SIZES.
//
//   cd app && node build/icons/make-ico.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const iconsDir = dirname(fileURLToPath(import.meta.url))
const buildDir = join(iconsDir, '..')

const SIZES = [16, 32, 64, 128, 256]
const entries = SIZES.map((size) => {
  const png = readFileSync(join(iconsDir, `icon-${size}.png`))
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width !== size || height !== size) {
    throw new Error(`icon-${size}.png is ${width}x${height}, expected ${size}x${size}`)
  }
  return { size, png }
})

const HEADER = 6
const DIR_ENTRY = 16
let offset = HEADER + DIR_ENTRY * entries.length

const header = Buffer.alloc(HEADER)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(entries.length, 4)

const dir = Buffer.alloc(DIR_ENTRY * entries.length)
entries.forEach((entry, index) => {
  const at = index * DIR_ENTRY
  dir.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 0) // 0 means 256
  dir.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1)
  dir.writeUInt8(0, at + 2) // palette colors (0 = truecolor)
  dir.writeUInt8(0, at + 3) // reserved
  dir.writeUInt16LE(1, at + 4) // color planes
  dir.writeUInt16LE(32, at + 6) // bits per pixel
  dir.writeUInt32LE(entry.png.length, at + 8)
  dir.writeUInt32LE(offset, at + 12)
  offset += entry.png.length
})

const ico = Buffer.concat([header, dir, ...entries.map((e) => e.png)])
writeFileSync(join(buildDir, 'icon.ico'), ico)
console.log(`wrote icon.ico — ${entries.length} entries (${SIZES.join(', ')}), ${ico.length} bytes`)
