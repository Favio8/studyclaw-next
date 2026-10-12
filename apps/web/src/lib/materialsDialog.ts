/**
 * 资料导入弹层的模块级打开入口（F1/M2）：LeftNav 注册自己的打开动作，
 * 新手引导 G3 与场景提示可据此直达导入，而不必复制弹层与上传逻辑。
 */

type MaterialsDialogOpener = (tab: "upload" | "import") => void;

let opener: MaterialsDialogOpener | null = null;

export function registerMaterialsDialog(fn: MaterialsDialogOpener | null): void {
  opener = fn;
}

export function openMaterialsDialog(tab: "upload" | "import" = "upload"): void {
  opener?.(tab);
}
