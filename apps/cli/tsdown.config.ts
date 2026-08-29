import { defineConfig } from 'tsdown'

/**
 * FL-20：CLI 打包为自包含单文件 bundle（dsh 同范式：`tsc -b` 先产出
 * `lib/types/bin.js`，tsdown 把它连同全部 workspace 闭包聚合成扁平
 * `lib/bin.js`——`files: ["lib/*.js"]` 的 glob 从此必然命中，`bin` 指向的
 * 入口及其依赖一起进 tarball，npm 安装即可运行）。
 *
 * - alwaysBundle：@studyclaw/* / @deepseek-ai/*（npm 上不存在，必须打进
 *   bundle——`workspace:^` 发布即坏的问题就此消失）+ 其余纯 JS 运行时依赖
 *   （xlsx/mammoth/turndown/zod/js-yaml/busboy 一并入包，安装不依赖它们）。
 * - neverBundle：koffi（win32 目录选择器的原生模块，无法打包进 JS）与
 *   pdf-parse（其 pdfjs 依赖在打包形态下会顶层执行 DOMMatrix/canvas 探测而
 *   崩溃，且需要从包目录读取 cmaps/字体等静态资产）——两者由发布清单声明，
 *   经 npm 正常安装。
 */
export default defineConfig({
  entry: ['lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: [/^@studyclaw\//, /^@deepseek-ai\//, 'busboy', 'js-yaml', 'mammoth', 'turndown', 'xlsx', 'zod'],
    neverBundle: ['koffi', 'pdf-parse'],
  },
})
