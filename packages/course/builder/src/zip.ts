/**
 * 最小 ZIP 读写（无第三方依赖）：`zlib.deflateRawSync` / `inflateRawSync` +
 * `zlib.crc32` 足够实现导出/导入所需的归档能力。
 *
 * 为什么不用现成库：本项目的发布约束是"不新增运行时依赖"，而备份归档是
 * 一次性、无压缩率诉求的场景——store/deflate 二选一即可，不值得为它引入依赖。
 *
 * 范围：只支持 ZIP 规范里最常用的部分——单盘、无加密、无 Zip64、无目录条目。
 * 课程状态文件远低于 4 GiB / 65535 条目上限，超限时明确报错而非静默截断。
 * @module @studyclaw/course-builder/src/zip
 */

import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** general purpose bit 11：文件名按 UTF-8 编码。未置位时严格的解压工具会按
 *  本地代码页解码文件名，中文课程名直接乱码（APPNOTE 6.4.4 / 4.4.4）。 */
const FLAG_UTF8 = 0x0800

/** Zip64 触发阈值：压缩前 4 GiB / 65535 条目。越过即报错，不静默产出坏档。 */
const MAX_ENTRY_BYTES = 0xffffffff
const MAX_ENTRIES = 0xffff

export interface ZipEntry {
  /** 归档内路径，始终用 `/` 分隔（ZIP 规范要求）。 */
  readonly path: string
  readonly data: Buffer
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * 打包为 ZIP 缓冲区。条目多于 65535 或单条目超过 4 GiB 时抛错——
 * 生成一个能被解压工具读一半的坏档，比直接失败糟糕得多。
 */
export function createZip(entries: readonly ZipEntry[], now = new Date()): Buffer {
  if (entries.length > MAX_ENTRIES) throw new RangeError(`归档条目过多：${entries.length}（上限 ${MAX_ENTRIES}）`)
  const { time, date } = dosDateTime(now)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    if (entry.data.length > MAX_ENTRY_BYTES) throw new RangeError(`条目超过 Zip64 阈值：${entry.path}`)
    // 路径必须是 `/`；空路径与绝对路径会造成解压逃逸，拒绝而不是清洗。
    const name = entry.path.split('\\').join('/')
    if (name === '' || name.startsWith('/')) throw new RangeError(`非法归档路径：${entry.path}`)
    const nameBuf = Buffer.from(name, 'utf8')
    const checksum = crc32(entry.data)
    const deflated = deflateRawSync(entry.data, { level: 9 })
    // 压不小就存原样（小文件上 deflate 反而更大）。
    const useDeflate = deflated.length < entry.data.length
    const payload = useDeflate ? deflated : entry.data
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(FLAG_UTF8, 6) // flags: bit 11 = UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    locals.push(local, nameBuf, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(FLAG_UTF8, 8) // flags: bit 11 = UTF-8 文件名
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}

function findEocd(buf: Buffer): number {
  // EOCD 固定 22 字节，注释最长 65535 → 从尾部最多回看 65557 字节。
  const limit = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= limit; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * 解包为条目列表。校验每个条目的 CRC——归档损坏要**报错**，不能把半截数据
 * 当成有效备份还原进用户的学习库。
 */
export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（缺少中央目录结束记录）')
  const total = buf.readUInt16LE(eocd + 10)
  let cursor = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []

  for (let i = 0; i < total; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error('ZIP 中央目录损坏')
    }
    const method = buf.readUInt16LE(cursor + 10)
    const checksum = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    cursor += 46 + nameLen + extraLen + commentLen

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP 条目损坏：${name}`)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    const data = method === METHOD_STORE ? Buffer.from(raw)
      : method === METHOD_DEFLATE ? inflateRawSync(raw)
        : null
    if (data === null) throw new Error(`不支持的 ZIP 压缩方式 ${method}：${name}`)
    if (data.length !== uncompressedSize || crc32(data) !== checksum) {
      throw new Error(`ZIP 条目校验失败（数据损坏）：${name}`)
    }
    entries.push({ path: name, data })
  }
  return entries
}
