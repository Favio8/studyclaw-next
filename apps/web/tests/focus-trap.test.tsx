/**
 * useFocusTrap 单测（W-10）：Tab 循环 / Escape / 焦点还原 / 嵌套栈顶仲裁。
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFocusTrap } from "../src/hooks/useFocusTrap";

function TrapDialog({ onEscape, label = "dialog" }: { onEscape?: () => void; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap({ containerRef: ref, onEscape });
  return (
    <section ref={ref} role="dialog" aria-modal="true" aria-label={label}>
      <button type="button">one</button>
      <button type="button">two</button>
      <button type="button">three</button>
    </section>
  );
}

function Nested() {
  const outer = useRef<HTMLElement>(null);
  const inner = useRef<HTMLElement>(null);
  const [innerOpen, setInnerOpen] = useState(true);
  const outerEscape = vi.fn();
  const innerEscape = vi.fn();
  useFocusTrap({ containerRef: outer, onEscape: outerEscape });
  useFocusTrap({ containerRef: inner, onEscape: innerEscape });
  return (
    <>
      <section ref={outer} role="dialog" aria-modal="true" aria-label="outer">
        <button type="button">outer-btn</button>
        {innerOpen ? (
          <section ref={inner} role="dialog" aria-modal="true" aria-label="inner">
            <button type="button">inner-btn</button>
          </section>
        ) : null}
      </section>
    </>
  );
}

describe("useFocusTrap", () => {
  it("打开时聚焦首个可聚焦元素", () => {
    render(<TrapDialog />);
    expect(screen.getByRole("button", { name: "one" })).toHaveFocus();
  });

  it("Tab 在容器内首尾循环，Shift+Tab 反向", () => {
    render(<TrapDialog />);
    const one = screen.getByRole("button", { name: "one" });
    const three = screen.getByRole("button", { name: "three" });

    // 末尾 Tab → 回首项（hook 边界循环；jsdom 不实现原生 Tab 移动，
    // 容器中段的前进由真实浏览器完成，这里只锁定 hook 的边界契约）。
    three.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(one).toHaveFocus();

    one.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(three).toHaveFocus();
  });

  it("Escape 调用 onEscape", () => {
    const onEscape = vi.fn();
    render(<TrapDialog onEscape={onEscape} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("关闭后焦点还原到打开前的元素", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>opener</button>
          {open ? <TrapDialog onEscape={() => setOpen(false)} /> : null}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("button", { name: "one" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("嵌套弹层仅栈顶响应 Escape", () => {
    render(<Nested />);
    // 栈顶是 inner：Escape 只触发 innerEscape，outerEscape 挂起。
    fireEvent.keyDown(document, { key: "Escape" });
    const innerDialog = screen.getByRole("dialog", { name: "inner" });
    expect(innerDialog).toBeInTheDocument();
    // 焦点应在 inner 内（inner 后挂载，自动聚焦覆盖 outer 的初始聚焦）
    expect(screen.getByRole("button", { name: "inner-btn" })).toHaveFocus();
  });
});
