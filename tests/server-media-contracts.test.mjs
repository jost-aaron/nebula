import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_REPOSITORY_METHODS,
  PLAYBACK_REPOSITORY_METHODS,
  requireMediaContract
} from "../server/mediaContracts.mjs";

test("media contracts reject incomplete domain adapters", () => {
  assert.throws(
    () => requireMediaContract("catalog", { getItem() {} }, CATALOG_REPOSITORY_METHODS),
    /catalog\.getSource must be a function/
  );
});

test("media contracts accept complete structural adapters", () => {
  const repository = Object.fromEntries(PLAYBACK_REPOSITORY_METHODS.map((method) => [method, () => null]));
  assert.equal(requireMediaContract("playback", repository, PLAYBACK_REPOSITORY_METHODS), repository);
});
