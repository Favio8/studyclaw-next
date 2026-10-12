/**
 * 原子替换（write-temp + rename）在 Windows 上会**间歇性**失败。
 *
 * 机制：`rename` 覆盖一个已存在的目标时，Windows 要求没有其它句柄正持有该文件。
 * 杀软实时扫描、搜索索引器、以及任何并发 reader 都会短暂占���它，于是
 * `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` 返回 `EPERM` / `EBUSY` / `EACCES`。
 * 这不是数据损坏，也不是逻辑错误——几十毫秒后重试几乎必然成功。
 *
 * 本仓库此前只在会话存储里踩过这个坑并就地写了一份重试，其余 12 处
 * write-temp + rename 仍是裸调用，于是同一个问题以"随机失败的测试"和
 * "偶发保存不了设置"两种形式反复出现。这里把它收敛成唯一实现。
 *
 * @module @studyclaw/fs-atomic
 */

import { rename } from 'node:fs/promises'

/**
 * 判定「目标文件被外部短暂占用」。
 *
 * 只收这三个码：它们在 POSIX 上基本不出现，在 Windows 上是 rename 撞上
 * 杀软/索引器/其它 reader 句柄的典型症状。ENOENT / EEXIST / EXDEV 等是
 * **真实错误**（路径写错、跨卷、目标不是文件），重试只会掩盖真问题，必须原样抛出。
 */
export function isTransientFileBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/**
 * 有界退避。约 200ms 总窗口——足以越过一次杀软扫描，又短到不会让用户
 * 在"保存失败"上干等。超出即抛出**最后一次**原始错误，不吞异常。
 */
const RENAME_RETRY_DELAYS_MS = [10, 40, 150]

/**
 * `rename`，对临时占用类错误做有界退避重试。
 *
 * 只重试 `isTransientFileBusy` 认定的三种码；其它错误第一次就抛。
 *
 * @param from - 源路径（同目录临时文件）
 * @param to - 目标路径
 * @throws 原始 `NodeJS.ErrnoException`（重试耗尽时抛最后一次的）
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isTransientFileBusy(error)) throw error
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}