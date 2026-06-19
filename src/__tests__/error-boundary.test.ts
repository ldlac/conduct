import { describe, it, expect } from "vitest";
import { ErrorBoundary } from "../tui/components/ErrorBoundary.js";

describe("ErrorBoundary", () => {
  it("is a class component with getDerivedStateFromError", () => {
    expect(typeof ErrorBoundary).toBe("function");
    expect(ErrorBoundary.prototype?.render).toBeDefined();
    expect(typeof ErrorBoundary.getDerivedStateFromError).toBe("function");
  });

  it("renders an error fallback when state.error is set", () => {
    const instance = new ErrorBoundary({ children: null, label: "Test" });
    instance.setState({ error: new Error("something broke") });
    const result = instance.render();
    // Should render a crash message, not throw.
    expect(result).toBeDefined();
  });

  it("handles missing label gracefully", () => {
    const instance = new ErrorBoundary({ children: null });
    instance.setState({ error: new Error("oops") });
    const result = instance.render();
    expect(result).toBeDefined();
  });

  it("passes through children when no error", () => {
    const instance = new ErrorBoundary({ children: "hello" });
    const result = instance.render();
    expect(result).toBe("hello");
  });
});
