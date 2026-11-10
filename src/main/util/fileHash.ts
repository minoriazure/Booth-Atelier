import { createReadStream } from 'fs'
import { createHash } from 'crypto'
export async function fileSha256(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}
