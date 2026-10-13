// Minimal asar reader used only while developing this plugin: pull a single file
// out of the DSH desktop app.asar so the shipped runtime's own packages can be
// inspected without unpacking the whole archive.
//
// usage: node tools/asar-read.mjs <app.asar> <path-inside-asar> <output-file>
//    or: DSH_APP_ASAR=<app.asar> node tools/asar-read.mjs <path-inside-asar> <output-file>
import fs from 'node:fs'

// Passing the archive path in keeps this tool free of any machine-specific path.
// Typical locations:
//   Windows  <install>\resources\app.asar
//   macOS    /Applications/DeepSeek Harness.app/Contents/Resources/app.asar
// Accept both argument forms: the archive may be given positionally or through
// DSH_APP_ASAR, and the remaining two arguments are always <path> <output>.
const cli = process.argv.slice(2)
const archive = process.env.DSH_APP_ASAR || (cli.length >= 3 ? cli[0] : undefined)
const [inside, out] = process.env.DSH_APP_ASAR || cli.length < 3 ? cli : cli.slice(1)
if (archive === undefined || !inside || !out) {
  console.error('usage: node tools/asar-read.mjs <app.asar> <path-inside-asar> <output-file>')
  console.error('   or: DSH_APP_ASAR=<app.asar> node tools/asar-read.mjs <path-inside-asar> <output-file>')
  process.exit(2)
}
if (!fs.existsSync(archive)) {
  console.error(`no such archive: ${archive}`)
  process.exit(2)
}

const fd = fs.openSync(archive, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
fs.readSync(fd, headerBuf, 0, headerSize, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const base = 16 + headerSize

// Descend the asar directory tree one segment at a time; an asar node is a
// directory when it carries `files`.
let node = header
for (const segment of inside.split('/').filter(Boolean)) {
  const next = node.files?.[segment]
  if (!next) {
    console.error(`not found: ${segment} (in ${inside})`)
    process.exit(1)
  }
  node = next
}
if (node.files) {
  console.error('that path is a directory, not a file')
  process.exit(1)
}
if (node.unpacked) {
  console.error('file is stored unpacked in app.asar.unpacked, not inside the archive')
  process.exit(1)
}

const size = Number(node.size)
const buf = Buffer.alloc(size)
fs.readSync(fd, buf, 0, size, base + Number(node.offset))
fs.writeFileSync(out, buf)
console.log(`wrote ${out} (${size} bytes)`)
