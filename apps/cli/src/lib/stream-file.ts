import { createReadStream } from 'node:fs'
import type { ServerResponse } from 'node:http'

/** Disk errors terminate this response; client disconnects release the file handle. */
export function pipeFileResponse(path: string, response: ServerResponse): void {
  const stream = createReadStream(path)
  stream.on('error', () => response.destroy())
  response.once('close', () => stream.destroy())
  if (response.destroyed) { stream.destroy(); return }
  stream.pipe(response)
}
