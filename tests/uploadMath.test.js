'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planParts, partLength, MIN_PART_BYTES, MAX_PART_BYTES, MAX_PARTS, MiB, GiB } = require('../src/utils/uploadMath');

const sumOfParts = (size, partSize) => {
  const total = Math.ceil(size / partSize);
  let sum = 0;
  for (let n = 1; n <= total; n++) sum += partLength(n, size, partSize);
  return sum;
};

describe('planParts', () => {
  it('uses one part for a tiny file', () => {
    assert.deepEqual(planParts(1, 16 * MiB), { partSizeBytes: 16 * MiB, totalParts: 1 });
  });

  it('plans a 3 GB and a 5 GB video with 16 MiB parts', () => {
    const three = planParts(3 * GiB, 16 * MiB);
    assert.deepEqual(three, { partSizeBytes: 16 * MiB, totalParts: 192 });
    const five = planParts(5 * GiB, 16 * MiB);
    assert.deepEqual(five, { partSizeBytes: 16 * MiB, totalParts: 320 });
  });

  it('handles sizes that are not a multiple of the part size (short last part)', () => {
    const size = 5 * GiB + 123;
    const { partSizeBytes, totalParts } = planParts(size, 16 * MiB);
    assert.equal(totalParts, 321);
    assert.equal(partLength(321, size, partSizeBytes), 123);
    assert.equal(partLength(320, size, partSizeBytes), 16 * MiB);
  });

  it('grows the part size (whole MiB) so a huge file never needs more than 10,000 parts', () => {
    const size = 500 * GiB;
    const { partSizeBytes, totalParts } = planParts(size, 16 * MiB);
    assert.ok(totalParts <= MAX_PARTS);
    assert.equal(partSizeBytes % MiB, 0);
    assert.ok(partSizeBytes >= Math.ceil(size / MAX_PARTS));
    assert.ok(partSizeBytes <= MAX_PART_BYTES);
  });

  it('every part except the last meets the 5 MiB storage minimum', () => {
    for (const size of [1, 10 * MiB, 3 * GiB + 7, 5 * GiB]) {
      const { partSizeBytes, totalParts } = planParts(size, 16 * MiB);
      if (totalParts > 1) assert.ok(partSizeBytes >= MIN_PART_BYTES);
    }
  });

  it('the parts always add up to exactly the file size (200 random sizes)', () => {
    let seed = 12345;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 200; i++) {
      const size = Math.max(1, Math.floor(rand() * 8 * GiB));
      const { partSizeBytes, totalParts } = planParts(size, 16 * MiB);
      assert.ok(totalParts >= 1 && totalParts <= MAX_PARTS);
      assert.equal(sumOfParts(size, partSizeBytes), size, `size ${size}`);
    }
  });

  it('rejects invalid input and files too big for multipart', () => {
    assert.throws(() => planParts(0, 16 * MiB), RangeError);
    assert.throws(() => planParts(-5, 16 * MiB), RangeError);
    assert.throws(() => planParts(1.5, 16 * MiB), RangeError);
    assert.throws(() => planParts(10, 0), RangeError);
    assert.throws(() => planParts(MAX_PARTS * MAX_PART_BYTES + 1, 16 * MiB), /too large/);
  });
});

describe('partLength', () => {
  it('rejects part numbers outside 1..totalParts', () => {
    assert.throws(() => partLength(0, 100, 10), RangeError);
    assert.throws(() => partLength(11, 100, 10), RangeError);
    assert.throws(() => partLength(1.5, 100, 10), RangeError);
  });
  it('returns the remainder for the last part', () => {
    assert.equal(partLength(5, 45, 10), 5);
    assert.equal(partLength(4, 45, 10), 10);
    assert.equal(partLength(1, 10, 10), 10);
  });
});
