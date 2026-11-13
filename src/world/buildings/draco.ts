/**
 * Google's Draco mesh decoder (the WebAssembly build that ships with three.js), driven
 * directly from the building workers: three's DRACOLoader would start a worker pool of its
 * own and hand back three.js geometries, where the workers only need raw arrays.
 */

/** The parts of the Emscripten module used here. */
export interface DracoModule {
  Decoder: new () => DracoDecoder;
  Mesh: new () => DracoMesh;
  DT_FLOAT32: number;
  HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  destroy(o: unknown): void;
}

interface DracoMesh {
  num_points(): number;
  num_faces(): number;
}

interface DracoAttribute {
  num_components(): number;
}

interface DracoDecoder {
  DecodeArrayToMesh(
    data: Int8Array,
    length: number,
    mesh: DracoMesh,
  ): {
    ok(): boolean;
    error_msg(): string;
  };
  GetAttributeByUniqueId(mesh: DracoMesh, id: number): DracoAttribute;
  GetAttributeDataArrayForAllPoints(
    mesh: DracoMesh,
    attribute: DracoAttribute,
    type: number,
    bytes: number,
    ptr: number,
  ): boolean;
  GetTrianglesUInt32Array(mesh: DracoMesh, bytes: number, ptr: number): boolean;
}

/**
 * Instantiates the decoder from the text of three's `draco_wasm_wrapper.js` (a classic script
 * that defines `DracoDecoderModule`) and the bytes of `draco_decoder.wasm`. `nodeRequire` is
 * only for tests in Node, where the wrapper wants `require`.
 */
export async function createDraco(
  wrapper: string,
  wasm: ArrayBuffer | Uint8Array,
  nodeRequire?: unknown,
): Promise<DracoModule> {
  // The wrapper is a plain script, not a module: evaluate it in its own function scope.
  const factory = new Function('require', `${wrapper}\nreturn DracoDecoderModule;`)(
    nodeRequire,
  ) as (opts: object) => Promise<DracoModule>;
  return factory({ wasmBinary: wasm });
}

export interface DecodedPrimitive {
  /** Per point, by glTF attribute name (POSITION, NORMAL, _BATCHID, ...). */
  attributes: Record<string, { array: Float32Array; components: number }>;
  indices: Uint32Array;
}

/** Decodes one KHR_draco_mesh_compression primitive. */
export function decodeDraco(
  draco: DracoModule,
  data: Uint8Array,
  attributeIds: Record<string, number>,
): DecodedPrimitive {
  const decoder = new draco.Decoder();
  const mesh = new draco.Mesh();
  try {
    const bytes = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
    const status = decoder.DecodeArrayToMesh(bytes, bytes.byteLength, mesh);
    if (!status.ok()) throw new Error(`draco: ${status.error_msg()}`);
    const points = mesh.num_points();
    const attributes: DecodedPrimitive['attributes'] = {};
    for (const [name, id] of Object.entries(attributeIds)) {
      const attr = decoder.GetAttributeByUniqueId(mesh, id);
      const components = attr.num_components();
      const n = points * components;
      const ptr = draco._malloc(n * 4);
      decoder.GetAttributeDataArrayForAllPoints(mesh, attr, draco.DT_FLOAT32, n * 4, ptr);
      attributes[name] = {
        array: new Float32Array(draco.HEAPF32.buffer, ptr, n).slice(),
        components,
      };
      draco._free(ptr);
    }
    const ni = mesh.num_faces() * 3;
    const ptr = draco._malloc(ni * 4);
    decoder.GetTrianglesUInt32Array(mesh, ni * 4, ptr);
    const indices = new Uint32Array(draco.HEAPF32.buffer, ptr, ni).slice();
    draco._free(ptr);
    return { attributes, indices };
  } finally {
    draco.destroy(mesh);
    draco.destroy(decoder);
  }
}
