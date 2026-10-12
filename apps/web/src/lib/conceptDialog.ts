/**
 * 概念提炼弹层的模块级打开入口（F2/M2）：ConceptEditor 注册自己的打开动作，
 * 补题前置条件与新手引导 G4 可据此直达「AI 概念提炼」，而不必各自复制弹层。
 */

type ConceptDialogOpener = (source?: string) => void;

let opener: ConceptDialogOpener | null = null;

export function registerConceptDialog(fn: ConceptDialogOpener | null): void {
  opener = fn;
}

export function openConceptDialog(source?: string): void {
  opener?.(source);
}
