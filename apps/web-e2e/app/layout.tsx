import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StudyClaw · 以测促学",
  description:
    "评测驱动、项目即课程、文件即状态的学习 Agent 控制台（DSH 风格）",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
