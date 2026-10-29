import { installBrowserGlobals } from "./browser-env";

// A test file that opts into a DOM environment (// @vitest-environment happy-dom) keeps its real document.
if (typeof document === "undefined") installBrowserGlobals();
