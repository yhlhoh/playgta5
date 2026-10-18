const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const uploads = [];
const nativeTexture = {
  createView(descriptor) { return {descriptor}; },
  destroy() {}
};
const device = {
  features: new Set(),
  createTexture(descriptor) {
    assert.equal(descriptor.format, 'rgba8unorm');
    return nativeTexture;
  },
  queue: {
    writeTexture(destination, data, layout, size) {
      uploads.push({destination, data: new Uint8Array(data), layout, size});
    },
    submit() {}
  }
};
const adapter = {
  features: new Set(),
  requestDevice: async descriptor => {
    assert.deepEqual(descriptor.requiredFeatures, []);
    return device;
  }
};
const context = vm.createContext({
  navigator: {gpu: {requestAdapter: async () => adapter}},
  console,
  Uint8Array,
  Set,
  Proxy,
  BigInt
});

(async () => {
  vm.runInContext(fs.readFileSync('support/bc-fallback.js', 'utf8'), context);
  const wrappedAdapter = await context.navigator.gpu.requestAdapter();
  assert.equal(wrappedAdapter.features.has('texture-compression-bc'), true);
  const wrappedDevice = await wrappedAdapter.requestDevice({requiredFeatures: ['texture-compression-bc']});
  const texture = wrappedDevice.createTexture({format: 'bc1-rgba-unorm', size: {width: 4, height: 4}});
  const block = new Uint8Array([0x00, 0xf8, 0x00, 0x00, 0, 0, 0, 0]);
  wrappedDevice.queue.writeTexture({texture}, block, {bytesPerRow: 8}, {width: 4, height: 4});
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].data.length, 64);
  assert.deepEqual([...uploads[0].data.slice(0, 4)], [255, 0, 0, 255]);
  assert.equal(texture.createView({format: 'bc1-rgba-unorm'}).descriptor.format, 'rgba8unorm');
  console.log('PASS: non-BC adapters decode BC1 uploads and preserve WebGPU method binding');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
