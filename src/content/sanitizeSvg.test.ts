import { describe, expect, it } from "vitest";

import { sanitizeSvgDataUrl } from "./sanitizeSvg";

describe("sanitizeSvgDataUrl", () => {
  it("移除脚本、事件和外链资源", () => {
    const url = sanitizeSvgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://evil.test/a" onload="x()"/><path fill="red"/></svg>');
    const decoded = decodeURIComponent(url.split(",", 2)[1] ?? "");
    expect(decoded).not.toContain("script");
    expect(decoded).not.toContain("onload");
    expect(decoded).not.toContain("evil.test");
    expect(decoded).toContain("fill=\"red\"");
  });
});
