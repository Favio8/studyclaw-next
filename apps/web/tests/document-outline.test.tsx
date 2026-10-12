import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ syllabus: vi.fn(), readingParsed: vi.fn(), readingTranslate: vi.fn(), readingOpenAt: vi.fn() }));
vi.mock("../src/lib/api", () => ({ api: mocks }));
vi.mock("../src/lib/readingFlow", () => ({ readingOpenAt: mocks.readingOpenAt }));
import DocumentOutline, { headingPage } from "../src/components/reader/DocumentOutline";
import { useAppStore } from "../src/store/useAppStore";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("locates wrapped headings and avoids inventing a page from prose mentions", () => {
  const blocks = [{ page: 1, text: "The introduction describes this taxonomy." }, { page: 4, text: "II. A TAXONOMY OF MEMORY\nIN LARGE LANGUAGE MODELS\nBody follows" }];
  expect(headingPage("A TAXONOMY OF MEMORY IN LARGE LANGUAGE MODELS", blocks)).toBe(4);
  expect(headingPage("INTRODUCTION", blocks)).toBeNull();
});
it("shows translated and original titles, links real pages and caches translation on reopen", async () => {
  useAppStore.getState().setActiveCourse("outline-course");
  mocks.syllabus.mockResolvedValue({ document_outline: [{ title: "INTRODUCTION", source: "paper.pdf" }, { title: "CONCLUSION", source: "other.pdf" }] });
  mocks.readingParsed.mockResolvedValue({ blocks: [{ page: 2, text: "I. INTRODUCTION\nDetails" }] });
  mocks.readingTranslate.mockImplementation(async function* () { yield { event: "token", data: { delta: "1. 引言" } }; });
  const first = render(<DocumentOutline source="paper.pdf" onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("引言")).toBeInTheDocument());
  expect(screen.getByText("INTRODUCTION")).toBeInTheDocument();
  expect(screen.queryByText("CONCLUSION")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /引言.*第 2 页/ }));
  expect(mocks.readingOpenAt).toHaveBeenCalledWith("paper.pdf", 2);
  first.unmount();
  render(<DocumentOutline source="paper.pdf" onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("引言")).toBeInTheDocument());
  expect(mocks.readingTranslate).toHaveBeenCalledTimes(1);
});
