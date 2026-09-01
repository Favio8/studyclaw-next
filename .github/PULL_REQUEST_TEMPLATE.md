<!-- 标题请遵循 Conventional Commits：emoji type(scope): 简述 -->

## 改动说明

<!-- 做了什么、为什么做；关联 Issue 请写 Fixes #NN -->

## 变更类型

- [ ] 功能（feat）
- [ ] 修复（fix）
- [ ] 文档（docs）
- [ ] 工程/构建（chore/eng）
- [ ] 性能（perf）
- [ ] 安全（security）

## 自查清单

- [ ] `pnpm typecheck` 零错误
- [ ] `pnpm test` 全绿；改动领域契约（RPC 方法 / 文件格式 / 事件类型）时已同步补测试
- [ ] 新增 RPC 方法已在 `apiproxy` 补 zod 校验与错误码
- [ ] 提交信息遵循 Conventional Commits（`emoji type(scope): …`，与仓库历史一致）
- [ ] 涉及 UI 的改动附了截图或录屏
- [ ] 未引入新的运行时依赖（确需引入请在说明里给出理由与许可证）
