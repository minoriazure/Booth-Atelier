import { readFileSync, readdirSync, createReadStream, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const ref = process.env.GITHUB_REF ?? ''
if (ref.startsWith('refs/tags/') && ref !== `refs/tags/v${version}`) throw new Error(`Tag ${ref} does not match package ${version}`)
if (JSON.parse(readFileSync('package-lock.json', 'utf8')).version !== version) throw new Error('Lockfile version mismatch')
if (process.argv.includes('--hash')) {
  const files = readdirSync('dist').filter((name) => name.endsWith('-portable.exe'))
  if (!files.length) throw new Error('No portable artifacts')
  const lines = []
  for (const file of files) {
    if (file !== `BoothAtelier-${version}-portable.exe`) throw new Error(`Unexpected artifact: ${file}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join('dist', file))) hash.update(chunk)
    lines.push(`${hash.digest('hex')}  ${file}`)
  }
  writeFileSync('dist/SHA256SUMS.txt', lines.join('\n') + '\n')
}
console.log(`Release metadata verified: ${version}`)
