import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const pngDimensions = async (path) => {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  return {
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16)
  };
};

test("Cinema uses the five-blade production identity across app surfaces", async () => {
  const [symbol, lockup, renderSource, iconSource, appSource, css] = await Promise.all([
    read("src/assets/branding/cinema/nebula-cinema-symbol.svg"),
    read("src/assets/branding/cinema/nebula-cinema-lockup.svg"),
    read("src/cinema/renderCinemaView.ts"),
    read("src/appIcons.ts"),
    read("src/apps.ts"),
    read("src/cinema/cinemaBrand.css")
  ]);

  assert.equal((symbol.match(/<use href="#blade"/g) ?? []).length, 5);
  assert.match(symbol, /fill="#F2EBDD"/);
  assert.match(symbol, /fill="#E7A940"/);
  assert.match(symbol, /right-facing play symbol/);
  assert.match(lockup, /Nebula Cinema horizontal logo/);
  assert.doesNotMatch(lockup, /<text\b/);
  assert.match(renderSource, /nebula-cinema-symbol\.svg/);
  assert.match(renderSource, /Local picture house/);
  assert.match(renderSource, /renderCinemaIcon\("LayoutDashboard"\).*Dashboard/);
  assert.match(iconSource, /cinemaIconMarkup/);
  assert.match(iconSource, /cinema-app-icon-cutout/);
  assert.doesNotMatch(iconSource, /<img class=.*cinema-app-icon/);
  assert.match(appSource, /accent: "#e7a940"/);
  assert.match(css, /--cinema-bone: #f2ebdd/);
  assert.match(css, /--cinema-amber: #e7a940/);
  assert.match(css, /\.cinema-video-stage \.cinema-transport-actions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(css, /\.cinema-control-menu-button > span[\s\S]*display: none/);
});

test("Cinema raster exports include practical icon, symbol, lockup, and monochrome sizes", async () => {
  const exports = new Map([
    ["src/assets/branding/cinema/png/nebula-cinema-app-icon-1024.png", [1024, 1024]],
    ["src/assets/branding/cinema/png/nebula-cinema-app-icon-256.png", [256, 256]],
    ["src/assets/branding/cinema/png/nebula-cinema-lockup-920.png", [920, 256]],
    ["src/assets/branding/cinema/png/nebula-cinema-monochrome-512.png", [512, 512]],
    ["src/assets/branding/cinema/png/nebula-cinema-symbol-256.png", [256, 256]],
    ["src/assets/branding/cinema/png/nebula-cinema-symbol-background-512.png", [512, 512]]
  ]);

  for (const [path, expected] of exports) {
    const dimensions = await pngDimensions(path);
    assert.deepEqual([dimensions.width, dimensions.height], expected, path);
  }
});
