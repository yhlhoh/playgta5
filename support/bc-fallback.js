/* WebGPU BC texture fallback for devices without texture-compression-bc.
 * BC1-BC5 are decoded while queue.writeTexture uploads them as RGBA8.
 */
(() => {
  'use strict';

  const FORMAT_MAP = {
    'bc1-rgba-unorm': 'rgba8unorm',
    'bc1-rgba-unorm-srgb': 'rgba8unorm-srgb',
    'bc2-rgba-unorm': 'rgba8unorm',
    'bc2-rgba-unorm-srgb': 'rgba8unorm-srgb',
    'bc3-rgba-unorm': 'rgba8unorm',
    'bc3-rgba-unorm-srgb': 'rgba8unorm-srgb',
    'bc4-r-unorm': 'rgba8unorm',
    'bc4-r-snorm': 'rgba8unorm',
    'bc5-rg-unorm': 'rgba8unorm',
    'bc5-rg-snorm': 'rgba8unorm',
    'bc6h-rgb-ufloat': 'rgba8unorm',
    'bc6h-rgb-float': 'rgba8unorm',
    'bc7-rgba-unorm': 'rgba8unorm',
    'bc7-rgba-unorm-srgb': 'rgba8unorm-srgb'
  };
  const BLOCK_BYTES = {
    'bc1-rgba-unorm': 8, 'bc1-rgba-unorm-srgb': 8,
    'bc2-rgba-unorm': 16, 'bc2-rgba-unorm-srgb': 16,
    'bc3-rgba-unorm': 16, 'bc3-rgba-unorm-srgb': 16,
    'bc4-r-unorm': 8, 'bc4-r-snorm': 8,
    'bc5-rg-unorm': 16, 'bc5-rg-snorm': 16,
    'bc6h-rgb-ufloat': 16, 'bc6h-rgb-float': 16,
    'bc7-rgba-unorm': 16, 'bc7-rgba-unorm-srgb': 16
  };
  const COMPRESSED_FORMATS = new Set(Object.keys(FORMAT_MAP));
  const textureInfo = new WeakMap();
  const queueInfo = new WeakMap();
  let warnedUnsupported = false;

  function u16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function color565(value) {
    return [
      Math.round(((value >> 11) & 31) * 255 / 31),
      Math.round(((value >> 5) & 63) * 255 / 63),
      Math.round((value & 31) * 255 / 31)
    ];
  }

  function putPixel(output, width, x, y, rgba) {
    if (x < 0 || y < 0 || x >= width) return;
    const index = (y * width + x) * 4;
    output[index] = rgba[0]; output[index + 1] = rgba[1];
    output[index + 2] = rgba[2]; output[index + 3] = rgba[3];
  }

  function decode565Block(bytes, offset, output, width, x0, y0, alpha) {
    const c0 = color565(u16(bytes, offset)), c1 = color565(u16(bytes, offset + 2));
    const colors = [c0.concat(255), c1.concat(255)];
    if (u16(bytes, offset) > u16(bytes, offset + 2)) {
      colors.push([Math.round((2 * c0[0] + c1[0]) / 3), Math.round((2 * c0[1] + c1[1]) / 3), Math.round((2 * c0[2] + c1[2]) / 3), 255]);
      colors.push([Math.round((c0[0] + 2 * c1[0]) / 3), Math.round((c0[1] + 2 * c1[1]) / 3), Math.round((c0[2] + 2 * c1[2]) / 3), 255]);
    } else {
      colors.push([Math.round((c0[0] + c1[0]) / 2), Math.round((c0[1] + c1[1]) / 2), Math.round((c0[2] + c1[2]) / 2), 255]);
      colors.push([0, 0, 0, 0]);
    }
    const indices = bytes[offset + 4] | (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const color = colors[(indices >>> (2 * (4 * y + x))) & 3].slice();
      if (alpha) color[3] = alpha[4 * y + x];
      putPixel(output, width, x0 + x, y0 + y, color);
    }
  }

  function alphaTable(a0, a1, signed) {
    const scale = signed ? value => Math.max(-1, (value < 128 ? value : value - 256) / 127) : value => value;
    const values = [a0, a1];
    if (a0 > a1) {
      for (let i = 1; i <= 6; i++) values.push((((7 - i) * a0 + i * a1) / 7) | 0);
    } else {
      for (let i = 1; i <= 4; i++) values.push(((((5 - i) * a0 + i * a1) / 5) | 0));
      values.push(signed ? -128 : 0, signed ? 127 : 255);
    }
    return values.map(scale);
  }

  function decodeAlphaBlock(bytes, offset, signed) {
    const values = alphaTable(bytes[offset], bytes[offset + 1], signed);
    let bits = 0n;
    for (let i = 0; i < 6; i++) bits |= BigInt(bytes[offset + 2 + i]) << BigInt(8 * i);
    const output = new Array(16);
    for (let i = 0; i < 16; i++) output[i] = values[Number((bits >> BigInt(3 * i)) & 7n)];
    return output.map(value => signed ? Math.max(0, Math.round((value + 1) * 127.5)) : value);
  }

  function decodeBlock(format, bytes, offset, output, width, x, y) {
    if (format.startsWith('bc1-')) {
      decode565Block(bytes, offset, output, width, x, y);
      return;
    }
    if (format.startsWith('bc2-')) {
      const alpha = [];
      for (let i = 0; i < 8; i++) {
        const value = bytes[offset + i];
        alpha.push((value & 15) * 17, (value >> 4) * 17);
      }
      decode565Block(bytes, offset + 8, output, width, x, y, alpha);
      return;
    }
    if (format.startsWith('bc3-')) {
      decode565Block(bytes, offset + 8, output, width, x, y, decodeAlphaBlock(bytes, offset, false));
      return;
    }
    if (format.startsWith('bc4-') || format.startsWith('bc5-')) {
      const red = decodeAlphaBlock(bytes, offset, format.endsWith('snorm'));
      const green = format.startsWith('bc5-') ? decodeAlphaBlock(bytes, offset + 8, format.endsWith('snorm')) : null;
      for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
        const index = row * 4 + column;
        putPixel(output, width, x + column, y + row, [red[index], green ? green[index] : 0, 0, 255]);
      }
      return;
    }
    if (!warnedUnsupported) {
      console.warn('PlayGTA5 BC fallback: BC6H/BC7 textures are shown as transparent placeholders.');
      warnedUnsupported = true;
    }
  }

  function decodeTexture(format, source, sourceOffset, bytesPerRow, width, height, depth) {
    const blockBytes = BLOCK_BYTES[format];
    const blocksWide = Math.ceil(width / 4), blocksHigh = Math.ceil(height / 4);
    const output = new Uint8Array(width * height * 4 * depth);
    for (let layer = 0; layer < depth; layer++) {
      const layerOffset = sourceOffset + layer * (bytesPerRow * blocksHigh);
      const layerOutput = output.subarray(layer * width * height * 4);
      for (let row = 0; row < blocksHigh; row++) for (let column = 0; column < blocksWide; column++) {
        decodeBlock(format, source, layerOffset + row * bytesPerRow + column * blockBytes,
          layerOutput, width, column * 4, row * 4);
      }
    }
    return output;
  }

  function isCompressed(format) {
    return typeof format === 'string' && COMPRESSED_FORMATS.has(format);
  }

  function featureSet(features) {
    const result = new Set(features || []);
    result.add('texture-compression-bc');
    return result;
  }

  function wrapQueue(queue) {
    if (queueInfo.has(queue)) return queueInfo.get(queue);
    const wrapped = new Proxy(queue, {
      get(target, property, receiver) {
        if (property !== 'writeTexture') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (destination, data, dataLayout, size) => {
          const info = textureInfo.get(destination.texture);
          if (!info || !isCompressed(info.format)) return target.writeTexture(destination, data, dataLayout, size);
          const width = typeof size === 'number' ? size : size.width;
          const height = typeof size === 'number' ? 1 : size.height;
          const depth = typeof size === 'number' ? 1 : (size.depthOrArrayLayers || 1);
          const blockBytes = BLOCK_BYTES[info.format];
          const blocksHigh = Math.ceil(height / 4);
          const bytesPerRow = dataLayout.bytesPerRow || Math.ceil(width / 4) * blockBytes;
          const source = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const decoded = decodeTexture(info.format, source, dataLayout.offset || 0, bytesPerRow, width, height, depth);
          return target.writeTexture({texture: info.texture, mipLevel: destination.mipLevel || 0, origin: destination.origin},
            decoded, {offset: 0, bytesPerRow: width * 4, rowsPerImage: height},
            {width, height, depthOrArrayLayers: depth});
        };
      }
    });
    queueInfo.set(queue, wrapped);
    return wrapped;
  }

  function wrapDevice(device) {
    return new Proxy(device, {
      get(target, property, receiver) {
        if (property === 'features') return featureSet(target.features);
        if (property === 'queue') return wrapQueue(target.queue);
        if (property === 'createTexture') return descriptor => {
          if (!isCompressed(descriptor.format)) return target.createTexture(descriptor);
          const info = {format: descriptor.format};
          const replacement = {...descriptor, format: FORMAT_MAP[descriptor.format]};
          info.texture = target.createTexture(replacement);
          const wrapped = new Proxy(info.texture, {
            get(texture, textureProperty, textureReceiver) {
              if (textureProperty !== 'createView') {
                const value = Reflect.get(texture, textureProperty, texture);
                return typeof value === 'function' ? value.bind(texture) : value;
              }
              return viewDescriptor => {
                const view = viewDescriptor ? {...viewDescriptor} : {};
                if (isCompressed(view.format)) view.format = FORMAT_MAP[view.format];
                return texture.createView(view);
              };
            }
          });
          info.texture = wrapped;
          textureInfo.set(wrapped, info);
          return wrapped;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  const nativeRequestAdapter = navigator.gpu?.requestAdapter?.bind(navigator.gpu);
  if (!nativeRequestAdapter) {
    globalThis.PlayGTA5BCFallback = {active: false, nativeBC: false};
    return;
  }

  navigator.gpu.requestAdapter = async (...args) => {
    const adapter = await nativeRequestAdapter(...args);
    if (!adapter) return adapter;
    const nativeBC = adapter.features?.has('texture-compression-bc') === true;
    if (nativeBC) {
      globalThis.PlayGTA5BCFallback = {active: false, nativeBC: true};
      return adapter;
    }
    globalThis.PlayGTA5BCFallback = {active: true, nativeBC: false, formats: [...COMPRESSED_FORMATS]};
    return new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === 'features') return featureSet(target.features);
        if (property !== 'requestDevice') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async descriptor => {
          const requested = descriptor ? {...descriptor} : {};
          if (requested.requiredFeatures) {
            requested.requiredFeatures = requested.requiredFeatures.filter(feature => feature !== 'texture-compression-bc');
          }
          return wrapDevice(await target.requestDevice(requested));
        };
      }
    });
  };
})();
