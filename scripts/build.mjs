#!/usr/bin/env node
// Builds icons/ and COVERAGE.md from a checkout of https://github.com/miguelsolorio/vscode-symbols.
// Usage: npm run build -- <path-to-vscode-symbols>

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { optimize } from 'svgo'

// Orca's limits, from src/shared/plugins/artifacts/plugin-icon-theme-artifact.ts in stablyai/orca.
const MAX_MAPPINGS = 512
const MAX_SVG_BYTES = 64 * 1024
const EXTENSION_KEY = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,31}$/

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstream = process.argv[2] && resolve(process.argv[2])
if (!upstream) {
  console.error('usage: node scripts/build.mjs <path-to-vscode-symbols>')
  process.exit(1)
}

const theme = JSON.parse(readFileSync(join(upstream, 'src/symbol-icon-theme.json'), 'utf8'))
const priority = JSON.parse(readFileSync(join(root, 'scripts/priority.json'), 'utf8'))
const upstreamVersion = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8')).version
const upstreamCommit = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const iconPath = (icon) => {
  const def = theme.iconDefinitions[icon]
  if (!def?.iconPath) throw new Error(`no icon definition for ${icon}`)
  return join(upstream, 'src', def.iconPath)
}

// ---- SVGs ---------------------------------------------------------------------------------

// Orca draws only plain shapes, gradients, clip paths and masks; it removes <style>, filters and
// embedded images. These rewrites keep each icon looking as it does in VS Code within that.
function adaptSvg(source, icon) {
  let svg = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<sodipodi:namedview[\s\S]*?(?:\/>|<\/sodipodi:namedview>)/g, '')
    .replace(/\s(?:sodipodi|inkscape):[\w-]+="[^"]*"/g, '')
  svg = inlineClassStyles(svg)
  // Figma names a layer blur `filter<n>_f_…`. Orca cannot blur, and an unblurred glow draws as a
  // hard shape, so the blurred layer is dropped. Drop shadows (`_d_`) keep their shape.
  svg = svg.replace(/<g filter="url\(#filter\d+_f_[^"]*\)">((?:(?!<g[\s>])[\s\S])*?)<\/g>/g, '')
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) svg = shrink(svg)
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) throw new Error(`${icon}.svg is still over 64 KB`)
  if (/<image[\s>]/.test(svg)) throw new Error(`${icon}.svg embeds a raster image`)
  return svg.trim() + '\n'
}

// Moves `.class { … }` rules from a <style> element onto the elements that use them.
function inlineClassStyles(svg) {
  const rules = new Map()
  svg = svg.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_, css) => {
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const selector of selectors.split(',')) {
        const name = selector.trim().match(/^\.([\w-]+)$/)?.[1]
        if (!name) throw new Error(`unsupported CSS selector: ${selector.trim()}`)
        rules.set(name, `${rules.get(name) ?? ''}${body.trim().replace(/;?$/, ';')}`)
      }
    }
    return ''
  })
  if (rules.size === 0) return svg
  return svg.replace(/<([\w:]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g, (tag, name, attributes, slash) => {
    const classes = attributes.match(/\sclass="([^"]*)"/)?.[1]
    if (!classes) return tag
    const declarations = classes.split(/\s+/).map((c) => rules.get(c) ?? '').join('')
    const existing = attributes.match(/\sstyle="([^"]*)"/)?.[1] ?? ''
    // An inline style attribute wins over a class rule, so it goes last.
    const kept = attributes.replace(/\s(?:class|style)="[^"]*"/g, '')
    return `<${name}${kept} style="${declarations}${existing}"${slash}>`
  })
}

// A few Symbols icons are traced or exported from Cairo with long path data and run past Orca's
// 64 KB limit. svgo rewrites their paths at two decimals; the viewBox stays so Orca can scale them.
function shrink(svg) {
  return optimize(svg, {
    floatPrecision: 2,
    plugins: [{ name: 'preset-default', params: { overrides: { removeViewBox: false } } }]
  }).data
}

// ---- Mappings -----------------------------------------------------------------------------

// Every way Symbols can reach an icon, in upstream order: [kind, key, icon].
const candidates = []
const add = (kind, key, icon, source) => candidates.push({ kind, key: key.toLowerCase(), icon, source })
for (const [key, icon] of Object.entries(theme.fileExtensions)) add('ext', key, icon, 'fileExtensions')
for (const [key, icon] of Object.entries(theme.fileNames)) add('name', key, icon, 'fileNames')
for (const [key, icon] of Object.entries(theme.folderNames)) add('folder', key, icon, 'folderNames')
// VS Code matches file names and extensions before language ids, so a language id only adds the
// names Symbols does not already map.
for (const [table, kind] of [
  [priority.languageExtensions, 'ext'],
  [priority.languageFileNames, 'name']
]) {
  for (const [languageId, keys] of Object.entries(table)) {
    const icon = theme.languageIds[languageId]
    if (!icon) throw new Error(`Symbols has no icon for language id ${languageId}`)
    for (const key of keys) add(kind, key, icon, `languageIds.${languageId}`)
  }
}

