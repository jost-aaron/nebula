import assert from "node:assert/strict";
import test from "node:test";

import { supportsHlsPlayback } from "../src/cinema/hlsSupport.ts";

const media = (nativeSupport = "") => ({
  canPlayType: () => nativeSupport
});

test("native HLS support does not require MediaSource", () => {
  assert.equal(supportsHlsPlayback(media("probably"), {}), true);
});

test("MSE HLS support requires a usable SourceBuffer and compatible codec", () => {
  const MediaSource = {
    isTypeSupported: (mimeType) => mimeType.includes("avc1.42E01E")
  };
  const SourceBuffer = {
    prototype: {
      appendBuffer() {},
      remove() {}
    }
  };

  assert.equal(supportsHlsPlayback(media(), { MediaSource, SourceBuffer }), true);
  assert.equal(supportsHlsPlayback(media(), {
    MediaSource,
    SourceBuffer: { prototype: { appendBuffer() {} } }
  }), false);
  assert.equal(supportsHlsPlayback(media(), {
    MediaSource: { isTypeSupported: () => false },
    SourceBuffer
  }), false);
});
