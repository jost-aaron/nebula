import assert from "node:assert/strict";
import test from "node:test";

import { createHlsPlayback, supportsHlsPlayback } from "../src/cinema/hlsPlayback.ts";

class FakeMedia extends EventTarget {
  attributes = new Map();
  loadCount = 0;

  constructor(nativeSupport = "") {
    super();
    this.nativeSupport = nativeSupport;
  }

  canPlayType() {
    return this.nativeSupport;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  set src(value) {
    this.setAttribute("src", value);
  }

  get src() {
    return this.getAttribute("src") ?? "";
  }

  load() {
    this.loadCount += 1;
  }
}

function createFakeHls({ supported = true } = {}) {
  const instances = [];
  class FakeHls {
    static isSupported() {
      return supported;
    }

    handlers = new Map();
    destroyCount = 0;
    recoverCount = 0;

    constructor(config) {
      this.config = config;
      instances.push(this);
    }

    on(event, handler) {
      this.handlers.set(event, handler);
    }

    emit(event, data) {
      this.handlers.get(event)?.(event, data);
    }

    loadSource(url) {
      this.loadedUrl = url;
    }

    attachMedia(media) {
      this.media = media;
    }

    recoverMediaError() {
      this.recoverCount += 1;
    }

    destroy() {
      this.destroyCount += 1;
    }
  }
  return { FakeHls, instances };
}

test("support detection and playback prefer native HLS", async () => {
  const media = new FakeMedia("probably");
  const { FakeHls, instances } = createFakeHls();
  assert.equal(supportsHlsPlayback(media, FakeHls), true);

  const playback = createHlsPlayback({
    media,
    manifestUrl: "/stream/master.m3u8?ticket=secret",
    hlsConstructor: FakeHls,
    userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"
  });
  assert.equal(playback.mode, "native");
  assert.equal(instances.length, 0);
  assert.equal(media.src, "/stream/master.m3u8?ticket=secret");
  media.dispatchEvent(new Event("loadedmetadata"));
  await playback.ready;
});

test("Chromium false-positive native HLS support still uses hls.js", async () => {
  const media = new FakeMedia("probably");
  const { FakeHls, instances } = createFakeHls();
  const playback = createHlsPlayback({
    media,
    manifestUrl: "/stream/master.m3u8",
    hlsConstructor: FakeHls,
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36"
  });
  assert.equal(playback.mode, "hls.js");
  assert.equal(instances.length, 1);
  instances[0].emit("hlsManifestParsed");
  await playback.ready;
});

test("MSE fallback loads, attaches, and credentials same-origin requests", async () => {
  const media = new FakeMedia();
  const { FakeHls, instances } = createFakeHls();
  const playback = createHlsPlayback({
    media,
    manifestUrl: "/stream/master.m3u8",
    pageUrl: "https://nebula.test/cinema",
    hlsConstructor: FakeHls
  });
  const hls = instances[0];

  assert.equal(playback.mode, "hls.js");
  assert.equal(hls.loadedUrl, "/stream/master.m3u8");
  assert.equal(hls.media, media);
  const xhr = { withCredentials: false };
  hls.config.xhrSetup(xhr);
  assert.equal(xhr.withCredentials, true);
  const request = hls.config.fetchSetup(
    { url: "https://nebula.test/stream/segment.ts" },
    { method: "GET" }
  );
  assert.equal(request.credentials, "same-origin");
  hls.emit("hlsManifestParsed");
  await playback.ready;
});

test("fatal media errors recover once, then reject with sanitized details", async () => {
  const media = new FakeMedia();
  const { FakeHls, instances } = createFakeHls();
  const errors = [];
  const playback = createHlsPlayback({
    media,
    manifestUrl: "/stream/master.m3u8?token=do-not-leak",
    hlsConstructor: FakeHls,
    onError: (error) => errors.push(error)
  });
  const hls = instances[0];

  hls.emit("hlsError", { fatal: true, type: "mediaError", url: "https://secret.invalid" });
  assert.equal(hls.recoverCount, 1);
  hls.emit("hlsError", { fatal: true, type: "mediaError", reason: "token=do-not-leak" });
  await assert.rejects(playback.ready, (error) => {
    assert.deepEqual(error, {
      fatal: true,
      kind: "media",
      message: "The HLS stream could not be decoded."
    });
    return true;
  });
  assert.deepEqual(errors, [
    { fatal: true, kind: "media", message: "The HLS stream could not be decoded." }
  ]);
});

test("fatal network errors fail without recovery and teardown is idempotent", async () => {
  const media = new FakeMedia();
  media.setAttribute("src", "/original.mp4");
  const { FakeHls, instances } = createFakeHls();
  const playback = createHlsPlayback({
    media,
    manifestUrl: "/stream/master.m3u8?token=do-not-leak",
    hlsConstructor: FakeHls
  });
  const hls = instances[0];

  hls.emit("hlsError", { fatal: true, type: "networkError", url: "https://secret.invalid" });
  await assert.rejects(playback.ready, (error) => {
    assert.equal(error.kind, "network");
    assert.match(error.message, /could not be loaded/);
    return true;
  });
  assert.equal(hls.recoverCount, 0);
  playback.destroy();
  playback.destroy();
  assert.equal(hls.destroyCount, 1);
  assert.equal(media.src, "/original.mp4");
  assert.equal(media.loadCount, 1);
});

test("teardown settles pending readiness without reporting a transport failure", async () => {
  const media = new FakeMedia();
  const { FakeHls } = createFakeHls();
  const errors = [];
  const playback = createHlsPlayback({ media, manifestUrl: "/stream/master.m3u8", hlsConstructor: FakeHls, onError: (error) => errors.push(error) });
  playback.destroy();
  await assert.rejects(playback.ready, { message: "HLS playback was stopped." });
  assert.deepEqual(errors, []);
});