const unique = new Map()
for (const candidate of candidates) {
  const id = `${candidate.kind}:${candidate.key}`
  if (candidate.kind === 'ext' && !EXTENSION_KEY.test(candidate.key)) throw new Error(`bad extension ${id}`)
  if (!unique.has(id)) unique.set(id, candidate)
}

const selected = new Map()
const take = (id) => {
  if (selected.size >= MAX_MAPPINGS - 2 || selected.has(id)) return
  const candidate = unique.get(id)
  if (!candidate) {
    console.warn(`warning: ${id} is not in Symbols; skipped`)
    return
  }
  selected.set(id, candidate)
}

for (const id of priority.essentials) take(id)

const byIcon = new Map()
for (const candidate of unique.values()) {
  if (!byIcon.has(candidate.icon)) byIcon.set(candidate.icon, [])
  byIcon.get(candidate.icon).push(candidate)
}
const shown = () => new Set([...selected.values()].map((c) => c.icon))
const coveredByEssentials = shown()
for (const [icon, group] of byIcon) {
  if (!coveredByEssentials.has(icon)) take(`${group[0].kind}:${group[0].key}`)
}
for (let round = 0; selected.size < MAX_MAPPINGS - 2; round += 1) {
  const groups = [...byIcon.values()].filter((group) => group.length > round)
  if (groups.length === 0) break
  for (const group of groups) take(`${group[round].kind}:${group[round].key}`)
}

// ---- Write --------------------------------------------------------------------------------

const iconsDir = join(root, 'icons')
rmSync(iconsDir, { recursive: true, force: true })
const written = new Map()
const svgFor = (icon) => {
  if (!written.has(icon)) {
    const source = iconPath(icon)
    const folder = source.includes('/folders/') ? 'folders' : 'files'
    const target = join(iconsDir, folder, `${icon}.svg`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, adaptSvg(readFileSync(source, 'utf8'), icon))
    written.set(icon, relative(root, target))
  }
  return written.get(icon)
}

const out = {
  schemaVersion: 1,
  icons: { file: svgFor(theme.file), folder: svgFor(theme.folder) },
  fileNames: {},
  fileExtensions: {},
  folderNames: {}
}
const section = { ext: 'fileExtensions', name: 'fileNames', folder: 'folderNames' }
for (const { kind, key, icon } of [...selected.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  out[section[kind]][key] = svgFor(icon)
}
writeFileSync(join(iconsDir, 'theme.json'), JSON.stringify(out, null, 2) + '\n')

// ---- Report -------------------------------------------------------------------------------

const allIcons = new Set(byIcon.keys())
const shownIcons = shown()
const missingIcons = [...allIcons].filter((icon) => !shownIcons.has(icon)).sort()
const omitted = [...unique.values()].filter((c) => !selected.has(`${c.kind}:${c.key}`))
const label = { ext: 'Extension', name: 'File name', folder: 'Folder name' }
const omittedRows = omitted
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
  .map((c) => `| ${label[c.kind]} | \`${c.key}\` | ${c.icon} |`)

writeFileSync(
  join(root, 'COVERAGE.md'),
  `# Coverage

Generated by \`scripts/build.mjs\` from [Symbols](https://github.com/miguelsolorio/vscode-symbols) ${upstreamVersion}, commit [\`${upstreamCommit.slice(0, 7)}\`](https://github.com/miguelsolorio/vscode-symbols/tree/${upstreamCommit}).

Orca allows at most ${MAX_MAPPINGS} mappings in one icon theme. Symbols maps ${unique.size} file names, extensions and folder names (counting the language ids it maps, turned into the extensions and file names VS Code gives them), so this port keeps ${selected.size + 2}:

- the generic file and folder icons;
- the common names listed in \`scripts/priority.json\`;
- at least one name for every other Symbols icon;
- then more names, a round at a time across all icons, until the budget runs out.

Every icon uses the SVG from Symbols. ${shownIcons.size} of the ${allIcons.size} icons Symbols maps appear here${missingIcons.length ? `; these do not: ${missingIcons.join(', ')}` : ''}.

A name left out below shows the generic file or folder icon instead. To change what is kept, edit \`scripts/priority.json\` and rebuild.

## Not mapped (${omitted.length})

| Kind | Name | Symbols icon |
| --- | --- | --- |
${omittedRows.join('\n')}
`
)

console.log(
  `${selected.size + 2} mappings, ${written.size} SVGs, ${shownIcons.size}/${allIcons.size} icons shown, ${omitted.length} names omitted`
)
