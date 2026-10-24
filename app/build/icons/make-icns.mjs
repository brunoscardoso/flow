// Regenerates build/icon.icns — the macOS app icon (electron-builder's
// `mac.icon`), assembled by Apple's own `iconutil` from the icon-<size>.png
// sources in this directory.
//
// Why not let electron-builder convert build/icon.png: its generated .icns
// wrote the 16, 32 and 48 px slots (the legacy RLE-packed is32/il32/ih32
// entries) as noise. Finder, Spotlight and every app list draw those slots, so
// the icon showed as coloured static there while the Dock — which reads the
// PNG-backed large slots — looked fine (live 2026-10-23, Flow 0.2.2). iconutil
// stores every slot as PNG, and electron-builder uses a .icns verbatim.
//
// The .icns is a committed binary, so this script is the one recorded path to
// it. Run it after changing the source PNGs; nothing runs it automatically.
//
//   cd app && node build/icons/make-icns.mjs
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const iconsDir = dirname(fileURLToPath(import.meta.url))
const buildDir = join(iconsDir, '..')

// iconset slot name → source size. @2x slots reuse the next size up.
const SLOTS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

const workDir = mkdtempSync(join(tmpdir(), 'flow-icns-'))
const iconset = join(workDir, 'icon.iconset')
try {
  execFileSync('mkdir', [iconset])
  for (const [slot, size] of SLOTS) {
    const source = join(iconsDir, `icon-${size}.png`)
    const png = readFileSync(source)
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    if (width !== size || height !== size) {
      throw new Error(`icon-${size}.png is ${width}x${height}, expected ${size}x${size}`)
    }
    copyFileSync(source, join(iconset, slot))
  }
  const target = join(buildDir, 'icon.icns')
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', target])
  console.log(`wrote icon.icns — ${SLOTS.length} slots from icon-<size>.png, ${readFileSync(target).length} bytes`)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
